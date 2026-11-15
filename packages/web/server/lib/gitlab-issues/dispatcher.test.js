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
  feedbackRounds: 0,
  lastFeedbackActor: null,
  feedbackItems: null,
  noteWatermarks: null,
  ...overrides,
});

const message = (text, completed = NOW + 1000) => ({
  type: 'assistant',
  content: [{ type: 'text', text }],
  time: { completed },
});

const evidenceJson = '```json\n{"rootCause":"timeout missing","changes":"added timeout","verification":[{"command":"bun test","result":"pass"}],"risks":"none"}\n```';
const triageValidJson = '```json\n{"verdict":"valid","summary":"the timeout is unbounded"}\n```';
const triageNotAnIssueJson = '```json\n{"verdict":"not-an-issue","summary":"by design","evidence":"src/login.js:40 returns early"}\n```';
const triageInsufficientJson = '```json\n{"verdict":"insufficient-info","summary":"nothing to check","missing":"reproduction steps"}\n```';
const planJson = '```json\n{"files":["src/login.js"],"dataFlow":"add timeout","verification":"bun test","risks":"none","outOfScope":"no ui"}\n```';
const reviewApproveJson = '```json\n{"verdict":"approve","summary":"fix matches the report","findings":[]}\n```';
const reviewChangesJson = '```json\n{"verdict":"request-changes","summary":"timeout is not bounded","findings":[{"file":"src/login.js","line":12,"severity":"blocker","note":"no upper bound"}]}\n```';
const evidence = {
  rootCause: 'x', changes: 'y', verification: [{ command: 'bun test', result: 'pass' }], risks: 'z',
};

