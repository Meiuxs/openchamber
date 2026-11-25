import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGitlabIssueRoutes } from './routes.js';

const tempDirs = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      post(routePath, handler) { routes.set(`POST ${routePath}`, handler); },
      get(routePath, handler) { routes.set(`GET ${routePath}`, handler); },
    },
    post(routePath) {
      return routes.get(`POST ${routePath}`);
    },
    get(routePath) {
      return routes.get(`GET ${routePath}`);
    },
  };
};

const createResponse = () => {
  let statusCode = 200;
  let body = null;
  return {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
};

// Mirrors the server helper: it trims, and leaves separator spelling alone.
const normalizeDirectoryPath = (value) => String(value ?? '').trim() || null;

const bindingFor = ({ ready = true, remoteUrl = 'https://gitlab.example.com/group/repo.git' } = {}) => ({  binding: {
    providers: ready
      ? [{ provider: 'gitlab', instance: 'https://gitlab.example.com', primaryRemote: 'origin', readiness: 'ready' }]
      : [],
  },
  repository: {
    remotes: [{ name: 'origin', fetch: { displayUrl: remoteUrl } }],
  },
});

// What the binding service throws for a folder that is not a Git repository.
const unsupportedRepository = () => Object.assign(
  new Error('Directory is not a supported Git repository'),
  { code: 'UNSUPPORTED_SOURCE_CONTROL_REPOSITORY', reason: 'not-a-git-repository' },
);

const createHarness = (options = {}) => {
  const registry = createRouteRegistry();
  const createIssue = vi.fn(async () => ({ iid: 17, web_url: 'https://gitlab.example.com/group/repo/-/issues/17' }));
  const warn = vi.fn();
  const readAccount = vi.fn(async () => (options.account === null
    ? null
    : { status: 'valid', token: 'secret-token', credentialId: 'acc-1', source: 'pat' }));
  const get = vi.fn(async () => {
    if (options.bindingError) throw options.bindingError;
    return bindingFor(options.binding);
  });
  const addLabels = vi.fn(async () => {});
  const removeLabels = vi.fn(async () => {});
  const postNote = vi.fn(async () => 1);
  const accessLevelOf = vi.fn(async () => options.accessLevel ?? 30);
  const listRuns = vi.fn(async () => {
    if (options.ledgerFails) throw new Error('ledger unreadable');
    return options.runs ?? [];
  });
  const getRun = vi.fn(async () => options.run ?? null);
  const listAccounts = vi.fn(async () => options.accounts ?? [{
    credentialId: 'acc-2',
    credentialRevision: 1,
    status: 'valid',
    source: 'pat',
    providerUserId: 'https://gitlab.example.com#7',
    user: { id: 7, login: 'sam' },
    role: 'actor',
  }]);
  registerGitlabIssueRoutes(registry.app, {
    readProjects: async () => options.projects ?? [{
      id: 'p1', path: '/repo', gitlabIssueBotAccountId: options.botAccountId ?? 'acc-1',
    }],
    bindingService: { get },
    authStore: { readAccount, listAccounts },
    normalizeDirectoryPath,
    apiFactory: () => ({
      createIssue, addLabels, removeLabels, postNote, accessLevelOf,
    }),
    dispatcher: {
      ledger: { list: listRuns, get: getRun },
      sessionStatus: async () => 'busy',
    },
    logger: { warn },
  });
  return {
    handler: registry.post('/api/gitlab-issues'),
    runsHandler: registry.get('/api/gitlab-issues/runs'),
    actionHandler: registry.post('/api/gitlab-issues/runs/action'),
    createIssue,
    readAccount,
    get,
    warn,
    addLabels,
    removeLabels,
    postNote,
    accessLevelOf,
    listRuns,
    getRun,
  };
};

const runRecord = (overrides = {}) => ({  origin: 'https://gitlab.example.com',
  projectEntryId: 'p1',
  projectId: 42,
  projectPath: 'group/repo',
  title: 'Fix login',
  iid: 17,
  kind: 'bug',
  phase: 'implementing',
  blockedReason: null,
  blockedFrom: null,
  branch: 'openchamber/issue-17-fix-login',
  targetBranch: 'main',
  mrIid: null,
  attempts: 1,
  reviewRounds: 0,
  reviewVerdict: null,
  triageVerdict: null,
  outcome: null,
  sessionId: 'ses_1',
  worktreePath: 'D:/wt/17',
  since: '2026-11-12T10:00:00.000Z',
  updatedAt: '2026-11-12T10:00:00.000Z',
  ...overrides,
});

const validBody = {
  directory: '/repo',
  kind: 'bug',
  title: 'Preview breaks on wide tables',
  targetBranch: 'release/2.9',
  description: 'Steps to reproduce.',
};

describe('GitLab issue create route', () => {
  it('files the issue through the project bot account with the parsed header', async () => {
    const { handler, createIssue } = createHarness();
    const res = createResponse();

    await handler({ body: validBody }, res);

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({
      iid: 17,
      webUrl: 'https://gitlab.example.com/group/repo/-/issues/17',
      projectPath: 'group/repo',
    });
    expect(createIssue).toHaveBeenCalledWith(
      'group/repo',
      'Preview breaks on wide tables',
      '类型: bug\n目标分支: `release/2.9`\n\nSteps to reproduce.',
    );
  });

  it('parses the project from an SCP-style SSH remote', async () => {
    const { handler, createIssue } = createHarness({
      binding: { remoteUrl: 'git@gitlab.example.com:group/repo.git' },
    });
    const res = createResponse();

    await handler({ body: validBody }, res);

    expect(res.statusCode).toBe(201);
    expect(createIssue).toHaveBeenCalledWith(
      'group/repo',
      'Preview breaks on wide tables',
      expect.stringContaining('类型: bug'),
    );
  });

  it('uses the default branch when no target branch is given', async () => {
    const { handler, createIssue } = createHarness();
    const res = createResponse();

    await handler({ body: { ...validBody, targetBranch: '' } }, res);

    expect(res.statusCode).toBe(201);
    expect(createIssue).toHaveBeenCalledWith(
      'group/repo',
      validBody.title,
      '类型: bug\n目标分支: ``\n\nSteps to reproduce.',
    );
  });

  it('rejects an unknown kind, an empty title and an invalid branch before calling GitLab', async () => {
    const { handler, createIssue } = createHarness();

    for (const [body, status, error] of [
      [{ ...validBody, kind: 'chore' }, 400, 'invalid-kind'],
      [{ ...validBody, title: '  ' }, 400, 'invalid-title'],
      [{ ...validBody, title: 'two\nlines' }, 400, 'invalid-title'],
      [{ ...validBody, targetBranch: 'bad..branch' }, 400, 'invalid-branch'],
      [{ ...validBody, targetBranch: 'release/`2.9`' }, 400, 'invalid-branch'],
      [{ ...validBody, directory: '' }, 400, 'invalid-directory'],
    ]) {
      const res = createResponse();
      await handler({ body }, res);
      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual({ error });
    }
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('reports a project without a configured bot account', async () => {
    const { handler, createIssue } = createHarness({ botAccountId: '' });
    const res = createResponse();

    await handler({ body: validBody }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'bot-account-missing' });
    expect(createIssue).not.toHaveBeenCalled();
  });

  // A project whose folder is not a Git repository can never be bound to
  // GitLab. The binding service rejects that read, and the answer for the
  // caller is the same one a project without a GitLab binding gets — an answer,
  // not a failure.
  it('reports a folder that is not a Git repository as not a GitLab project', async () => {
    const { handler, warn, createIssue } = createHarness({ bindingError: unsupportedRepository() });
    const res = createResponse();

    await handler({ body: validBody }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'not-gitlab-project' });
    expect(createIssue).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a project that has no ready GitLab binding', async () => {
    const { handler } = createHarness({ binding: { ready: false } });
    const res = createResponse();

    await handler({ body: validBody }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'not-gitlab-project' });
  });

  it('reports a bot account that is no longer valid', async () => {
    const { handler } = createHarness({ account: null });
    const res = createResponse();

    await handler({ body: validBody }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'bot-account-unusable' });
  });

  it('answers 404 for a directory that is not a configured project', async () => {
    const { handler } = createHarness();
    const res = createResponse();

    await handler({ body: { ...validBody, directory: '/elsewhere' } }, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'project-not-found' });
  });

  it('finds the project when the request spells a Windows path with forward slashes', async () => {
    const { handler, createIssue } = createHarness({
      projects: [{ id: 'p1', path: 'C:\\Code\\repo', gitlabIssueBotAccountId: 'acc-1' }],
    });
    const res = createResponse();

    await handler({ body: { ...validBody, directory: 'C:/Code/repo/' } }, res);

    expect(res.statusCode).toBe(201);
    expect(createIssue).toHaveBeenCalled();
  });

  it('turns a GitLab failure into a request error without leaking the token', async () => {
    const { handler, createIssue, warn } = createHarness();
    const failure = new Error('401 Unauthorized');
    // The client hangs the authenticated request off the error.
    failure.cause = { request: { headers: { 'private-token': 'secret-token' } } };
    createIssue.mockRejectedValueOnce(failure);
    const res = createResponse();

    await handler({ body: validBody }, res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'gitlab-request-failed' });
    expect(JSON.stringify(res.body)).not.toContain('secret-token');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-token');
  });

  it('reports a failed project or binding lookup on its own', async () => {
    const res = createResponse();
    const registry = createRouteRegistry();
    registerGitlabIssueRoutes(registry.app, {
      readProjects: async () => { throw new Error('settings unreadable'); },
      bindingService: { get: async () => { throw new Error('unused'); } },
      authStore: { readAccount: async () => null },
      normalizeDirectoryPath,
      logger: { warn: () => {} },
    });

    await registry.post('/api/gitlab-issues')({ body: validBody }, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'lookup-failed' });
  });
});

