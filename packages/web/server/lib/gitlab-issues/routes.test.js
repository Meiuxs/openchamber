import { describe, expect, it, vi } from 'vitest';

import { registerGitlabIssueRoutes } from './routes.js';

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      post(routePath, handler) { routes.set(`POST ${routePath}`, handler); },
    },
    post(routePath) {
      return routes.get(`POST ${routePath}`);
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

const bindingFor = ({ ready = true, remoteUrl = 'https://gitlab.example.com/group/repo.git' } = {}) => ({
  binding: {
    providers: ready
      ? [{ provider: 'gitlab', instance: 'https://gitlab.example.com', primaryRemote: 'origin', readiness: 'ready' }]
      : [],
  },
  repository: {
    remotes: [{ name: 'origin', fetch: { displayUrl: remoteUrl } }],
  },
});

const createHarness = (options = {}) => {
  const registry = createRouteRegistry();
  const createIssue = vi.fn(async () => ({ iid: 17, web_url: 'https://gitlab.example.com/group/repo/-/issues/17' }));
  const warn = vi.fn();
  const readAccount = vi.fn(async () => (options.account === null
    ? null
    : { status: 'valid', token: 'secret-token', credentialId: 'acc-1', source: 'pat' }));
  const get = vi.fn(async () => bindingFor(options.binding));
  registerGitlabIssueRoutes(registry.app, {
    readProjects: async () => options.projects ?? [{
      id: 'p1', path: '/repo', gitlabIssueBotAccountId: options.botAccountId ?? 'acc-1',
    }],
    bindingService: { get },
    authStore: { readAccount },
    normalizeDirectoryPath,
    apiFactory: () => ({ createIssue }),
    logger: { warn },
  });
  return { handler: registry.post('/api/gitlab-issues'), createIssue, readAccount, get, warn };
};

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
