import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitlabIssueDispatcher } from './dispatcher.js';
import { createGitlabIssueLedger, ledgerKey } from './ledger.js';

const INSTANCE = 'https://gitlab.example.com';
const NOW = Date.parse('2026-11-12T10:00:00.000Z');
const dirs = [];

const issue = (overrides = {}) => ({
  iid: 17,
  title: 'Fix login',
  description: '类型: bug\n目标分支: ``',
  state: 'opened',
  labels: ['ai-ready'],
  ...overrides,
});

const runEntry = (overrides = {}) => ({
  origin: INSTANCE,
  projectId: 42,
  iid: 17,
  kind: 'bug',
  phase: 'claimed',
  targetBranch: 'main',
  branch: 'openchamber/issue-17-fix-login',
  actorUserId: 7,
  actorAccountId: 'actor-acc',
  sessionId: null,
  worktreePath: null,
  mrIid: null,
  attempts: 1,
  leaseUntil: null,
  since: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  lastError: null,
  blockedReason: null,
  approvalNoteId: null,
  planNoteId: null,
  evidenceNoteId: null,
  evidence: null,
  ...overrides,
});

const message = (text, completed = NOW + 1000) => ({
  type: 'assistant',
  content: [{ type: 'text', text }],
  time: { completed },
});

const evidenceJson = '```json\n{"rootCause":"timeout missing","changes":"added timeout","verification":[{"command":"bun test","result":"pass"}],"risks":"none"}\n```';
const planJson = '```json\n{"files":["src/login.js"],"dataFlow":"add timeout","verification":"bun test","risks":"none","outOfScope":"no ui"}\n```';

