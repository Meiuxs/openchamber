import { describe, expect, it, vi } from 'vitest';
import { createProvider } from './provider.js';
import { createGitLabResourceService } from './resources.js';
import {
  decodeAcrossCursor,
  encodeAcrossCursor,
  mergeRequestToReference,
  issueToReference,
  readGitLabAcrossRequest,
  runAcrossSearch,
} from './reference-search.js';

const context = (directory, accountId = 'acct#1') => ({
  directory,
  repositoryId: `${directory}#repo`,
  provider: 'gitlab',
  instance: 'https://gitlab.example.com',
  accountId,
  bindingRevision: 1,
  primaryRemote: 'origin',
});

const request = (contexts, extra = {}) => ({
  contexts,
  kind: 'issue',
  state: 'open',
  people: 'any',
  labels: [],
  query: '',
  cursor: null,
  ...extra,
});

const reference = (number) => ({
  kind: 'issue', number, title: `Issue ${number}`, url: `https://gitlab.example.com/a/b/-/issues/${number}`,
  body: '', bodyTruncated: false, createdAt: null, updatedAt: `2026-11-0${number}`,
  author: null, labels: [], commentCount: 0, sourceRepo: { owner: 'a', repo: 'b', source: 'origin' }, state: 'open',
});

describe('readGitLabAcrossRequest', () => {
  it('deduplicates folders and rejects a provider other than GitLab', () => {
    const parsed = readGitLabAcrossRequest(request([context('/a'), context('/a'), context('/b')]));
    expect(parsed.contexts.map((item) => item.directory)).toEqual(['/a', '/b']);
    expect(parsed.directories).toEqual(['/a', '/a', '/b']);
    expect(readGitLabAcrossRequest(request([{ ...context('/a'), provider: 'github' }]))).toBeNull();
    expect(readGitLabAcrossRequest(request([context('/a')], { kind: 'discussion' }))).toBeNull();
  });
});

describe('across cursor', () => {
  it('round-trips page positions and rejects a foreign scope', () => {
    const input = readGitLabAcrossRequest(request([context('/a'), context('/b')]));
    const cursor = encodeAcrossCursor(input, [2, null]);
    expect(decodeAcrossCursor(input, cursor)).toEqual([2, null]);
    const other = readGitLabAcrossRequest(request([context('/a'), context('/c')]));
    expect(decodeAcrossCursor(other, cursor)).toBeNull();
    expect(decodeAcrossCursor(input, 'invalid!')).toBeNull();
  });
});

describe('reference mapping', () => {
  it('maps GitLab issues and merge requests into across references', () => {
    const project = { id: '1', provider: 'gitlab', instance: 'https://gitlab.example.com', owner: 'a', name: 'b', url: 'https://gitlab.example.com/a/b' };
    expect(issueToReference({
      number: 7, title: 'Issue', url: 'https://gitlab.example.com/a/b/-/issues/7', state: 'closed',
      body: 'x'.repeat(20_001), project, labels: [{ name: 'bug' }], author: { username: 'dev', avatarUrl: 'https://img' },
      updatedAt: '2026-11-01', createdAt: '2026-10-01',
    })).toMatchObject({
      kind: 'issue', state: 'completed', bodyTruncated: true, author: { login: 'dev' },
      sourceRepo: { owner: 'a', repo: 'b', source: 'origin' },
    });
    expect(mergeRequestToReference({
      number: 9, title: 'MR', url: 'https://gitlab.example.com/a/b/-/merge_requests/9', state: 'merged',
      draft: false, base: 'main', head: 'feature', headSha: 'abc', project, labels: [],
    })).toMatchObject({
      kind: 'pull', state: 'merged', draft: false, head: 'feature', base: 'main', headSha: 'abc',
      sourceRepo: { owner: 'a', repo: 'b', source: 'origin' },
    });
  });
});

