import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRANCH_PREFIX, TemplateError, buildIssueBranch, createGitlabIssueApi,
  findAccountForUser, isValidBranchPrefix, isValidGitRefName, matchReusableBranch,
  parseIssueTemplate, resolveAccount, resolveProjectConfig, slugifyIssueTitle,
} from './gitlab.js';

const issue = (description) => ({ description });

describe('GitLab issue template parsing', () => {
  it('reads bug and feature from the template line', () => {
    expect(parseIssueTemplate(issue('类型: bug\n目标分支: ``'))).toEqual({ kind: 'bug', targetBranch: '' });
    expect(parseIssueTemplate(issue('类型: feature\n目标分支: `release/2.8`'))).toEqual({ kind: 'feature', targetBranch: 'release/2.8' });
  });

  it('blocks a missing or unknown type', () => {
    expect(() => parseIssueTemplate(issue('no template'))).toThrow(TemplateError);
    expect(() => parseIssueTemplate(issue('类型: chore'))).toThrow(TemplateError);
    expect(() => parseIssueTemplate(issue('类型: bug\n目标分支: `bad branch`'))).toThrow(TemplateError);
  });

  it('treats a missing target line as the default branch and an empty backtick value as default', () => {
    expect(parseIssueTemplate(issue('类型: bug')).targetBranch).toBe('');
    expect(parseIssueTemplate(issue('类型: bug\n目标分支:')).targetBranch).toBe('');
  });
});

describe('GitLab issue branch names', () => {
  it('slugifies ASCII titles and drops non-ASCII ones', () => {
    expect(slugifyIssueTitle('Fix Login Timeout!')).toBe('fix-login-timeout');
    expect(slugifyIssueTitle('修复登录超时')).toBe('');
    expect(buildIssueBranch(DEFAULT_BRANCH_PREFIX, 17, '修复登录超时')).toBe('openchamber/issue-17');
    expect(buildIssueBranch(DEFAULT_BRANCH_PREFIX, 17, 'Fix Login')).toBe('openchamber/issue-17-fix-login');
  });

  it('caps the slug at forty characters and trims hyphens', () => {
    expect(slugifyIssueTitle('---a very long title that goes well past the cap---'))
      .toBe('a-very-long-title-that-goes-well-past-th');
  });

  it('reuses a branch only under the configured prefix and issue number', () => {
    const branches = [
      { name: 'openchamber/issue-17-old-title' },
      { name: 'openchamber/issue-170-x' },
      { name: 'other/issue-17-x' },
    ];
    expect(matchReusableBranch(branches, 'openchamber/', 17)).toBe('openchamber/issue-17-old-title');
    expect(matchReusableBranch(branches, 'other/', 17)).toBe('other/issue-17-x');
    expect(matchReusableBranch([], 'openchamber/', 17)).toBeNull();
  });

  it('validates prefixes and ref names', () => {
    expect(isValidBranchPrefix('openchamber/')).toBe(true);
    expect(isValidBranchPrefix('team/bot/')).toBe(true);
    expect(isValidBranchPrefix('openchamber')).toBe(false);
    expect(isValidBranchPrefix('/bad/')).toBe(false);
    expect(isValidBranchPrefix('bad space/')).toBe(false);
    expect(isValidGitRefName('openchamber/issue-1-fix')).toBe(true);
    expect(isValidGitRefName('bad branch')).toBe(false);
    expect(isValidGitRefName('a..b')).toBe(false);
    expect(isValidGitRefName('-dash')).toBe(false);
    expect(isValidGitRefName('release/v1./x')).toBe(false);
    expect(isValidBranchPrefix('release/v1./')).toBe(false);
  });

  it('resolves disabled, incomplete, and default project configs', () => {
    expect(resolveProjectConfig({}).enabled).toBe(false);
    expect(resolveProjectConfig({ autoDispatchGitlabIssues: true, gitlabIssueBotAccountId: '' }).enabled).toBe(false);
    expect(resolveProjectConfig({
      autoDispatchGitlabIssues: true, gitlabIssueBotAccountId: 'acc-1',
    })).toEqual({
      enabled: true, botAccountId: 'acc-1', prefix: 'openchamber/', timeoutMinutes: 30,
    });
    expect(resolveProjectConfig({
      autoDispatchGitlabIssues: true, gitlabIssueBotAccountId: 'acc-1',
      gitlabIssueBranchPrefix: 'bad prefix/', gitlabIssueTimeoutMinutes: 0,
    }).enabled).toBe(false);
    expect(resolveProjectConfig({
      autoDispatchGitlabIssues: true, gitlabIssueBotAccountId: 'acc-1',
      gitlabIssueTimeoutMinutes: '30',
    }).enabled).toBe(false);
  });
});

