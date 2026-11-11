/**
 * End-to-end shape with the real `createGitlabIssueApi` adapter over a fake
 * GitBeaker client. The 12.7 diff fallback lives in the shared GitLab module
 * and is covered by `../gitlab/resources.test.js`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitlabIssueDispatcher } from './dispatcher.js';
import { createGitlabIssueApi } from './gitlab.js';
import { createGitlabIssueLedger } from './ledger.js';

const INSTANCE = 'https://gitlab.example.com';
const NOW = Date.parse('2026-11-12T10:00:00.000Z');
const dirs = [];

const paged = (data) => async () => ({ data, paginationInfo: { next: null } });

const evidenceJson = '```json\n{"rootCause":"missing timeout","changes":"added timeout","verification":[{"command":"bun test","result":"pass"}],"risks":"none"}\n```';
const planJson = '```json\n{"files":["src/login.js"],"dataFlow":"add timeout","verification":"bun test","risks":"none","outOfScope":"no ui"}\n```';

async function createFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitlab-integration-'));
  dirs.push(dir);

  const state = {
    issue: {
      iid: 17,
      title: 'Fix login',
      description: '类型: bug\n目标分支: ``',
      state: 'opened',
      labels: ['ai-ready'],
    },
    notes: [],
    members: [{ id: 7, access_level: 30 }],
    branches: [{ name: 'main' }],
    mrs: [],
    listIssueOptions: [],
    sessionId: null,
    messages: [],
    calls: { createMr: null, pushes: [], identity: null, sessionCreates: 0 },
  };

  const issueView = () => ({ ...state.issue, labels: [...state.issue.labels] });

  const makeClient = (user) => ({
    Users: { showCurrentUser: async () => user },
    Projects: { show: async () => ({ id: 42, default_branch: 'main' }) },
    Issues: {
      all: async (options) => {
        state.listIssueOptions.push(options);
        return { data: [issueView()], paginationInfo: { next: null } };
      },
      show: async () => issueView(),
      edit: async (_projectId, _iid, options) => {
        if (options.addLabels) {
          for (const label of options.addLabels.split(',')) {
            if (!state.issue.labels.includes(label)) state.issue.labels.push(label);
          }
        }
        if (options.removeLabels) {
          const removed = options.removeLabels.split(',');
          state.issue.labels = state.issue.labels.filter((label) => !removed.includes(label));
        }
        if (options.stateEvent === 'close') state.issue.state = 'closed';
      },
    },
    IssueNotes: {
      all: async () => ({ data: state.notes, paginationInfo: { next: null } }),
      create: async (_projectId, _iid, body) => {
        const id = state.notes.length + 100;
        state.notes.push({ id, body, created_at: new Date(NOW).toISOString(), author: { id: 9 } });
        return { id };
      },
    },
    IssueLabelEvents: {
      all: paged([{
        label: { name: 'ai-ready' }, action: 'add', user: { id: 7 }, created_at: '2026-11-12T09:00:00Z',
      }]),
    },
    ProjectMembers: { all: paged(state.members) },
    Branches: {
      all: async () => ({ data: state.branches, paginationInfo: { next: null } }),
      show: async () => ({ name: 'main' }),
    },
    MergeRequests: {
      all: paged([]),
      create: async (...args) => {
        state.calls.createMr = args;
        const mr = { iid: 5, state: 'opened', web_url: `${INSTANCE}/mr/5` };
        state.mrs.push(mr);
        return mr;
      },
      show: async () => state.mrs[0],
    },
  });

  const botClient = makeClient({ id: 9, username: 'bot', email: 'bot@example.com' });
  const actorClient = makeClient({ id: 7, username: 'sam', name: 'Sam', email: 'sam@example.com' });

  const ledger = createGitlabIssueLedger({ filePath: path.join(dir, 'runs.json'), now: () => NOW });
  const workspace = {
    fetchBranch: vi.fn(async () => ({})),
    localBranchExists: vi.fn(async () => false),
    createWorktreeFor: vi.fn(async () => ({ path: 'D:/wt/17' })),
    configureIdentity: vi.fn(async (input) => { state.calls.identity = input; }),
    commitCountSince: vi.fn(async () => 1),
    hasDiffSince: vi.fn(async () => true),
    pushBranch: vi.fn(async ({ branch }) => {
      state.calls.pushes.push(branch);
      return { branch, sha: 'abc123' };
    }),
    removeWorktreeSafely: vi.fn(async () => ({ removed: true, dirty: false })),
  };

  const client = {
    session: {
      active: async () => ({
        data: state.messages.length ? {} : { [state.sessionId]: { type: 'running' } },
      }),
      create: async () => {
        state.calls.sessionCreates += 1;
        state.sessionId = `ses_${state.calls.sessionCreates}`;
        return { data: { id: state.sessionId } };
      },
      prompt: async () => {},
      abort: async () => {},
      get: async ({ sessionID }) => ({ id: sessionID }),
    },
    message: { list: async () => ({ data: state.messages }) },
  };

  const accounts = {
    'bot-acc': {
      credentialId: 'bot-acc', credentialRevision: 1, status: 'valid', source: 'pat',
      token: 'b', providerUserId: `${INSTANCE}#9`, user: { id: 9, login: 'bot' }, role: 'bot',
    },
    'actor-acc': {
      credentialId: 'actor-acc', credentialRevision: 1, status: 'valid', source: 'pat',
      token: 'a', providerUserId: `${INSTANCE}#7`,
      user: { id: 7, login: 'sam', name: 'Sam', email: 'sam@example.com' }, role: 'actor',
    },
  };

  const dispatcher = createGitlabIssueDispatcher({
    listProjects: async () => [{
      id: 'proj-1', path: 'D:/repo',
      autoDispatchGitlabIssues: true, gitlabIssueBotAccountId: 'bot-acc',
    }],
    authStore: {
      readAccount: async (origin, id) => {
        if (origin !== INSTANCE) return null;
        return accounts[id] ?? null;
      },
      listAccounts: async (origin) => (origin === INSTANCE ? Object.values(accounts) : []),
    },
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
            primaryRemote: 'origin',
            readiness: 'ready',
            endpoint: { displayUrl: `${INSTANCE}/team/repo.git`, fingerprint: 'fp-1' },
          }],
          remotes: [],
        },
        repository: {
          remotes: [{ name: 'origin', fetch: { displayUrl: `${INSTANCE}/team/repo.git` } }],
        },
      }),
    },
    apiFactory: ({ account }) => createGitlabIssueApi({
      client: account.role === 'actor' ? actorClient : botClient,
    }),
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
    logger: { info() {}, warn() {} },
    now: () => NOW,
    issueScanEveryTicks: 1,
    tickIntervalMs: 3_600_000,
    startupDelayMs: 3_600_000,
  });

  return { dispatcher, ledger, state };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('GitLab issue automation integration', () => {
  it('turns a labeled bug issue into a merge request through the real adapter', async () => {
    const { dispatcher, ledger, state } = await createFixture();
    await dispatcher.tick();
    expect(state.listIssueOptions[0]).toMatchObject({ labels: 'ai-ready', state: 'opened' });

    await dispatcher.tick();
    await dispatcher.tick();
    expect(state.calls.sessionCreates).toBe(1);
    expect(state.calls.identity).toEqual({
      cwd: 'D:/wt/17', name: 'Sam', email: 'sam@example.com',
    });

    state.messages = [{
      type: 'assistant',
      content: [{ type: 'text', text: evidenceJson }],
      time: { completed: NOW + 1000 },
    }];
    await dispatcher.tick();
    await dispatcher.tick();

    const run = (await ledger.list())[0];
    expect(run.phase).toBe('mr-open');
    expect(state.calls.pushes).toEqual(['openchamber/issue-17-fix-login']);
    expect(state.calls.createMr).toEqual([
      42,
      'openchamber/issue-17-fix-login',
      'main',
      'Fix login (#17)',
      { description: expect.stringContaining('Closes #17') },
    ]);
    expect(state.notes.some((note) => note.body.includes('### 实现结果'))).toBe(true);
  });

  it('takes a feature issue through plan approval into a merge request', async () => {
    const { dispatcher, ledger, state } = await createFixture();
    state.issue.description = '类型: feature\n目标分支: ``';

    await dispatcher.tick();
    await dispatcher.tick();
    await dispatcher.tick();
    expect((await ledger.list())[0].phase).toBe('planning');

    state.messages = [{
      type: 'assistant',
      content: [{ type: 'text', text: planJson }],
      time: { completed: NOW + 1000 },
    }];
    await dispatcher.tick();
    expect((await ledger.list())[0].phase).toBe('waiting-approval');
    expect(state.notes.some((note) => note.body.includes('### 方案'))).toBe(true);

    state.notes.push({
      id: 500, body: '/ai-approve', created_at: new Date(NOW + 2000).toISOString(), author: { id: 7 },
    });
    await dispatcher.tick();
    expect((await ledger.list())[0].phase).toBe('preparing');

    state.messages = [];
    await dispatcher.tick();
    expect((await ledger.list())[0].phase).toBe('implementing');

    state.messages = [{
      type: 'assistant',
      content: [{ type: 'text', text: evidenceJson }],
      time: { completed: NOW + 3000 },
    }];
    await dispatcher.tick();
    await dispatcher.tick();

    const run = (await ledger.list())[0];
    expect(run.phase).toBe('mr-open');
    expect(state.calls.pushes).toEqual(['openchamber/issue-17-fix-login']);
    expect(state.calls.createMr).not.toBeNull();
  });
});