describe('runAcrossSearch', () => {
  it('reads folders with bounded concurrency and keeps each folder status', async () => {
    const input = readGitLabAcrossRequest(request([context('/a'), context('/b'), context('/c'), context('/bad')]));
    const active = { value: 0, peak: 0 };
    const readPage = vi.fn(async (trusted, page) => {
      active.value += 1;
      active.peak = Math.max(active.peak, active.value);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active.value -= 1;
      if (trusted.directory === '/bad') throw new Error('host failed');
      return {
        status: 'included',
        target: { owner: 'a', repo: trusted.directory.slice(1), url: `https://gitlab.example.com/a/${trusted.directory.slice(1)}` },
        items: [reference(Number(trusted.directory.slice(-1)))],
        hasMore: false,
      };
    });
    const result = await runAcrossSearch({
      input,
      validateContext: async (value) => value,
      readPage,
    });

    expect(active.peak).toBeLessThanOrEqual(4);
    expect(readPage).toHaveBeenCalledTimes(4);
    expect(result.items.map((item) => item.directory).sort()).toEqual(['/a', '/b', '/c']);
    expect(result.repositories.map((repo) => [repo.directory, repo.status])).toEqual([
      ['/a', 'included'], ['/b', 'included'], ['/c', 'included'], ['/bad', 'error'],
    ]);
    expect(result.cursor).toBeNull();
  });

  it('returns each GitLab issue once when two folders resolve to the same project', async () => {
    const instance = 'https://gitlab.example.com';
    const target = { owner: 'root', repo: 'openchamber', url: `${instance}/root/openchamber` };
    const readPage = vi.fn(async () => ({
      status: 'included', target,
      items: [{ ...reference(1), sourceRepo: { owner: 'root', repo: 'openchamber', source: 'origin' } }],
      hasMore: false,
    }));
    const result = await runAcrossSearch({
      input: readGitLabAcrossRequest(request([context('/first'), context('/second')])),
      validateContext: async (value) => value,
      readPage,
    });
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(1);
    expect(result.repositories.map((repo) => repo.status)).toEqual(['included', 'included']);
  });

  it('keeps issues from different GitLab instances with the same project path', async () => {
    const left = { ...context('/first'), instance: 'https://gitlab.com' };
    const right = { ...context('/second'), instance: 'http://localhost:8929' };
    const target = { owner: 'root', repo: 'openchamber', url: 'http://localhost:8929/root/openchamber' };
    const readPage = vi.fn(async () => ({
      status: 'included', target,
      items: [{ ...reference(5), sourceRepo: { owner: 'root', repo: 'openchamber', source: 'origin' } }],
      hasMore: false,
    }));
    const result = await runAcrossSearch({
      input: readGitLabAcrossRequest(request([left, right])),
      validateContext: async (value) => value,
      readPage,
    });
    expect(result.items).toHaveLength(2);
    expect(new Set(result.items.map((item) => item.directory))).toEqual(new Set(['/first', '/second']));
  });

  it('passes the validated context to the page read', async () => {
    const trusted = { ...context('/a'), instance: 'https://gitlab.example.com' };
    const readPage = vi.fn(async () => ({ status: 'included', target: { owner: 'a', repo: 'a', url: 'https://gitlab.example.com/a/a' }, items: [], hasMore: false }));
    await runAcrossSearch({
      input: readGitLabAcrossRequest(request([context('/a')])),
      validateContext: async () => trusted,
      readPage,
    });
    expect(readPage.mock.calls[0][0]).toBe(trusted);
  });

  it('reads a shared project once for directories on the same remote', async () => {
    const origin = 'https://gitlab.example.com';
    const client = {
      Projects: {
        show: vi.fn(async () => ({
          id: 42, path_with_namespace: 'a/b', web_url: `${origin}/a/b`, forked_from_project: null,
        })),
      },
      Issues: {
        all: vi.fn(async () => ({ data: [{
          iid: 1, title: 'Issue', web_url: `${origin}/a/b/-/issues/1`, description: '', state: 'opened',
          author: { id: 9, username: 'dev' }, labels: [], created_at: '2026-11-01', updated_at: '2026-11-02',
        }], paginationInfo: { next: null } })),
      },
    };
    const resolveProjects = vi.fn(async () => ({ projects: [{ projectPath: 'a/b', url: `${origin}/a/b`, remoteName: 'origin' }] }));
    const service = createGitLabResourceService({ origin, client, resolveProjects });
    const requestCache = { projects: new Map(), pages: new Map() };
    const pageOptions = { kind: 'issue', labels: [], query: '' };

    const [first, second] = await Promise.all([
      service.referencesAcrossPage({ directory: '/first', primaryRemote: 'origin' }, 1, pageOptions, requestCache),
      service.referencesAcrossPage({ directory: '/second', primaryRemote: 'origin' }, 1, pageOptions, requestCache),
    ]);

    expect(client.Projects.show).toHaveBeenCalledTimes(1);
    expect(resolveProjects).toHaveBeenCalledTimes(2);
    expect(client.Issues.all).toHaveBeenCalledTimes(1);
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
  });

  it('does not share a cached project page between accounts', async () => {
    const origin = 'https://gitlab.example.com';
    const client = {
      Projects: {
        show: vi.fn(async () => ({
          id: 42, path_with_namespace: 'a/b', web_url: `${origin}/a/b`, forked_from_project: null,
        })),
      },
      Issues: {
        all: vi.fn(async () => ({ data: [], paginationInfo: { next: null } })),
      },
    };
    const service = createGitLabResourceService({
      origin, client,
      resolveProjects: async () => ({ projects: [{ projectPath: 'a/b', url: `${origin}/a/b`, remoteName: 'origin' }] }),
    });
    const requestCache = { projects: new Map(), pages: new Map() };
    const pageOptions = { kind: 'issue', labels: [], query: '' };

    await Promise.all([
      service.referencesAcrossPage({ directory: '/first', primaryRemote: 'origin', accountId: 'acct#1' }, 1, pageOptions, requestCache),
      service.referencesAcrossPage({ directory: '/second', primaryRemote: 'origin', accountId: 'acct#2' }, 1, pageOptions, requestCache),
    ]);

    expect(client.Projects.show).toHaveBeenCalledTimes(2);
    expect(client.Issues.all).toHaveBeenCalledTimes(2);
  });

  it('serves the provider resource with one session per folder', async () => {
    const readPage = vi.fn(async (value, page) => ({
      status: 'included',
      target: { owner: 'a', repo: value.directory.slice(1), url: `https://gitlab.example.com/a/${value.directory.slice(1)}` },
      items: page === null ? [] : [reference(1)],
      hasMore: false,
    }));
    const account = {
      token: 'stored', source: 'pat', status: 'valid', credentialId: 'cred#1', credentialRevision: 1,
      providerUserId: 'https://gitlab.example.com#9', user: { id: 9 },
    };
    const provider = createProvider({
      store: {
        readInstance: vi.fn(async () => ({ accounts: [{ ...account, id: 'acct#1' }], activeAccountId: 'acct#1', cliDisabled: false, cliActive: false })),
        readAccount: vi.fn(async () => ({ ...account, id: 'acct#1' })),
      },
      events: { connected: vi.fn(), invalidated: vi.fn(), removed: vi.fn() },
      createClient: () => ({}),
      createDownloader: () => () => undefined,
      createResourceService: () => ({ referencesAcrossPage: readPage }),
    });

    const result = await provider.resources.referencesAcross({
      body: request([context('/a'), context('/b', 'acct#1')]),
      validateReadContext: async (value) => value,
    });

    expect(readPage).toHaveBeenCalledTimes(2);
    expect(result.repositories.map((repo) => [repo.directory, repo.status])).toEqual([['/a', 'included'], ['/b', 'included']]);
    expect(result.items).toHaveLength(2);
  });
});