const paged = (data) => async () => ({ data, paginationInfo: { next: null } });

const apiFixture = () => {
  const client = {
    Users: { showCurrentUser: async () => ({ id: 9, username: 'bot', name: 'Bot', email: 'bot@example.com' }) },
    Projects: { show: async (id) => ({ id, default_branch: 'main' }) },
    Issues: {
      all: paged([{ iid: 17, labels: [{ name: 'ai-ready' }] }]),
      show: async () => ({ iid: 17, state: 'opened', labels: [{ name: 'ai-ready' }] }),
      edit: async () => ({ ok: true }),
    },
    IssueNotes: {
      all: paged([{ id: 30, body: '/ai-approve', created_at: '2026-11-12T10:00:00Z', author: { id: 7 } }]),
      create: async () => ({ id: 31 }),
    },
    IssueLabelEvents: {
      all: paged([{ label: { name: 'ai-ready' }, action: 'add', user: { id: 7 }, created_at: '2026-11-12T09:00:00Z' }]),
    },
    ProjectMembers: { all: paged([{ id: 7, access_level: 30 }]) },
    Branches: {
      all: paged([{ name: 'openchamber/issue-17-old' }]),
      show: async () => ({ name: 'main' }),
    },
    MergeRequests: {
      all: paged([{ iid: 5, state: 'opened', web_url: 'https://gitlab.example.com/mr/5' }]),
      create: async () => ({ iid: 5, web_url: 'https://gitlab.example.com/mr/5' }),
      show: async () => ({ iid: 5, state: 'opened' }),
    },
  };
  return { client, api: createGitlabIssueApi({ client }) };
};

