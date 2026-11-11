import { describe, expect, test } from 'bun:test';
import { parseCustomProviderLogos, parseProjects } from './parsers';

describe('parseCustomProviderLogos', () => {
  test('keeps well-formed entries and drops the rest one by one', () => {
    const raw = {
      acme: { mime: 'image/png', updatedAt: 1794114747809 },
      ' campus-llm ': { mime: 'image/svg+xml', updatedAt: 2 },
      gif: { mime: 'image/gif', updatedAt: 3 },
      stale: { mime: 'image/webp', updatedAt: 0 },
      '  ': { mime: 'image/png', updatedAt: 4 },
      broken: 'image/png',
    };

    expect(parseCustomProviderLogos(raw, {})).toEqual({
      acme: { mime: 'image/png', updatedAt: 1794114747809 },
      'campus-llm': { mime: 'image/svg+xml', updatedAt: 2 },
    });
    expect(parseCustomProviderLogos(['acme'], {})).toBeUndefined();
    expect(parseCustomProviderLogos(null, {})).toBeUndefined();
  });
});

describe('parseProjects', () => {
  test('keeps per-project agent, model and thinking defaults across a settings round trip', () => {
    const projects = [
      { path: '/repo/app', label: 'App', defaultAgent: ' reviewer ', defaultModel: 'openai/gpt-5.6', defaultVariant: 'low' },
      { path: '/repo/lib', defaultAgent: ' ', defaultModel: '  ', defaultVariant: 42 },
      { path: '/repo/legacy' },
    ];
    const parsed = parseProjects(projects, { projects });

    expect(parsed?.map((project) => [project.path, project.defaultAgent, project.defaultModel, project.defaultVariant])).toEqual([
      ['/repo/app', 'reviewer', 'openai/gpt-5.6', 'low'],
      ['/repo/lib', undefined, undefined, undefined],
      ['/repo/legacy', undefined, undefined, undefined],
    ]);
    expect(parseProjects(parsed, { projects: parsed })).toEqual(parsed);
  });

  test('keeps autoDispatchIssues across a settings round trip', () => {
    const projects = [
      { path: '/repo/app', autoDispatchIssues: true },
      { path: '/repo/lib' },
      { path: '/repo/bad', autoDispatchIssues: false },
    ];
    const parsed = parseProjects(projects, { projects });

    expect(parsed?.map((project) => project.autoDispatchIssues)).toEqual([true, undefined, undefined]);
    expect(parseProjects(parsed, { projects: parsed })).toEqual(parsed);
  });

  test('keeps GitLab issue automation fields across a settings round trip', () => {
    const projects = [
      {
        path: '/repo/app', autoDispatchGitlabIssues: true,
        gitlabIssueBranchPrefix: 'team/bot/', gitlabIssueBotAccountId: 'acc-1',
        gitlabIssueTimeoutMinutes: 45,
      },
      { path: '/repo/lib' },
      { path: '/repo/bad', gitlabIssueTimeoutMinutes: 0, gitlabIssueBranchPrefix: '' },
      { path: '/repo/edited', gitlabIssueBranchPrefix: 'bad prefix/', gitlabIssueTimeoutMinutes: 0 },
    ];
    const parsed = parseProjects(projects, { projects });

    expect(parsed?.[0]).toMatchObject({
      autoDispatchGitlabIssues: true,
      gitlabIssueBranchPrefix: 'team/bot/',
      gitlabIssueBotAccountId: 'acc-1',
      gitlabIssueTimeoutMinutes: 45,
    });
    expect(parsed?.[1]).not.toHaveProperty('gitlabIssueTimeoutMinutes');
    expect(parsed?.[2]).not.toHaveProperty('gitlabIssueBranchPrefix');
    expect(parsed?.[2]).toMatchObject({ gitlabIssueTimeoutMinutes: 0 });
    expect(parsed?.[3]).toMatchObject({
      gitlabIssueBranchPrefix: 'bad prefix/',
      gitlabIssueTimeoutMinutes: 0,
    });
    expect(parseProjects(parsed, { projects: parsed })).toEqual(parsed);
  });
});