async function harness({
  issueOverrides = {}, accounts: accountOverrides = {}, members, primaryRemote = 'origin',
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitlab-dispatch-'));
  dirs.push(dir);
  const ledger = createGitlabIssueLedger({ filePath: path.join(dir, 'runs.json'), now: () => NOW });

  const accounts = {
    'bot-acc': {
      credentialId: 'bot-acc', credentialRevision: 1, status: 'valid', source: 'pat', token: 'b',
      providerUserId: `${INSTANCE}#9`, user: { id: 9, login: 'bot', name: 'Bot' }, role: 'bot',
    },
    'actor-acc': {
      credentialId: 'actor-acc', credentialRevision: 1, status: 'valid', source: 'pat', token: 'a',
      providerUserId: `${INSTANCE}#7`,
      user: { id: 7, login: 'sam', name: 'Sam', email: 'sam@example.com' }, role: 'actor',
    },
    'taker-acc': {
      credentialId: 'taker-acc', credentialRevision: 1, status: 'valid', source: 'pat', token: 't',
      providerUserId: `${INSTANCE}#8`,
      user: { id: 8, login: 'lee', name: 'Lee', email: 'lee@example.com' }, role: 'actor',
    },
    ...accountOverrides,
  };

  const state = {
    issue: issue(issueOverrides),
    notes: [],
    users: { bot: { id: 9, username: 'bot', email: 'bot@example.com' }, actor: { id: 7, username: 'sam', name: 'Sam', email: 'sam@example.com' } },
    members: members ?? [{ id: 7, access_level: 30 }],
    branches: [{ name: 'main' }],
    mrs: [],
    sessionId: null,
    sessionGone: false,
    idle: true,
    unauthorized: false,
    messages: [],
    commits: 1,
    hasDiff: true,
    worktreeDirty: false,
    calls: { labels: [], prompts: [], aborts: [], pushes: [], sessionCreates: 0, createMr: null },
  };

  const issueView = () => ({
    ...state.issue,
    labels: state.issue.labels.map((name) => ({ name })),
  });

  const apiFor = ({ account }) => {
    const role = account?.role === 'actor' ? 'actor' : 'bot';
    return {
      currentUser: async () => state.users[role],
      getProject: async () => {
        if (state.unauthorized) {
          const error = new Error('unauthorized');
          error.status = 401;
          throw error;
        }
        return { id: 42, default_branch: 'main' };
      },
      listOpenIssues: async () => [issueView()],
      getIssue: async () => issueView(),
      listNotes: async () => state.notes,
      postNote: async (_projectId, _iid, body) => {
        const id = state.notes.length + 100;
        state.notes.push({ id, body, created_at: new Date(NOW).toISOString(), author: { id: 9 } });
        return id;
      },
      listLabelEvents: async () => [{
        label: { name: 'ai-ready' }, action: 'add', user: { id: 7 }, created_at: '2026-11-12T09:00:00Z',
      }],
      listMembers: async () => state.members,
      accessLevelOf: async (_projectId, userId) => state.members.find((entry) => entry.id === userId)?.access_level ?? 0,
      latestTriggerer: async () => ({ userId: 7 }),
      latestCommand: async (_projectId, _iid, { sinceIso, botUserId, commands }) => {
        const since = Date.parse(sinceIso ?? 0) || 0;
        const matches = state.notes.filter((note) => note.author?.id !== botUserId
          && (Date.parse(note.created_at) || 0) >= since
          && commands.includes(String(note.body).trim().split('\n')[0].trim()));
        const newest = matches.sort((left, right) => right.id - left.id)[0];
        return newest
          ? { command: String(newest.body).trim().split('\n')[0].trim(), userId: newest.author.id, noteId: newest.id }
          : null;
      },
      addLabels: async (_projectId, _iid, labels) => {
        state.calls.labels.push(['add', labels]);
        for (const label of labels) if (!state.issue.labels.includes(label)) state.issue.labels.push(label);
      },
      removeLabels: async (_projectId, _iid, labels) => {
        state.calls.labels.push(['remove', labels]);
        state.issue.labels = state.issue.labels.filter((label) => !labels.includes(label));
      },
      closeIssue: async () => { state.issue.state = 'closed'; },
      listBranches: async () => state.branches,
      showBranch: async () => ({ name: 'main' }),
      listOpenMergeRequests: async () => state.mrs.filter((mr) => mr.state === 'opened'),
      createMergeRequest: async (...args) => {
        state.calls.createMr = args;
        const mr = { iid: 5, state: 'opened', web_url: `${INSTANCE}/mr/5` };
        state.mrs.push(mr);
        return mr;
      },
      getMergeRequest: async () => state.mrs[0],
    };
  };

  const workspace = {
    fetchBranch: vi.fn(async () => ({})),
    localBranchExists: vi.fn(async () => false),
    createWorktreeFor: vi.fn(async () => ({ path: 'D:/wt/17' })),
    configureIdentity: vi.fn(async () => ({})),
    commitCountSince: vi.fn(async () => state.commits),
    hasDiffSince: vi.fn(async () => state.hasDiff),
    pushBranch: vi.fn(async ({ branch }) => {
      state.calls.pushes.push(branch);
      return { branch, sha: 'abc123' };
    }),
    removeWorktreeSafely: vi.fn(async () => ({
      removed: !state.worktreeDirty,
      dirty: state.worktreeDirty,
    })),
  };

  const client = {
    session: {
      active: async () => ({
        data: state.idle ? {} : { [state.sessionId]: { type: 'running' } },
      }),
      create: async () => {
        state.calls.sessionCreates += 1;
        state.sessionId = `ses_${state.calls.sessionCreates}`;
        return { data: { id: state.sessionId } };
      },
      prompt: async ({ text }) => { state.calls.prompts.push(text); },
      abort: async ({ sessionID }) => { state.calls.aborts.push(sessionID); },
      get: async ({ sessionID }) => {
        if (state.sessionGone) {
          const error = new Error('not found');
          error.status = 404;
          throw error;
        }
        return { id: sessionID };
      },
    },
    message: {
      list: async () => ({ data: state.idle ? state.messages : [] }),
    },
  };

  const authStore = {
    readAccount: async (origin, accountId) => (origin === INSTANCE ? accounts[accountId] ?? null : null),
    listAccounts: async (origin) => (origin === INSTANCE ? Object.values(accounts) : []),
    markAccountInvalid: vi.fn(async () => true),
  };

  const dispatcher = createGitlabIssueDispatcher({
    listProjects: async () => [{
      id: 'proj-1',
      path: 'D:/repo',
      autoDispatchGitlabIssues: true,
      gitlabIssueBotAccountId: 'bot-acc',
    }],
    authStore,
    bindingService: {
      get: async () => ({
        binding: {
          repositoryId: 'repo-1',
          revision: 1,
          state: 'bound',
          configRevision: 'cfg-1',
          providers: [{
            provider: 'gitlab',
            instance: INSTANCE,
            accountId: 'bot-acc',
            primaryRemote,
            readiness: 'ready',
            endpoint: { displayUrl: `${INSTANCE}/team/repo.git`, fingerprint: 'fp-1' },
          }],
          remotes: [],
        },
        repository: {
          remotes: [{ name: primaryRemote, fetch: { displayUrl: `${INSTANCE}/team/repo.git` } }],
        },
      }),
    },
    apiFactory: apiFor,
    workspace,
    clientFactory: () => client,
    credentialResolver: {
      resolve: async () => ({
        username: 'oauth2', password: 'secret',
        allowedEndpoint: { protocol: 'https', host: 'gitlab.example.com', path: 'team/repo' },
      }),
    },
    createHttpsCredentialReference: () => 'ocgit:v2:https:gitlab:ref',
    ledger,
    ledgerPath: path.join(dir, 'runs.json'),
    logger: { info() {}, warn() {} },
    now: () => NOW,
    issueScanEveryTicks: 1,
    tickIntervalMs: 3_600_000,
    startupDelayMs: 3_600_000,
  });

  return { dispatcher, ledger, state, workspace, authStore };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('GitLab issue dispatcher claim', () => {
  it('claims an eligible issue and mirrors the label', async () => {
    const { dispatcher, ledger, state } = await harness();
    await dispatcher.tick();
    const runs = await ledger.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ phase: 'claimed', kind: 'bug', actorAccountId: 'actor-acc' });
    expect(state.calls.labels).toContainEqual(['add', ['ai-working']]);
    expect(state.notes.some((note) => note.body.includes('已认领'))).toBe(true);
  });

  it('blocks an issue with no template and writes the blocked ledger entry', async () => {
    const { dispatcher, ledger, state } = await harness({
      issueOverrides: { description: 'no template' },
    });
    await dispatcher.tick();
    expect(state.calls.labels).toContainEqual(['add', ['ai-blocked']]);
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'invalid-template',
    });
  });

  it('respects the global active run cap', async () => {
    const { dispatcher, ledger } = await harness();
    for (let iid = 1; iid <= 3; iid += 1) {
      await ledger.put(runEntry({ iid, phase: 'waiting-approval', attempts: 1 }));
    }
    await dispatcher.tick();
    expect(await ledger.list()).toHaveLength(3);
  });

  it('marks the bot account invalid when the instance refuses it', async () => {
    const { dispatcher, authStore, state } = await harness();
    state.unauthorized = true;
    await dispatcher.tick();
    expect(authStore.markAccountInvalid).toHaveBeenCalledWith(INSTANCE, 'bot-acc');
  });

  it('blocks a triggerer below Developer access', async () => {
    const { dispatcher, ledger, state } = await harness({ members: [{ id: 7, access_level: 20 }] });
    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'missing-credential',
    });
    expect(state.calls.labels).toContainEqual(['add', ['ai-blocked']]);
  });
});