async function harness({
  issueOverrides = {}, accounts: accountOverrides = {}, members, primaryRemote = 'origin',
  resolveWorktreeSetup, worktreeSetupState, projectOverrides = {},
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
    mrNotes: [],
    users: { bot: { id: 9, username: 'bot', email: 'bot@example.com' }, actor: { id: 7, username: 'sam', name: 'Sam', email: 'sam@example.com' } },
    members: members ?? [{ id: 7, access_level: 30 }],
    branches: [{ name: 'main' }],
    mrs: [],
    sessionId: null,
    sessionGone: false,
    idle: true,
    unauthorized: false,
    labelEventsFail: false,
    closeFails: false,
    messages: [],
    commits: 1,
    hasDiff: true,
    worktreeDirty: false,
    calls: {
      labels: [], prompts: [], interrupts: [], pushes: [], sessionCreates: 0, sessionCreate: null, createMr: null,
      closes: 0,
    },
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
      listMergeRequestNotes: async () => state.mrNotes,
      postMergeRequestNote: async (_projectId, _iid, body) => {
        const id = state.mrNotes.length + 300;
        state.mrNotes.push({ id, body, created_at: new Date(NOW).toISOString(), author: { id: 9 } });
        return id;
      },
      listLabelEvents: async () => [{
        label: { name: 'ai-ready' }, action: 'add', user: { id: 7 }, created_at: '2026-11-12T09:00:00Z',
      }],
      listMembers: async () => state.members,
      accessLevelOf: async (_projectId, userId) => state.members.find((entry) => entry.id === userId)?.access_level ?? 0,
      latestTriggerer: async () => {
        if (state.labelEventsFail) throw new Error('resource label events are not available');
        return { userId: 7 };
      },
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
      closeIssue: async () => {
        if (state.closeFails) {
          const error = new Error('403 Forbidden');
          error.response = { status: 403 };
          throw error;
        }
        state.calls.closes += 1;
        state.issue.state = 'closed';
      },
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
      create: async (payload) => {
        state.calls.sessionCreates += 1;
        state.calls.sessionCreate = payload;
        state.sessionId = `ses_${state.calls.sessionCreates}`;
        return { data: { id: state.sessionId } };
      },
      prompt: async ({ text }) => { state.calls.prompts.push(text); },
      interrupt: async ({ sessionID }) => { state.calls.interrupts.push(sessionID); },
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
      ...projectOverrides,
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
    resolveWorktreeSetup,
    worktreeSetupState,
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

describe('GitLab issue dispatcher worktree setup', () => {
  it('gives the creation the project setup commands', async () => {
    const resolveWorktreeSetup = vi.fn(async () => ({ startCommand: 'bun install', untrustedSkipped: [] }));
    const { dispatcher, workspace } = await harness({ resolveWorktreeSetup });

    await dispatcher.tick();
    await dispatcher.tick();

    expect(resolveWorktreeSetup).toHaveBeenCalledWith(expect.objectContaining({ id: 'proj-1', path: 'D:/repo' }));
    expect(workspace.createWorktreeFor).toHaveBeenCalledWith(expect.objectContaining({ startCommand: 'bun install' }));
  });

  it('starts no session while the worktree setup is still running', async () => {
    const worktreeSetupState = vi.fn(async () => 'pending');
    const { dispatcher, ledger, state } = await harness({ worktreeSetupState });

    await dispatcher.tick();
    await dispatcher.tick();
    await dispatcher.tick();

    let run = (await ledger.list())[0];
    expect(run.phase).toBe('preparing');
    expect(state.calls.sessionCreates).toBe(0);

    worktreeSetupState.mockResolvedValue('ready');
    await dispatcher.tick();

    run = (await ledger.list())[0];
    expect(run.phase).toBe('triaging');
    expect(state.calls.sessionCreates).toBe(1);
  });

  it('blocks the run when the worktree setup failed', async () => {
    const { dispatcher, ledger } = await harness({ worktreeSetupState: vi.fn(async () => 'failed') });

    await dispatcher.tick();
    await dispatcher.tick();
    await dispatcher.tick();

    const run = (await ledger.list())[0];
    expect(run.phase).toBe('blocked');
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
    expect(run.phase).toBe('triaging');
    expect(state.calls.sessionCreates).toBe(1);
    expect(state.calls.prompts[0]).toContain('You are triaging');

    // The verdict decides the rail: a real problem goes to the fix session.
    state.messages = [message(triageValidJson)];
    await dispatcher.tick();
    run = (await ledger.list())[0];
    expect(run.phase).toBe('implementing');
    expect(run.triageVerdict).toBe('valid');
    expect(state.notes.some((note) => note.body.includes('### 判定：问题成立'))).toBe(true);

    await dispatcher.tick();
    expect(state.calls.sessionCreates).toBe(2);
    expect(state.calls.prompts[1]).toContain('You are implementing');

    state.messages = [message(evidenceJson)];
    await dispatcher.tick();
    run = (await ledger.list())[0];
    expect(run.phase).toBe('reviewing');
    expect(run.evidenceNoteId).toEqual(expect.any(Number));
    expect(state.notes.some((note) => note.body.includes('### 实现结果'))).toBe(true);

    // The review session opens on its own tick, after the implementation's
    // answer has been read.
    await dispatcher.tick();
    expect(state.calls.sessionCreates).toBe(3);
    expect(state.calls.prompts[2]).toContain('You are reviewing');

    state.messages = [message(reviewApproveJson)];
    await dispatcher.tick();
    run = (await ledger.list())[0];
    expect(run.phase).toBe('verifying');
    expect(run.reviewVerdict).toBe('approve');
    expect(state.notes.some((note) => note.body.includes('### 代码审核：通过'))).toBe(true);

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

describe('GitLab issue dispatcher triage gate', () => {
  const triageRun = (overrides = {}) => runEntry({
    phase: 'triaging', sessionId: 'ses_triage', worktreePath: 'D:/wt/17', attempts: 0,
    ...overrides,
  });

  it('closes the issue and ends the run when the report is not a problem', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    await ledger.put(triageRun());
    state.messages = [message(triageNotAnIssueJson)];

    await dispatcher.tick();
    const run = (await ledger.list())[0];
    expect(run).toMatchObject({
      phase: 'done', outcome: 'not-an-issue', triageVerdict: 'not-an-issue', sessionId: null,
    });
    expect(state.calls.closes).toBe(1);
    expect(state.issue.state).toBe('closed');
    expect(state.notes.some((note) => note.body.includes('### 判定：非问题')
      && note.body.includes('src/login.js:40'))).toBe(true);
    expect(state.calls.labels).toContainEqual(['add', ['ai-done']]);
    expect(state.calls.labels).toContainEqual(['remove', ['ai-working', 'ai-plan-review', 'ai-review']]);
    // The comment and the close are the whole outcome: no branch is pushed and
    // no merge request claims the issue was fixed.
    expect(state.calls.pushes).toEqual([]);
    expect(state.calls.createMr).toBeNull();
  });

  it('leaves the issue open when the bot may not close it', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    state.closeFails = true;
    await ledger.put(triageRun());
    state.messages = [message(triageNotAnIssueJson)];

    await dispatcher.tick();
    const run = (await ledger.list())[0];
    // A failed close is not a finished run: the issue is still open, so the
    // ledger must not say done.
    expect(run).toMatchObject({
      phase: 'blocked', blockedReason: 'not-an-issue', triageVerdict: 'not-an-issue',
    });
    expect(state.issue.state).toBe('opened');
    expect(state.notes.some((note) => note.body.includes('请人工关闭'))).toBe(true);
    expect(state.calls.labels).toContainEqual(['add', ['ai-blocked']]);
    expect(state.calls.labels).not.toContainEqual(['add', ['ai-done']]);
  });

  it('blocks a report nobody can check and keeps the issue open', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    await ledger.put(triageRun());
    state.messages = [message(triageInsufficientJson)];

    await dispatcher.tick();
    const run = (await ledger.list())[0];
    expect(run).toMatchObject({ phase: 'blocked', blockedReason: 'insufficient-info' });
    // Unverifiable is not the same as wrong: the issue waits for the reporter.
    expect(state.issue.state).toBe('opened');
    expect(state.calls.closes).toBe(0);
    expect(state.notes.some((note) => note.body.includes('reproduction steps'))).toBe(true);
    expect(state.calls.labels).toContainEqual(['add', ['ai-blocked']]);
  });

  it('starts the implementation when the report holds up', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    await ledger.put(triageRun({ attempts: 1 }));
    state.messages = [message(triageValidJson)];

    await dispatcher.tick();
    const run = (await ledger.list())[0];
    expect(run).toMatchObject({
      phase: 'implementing', triageVerdict: 'valid', sessionId: null, attempts: 0,
    });
    // Triage is a gate, not a retry: it must not consume the retry budget the
    // fix session needs.
    expect(run.events.some((event) => event.kind === 'phase' && event.to === 'implementing')).toBe(true);
    expect(state.calls.closes).toBe(0);
    expect(state.issue.state).toBe('opened');
  });

  it('re-runs triage without asking the branch whether the verdict exists', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    state.sessionGone = true;
    await ledger.put(triageRun({
      sessionId: 'ses_lost', leaseUntil: new Date(NOW - 60_000).toISOString(),
    }));

    await dispatcher.tick();
    const run = (await ledger.list())[0];
    // A commit on the branch says nothing about whether the report is real, so
    // the phase stays and a fresh session decides again.
    expect(run.phase).toBe('triaging');
    expect(state.calls.sessionCreates).toBe(1);
  });

  it('cancels a triage session when the issue is closed mid-flight', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    state.issue.state = 'closed';
    await ledger.put(triageRun());

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'cancelled',
    });
    expect(state.calls.interrupts).toEqual(['ses_triage']);
  });
});

