import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

import { RunDetail } from './RunDetail';
import type { Run } from './runModel';

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
  branch: 'openchamber/issue-1-docs',
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
  recordPath: '/repo/.openchamber/issue-records/openchamber/issue-1.md',
  projectDirectory: '/repo',
};

const render = (run: Run) => renderToStaticMarkup(
  <I18nProvider>
    <RunDetail
      run={run}
      account="@root"
      multiAccounts={false}
      onBack={() => undefined}
      onOpenSession={() => undefined}
      onAction={() => undefined}
      onOpenSettings={() => undefined}
    />
  </I18nProvider>,
);

test('offers the delivery note beside the issue and merge request links', () => {
  const html = render(target);

  expect(html).toContain('Delivery note');
});

test('leaves the delivery note out when the run has none', () => {
  const html = render({ ...target, recordPath: null, projectDirectory: null });

  expect(html).not.toContain('Delivery note');
});