describe('GitLab issue dispatcher bug path', () => {
  it('runs worktree, session, evidence, push, and merge request', async () => {
    const { dispatcher, ledger, state, workspace } = await harness();
    await dispatcher.tick();

    await dispatcher.tick();
    let run = (await ledger.list())[0];
    expect(run.phase).toBe('preparing');
    expect(workspace.fetchBranch).toHaveBeenCalled();
    expect(workspace.createWorktreeFor).toHaveBeenCalledWith(expect.objectContaining({
      branch: 'openchamber/issue-17-fix-login',
      startRef: 'origin/main',
      worktreeName: 'gitlab-issue-17',
    }));
    expect(workspace.configureIdentity).toHaveBeenCalledWith({
      cwd: 'D:/wt/17', name: 'Sam', email: 'sam@example.com',
    });

    await dispatcher.tick();
    run = (await ledger.list())[0];
    expect(run.phase).toBe('implementing');
    expect(state.calls.sessionCreates).toBe(1);
    expect(state.calls.prompts[0]).toContain('You are implementing');

    state.messages = [message(evidenceJson)];
    await dispatcher.tick();
    run = (await ledger.list())[0];
    expect(run.phase).toBe('verifying');
    expect(run.evidenceNoteId).toEqual(expect.any(Number));
    expect(state.notes.some((note) => note.body.includes('### 实现结果'))).toBe(true);

    await dispatcher.tick();
    run = (await ledger.list())[0];
    expect(run.phase).toBe('mr-open');
    expect(run.mrIid).toBe(5);
    expect(state.calls.pushes).toEqual(['openchamber/issue-17-fix-login']);
    expect(state.calls.createMr).toEqual([
      42,
      'openchamber/issue-17-fix-login',
      'main',
      'Fix login (#17)',
      expect.stringContaining('Closes #17'),
    ]);
  });
});

