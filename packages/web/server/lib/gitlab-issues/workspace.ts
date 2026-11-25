import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWorktree as defaultCreateWorktree, removeWorktree as defaultRemoveWorktree } from '../git/service.js';
import type { BootstrapStore, WorktreeCreateInput, WorktreeServerOptions, WorktreeRemovalInput } from '../git/service-contracts.js';
import type { createGitCredentialBroker } from '../git/credential-broker.js';
import { isValidGitRefName } from './gitlab.js';
import type { ChangeSummary, ChangeSummaryFile } from './ledger.js';

type CredentialEndpoint = { protocol: string; host: string; port: number; path: string };

export interface IssueCredential {
  actor: { provider: string; instance: string; accountId: string; login: string | null };
  username: string;
  password: string;
  allowedEndpoint: CredentialEndpoint;
  endpointAliases?: readonly CredentialEndpoint[] | undefined;
}

class WorkspaceError extends Error {
  code: string;
  exitCode?: number | null | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

const redact = (text: string | null | undefined, secrets: readonly (string | null | undefined)[] | null | undefined) => {
  let result = String(text ?? '');
  for (const secret of secrets ?? []) {
    if (secret) result = result.split(secret).join('[redacted]');
  }
  return result.trim();
};

type WorktreeCreator = (
  repoPath: string,
  input: WorktreeCreateInput,
  options: WorktreeServerOptions & { reuseNodeModules?: boolean | undefined },
) => Promise<{ path: string }>;

type WorktreeRemover = (repoPath: string, input: WorktreeRemovalInput) => Promise<boolean>;

export interface WorkspaceOptions {
  spawnImpl?: typeof spawn | undefined;
  gitBinary?: string | undefined;
  credentialBroker: ReturnType<typeof createGitCredentialBroker>;
  createWorktree?: WorktreeCreator | undefined;
  removeWorktree?: WorktreeRemover | undefined;
}

interface RunOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  gitConfigArgs?: string[] | undefined;
  redactionSecrets?: string[] | undefined;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface LeaseEnv {
  env: NodeJS.ProcessEnv;
  gitConfigArgs: string[];
  redactionSecrets: string[];
}

interface WorktreeRemovalResult {
  removed: boolean;
  dirty: boolean;
  error?: string | undefined;
}

export function createGitlabIssueWorkspace({
  spawnImpl = spawn,
  gitBinary = 'git',
  credentialBroker,
  createWorktree = defaultCreateWorktree,
  removeWorktree = defaultRemoveWorktree,
}: WorkspaceOptions) {
  if (!credentialBroker) throw new Error('GitLab issue workspace needs the credential broker');

  const run = (args: string[], { cwd, env = {}, gitConfigArgs = [], redactionSecrets = [] }: RunOptions = {}): Promise<CommandResult> => new Promise((resolve, reject) => {
    const child = spawnImpl(gitBinary, [...gitConfigArgs, ...args], {
      cwd,
      shell: false,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
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

  const withLease = async <Result>({ operationId = randomUUID(), credential, operation }: {
    operationId?: string | undefined;
    credential: IssueCredential;
    operation: (lease: LeaseEnv) => Promise<Result>;
  }): Promise<Result> => {
    if (credentialBroker.start instanceof Function) await credentialBroker.start();
    const lease = credentialBroker.issue({
      operationId,
      credential: {
        mode: 'managed',
        transport: 'https',
        username: credential.username,
        password: credential.password,
        actor: credential.actor,
        allowedEndpoint: credential.allowedEndpoint,
      },
      endpointAliases: credential.endpointAliases ?? [],
    });
    try {
      return await operation({
        env: lease.env,
        gitConfigArgs: [...lease.gitConfigArgs],
        redactionSecrets: [...(lease.redactionSecrets ?? []), credential.username, credential.password],
      });
    } finally {
      lease.revoke();
    }
  };

  const hasUncommittedChanges = async ({ cwd }: { cwd: string }): Promise<boolean> => {
    const result = await run(['status', '--porcelain'], { cwd });
    return result.stdout.trim().length > 0;
  };

  const parseNumstat = (text: string): Map<string, { added: number | null; removed: number | null }> => {
    const counts = new Map<string, { added: number | null; removed: number | null }>();
    for (const line of text.split('\n')) {
      const [added, removed, ...rest] = line.split('\t');
      const file = rest.join('\t');
      if (!file) continue;
      counts.set(file, {
        added: added === '-' ? null : Number.parseInt(added ?? '', 10) || 0,
        removed: removed === '-' ? null : Number.parseInt(removed ?? '', 10) || 0,
      });
    }
    return counts;
  };

  const parseNameStatus = (text: string): ChangeSummaryFile[] => {
    const files: ChangeSummaryFile[] = [];
    for (const line of text.split('\n')) {
      const [code, first, second] = line.split('\t');
      if (!code || !first) continue;
      const status = code.startsWith('A') ? 'added'
        : code.startsWith('D') ? 'deleted'
          : code.startsWith('R') ? 'renamed' : 'modified';
      files.push({ path: (second ?? first).trim(), status, added: null, removed: null });
    }
    return files;
  };

  const describeChanges = async ({ cwd, baseRef }: { cwd: string; baseRef: string }): Promise<ChangeSummary | null> => {
    try {
      const [numstat, nameStatus, log] = await Promise.all([
        run(['diff', '--numstat', `${baseRef}...HEAD`], { cwd }),
        run(['diff', '--name-status', `${baseRef}...HEAD`], { cwd }),
        run(['log', '--format=%h%x09%s', `${baseRef}..HEAD`], { cwd }),
      ]);
      const counts = parseNumstat(numstat.stdout);
      const files = parseNameStatus(nameStatus.stdout)
        .map((file) => ({ ...file, ...(counts.get(file.path) ?? {}) }))
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
      const commits = log.stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const [sha, ...subject] = line.split('\t');
        return { sha: sha ?? '', subject: subject.join('\t') };
      });
      return { baseRef, files, commits, capturedAt: new Date().toISOString() };
    } catch {
      return null;
    }
  };

  return {
    run,
    describeChanges,
    async remoteUrl({ cwd, remote }: { cwd: string; remote: string }) {
      const result = await run(['remote', 'get-url', remote], { cwd });
      return result.stdout.trim();
    },
    async fetchBranch({ cwd, remote, branch, credential, sshCommand }: {
      cwd: string; remote: string; branch: string;
      credential?: IssueCredential | undefined; sshCommand?: string | null | undefined;
    }) {
      const sshArgs = sshCommand ? ['-c', `core.sshCommand=${sshCommand}`] : [];
      if (!credential) return run(['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { cwd, gitConfigArgs: sshArgs });
      return withLease({
        credential,
        operation: (lease) => run(
          ['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
          { cwd, ...lease },
        ),
      });
    },
    async localBranchExists({ cwd, branch }: { cwd: string; branch: string }) {
      const result = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd })
        .catch(() => ({ code: 1 }));
      return result.code === 0;
    },
    async createWorktreeFor({
      repoPath, branch, worktreeName, startRef, mode = 'new', bootstrapStore, startCommand = '',
    }: {
      repoPath: string;
      branch: string;
      worktreeName: string;
      startRef?: string | undefined;
      mode?: string | undefined;
      bootstrapStore?: BootstrapStore | null | undefined;
      startCommand?: string | null | undefined;
    }) {
      const setup = String(startCommand ?? '').trim();
      const input: WorktreeCreateInput = mode === 'existing'
        ? { mode: 'existing', branchName: branch, existingBranch: branch, worktreeName }
        : { mode: 'new', branchName: branch, worktreeName };
      if (mode !== 'existing') input.startRef = startRef ?? null;
      if (setup) input.startCommand = setup;
      try {
        return await createWorktree(repoPath, input, { bootstrapStore: bootstrapStore ?? undefined, reuseNodeModules: true });
      } catch (error) {
        throw new WorkspaceError('worktree-failed', error instanceof Error ? error.message : String(error));
      }
    },
    async configureIdentity({ cwd, name, email }: { cwd: string; name: string; email: string }) {
      const signing = await run(['config', '--bool', 'commit.gpgsign'], { cwd })
        .catch(() => ({ stdout: 'false' }));
      if (String(signing.stdout).trim() === 'true') {
        throw new WorkspaceError(
          'signing-required',
          'The repository requires signed commits and no triggerer signing key is available',
        );
      }
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
    async commitCountSince({ cwd, baseRef }: { cwd: string; baseRef: string }) {
      const result = await run(['rev-list', '--count', `${baseRef}..HEAD`], { cwd });
      return Number.parseInt(result.stdout.trim(), 10) || 0;
    },
    async hasDiffSince({ cwd, baseRef }: { cwd: string; baseRef: string }) {
      const exitCode = await run(['diff', '--quiet', `${baseRef}..HEAD`], { cwd })
        .then(() => 0, (error) => (error instanceof WorkspaceError ? error.exitCode : null));
      if (exitCode === 0) return false;
      if (exitCode === 1) return true;
      throw new WorkspaceError('git-failed', 'Could not compare the branch against the target');
    },
    async runVerifyCommand({ cwd, command, timeoutMs }: { cwd: string; command: string; timeoutMs: number }) {
      const trimmed = String(command ?? '').trim();
      if (!trimmed) return { code: 0, stdout: '', stderr: '' };
      return await new Promise<CommandResult>((resolve, reject) => {
        const child = spawnImpl(trimmed, { cwd, shell: true, windowsHide: true, env: { ...process.env } });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const cap = 200_000;
        child.stdout?.on('data', (chunk: Buffer | string) => {
          if (stdout.length < cap) stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
          if (stderr.length < cap) stderr += chunk.toString();
        });
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(new WorkspaceError('verify-timeout', `The verify command did not finish within ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new WorkspaceError('verify-failed', error instanceof Error ? error.message : String(error)));
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      });
    },
    async pushBranch({ cwd, remote, branch, credential, sshCommand }: {
      cwd: string; remote: string; branch: string;
      credential?: IssueCredential | undefined; sshCommand?: string | null | undefined;
    }) {
      if (!isValidGitRefName(branch)) {
        throw new WorkspaceError('invalid-branch', `Refusing to push invalid branch name: ${branch}`);
      }
      try {
        if (credential) {
          await withLease({
            credential,
            operation: (lease) => run(
              ['push', '--no-verify', remote, `HEAD:refs/heads/${branch}`],
              { cwd, ...lease },
            ),
          });
        } else {
          const sshArgs = sshCommand ? ['-c', `core.sshCommand=${sshCommand}`] : [];
          await run(['push', '--no-verify', remote, `HEAD:refs/heads/${branch}`], { cwd, gitConfigArgs: sshArgs });
        }
      } catch (error) {
        throw new WorkspaceError('push-rejected', error instanceof Error ? error.message : String(error));
      }
      const head = await run(['rev-parse', 'HEAD'], { cwd });
      return { branch, sha: head.stdout.trim() };
    },
    async removeWorktreeSafely({ repoPath, worktreePath }: { repoPath: string; worktreePath: string | null | undefined }): Promise<WorktreeRemovalResult> {
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