describe('GitLab issue dispatcher session start and outcome', () => {
  it('asks for a model whose id keeps its own slashes', async () => {
    const { dispatcher, state } = await harness({
      projectOverrides: { defaultModel: 'magpie/workbuddy-ai/glm-5.3-flash', defaultVariant: 'high' },
    });
    await dispatcher.tick();
    await dispatcher.tick();
    await dispatcher.tick();

    expect(state.calls.sessionCreate).toMatchObject({
      model: { providerID: 'magpie', id: 'workbuddy-ai/glm-5.3-flash', variant: 'high' },
    });
  });

  it('blocks with a readable reason when the turn ended without an answer', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    await ledger.put(runEntry({
      phase: 'implementing', sessionId: 'ses_impl', worktreePath: 'D:/wt/17', attempts: 1,
    }));
    state.messages = [{ type: 'idle', time: { created: NOW + 1000 } }];

    await dispatcher.tick();

    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'session-failed',
    });
    expect(state.calls.labels).toContainEqual(['add', ['ai-blocked']]);
    expect(state.notes.some((note) => note.body.includes('会话没有任何输出'))).toBe(true);
  });

  it('blocks with the same reason when the finished turn carried no text', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    await ledger.put(runEntry({
      phase: 'implementing', sessionId: 'ses_impl', worktreePath: 'D:/wt/17', attempts: 1,
    }));
    state.messages = [message('')];

    await dispatcher.tick();

    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'session-failed',
    });
    expect(state.notes.some((note) => note.body.includes('会话没有任何输出'))).toBe(true);
  });

  it('keeps waiting while the session has recorded nothing yet', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    await ledger.put(runEntry({
      phase: 'implementing', sessionId: 'ses_impl', worktreePath: 'D:/wt/17', attempts: 1,
    }));

    await dispatcher.tick();

    expect((await ledger.list())[0].phase).toBe('implementing');
    expect(state.calls.labels).not.toContainEqual(['add', ['ai-blocked']]);
  });

  it('stamps every event it records with the time it happened', async () => {
    const { dispatcher, ledger } = await harness();
    await dispatcher.tick();
    await dispatcher.tick();

    const run = (await ledger.list())[0];
    expect(run.events.length).toBeGreaterThan(0);
    for (const event of run.events) expect(event.at).toEqual(expect.any(String));
  });

  it('keeps every session the run opened, by stage', async () => {
    const { dispatcher, ledger, state } = await harness();
    await dispatcher.tick();
    await dispatcher.tick();
    await dispatcher.tick();

    let run = (await ledger.list())[0];
    expect(run.sessions).toEqual([
      { sessionId: 'ses_1', stage: 'triaging', at: expect.any(String) },
    ]);

    // The triage verdict opens the fix session; both stay in the trail.
    state.messages = [message(triageValidJson)];
    await dispatcher.tick();
    await dispatcher.tick();

    run = (await ledger.list())[0];
    expect(run.sessions).toEqual([
      { sessionId: 'ses_1', stage: 'triaging', at: expect.any(String) },
      { sessionId: 'ses_2', stage: 'implementing', at: expect.any(String) },
    ]);

    state.messages = [message(evidenceJson)];
    await dispatcher.tick();

    run = (await ledger.list())[0];
    // Every session the run created is in the trail, so a card can always offer
    // the one that is already gone from `sessionId`.
    expect(run.sessions).toHaveLength(state.calls.sessionCreates);
  });

  it('reports only the statuses the panel knows', async () => {
    const { dispatcher, state } = await harness();
    const run = { sessionId: 'ses_impl', worktreePath: 'D:/wt/17' };
    state.messages = [{ type: 'idle', time: { created: NOW + 1000 } }];
    await expect(dispatcher.sessionStatus(run)).resolves.toBeNull();

    state.messages = [message(evidenceJson)];
    await expect(dispatcher.sessionStatus(run)).resolves.toBe('idle');
  });
});