describe('GitLab issue dispatcher feature path', () => {
  it('posts a plan, waits for approval, and then prepares implementation', async () => {
    const { dispatcher, ledger, state } = await harness({
      issueOverrides: { description: '类型: feature\n目标分支: ``' },
    });
    await dispatcher.tick();
    await dispatcher.tick();
    expect((await ledger.list())[0].phase).toBe('planning');

    await dispatcher.tick();
    expect(state.calls.sessionCreates).toBe(1);
    state.messages = [message(planJson)];
    await dispatcher.tick();

    let run = (await ledger.list())[0];
    expect(run.phase).toBe('waiting-approval');
    expect(run.planNoteId).toEqual(expect.any(Number));
    expect(state.calls.labels).toContainEqual(['add', ['ai-plan-review']]);
    expect(state.notes.some((note) => note.body.includes('### 方案'))).toBe(true);

    state.notes.push({
      id: 200, body: '/ai-approve', created_at: new Date(NOW + 2000).toISOString(), author: { id: 7 },
    });
    await dispatcher.tick();
    run = (await ledger.list())[0];
    expect(run.phase).toBe('preparing');
    expect(state.calls.labels).toContainEqual(['add', ['ai-working']]);
  });

  it('blocks with rejected after /ai-reject', async () => {
    const { dispatcher, ledger, state } = await harness({
      issueOverrides: { description: '类型: feature\n目标分支: ``' },
    });
    await dispatcher.tick();
    await dispatcher.tick();
    await dispatcher.tick();
    state.messages = [message(planJson)];
    await dispatcher.tick();

    state.notes.push({
      id: 201, body: '/ai-reject', created_at: new Date(NOW + 2000).toISOString(), author: { id: 7 },
    });
    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'rejected',
    });
  });
});

describe('GitLab issue dispatcher commands', () => {
  it('rebinds the actor on /ai-take', async () => {
    const { dispatcher, ledger, state } = await harness({
      members: [{ id: 7, access_level: 30 }, { id: 8, access_level: 30 }],
    });
    await ledger.put(runEntry({
      phase: 'blocked', blockedReason: 'missing-credential', attempts: 1,
      labels: ['ai-ready', 'ai-blocked'],
    }));
    state.issue.labels = ['ai-ready', 'ai-blocked'];
    state.notes.push({
      id: 300, body: '/ai-take', created_at: new Date(NOW + 1000).toISOString(), author: { id: 8 },
    });

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'claimed', actorUserId: 8, actorAccountId: 'taker-acc',
    });
  });

  it('resets a blocked run after the human removes ai-blocked', async () => {
    const { dispatcher, ledger, state } = await harness();
    await ledger.put(runEntry({
      phase: 'blocked', blockedReason: 'verification-failed', attempts: 2,
    }));
    state.issue.labels = ['ai-ready'];

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'claimed', attempts: 0, blockedReason: null,
    });
  });
});