describe('GitLab run panel routes', () => {
  it('lists a project ledger with derived links and the bot status', async () => {
    const { runsHandler } = createHarness({ runs: [runRecord()] });
    const res = createResponse();

    await runsHandler({ query: { directory: '/repo' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.bot).toEqual({ status: 'valid', accountId: 'acc-1' });
    expect(res.body.runs[0]).toMatchObject({
      key: 'https://gitlab.example.com|42|17',
      issueUrl: 'https://gitlab.example.com/group/repo/issues/17',
      sessionStatus: 'busy',
    });
    // A ledger written before runs kept their sessions still lists.
    expect(res.body.runs[0].sessions).toEqual([]);
  });

  // GitLab 12.7, which the intranet deployment runs, serves the short form and
  // 404s on the `/-/` one, so a link the panel renders must not carry it.
  it('builds links in the form older GitLab serves', async () => {
    const { runsHandler } = createHarness({ runs: [runRecord({ mrIid: 5 })] });
    const res = createResponse();

    await runsHandler({ query: { directory: '/repo' } }, res);

    expect(res.body.runs[0].issueUrl).toBe('https://gitlab.example.com/group/repo/issues/17');
    expect(res.body.runs[0].mrUrl).toBe('https://gitlab.example.com/group/repo/merge_requests/5');
  });

  // A run that ended without a merge request says otherwise nothing but
  // "done", so the verdict and the outcome reach the panel.
  it('carries the triage verdict and the outcome of a finished run', async () => {
    const { runsHandler } = createHarness({
      runs: [runRecord({
        phase: 'done', triageVerdict: 'not-an-issue', outcome: 'not-an-issue', sessionId: null,
      })],
    });
    const res = createResponse();

    await runsHandler({ query: { directory: '/repo' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.runs[0]).toMatchObject({
      phase: 'done', triageVerdict: 'not-an-issue', outcome: 'not-an-issue',
    });
  });

  it('reports a run recorded before triage as having no verdict', async () => {
    const { runsHandler } = createHarness({ runs: [runRecord()] });
    const res = createResponse();

    await runsHandler({ query: { directory: '/repo' } }, res);

    expect(res.body.runs[0]).toMatchObject({ triageVerdict: null, outcome: null });
  });

  it('reports the record path only when the file exists', async () => {
    const checkout = await fs.mkdtemp(path.join(os.tmpdir(), 'routes-record-'));
    tempDirs.push(checkout);
    const recordPath = path.join(checkout, '.openchamber', 'issue-records', 'group', 'repo', 'issue-17.md');
    await fs.mkdir(path.dirname(recordPath), { recursive: true });
    await fs.writeFile(recordPath, '# Fix login (#17)\n', 'utf8');
    const { runsHandler } = createHarness({
      runs: [runRecord()],
      projects: [{
        id: 'p1',
        path: checkout,
        gitlabIssueBotAccountId: 'acc-1',
        autoDispatchGitlabIssues: true,
      }],
    });
    const res = createResponse();

    // The global branch resolves the checkout from the run's projectEntryId.
    await runsHandler({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.runs[0].recordPath).toBe(recordPath);
    expect(res.body.runs[0].projectDirectory).toBe(checkout);
  });

  it('reports null for a run whose record was never written', async () => {
    const checkout = await fs.mkdtemp(path.join(os.tmpdir(), 'routes-record-'));
    tempDirs.push(checkout);
    const { runsHandler } = createHarness({
      runs: [runRecord()],
      projects: [{ id: 'p1', path: checkout, gitlabIssueBotAccountId: 'acc-1' }],
    });
    const res = createResponse();

    // The directory branch knows the checkout from the project lookup.
    await runsHandler({ query: { directory: checkout } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.runs[0].recordPath).toBeNull();
    expect(res.body.runs[0].projectDirectory).toBeNull();
  });

  it('lists the sessions behind the stops and drops unusable entries', async () => {
    const { runsHandler } = createHarness({
      runs: [runRecord({
        sessions: [
          { sessionId: 'ses_fix', stage: 'implementing', at: '2026-11-12T10:00:00.000Z' },
          { sessionId: 'ses_review', stage: 'reviewing', at: '2026-11-12T10:05:00.000Z' },
          { stage: 'reviewing', at: '2026-11-12T10:09:00.000Z' },
        ],
      })],
    });
    const res = createResponse();

    await runsHandler({ query: { directory: '/repo' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.runs[0].sessions).toEqual([
      { sessionId: 'ses_fix', stage: 'implementing', at: '2026-11-12T10:00:00.000Z' },
      { sessionId: 'ses_review', stage: 'reviewing', at: '2026-11-12T10:05:00.000Z' },
    ]);
  });

  // The board offers the runs tab for any project, including folders that are
  // not Git repositories (a plain folder, or a worktree whose git metadata is
  // gone). The panel must be told there is nothing to show, not handed a
  // server failure it cannot explain.
  it('answers not-gitlab-project for a folder that is not a Git repository', async () => {
    const { runsHandler, warn } = createHarness({ bindingError: unsupportedRepository() });
    const res = createResponse();

    await runsHandler({ query: { directory: '/repo' } }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'not-gitlab-project' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports an unreadable ledger as an error, never as an empty list', async () => {
    const { runsHandler } = createHarness({ ledgerFails: true });
    const res = createResponse();

    await runsHandler({ query: { directory: '/repo' } }, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'ledger-unreadable' });
  });

  it('allows acting as the bot account, so a person may share one GitLab account with the automation', async () => {
    const { actionHandler, addLabels, removeLabels } = createHarness({ run: runRecord(), botAccountId: 'acc-2' });
    const res = createResponse();

    await actionHandler({
      body: {
        directory: '/repo',
        key: 'https://gitlab.example.com|42|17',
        action: 'cancel',
        accountId: 'acc-2',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(addLabels).toHaveBeenCalledWith(42, 17, ['ai-blocked']);
    expect(removeLabels).toHaveBeenCalledWith(42, 17, ['ai-working']);
  });

  it('refuses an action the phase does not accept', async () => {
    const { actionHandler } = createHarness({ run: runRecord({ phase: 'implementing' }) });
    const res = createResponse();

    await actionHandler({
      body: {
        directory: '/repo',
        key: 'https://gitlab.example.com|42|17',
        action: 'approve',
        accountId: 'acc-2',
      },
    }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'phase-mismatch', phase: 'implementing' });
  });

  it('refuses an acting account below Developer', async () => {
    const { actionHandler, removeLabels } = createHarness({
      run: runRecord({ phase: 'blocked', blockedReason: 'review-rejected' }),
      accessLevel: 20,
    });
    const res = createResponse();

    await actionHandler({
      body: {
        directory: '/repo',
        key: 'https://gitlab.example.com|42|17',
        action: 'reset',
        accountId: 'acc-2',
      },
    }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'insufficient-access' });
    expect(removeLabels).not.toHaveBeenCalled();
  });

  it('resets a blocked run with the acting account', async () => {
    const { actionHandler, removeLabels, addLabels } = createHarness({
      run: runRecord({ phase: 'blocked', blockedReason: 'review-rejected' }),
    });
    const res = createResponse();

    await actionHandler({
      body: {
        directory: '/repo',
        key: 'https://gitlab.example.com|42|17',
        action: 'reset',
        accountId: 'acc-2',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(removeLabels).toHaveBeenCalledWith(42, 17, ['ai-blocked']);
    expect(addLabels).toHaveBeenCalledWith(42, 17, ['ai-ready']);
  });
});