describe('GitLab issue dispatcher feature path', () => {
  it('posts a plan, waits for approval, and then starts the implementation', async () => {
    const { dispatcher, ledger, state } = await harness({
      issueOverrides: { description: '类型: feature\n目标分支: ``' },
    });
    await dispatcher.tick();
    await dispatcher.tick();
    expect((await ledger.list())[0].phase).toBe('preparing');

    await dispatcher.tick();
    expect(state.calls.sessionCreates).toBe(1);
    expect(state.calls.prompts[0]).toContain('You are triaging');
    // A capability that already exists is the one feature verdict that ends
    // the run; a plan is what a real request gets.
    state.messages = [message(triageValidJson)];
    await dispatcher.tick();
    expect((await ledger.list())[0].phase).toBe('planning');

    await dispatcher.tick();
    expect(state.calls.sessionCreates).toBe(2);
    expect(state.calls.prompts[1]).toContain('You are planning');
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
    // Approval settles what to build, so the run goes straight to the fix
    // session instead of a second trip through triage.
    expect(run.phase).toBe('implementing');
    expect(state.calls.labels).toContainEqual(['add', ['ai-working']]);
  });

  it('blocks with rejected after /ai-reject', async () => {
    const { dispatcher, ledger, state } = await harness({
      issueOverrides: { description: '类型: feature\n目标分支: ``' },
    });
    await dispatcher.tick();
    await dispatcher.tick();
    await dispatcher.tick();
    state.messages = [message(triageValidJson)];
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

  it('sends review findings back to a fresh implement session', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    await ledger.put(runEntry({
      phase: 'reviewing', sessionId: 'ses_rev', worktreePath: 'D:/wt/17', attempts: 1,
      evidenceNoteId: 1, evidence, reviewRounds: 0,
    }));
    state.messages = [message(reviewChangesJson)];

    await dispatcher.tick();
    let run = (await ledger.list())[0];
    expect(run).toMatchObject({
      phase: 'implementing', sessionId: null, reviewRounds: 1, reviewVerdict: 'request-changes', attempts: 0,
    });
    expect(state.notes.some((note) => note.body.includes('### 代码审核：需修改'))).toBe(true);

    await dispatcher.tick();
    run = (await ledger.list())[0];
    expect(run.phase).toBe('implementing');
    expect(state.calls.sessionCreates).toBe(1);
    expect(state.calls.prompts[0]).toContain('<review-findings untrusted="true">');
    expect(state.calls.prompts[0]).toContain('src/login.js:12');
  });

  it('blocks a run the review asks to change past the round limit', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    await ledger.put(runEntry({
      phase: 'reviewing', sessionId: 'ses_rev', worktreePath: 'D:/wt/17', attempts: 1,
      evidenceNoteId: 1, evidence, reviewRounds: 3,
    }));
    state.messages = [message(reviewChangesJson)];

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'review-rejected', reviewRounds: 4,
    });
  });

  it('blocks a claim when label events cannot be read', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.labelEventsFail = true;

    await dispatcher.tick();
    const [run] = await ledger.list();
    expect(run).toMatchObject({
      phase: 'blocked', blockedReason: 'label-events-unavailable',
    });
    expect(state.issue.labels).toContain('ai-blocked');
    expect(state.notes.some((note) => note.body.includes('label-events-unavailable'))).toBe(true);
  });

  it('blocks a planning run past its timeout', async () => {
    const { dispatcher, ledger, state } = await harness();
    // A planning run holds `ai-working` for as long as its session does; the
    // cancellation check runs before the timeout and would read its absence
    // as a human cancel.
    state.issue.labels = ['ai-ready', 'ai-working', 'ai-plan-review'];
    await ledger.put(runEntry({
      phase: 'planning', kind: 'feature', sessionId: 'ses_9', worktreePath: 'D:/wt/17', attempts: 1,
      since: new Date(NOW - 31 * 60_000).toISOString(),
    }));

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'timeout',
    });
    expect(state.calls.interrupts).toEqual(['ses_9']);
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
    expect(state.calls.interrupts).toEqual(['ses_9']);
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
    expect(state.calls.interrupts).toEqual(['ses_9']);
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
    expect(state.calls.interrupts).toEqual(['ses_9']);
    expect(state.notes.some((note) => note.body.includes('timeout'))).toBe(true);
  });

  it('adopts an existing open merge request instead of creating a second one', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working'];
    state.mrs = [{ iid: 5, state: 'opened', web_url: `${INSTANCE}/mr/5` }];
    await ledger.put(runEntry({
      phase: 'verifying', worktreePath: 'D:/wt/17', attempts: 1, evidenceNoteId: 1,
      reviewVerdict: 'approve',
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

    // The triage verdict opens the fix session on the tick after it is read.
    state.messages = [message(triageValidJson)];
    await dispatcher.tick();
    await dispatcher.tick();
    state.messages = [message(evidenceJson)];
    await dispatcher.tick();
    await dispatcher.tick();
    // The review gate sits between the implementation and the push: open the
    // review session, then let its approve verdict reach the verify step.
    state.messages = [message(reviewApproveJson)];
    await dispatcher.tick();
    await dispatcher.tick();
    // The verdict unlocks the verify step; the comparison runs on its tick.
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
      reviewVerdict: 'approve',
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
      reviewVerdict: 'approve',
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
      attempts: 1, evidenceNoteId: 1, reviewVerdict: 'approve',
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
    state.messages = [message(triageValidJson)];
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
      phase: 'implementing', actorUserId: 8, actorAccountId: 'taker-acc',
    });
  });
});

