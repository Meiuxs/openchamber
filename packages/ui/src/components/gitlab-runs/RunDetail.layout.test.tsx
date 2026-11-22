import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

import type { Run } from './runModel';

const branch = 'openchamber/issue-1-docs-document-the-local-gitlab-port-in-runs';

const target: Run = {
  key: 'run-1',
  origin: 'gitlab.example.com',
  projectEntryId: 'project-1',
  iid: 1,
  title: 'document the local GitLab port',
  kind: 'bug',
  phase: 'done',
  blockedReason: null,
  blockedFrom: null,
  lastError: null,
  branch,
  targetBranch: 'main',
  worktreePath: '/worktrees/issue-1',
  mrIid: 1,
  issueUrl: 'https://gitlab.example.com/openchamber/-/issues/1',
  mrUrl: 'https://gitlab.example.com/openchamber/-/merge_requests/1',
  attempts: 1,
  reviewRounds: 0,
  feedbackRounds: 0,
  reviewVerdict: null,
  triageVerdict: null,
  outcome: null,
  since: '2026-11-15T09:40:00.000Z',
  updatedAt: null,
  sessionId: null,
  sessionStatus: null,
  sessions: [],
  events: [],
  issueState: null,
  triage: null,
  plan: null,
  evidence: null,
  reviewFindings: [],
  reviewImpact: null,
};

mock.module('./useRunFiles', () => ({ useRunFiles: () => ({ files: [], loading: false }) }));

const { RunDetail } = await import('./RunDetail');

const render = (account: string | null = '@root', multiAccounts = false) => renderToStaticMarkup(
  <I18nProvider>
    <RunDetail
      run={target}
      account={account}
      multiAccounts={multiAccounts}
      onBack={() => undefined}
      onOpenSession={() => undefined}
      onAction={() => undefined}
      onOpenSettings={() => undefined}
    />
  </I18nProvider>,
);

test('keeps the full branch readable while the visible name is shortened', () => {
  const html = render();

  // The row clips a long branch visually; the whole name stays in the element
  // and one hover away.
  expect(html).toContain(`title="${branch}"`);
  expect(html).toContain(`>${branch}</code>`);
});

test('names the acting account beside the run title, not among the run facts', () => {
  const html = render();

  // One badge, described in words for people who do not know the shorthand.
  expect(html.split('@root').length - 1).toBe(2);
  expect(html).toContain('title="as @root"');
});

test('leaves the identity out when the action will ask which account to use', () => {
  const html = render('@root', true);

  expect(html).not.toContain('@root');
});
