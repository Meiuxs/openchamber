import { describe, expect, it } from 'vitest';

import { createSettingsNormalizationRuntime } from './settings-normalization-runtime.js';

const createTestRuntime = ({ canonicalPathOf, ...overrides } = {}) => {
  const defaults = {
    os: { homedir: () => '/home/testuser' },
    path: {
      resolve: (...args) => args[args.length - 1],
      sep: '/',
      dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
    },
    processLike: { platform: 'linux', env: {} },
    tunnelBootstrapTtlDefaultMs: 600000,
    tunnelBootstrapTtlMinMs: 60000,
    tunnelBootstrapTtlMaxMs: 3600000,
    tunnelSessionTtlDefaultMs: 86400000,
    tunnelSessionTtlMinMs: 3600000,
    tunnelSessionTtlMaxMs: 604800000,
  };

  return createSettingsNormalizationRuntime({ ...defaults, ...overrides, canonicalPaths: canonicalPathOf && { of: canonicalPathOf, refresh: async () => {} } });
};

describe('settings normalization runtime - symlink resolution', () => {
  describe('normalizePathForPersistence', () => {
    it('stores the canonical path', () => {
      const runtime = createTestRuntime({
        canonicalPathOf: (p) =>
          p === '/home/user/workplace' ? '/workplace/user' : p,
      });

      const result = runtime.normalizePathForPersistence('/home/user/workplace');
      expect(result).toBe('/workplace/user');
    });

    it('passes through when no canonical path is known', () => {
      const runtime = createTestRuntime({ canonicalPathOf: undefined });

      const result = runtime.normalizePathForPersistence('/some/path');
      expect(result).toBe('/some/path');
    });

    it('preserves lowercase colon-prefixed paths on non-Windows platforms', () => {
      const runtime = createTestRuntime({ canonicalPathOf: undefined });

      expect(runtime.normalizePathForPersistence('c:project')).toBe('c:project');
    });

    it('uppercases Windows drive letter before and after realpath resolution', () => {
      const runtime = createTestRuntime({
        processLike: { platform: 'win32', env: {} },
        canonicalPathOf: (p) => {
          // A resolver can answer with a lowercase drive letter
          if (p === 'C:\\Users\\me\\project') return 'c:\\real\\project';
          return p;
        },
      });

      const result = runtime.normalizePathForPersistence('c:\\Users\\me\\project');
      // Drive letter uppercased on input AND after realpath
      expect(result).toBe('C:\\real\\project');
    });
  });

  describe('sanitizeProjects', () => {
    it('resolves symlinks in project paths', () => {
      const runtime = createTestRuntime({
        canonicalPathOf: (p) =>
          p === '/home/user/workplace/MyProject'
            ? '/workplace/user/MyProject'
            : p,
      });

      const projects = [
        { id: 'proj1', path: '/home/user/workplace/MyProject', label: 'MyProject', color: 'primary', addedAt: 1000, lastOpenedAt: 1000 },
      ];

      const result = runtime.sanitizeProjects(projects);
      expect(result[0].path).toBe('/workplace/user/MyProject');
    });

    it('keeps a default thinking level next to its model and drops it alone', () => {
      const runtime = createTestRuntime({
        canonicalPathOf: (p) => p,
        path: { resolve: (p) => p, sep: '/', dirname: (p) => p.split('/').slice(0, -1).join('/') || '/' },
      });

      const projects = [
        { id: 'proj1', path: '/a', defaultModel: 'anthropic/claude-opus-5', defaultVariant: 'high' },
        { id: 'proj2', path: '/b', defaultVariant: 'high' },
      ];

      const result = runtime.sanitizeProjects(projects);
      expect(result[0].defaultVariant).toBe('high');
      expect(result[1].defaultVariant).toBe(undefined);
    });

    it('keeps a project default agent', () => {
      const runtime = createTestRuntime({
        canonicalPathOf: (p) => p,
        path: { resolve: (p) => p, sep: '/', dirname: (p) => p.split('/').slice(0, -1).join('/') || '/' },
      });

      const result = runtime.sanitizeProjects([
        { id: 'proj1', path: '/a', defaultAgent: 'plan' },
      ]);

      expect(result[0].defaultAgent).toBe('plan');
    });

    it('keeps the label source next to the label it describes', () => {
      const runtime = createTestRuntime();

      const result = runtime.sanitizeProjects([
        { id: 'proj1', path: '/a', label: 'Example', labelSource: 'manual' },
        { id: 'proj2', path: '/b', label: 'Billing', labelSource: 'nonsense' },
        { id: 'proj3', path: '/c', labelSource: 'manual' },
        { id: 'proj4', path: '/d', label: 'd', labelSource: 'auto' },
      ]);

      expect(result[0].labelSource).toBe('manual');
      expect(result[1].labelSource).toBe(undefined);
      expect(result[2].labelSource).toBe(undefined);
      expect(result[3].labelSource).toBe('auto');
      expect(runtime.sanitizeProjects(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it('keeps a valid project issuesDir and omits it when absent', () => {
      const runtime = createTestRuntime();

      const result = runtime.sanitizeProjects([
        { id: 'proj1', path: '/a', issuesDir: '  plan/issues  ' },
        { id: 'proj2', path: '/b' },
      ]);

      expect(result[0].issuesDir).toBe('plan/issues');
      expect(result[1].issuesDir).toBe(undefined);
    });

    it('stores autoDispatchIssues only when true and round-trips it', () => {
      const runtime = createTestRuntime();

      const result = runtime.sanitizeProjects([
        { id: 'proj1', path: '/a', autoDispatchIssues: true },
        { id: 'proj2', path: '/b', autoDispatchIssues: false },
        { id: 'proj3', path: '/c', autoDispatchIssues: 'yes' },
        { id: 'proj4', path: '/d' },
      ]);

      expect(result[0].autoDispatchIssues).toBe(true);
      expect(result[1].autoDispatchIssues).toBe(undefined);
      expect(result[2].autoDispatchIssues).toBe(undefined);
      expect(result[3].autoDispatchIssues).toBe(undefined);
      expect(runtime.sanitizeProjects(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it('stores GitLab issue automation fields and keeps invalid values so the page can explain them', () => {
      const runtime = createTestRuntime();

      const result = runtime.sanitizeProjects([
        {
          id: 'proj1', path: '/a', autoDispatchGitlabIssues: true,
          gitlabIssueBranchPrefix: 'team/bot/', gitlabIssueBotAccountId: 'acc-1',
          gitlabIssueTimeoutMinutes: 45,
          gitlabIssueReviewAgent: ' review-changes ', gitlabIssueVerifyCommand: ' bun run check ',
          gitlabIssueSecondReview: false, gitlabIssueAutoCloseNotAnIssue: false,
        },
        {
          id: 'proj2', path: '/b', autoDispatchGitlabIssues: false,
          gitlabIssueBranchPrefix: 'bad prefix/', gitlabIssueBotAccountId: ' ',
          gitlabIssueTimeoutMinutes: 0,
          gitlabIssueReviewAgent: '   ', gitlabIssueVerifyCommand: '  ',
          gitlabIssueSecondReview: 'no', gitlabIssueAutoCloseNotAnIssue: 1,
        },
        {
          id: 'proj3', path: '/c', autoDispatchGitlabIssues: true,
          gitlabIssueBranchPrefix: 'openchamber', gitlabIssueBotAccountId: 'acc-2',
          gitlabIssueTimeoutMinutes: '30',
        },
      ]);

      expect(result[0]).toMatchObject({
        autoDispatchGitlabIssues: true,
        gitlabIssueBranchPrefix: 'team/bot/',
        gitlabIssueBotAccountId: 'acc-1',
        gitlabIssueTimeoutMinutes: 45,
        // The recheck and close gates are opt-out: an explicit false must
        // survive the round trip, and absence stays absence.
        gitlabIssueReviewAgent: 'review-changes', gitlabIssueVerifyCommand: 'bun run check',
        gitlabIssueSecondReview: false, gitlabIssueAutoCloseNotAnIssue: false,
      });
      expect(result[1]).not.toHaveProperty('autoDispatchGitlabIssues');
      expect(result[1]).toMatchObject({
        gitlabIssueBranchPrefix: 'bad prefix/',
        gitlabIssueTimeoutMinutes: 0,
      });
      expect(result[1]).not.toHaveProperty('gitlabIssueBotAccountId');
      expect(result[1]).not.toHaveProperty('gitlabIssueReviewAgent');
      expect(result[1]).not.toHaveProperty('gitlabIssueVerifyCommand');
      expect(result[1]).not.toHaveProperty('gitlabIssueSecondReview');
      expect(result[1]).not.toHaveProperty('gitlabIssueAutoCloseNotAnIssue');
      expect(result[2]).toMatchObject({ gitlabIssueBranchPrefix: 'openchamber' });
      expect(result[2]).not.toHaveProperty('gitlabIssueTimeoutMinutes');
      expect(runtime.sanitizeProjects(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it('nulls an absolute project issuesDir on either separator family', () => {
      const runtime = createTestRuntime();

      const result = runtime.sanitizeProjects([
        { id: 'proj1', path: '/a', issuesDir: '/etc/escape' },
        { id: 'proj2', path: '/b', issuesDir: 'C:\\escape' },
        { id: 'proj3', path: '/c', issuesDir: 'C:/escape' },
      ]);

      expect(result[0].issuesDir).toBe(null);
      expect(result[1].issuesDir).toBe(null);
      expect(result[2].issuesDir).toBe(null);
    });

    it('nulls a project issuesDir whose segments escape the project', () => {
      const runtime = createTestRuntime();

      const result = runtime.sanitizeProjects([
        { id: 'proj1', path: '/a', issuesDir: '../escape' },
        { id: 'proj2', path: '/b', issuesDir: 'plan\\..\\escape' },
        { id: 'proj3', path: '/c', issuesDir: '..' },
        // Win32 normalization strips trailing dots/spaces per component, so
        // these segments resolve as `..` on Windows and must escape too.
        { id: 'proj4', path: '/d', issuesDir: 'plan/.. /escape' },
        { id: 'proj5', path: '/e', issuesDir: 'plan\\.. .\\escape' },
      ]);

      expect(result[0].issuesDir).toBe(null);
      expect(result[1].issuesDir).toBe(null);
      expect(result[2].issuesDir).toBe(null);
      expect(result[3].issuesDir).toBe(null);
      expect(result[4].issuesDir).toBe(null);
    });

    it('keeps project issuesDir segments that only look like escapes', () => {
      const runtime = createTestRuntime();

      const result = runtime.sanitizeProjects([
        { id: 'proj1', path: '/a', issuesDir: '....' },
        { id: 'proj2', path: '/b', issuesDir: '..foo' },
        { id: 'proj3', path: '/c', issuesDir: 'foo..' },
      ]);

      expect(result[0].issuesDir).toBe('....');
      expect(result[1].issuesDir).toBe('..foo');
      expect(result[2].issuesDir).toBe('foo..');
    });

    it('nulls a non-string project issuesDir', () => {
      const runtime = createTestRuntime();

      const result = runtime.sanitizeProjects([
        { id: 'proj1', path: '/a', issuesDir: 42 },
        { id: 'proj2', path: '/b', issuesDir: null },
        { id: 'proj3', path: '/c', issuesDir: '   ' },
      ]);

      expect(result[0].issuesDir).toBe(null);
      expect(result[1].issuesDir).toBe(null);
      expect(result[2].issuesDir).toBe(null);
    });

    it('deduplicates projects that resolve to the same realpath', () => {
      const runtime = createTestRuntime({
        canonicalPathOf: (p) => p.startsWith('/symlink') ? '/real/project' : p,
        path: { resolve: (p) => p, sep: '/', dirname: (p) => p.split('/').slice(0, -1).join('/') || '/' },
      });

      const projects = [
        { id: 'proj1', path: '/symlink/a', label: 'A', color: 'primary', addedAt: 1000, lastOpenedAt: 1000 },
        { id: 'proj2', path: '/symlink/b', label: 'B', color: 'keyword', addedAt: 2000, lastOpenedAt: 2000 },
      ];

      const result = runtime.sanitizeProjects(projects);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('proj1');
    });
  });

  describe('normalizeSettingsPaths', () => {
    it('resolves symlinks in lastDirectory', () => {
      const runtime = createTestRuntime({
        canonicalPathOf: (p) =>
          p === '/home/user/workplace/LyraRefactoring'
            ? '/workplace/user/LyraRefactoring'
            : p,
      });

      const result = runtime.normalizeSettingsPaths({
        lastDirectory: '/home/user/workplace/LyraRefactoring',
      });

      expect(result.changed).toBe(true);
      expect(result.settings.lastDirectory).toBe('/workplace/user/LyraRefactoring');
    });

    it('does not flag as changed when path is already canonical', () => {
      const runtime = createTestRuntime();

      const result = runtime.normalizeSettingsPaths({
        lastDirectory: '/real/path',
      });

      expect(result.changed).toBe(false);
    });
  });
});