describe('GitLab issue dispatcher feedback rounds', () => {
  const mrOpenRun = (overrides = {}) => runEntry({
    phase: 'mr-open', mrIid: 5, worktreePath: 'D:/wt/17', attempts: 1,
    evidenceNoteId: 1, evidence,
    noteWatermarks: { issue: 100, mergeRequest: 100 },
    ...overrides,
  });
  const commentNote = (id, body, author = { id: 7, username: 'sam' }) => ({
    id, body, created_at: new Date(NOW + 2000).toISOString(), author,
  });

  it('does not push a verifying run that carries no approve verdict', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working', 'ai-review'];
    state.mrs = [{ iid: 5, state: 'opened', web_url: `${INSTANCE}/mr/5` }];
    // A ledger written before the review gate has no verdict: it must wait for
    // a human, not push.
    await ledger.put(mrOpenRun({
      phase: 'verifying', sessionId: null, reviewVerdict: null, reviewNoteId: null,
    }));

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'review-rejected',
    });
    expect(state.calls.pushes).toEqual([]);
    expect(state.calls.createMr).toBeNull();
  });

  it('sends a trigger comment into an addressing session and answers on the channel', async () => {
    const wt = await fs.mkdtemp(path.join(os.tmpdir(), 'gitlab-wt-'));
    dirs.push(wt);
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working', 'ai-review'];
    state.mrs = [{ iid: 5, state: 'opened', web_url: `${INSTANCE}/mr/5` }];
    state.notes.push(commentNote(200, '@bot 修复: 样式塌了'));
    await ledger.put(mrOpenRun({ worktreePath: wt }));

    await dispatcher.tick();
    let run = (await ledger.list())[0];
    expect(run).toMatchObject({
      phase: 'addressing',
      feedbackRounds: 1,
      lastFeedbackActor: 7,
      feedbackItems: [{ author: 'sam', text: '样式塌了' }],
      sessionId: null,
      noteWatermarks: { issue: 200, mergeRequest: 100 },
    });
    expect(state.notes.some((note) => note.body.includes('开始第 1 轮修复'))).toBe(true);
    expect(state.notes.some((note) => note.body.includes('@sam：样式塌了'))).toBe(true);

    await dispatcher.tick();
    run = (await ledger.list())[0];
    expect(run.phase).toBe('addressing');
    expect(state.calls.prompts[0]).toContain('<feedback untrusted="true">');
    expect(state.calls.prompts[0]).toContain('@sam: 样式塌了');
    expect(state.calls.prompts[0]).toContain('Never push');
    expect(state.calls.labels).toContainEqual(['add', ['ai-working']]);
    // The session title says what the round is for: the sidebar only shows
    // the title, never the run.
    expect(state.calls.sessionCreate).toMatchObject({
      title: expect.stringContaining('#17: Fix login · 反馈修复第 1 轮'),
    });
  });

  it('initializes the watermarks without retroactively triggering on old comments', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working', 'ai-review'];
    state.mrs = [{ iid: 5, state: 'opened', web_url: `${INSTANCE}/mr/5` }];
    state.notes.push(commentNote(150, '@bot 修复'));
    await ledger.put(mrOpenRun({ noteWatermarks: null, worktreePath: 'D:/wt/17' }));

    await dispatcher.tick();
    let run = (await ledger.list())[0];
    expect(run).toMatchObject({
      phase: 'mr-open',
      noteWatermarks: { issue: 150, mergeRequest: 0 },
      feedbackRounds: 0,
    });
    expect(state.calls.sessionCreates).toBe(0);

    await dispatcher.tick();
    run = (await ledger.list())[0];
    expect(run.phase).toBe('mr-open');
    expect(state.calls.sessionCreates).toBe(0);
  });

  it('replies to a bare mention with usage and does not start a round', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working', 'ai-review'];
    state.mrs = [{ iid: 5, state: 'opened', web_url: `${INSTANCE}/mr/5` }];
    state.notes.push(commentNote(200, '@bot 进度如何'));
    await ledger.put(mrOpenRun());

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'mr-open', feedbackRounds: 0, noteWatermarks: { issue: 200, mergeRequest: 100 },
    });
    expect(state.notes.some((note) => note.body.includes('要开始新一轮修复'))).toBe(true);
  });

  it('ignores comments from people below Developer access', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working', 'ai-review'];
    state.mrs = [{ iid: 5, state: 'opened', web_url: `${INSTANCE}/mr/5` }];
    state.notes.push(commentNote(200, '@bot 修复', { id: 99, username: 'guest' }));
    await ledger.put(mrOpenRun());

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({ phase: 'mr-open', feedbackRounds: 0 });
    expect(state.calls.sessionCreates).toBe(0);
    expect(state.notes.some((note) => note.body.includes('开始第'))).toBe(false);
  });

  it('blocks a run past the feedback round limit', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working', 'ai-review'];
    state.mrs = [{ iid: 5, state: 'opened', web_url: `${INSTANCE}/mr/5` }];
    state.notes.push(commentNote(200, '@bot 修复: again'));
    await ledger.put(mrOpenRun({ feedbackRounds: 5 }));

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({
      phase: 'blocked', blockedReason: 'feedback-limit', noteWatermarks: { issue: 200, mergeRequest: 100 },
    });
    expect(state.calls.labels).toContainEqual(['add', ['ai-blocked']]);
  });

  it('runs the round through review, pushes, and answers the MR with the sha', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working', 'ai-review'];
    state.mrs = [{ iid: 5, state: 'opened', web_url: `${INSTANCE}/mr/5` }];
    await ledger.put(mrOpenRun({
      phase: 'addressing', sessionId: 'ses_addr', feedbackRounds: 1, lastFeedbackActor: 7,
      feedbackItems: [{ author: 'sam', text: 'timeout is not bounded' }],
    }));
    state.messages = [message(evidenceJson)];

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({ phase: 'reviewing', sessionId: null });

    await dispatcher.tick();
    expect(state.calls.prompts[0]).toContain('<feedback untrusted="true">');
    expect(state.calls.prompts[0]).toContain('every entry is either addressed or named');

    state.messages = [message(reviewApproveJson)];
    await dispatcher.tick();
    let run = (await ledger.list())[0];
    expect(run).toMatchObject({ phase: 'verifying', feedbackItems: null });

    await dispatcher.tick();
    run = (await ledger.list())[0];
    expect(run).toMatchObject({ phase: 'mr-open', mrIid: 5 });
    expect(state.calls.pushes).toEqual(['openchamber/issue-17-fix-login']);
    expect(state.mrNotes.some((note) => note.body.includes('第 1 轮反馈修复') && note.body.includes('abc123'))).toBe(true);
    expect(state.notes.some((note) => note.body.includes('### 实现结果'))).toBe(true);
  });

  it('does not trigger a round on a merged or closed merge request', async () => {
    const { dispatcher, ledger, state } = await harness();
    state.issue.labels = ['ai-ready', 'ai-working', 'ai-review'];
    state.mrs = [{ iid: 5, state: 'merged', web_url: `${INSTANCE}/mr/5` }];
    state.notes.push(commentNote(200, '@bot 修复'));
    await ledger.put(mrOpenRun());

    await dispatcher.tick();
    expect((await ledger.list())[0]).toMatchObject({ phase: 'done', feedbackRounds: 0 });
    expect(state.notes.some((note) => note.body.includes('开始第'))).toBe(false);
  });
});