describe('GitLab issue API service', () => {
  it('posts notes and edits labels through GitBeaker argument shapes', async () => {
    const { client, api } = apiFixture();
    const created = [];
    client.IssueNotes.create = async (...args) => { created.push(args); return { id: 31 }; };
    const edited = [];
    client.Issues.edit = async (...args) => { edited.push(args); };

    await expect(api.postNote(42, 17, 'claimed')).resolves.toBe(31);
    await api.addLabels(42, 17, ['ai-working']);
    await api.removeLabels(42, 17, ['ai-ready']);

    expect(created).toEqual([[42, 17, 'claimed']]);
    expect(edited).toEqual([
      [42, 17, { addLabels: 'ai-working' }],
      [42, 17, { removeLabels: 'ai-ready' }],
    ]);
  });

  it('reads the newest non-bot ai-ready label event and the triggerer access level', async () => {
    const { client, api } = apiFixture();
    client.IssueLabelEvents.all = paged([
      { label: { name: 'ai-ready' }, action: 'add', user: { id: 9 }, created_at: '2026-11-12T10:00:00Z' },
      { label: { name: 'ai-ready' }, action: 'remove', user: { id: 7 }, created_at: '2026-11-12T11:00:00Z' },
      { label: { name: 'ai-ready' }, action: 'add', user: { id: 7 }, created_at: '2026-11-12T09:00:00Z' },
    ]);
    await expect(api.latestTriggerer(42, 17, 9)).resolves.toEqual({ userId: 7 });
    await expect(api.accessLevelOf(42, 7)).resolves.toBe(30);
  });

  it('reads only the newest explicit command after the phase started', async () => {
    const { client, api } = apiFixture();
    client.IssueNotes.all = paged([
      { id: 21, body: '/ai-approve', created_at: '2026-11-12T09:00:00Z', author: { id: 7 } },
      { id: 22, body: 'ordinary comment', created_at: '2026-11-12T10:00:00Z', author: { id: 7 } },
      { id: 23, body: '/ai-reject', created_at: '2026-11-12T10:30:00Z', author: { id: 7 } },
      { id: 24, body: '/ai-approve', created_at: '2026-11-12T11:00:00Z', author: { id: 9 } },
    ]);
    await expect(api.latestCommand(42, 17, {
      sinceIso: '2026-11-12T10:00:00Z', botUserId: 9,
      commands: ['/ai-approve', '/ai-reject'],
    })).resolves.toEqual({ command: '/ai-reject', userId: 7, noteId: 23 });
  });

  it('ignores the newest command when its author is below Developer', async () => {
    const { client, api } = apiFixture();
    client.ProjectMembers.all = paged([{ id: 7, access_level: 30 }, { id: 8, access_level: 20 }]);
    client.IssueNotes.all = paged([
      { id: 40, body: '/ai-approve', created_at: '2026-11-12T10:00:00Z', author: { id: 7 } },
      { id: 41, body: '/ai-reject', created_at: '2026-11-12T10:30:00Z', author: { id: 8 } },
    ]);
    await expect(api.latestCommand(42, 17, {
      sinceIso: '2026-11-12T09:00:00Z',
      botUserId: 9,
      commands: ['/ai-approve', '/ai-reject'],
      minAccessLevel: 30,
    })).resolves.toEqual({ command: '/ai-approve', userId: 7, noteId: 40 });
  });

  it('adopts an existing open merge request for the branch', async () => {
    const { api } = apiFixture();
    await expect(api.listOpenMergeRequests(42, 'openchamber/issue-17-x'))
      .resolves.toEqual([{ iid: 5, state: 'opened', web_url: 'https://gitlab.example.com/mr/5' }]);
  });

  it('scans at most three pages of open issues per call', async () => {
    const { client, api } = apiFixture();
    const pages = [];
    client.Issues.all = async ({ page }) => {
      pages.push(page);
      return {
        data: [{ iid: page, labels: [{ name: 'ai-ready' }] }],
        paginationInfo: { next: page + 1 },
      };
    };
    await expect(api.listOpenIssues(42)).resolves.toHaveLength(3);
    expect(pages).toEqual([1, 2, 3]);
  });
});

describe('GitLab account resolution', () => {
  const accounts = [{
    credentialId: 'acc-1', credentialRevision: 1, providerUserId: 'https://gitlab.example.com#7',
    token: 't', source: 'pat', status: 'valid',
    user: { id: 7, login: 'sam', name: 'Sam', email: 'sam@example.com' },
  }];
  const authStore = {
    readAccount: async (origin, id) => (origin === 'https://gitlab.example.com' && id === 'acc-1' ? accounts[0] : null),
    listAccounts: async (origin) => (origin === 'https://gitlab.example.com' ? accounts : []),
  };

  it('resolves by account id on the same origin only', async () => {
    await expect(resolveAccount(authStore, 'https://gitlab.example.com', 'acc-1'))
      .resolves.toMatchObject({ credentialId: 'acc-1' });
    await expect(resolveAccount(authStore, 'https://other.example.com', 'acc-1')).resolves.toBeNull();
  });

  it('finds an account for a GitLab user on the same origin only', async () => {
    await expect(findAccountForUser(authStore, 'https://gitlab.example.com', 7))
      .resolves.toMatchObject({ credentialId: 'acc-1' });
    await expect(findAccountForUser(authStore, 'https://gitlab.example.com', 8)).resolves.toBeNull();
    await expect(findAccountForUser(authStore, 'https://other.example.com', 7)).resolves.toBeNull();
  });
});