describe('GitLab issue dispatcher cleanup and recovery', () => {
  it('keeps a dirty worktree when the merge request is merged', async () => {
    const { dispatcher, ledger, state, workspace } = await harness();
    state.worktreeDirty = true;
    state.mrs = [{ iid: 5, state: 'merged', web_url: `${INSTANCE}/mr/5` }];
    state.issue.labels = ['ai-ready', 'ai-working', 'ai-review'];
    await ledger.put(runEntry({
      phase: 'mr-open', mrIid: 5, sessionId: 'ses_1', worktreePath: 'D:/wt/17', attempts: 2,
    }));

    await dispatcher.tick();
    const run = (await ledger.list())[0];
    expect(run).toMatchObject({ phase: 'done', worktreePath: 'D:/wt/17' });
    expect(state.calls.labels).toContainEqual(['add', ['ai-done']]);
    expect(state.notes.some((note) => note.body.includes('已保留'))).toBe(true);
    expect(workspace.removeWorktreeSafely).toHaveBeenCalled();
  });

  it('cancels a run when ai-working is removed', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready'];
    await ledger.put(runEntry({
      phase: 'implementing', sessionId: 'ses_9', worktreePath: 'D:/wt/17', attempts: 2,
    }));

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'cancelled',
    });
    expect(state.calls.aborts).toEqual(['ses_9']);
  });

  it('cancels a run when the issue is closed mid-flight', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    state.issue.state = 'closed';
    await ledger.put(runEntry({
      phase: 'implementing', sessionId: 'ses_9', worktreePath: 'D:/wt/17', attempts: 2,
    }));

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'cancelled',
    });
    expect(state.calls.aborts).toEqual(['ses_9']);
  });

  it('blocks an implementing run past its timeout', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    await ledger.put(runEntry({
      phase: 'implementing', sessionId: 'ses_9', worktreePath: 'D:/wt/17', attempts: 2,
      since: new Date(NOW - 31 * 60_000).toISOString(),
    }));

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'timeout',
    });
    expect(state.calls.aborts).toEqual(['ses_9']);
    expect(state.notes.some((note) => note.body.includes('timeout'))).toBe(true);
  });

  it('adopts an existing open merge request instead of creating a second one', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    state.mrs = [{ iid: 5, state: 'opened', web_url: `${INSTANCE}/mr/5` }];
    await ledger.put(runEntry({
      phase: 'verifying', worktreePath: 'D:/wt/17', attempts: 1, evidenceNoteId: 1,
      evidence: {
        rootCause: 'x', changes: 'y',
        verification: [{ command: 'bun test', result: 'pass' }], risks: 'z',
      },
    }));

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({ phase: 'mr-open', mrIid: 5 });
    expect(state.calls.createMr).toBeNull();
    expect(state.calls.pushes).toEqual(['openchamber/issue-17-fix-login']);
  });

  it('recovers a lost session on the committed worktree without duplicating it', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    state.sessionGone = true;
    state.commits = 1;
    await ledger.put(runEntry({
      phase: 'implementing', sessionId: 'ses_lost', worktreePath: 'D:/wt/17', attempts: 1,
      leaseUntil: new Date(NOW - 60_000).toISOString(),
    }));

    await dispatcher.tick();
    const run = (await ledger.list())[0];
    expect(run.phase).toBe('implementing');
    expect(state.calls.sessionCreates).toBe(1);
    expect(run.sessionId).toBe('ses_1');
  });

  it('finishes as done when a merged-run issue is already closed', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working', 'ai-review'];
    state.issue.state = 'closed';
    state.mrs = [{ iid: 5, state: 'opened', web_url: `${INSTANCE}/mr/5` }];
    await ledger.put(runEntry({
      phase: 'mr-open', mrIid: 5, worktreePath: 'D:/wt/17', attempts: 2,
    }));

    await dispatcher.tick();
    const run = (await ledger.list())[0];
    expect(run).toMatchObject({ phase: 'done', worktreePath: null });
    expect(state.calls.labels).toContainEqual(['add', ['ai-done']]);
  });

  it('uses the bound primary remote for worktree refs', async () => {
    const { dispatcher, ledger, state, workspace } = await harness({ primaryRemote: 'upstream' });
    await dispatcher.tick();
    await dispatcher.tick();
    expect(workspace.createWorktreeFor).toHaveBeenCalledWith(expect.objectContaining({
      startRef: 'upstream/main',
    }));

    state.messages = [message(evidenceJson)];
    await dispatcher.tick();
    await dispatcher.tick();
    await dispatcher.tick();
    expect(workspace.hasDiffSince).toHaveBeenCalledWith({
      cwd: 'D:/wt/17',
      baseRef: 'upstream/main',
    });
    expect((await ledger.list())[0].phase).toBe('mr-open');
  });

  it('blocks a branch whose committed tree equals the target', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    state.hasDiff = false;
    await ledger.put(runEntry({
      phase: 'verifying', worktreePath: 'D:/wt/17', attempts: 1, evidenceNoteId: 1,
      evidence: {
        rootCause: 'x', changes: 'y',
        verification: [{ command: 'bun test', result: 'pass' }], risks: 'z',
      },
    }));

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'verification-failed',
    });
    expect(state.calls.pushes).toEqual([]);
  });

  it('blocks verifying when the branch cannot be compared with the target', async () => {
    const { dispatcher, ledger, state, workspace } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    workspace.hasDiffSince.mockRejectedValue(Object.assign(
      new Error('Could not compare the branch against the target'),
      { name: 'WorkspaceError', code: 'git-failed' },
    ));
    await ledger.put(runEntry({
      phase: 'verifying', worktreePath: 'D:/wt/17', attempts: 1, evidenceNoteId: 1,
      evidence: {
        rootCause: 'x', changes: 'y',
        verification: [{ command: 'bun test', result: 'pass' }], risks: 'z',
      },
    }));

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'verification-failed',
    });
  });

  it('recovers a dead session even while its old lease is still in the future', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    state.sessionGone = true;
    state.commits = 1;
    await ledger.put(runEntry({
      phase: 'implementing', sessionId: 'ses_lost', worktreePath: 'D:/wt/17', attempts: 1,
      leaseUntil: new Date(NOW + 60_000).toISOString(),
    }));

    await dispatcher.tick();
    const run = (await ledger.list())[0];
    expect(run.phase).toBe('implementing');
    expect(state.calls.sessionCreates).toBe(1);
  });

  it('blocks a branch that does not start with the configured prefix', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    await ledger.put(runEntry({
      phase: 'verifying', branch: 'other/issue-17-fix-login', worktreePath: 'D:/wt/17',
      attempts: 1, evidenceNoteId: 1,
      evidence: {
        rootCause: 'x', changes: 'y',
        verification: [{ command: 'bun test', result: 'pass' }], risks: 'z',
      },
    }));

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'verification-failed',
    });
    expect(state.calls.pushes).toEqual([]);
  });

  it('blocks with mr-closed when the merge request closes without merging', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working', 'ai-review'];
    state.mrs = [{ iid: 5, state: 'closed', web_url: `${INSTANCE}/mr/5` }];
    await ledger.put(runEntry({
      phase: 'mr-open', mrIid: 5, worktreePath: 'D:/wt/17', attempts: 1,
    }));

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'mr-closed',
    });
    expect(state.calls.labels).toContainEqual(['add', ['ai-blocked']]);
  });

  it('rebinds the feature actor to the approver', async () => {
    const { dispatcher, ledger, state } = await harness({
      issueOverrides: { description: '类型: feature\n目标分支: ``' },
      members: [{ id: 7, access_level: 30 }, { id: 8, access_level: 30 }],
    });
    await dispatcher.tick();
    await dispatcher.tick();
    await dispatcher.tick();
    state.messages = [message(planJson)];
    await dispatcher.tick();
    expect((await ledger.list())[0].phase).toBe('waiting-approval');

    state.notes.push({
      id: 400, body: '/ai-approve', created_at: new Date(NOW + 2000).toISOString(), author: { id: 8 },
    });
    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'preparing', actorUserId: 8, actorAccountId: 'taker-acc',
    });
  });
});
