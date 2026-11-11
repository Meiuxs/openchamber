import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWorktree as defaultCreateWorktree, removeWorktree as defaultRemoveWorktree } from '../git/service.js';
import { isValidGitRefName } from './gitlab.js';

class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

const redact = (text, secrets) => {
  let result = String(text ?? '');
  for (const secret of secrets ?? []) {
    if (secret) result = result.split(secret).join('[redacted]');
  }
  return result.trim();
};

export function createGitlabIssueWorkspace({
  spawnImpl = spawn,
  gitBinary = 'git',
  credentialBroker,
  createWorktree = defaultCreateWorktree,
  removeWorktree = defaultRemoveWorktree,
} = {}) {
  if (!credentialBroker) throw new Error('GitLab issue workspace needs the credential broker');

  const run = (args, { cwd, env = {}, gitConfigArgs = [], redactionSecrets = [] } = {}) => new Promise((resolve, reject) => {
    const child = spawnImpl(gitBinary, [...gitConfigArgs, ...args], {
      cwd,
      shell: false,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else {
        const failure = new WorkspaceError('git-failed', redact(stderr || stdout, redactionSecrets));
        failure.exitCode = code;
        failure.stdout = stdout;
        failure.stderr = stderr;
        reject(failure);
      }
    });
  });

  const withLease = async ({ operationId = randomUUID(), credential, operation }) => {
    if (credentialBroker.start instanceof Function) await credentialBroker.start();
    const lease = credentialBroker.issue({
      operationId,
      credential: {
        mode: 'managed',
        transport: 'https',
        username: credential.username,
        password: credential.password,
        allowedEndpoint: credential.allowedEndpoint,
      },
      endpointAliases: credential.endpointAliases ?? [],
    });
    try {
      return await operation({
        env: lease.env,
        gitConfigArgs: lease.gitConfigArgs,
        redactionSecrets: [...(lease.redactionSecrets ?? []), credential.username, credential.password],
      });
    } finally {
      lease.revoke();
    }
  };

  const hasUncommittedChanges = async ({ cwd }) => {
    const result = await run(['status', '--porcelain'], { cwd });
    return result.stdout.trim().length > 0;
  };

  return {
    run,
    async remoteUrl({ cwd, remote }) {
      const result = await run(['remote', 'get-url', remote], { cwd });
      return result.stdout.trim();
    },
    async fetchBranch({ cwd, remote, branch, credential }) {
      return withLease({
        credential,
        operation: (lease) => run(
          ['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
          { cwd, ...lease },
        ),
      });
    },
    async localBranchExists({ cwd, branch }) {
      const result = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd })
        .catch(() => ({ code: 1 }));
      return result.code === 0;
    },
    async createWorktreeFor({ repoPath, branch, worktreeName, startRef, mode = 'new', bootstrapStore }) {
      const input = mode === 'existing'
        ? { mode: 'existing', branchName: branch, existingBranch: branch, worktreeName }
        : { mode: 'new', branchName: branch, worktreeName, startRef };
      try {
        return await createWorktree(repoPath, input, { bootstrapStore });
      } catch (error) {
        throw new WorkspaceError('worktree-failed', error instanceof Error ? error.message : String(error));
      }
    },
    async configureIdentity({ cwd, name, email }) {
      const signing = await run(['config', '--bool', 'commit.gpgsign'], { cwd })
        .catch(() => ({ stdout: 'false' }));
      if (String(signing.stdout).trim() === 'true') {
        throw new WorkspaceError(
          'signing-required',
          'The repository requires signed commits and no triggerer signing key is available',
        );
      }
      // The identity and the empty credential helper live in the worktree's
      // own config, so the main checkout keeps its user and helpers. An empty
      // `credential.helper` resets the accumulated list; the one-shot lease
      // passes its helper on the command line, which still wins.
      const worktreeConfig = await run(['config', '--get', 'extensions.worktreeConfig'], { cwd })
        .then((result) => result.stdout.trim())
        .catch(() => '');
      if (worktreeConfig !== 'true') {
        await run(['config', 'extensions.worktreeConfig', 'true'], { cwd });
      }
      await run(['config', '--worktree', 'user.name', name], { cwd });
      await run(['config', '--worktree', 'user.email', email], { cwd });
      await run(['config', '--worktree', 'credential.helper', ''], { cwd });
    },
    hasUncommittedChanges,
    async commitCountSince({ cwd, baseRef }) {
      const result = await run(['rev-list', '--count', `${baseRef}..HEAD`], { cwd });
      return Number.parseInt(result.stdout.trim(), 10) || 0;
    },
    /** Whether the branch changes the tree relative to `baseRef`. */
    async hasDiffSince({ cwd, baseRef }) {
      const exitCode = await run(['diff', '--quiet', `${baseRef}..HEAD`], { cwd })
        .then(() => 0, (error) => error.exitCode);
      if (exitCode === 0) return false;
      if (exitCode === 1) return true;
      throw new WorkspaceError('git-failed', 'Could not compare the branch against the target');
    },
    async pushBranch({ cwd, remote, branch, credential }) {
      if (!isValidGitRefName(branch)) {
        throw new WorkspaceError('invalid-branch', `Refusing to push invalid branch name: ${branch}`);
      }
      try {
        await withLease({
          credential,
          operation: (lease) => run(
            ['push', '--no-verify', remote, `HEAD:refs/heads/${branch}`],
            { cwd, ...lease },
          ),
        });
      } catch (error) {
        throw new WorkspaceError('push-rejected', error instanceof Error ? error.message : String(error));
      }
      const head = await run(['rev-parse', 'HEAD'], { cwd });
      return { branch, sha: head.stdout.trim() };
    },
    async removeWorktreeSafely({ repoPath, worktreePath }) {
      if (!worktreePath) return { removed: false, dirty: false };
      if (await hasUncommittedChanges({ cwd: worktreePath })) return { removed: false, dirty: true };
      try {
        await removeWorktree(repoPath, { directory: worktreePath });
        return { removed: true, dirty: false };
      } catch (error) {
        return { removed: false, dirty: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
