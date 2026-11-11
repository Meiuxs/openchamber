import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createGitlabIssueWorkspace } from './workspace.js';

const fakeSpawn = (responses) => {
  const calls = [];
  const spawnImpl = (binary, args, options) => {
    calls.push({ binary, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      const match = responses.find((entry) => entry.when(args));
      if (match?.error) {
        child.stderr.emit('data', match.error);
        child.emit('close', match.code ?? 1);
        return;
      }
      child.stdout.emit('data', match?.stdout ?? '');
      child.emit('close', match?.code ?? 0);
    });
    return child;
  };
  return { spawnImpl, calls };
};

const broker = () => ({
  issue: vi.fn(() => ({
    env: { OPENCHAMBER_GIT_CREDENTIAL_NONCE: 'n' },
    gitConfigArgs: ['-c', 'credential.helper=x'],
    redactionSecrets: ['secret'],
    revoke: vi.fn(),
    expiresAt: Date.now() + 1000,
  })),
  revoke: vi.fn(),
});

const credential = {
  username: 'oauth2',
  password: 'secret',
  allowedEndpoint: { protocol: 'https', host: 'gitlab.example.com', path: 'team/repo' },
};

describe('GitLab issue workspace', () => {
  it('pushes without force and returns the head sha', async () => {
    const { spawnImpl, calls } = fakeSpawn([
      { when: (args) => args.includes('push'), stdout: '' },
      { when: (args) => args.includes('rev-parse'), stdout: 'abc123\n' },
    ]);
    const workspace = createGitlabIssueWorkspace({ spawnImpl, credentialBroker: broker() });
    await expect(workspace.pushBranch({
      cwd: 'D:/repo', remote: 'origin', branch: 'openchamber/issue-1-x', credential,
    })).resolves.toEqual({ branch: 'openchamber/issue-1-x', sha: 'abc123' });
    const pushCall = calls.find((call) => call.args.includes('push'));
    expect(pushCall.args).not.toContain('--force');
    expect(pushCall.args).not.toContain('-f');
    expect(pushCall.args.join(' ')).toContain('HEAD:refs/heads/openchamber/issue-1-x');
    expect(pushCall.options.shell).toBe(false);
  });

  it('refuses an invalid branch name before spawning git', async () => {
    const { spawnImpl, calls } = fakeSpawn([]);
    const workspace = createGitlabIssueWorkspace({ spawnImpl, credentialBroker: broker() });
    await expect(workspace.pushBranch({
      cwd: 'D:/repo', remote: 'origin', branch: 'bad branch', credential,
    })).rejects.toMatchObject({ code: 'invalid-branch' });
    expect(calls).toHaveLength(0);
  });

  it('surfaces a non-fast-forward rejection and revokes the lease', async () => {
    const localBroker = broker();
    const { spawnImpl } = fakeSpawn([
      { when: (args) => args.includes('push'), stderr: 'non-fast-forward', code: 1 },
    ]);
    const workspace = createGitlabIssueWorkspace({ spawnImpl, credentialBroker: localBroker });
    await expect(workspace.pushBranch({
      cwd: 'D:/repo', remote: 'origin', branch: 'openchamber/issue-1-x', credential,
    })).rejects.toMatchObject({ code: 'push-rejected' });
    expect(localBroker.issue.mock.results[0].value.revoke).toHaveBeenCalled();
  });

  it('refuses to remove a dirty worktree and reports it', async () => {
    const { spawnImpl } = fakeSpawn([
      { when: (args) => args.includes('status'), stdout: ' M file.js\n' },
    ]);
    const removeWorktree = vi.fn();
    const workspace = createGitlabIssueWorkspace({ spawnImpl, credentialBroker: broker(), removeWorktree });
    await expect(workspace.removeWorktreeSafely({ repoPath: 'D:/repo', worktreePath: 'D:/wt' }))
      .resolves.toEqual({ removed: false, dirty: true });
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('reads whether the branch changes the tree against the base', async () => {
    const changed = createGitlabIssueWorkspace({
      spawnImpl: fakeSpawn([{ when: (args) => args.includes('diff'), error: 'diff --git a/x b/x', code: 1 }]).spawnImpl,
      credentialBroker: broker(),
    });
    await expect(changed.hasDiffSince({ cwd: 'D:/wt', baseRef: 'origin/main' })).resolves.toBe(true);

    const unchanged = createGitlabIssueWorkspace({
      spawnImpl: fakeSpawn([{ when: (args) => args.includes('diff'), stdout: '' }]).spawnImpl,
      credentialBroker: broker(),
    });
    await expect(unchanged.hasDiffSince({ cwd: 'D:/wt', baseRef: 'origin/main' })).resolves.toBe(false);
  });

  it('refuses a signed-commit repository before the agent runs', async () => {
    const { spawnImpl } = fakeSpawn([
      { when: (args) => args.includes('commit.gpgsign'), stdout: 'true\n' },
    ]);
    const workspace = createGitlabIssueWorkspace({ spawnImpl, credentialBroker: broker() });
    await expect(workspace.configureIdentity({
      cwd: 'D:/wt', name: 'Sam', email: 'sam@example.com',
    })).rejects.toMatchObject({ code: 'signing-required' });
  });

  it('writes the triggerer identity into the worktree config only', async () => {
    const { spawnImpl, calls } = fakeSpawn([
      { when: (args) => args.includes('commit.gpgsign'), stdout: 'false\n' },
      { when: (args) => args.includes('--get'), stdout: 'true\n' },
      { when: (args) => args.includes('user.name'), stdout: '' },
      { when: (args) => args.includes('user.email'), stdout: '' },
      { when: (args) => args.includes('credential.helper'), stdout: '' },
    ]);
    const workspace = createGitlabIssueWorkspace({ spawnImpl, credentialBroker: broker() });
    await workspace.configureIdentity({ cwd: 'D:/wt', name: 'Sam', email: 'sam@example.com' });
    expect(calls.some((call) => call.args.join(' ') === 'config --worktree user.name Sam')).toBe(true);
    expect(calls.some((call) => call.args.join(' ') === 'config --worktree user.email sam@example.com')).toBe(true);
    expect(calls.some((call) => call.args.join(' ') === 'config --worktree credential.helper ')).toBe(true);
    expect(calls.some((call) => call.args.includes('--local'))).toBe(false);
  });

  it('enables per-worktree config before writing the worktree identity', async () => {
    const { spawnImpl, calls } = fakeSpawn([
      { when: (args) => args.includes('commit.gpgsign'), stdout: 'false\n' },
      { when: (args) => args.includes('--get'), code: 1 },
      { when: (args) => args.includes('extensions.worktreeConfig'), stdout: '' },
      { when: (args) => args.includes('user.name'), stdout: '' },
      { when: (args) => args.includes('user.email'), stdout: '' },
      { when: (args) => args.includes('credential.helper'), stdout: '' },
    ]);
    const workspace = createGitlabIssueWorkspace({ spawnImpl, credentialBroker: broker() });
    await workspace.configureIdentity({ cwd: 'D:/wt', name: 'Sam', email: 'sam@example.com' });
    const enable = calls.findIndex((call) => call.args.join(' ') === 'config extensions.worktreeConfig true');
    const identity = calls.findIndex((call) => call.args.join(' ') === 'config --worktree user.name Sam');
    expect(enable).toBeGreaterThanOrEqual(0);
    expect(identity).toBeGreaterThan(enable);
  });

  it('redacts the credential username and password from git errors', async () => {
    const { spawnImpl } = fakeSpawn([
      { when: (args) => args.includes('push'), error: 'fatal: oauth2 rejected secret', code: 1 },
    ]);
    const workspace = createGitlabIssueWorkspace({ spawnImpl, credentialBroker: broker() });
    const error = await workspace.pushBranch({
      cwd: 'D:/repo', remote: 'origin', branch: 'openchamber/issue-1-x', credential,
    }).catch((failure) => failure);
    expect(error.message).not.toContain('secret');
    expect(error.message).not.toContain('oauth2');
    expect(error.message).toContain('[redacted]');
  });
});
