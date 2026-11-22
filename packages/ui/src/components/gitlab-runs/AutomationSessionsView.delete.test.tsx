import React, { act } from 'react';
import { expect, mock, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { useSessionUIStore } from '@/sync/session-ui-store';

import type { Run } from './runModel';

// A full run record, in the shape the schema infers, so the fixture stays
// checked and nothing relies on a blind cast.
const run = (overrides: Partial<Run> = {}): Run => ({
  key: 'run-1',
  origin: 'gitlab.example.com',
  projectEntryId: 'project-1',
  iid: 5,
  title: 'a run',
  kind: 'bug',
  phase: 'done',
  blockedReason: null,
  blockedFrom: null,
  lastError: null,
  branch: 'ai/issue-5',
  targetBranch: 'main',
  worktreePath: '/worktrees/issue-5',
  mrIid: null,
  issueUrl: null,
  mrUrl: null,
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
  sessions: [{ sessionId: 'ses-stage', stage: 'implementing', at: '2026-11-15T09:41:00.000Z' }],
  events: [],
  issueState: null,
  triage: null,
  plan: null,
  evidence: null,
  reviewFindings: [],
  reviewImpact: null,
  ...overrides,
});

const target = run();

mock.module('./useGitlabRuns', () => ({
  useGitlabRuns: () => ({
    runs: [target], bot: null, error: false, loading: false, notBound: false, refresh: () => undefined,
  }),
}));
mock.module('./useRunAccounts', () => ({ useRunAccounts: () => () => [] }));
mock.module('@/lib/worktrees/worktreeManager', () => ({ removeProjectWorktree: async () => undefined }));
mock.module('@/components/ui/confirm-dialog', () => ({
  useConfirmDialog: () => ({ confirm: async () => true, dialog: null }),
}));

const { AutomationSessionsView } = await import('./AutomationSessionsView');

test('deleting a session removes it from this machine and keeps the run row', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    localStorage: dom.localStorage,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    Node: dom.Node,
    Event: dom.Event,
    MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver,
    ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const deleted: string[][] = [];
  const directories: Array<[string, string | null]> = [];
  const deleteSessions = spyOn(useSessionUIStore.getState(), 'deleteSessions')
    .mockImplementation(async (ids) => {
      deleted.push(ids);
      return { deletedIds: ids, failedIds: [] };
    });
  const setSessionDirectory = spyOn(useSessionUIStore.getState(), 'setSessionDirectory')
    .mockImplementation((id, directory) => { directories.push([id, directory]); });
  const successToast = spyOn(toast, 'success').mockImplementation(() => 'success');
  const errorToast = spyOn(toast, 'error').mockImplementation(() => 'error');

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<I18nProvider><AutomationSessionsView onLeave={() => undefined} /></I18nProvider>);
    });

    const remove = [...container.querySelectorAll('button')]
      .find((button) => (button.getAttribute('aria-label') ?? '').includes('#5'));
    expect(remove).toBeTruthy();

    await act(async () => {
      remove?.click();
    });

    // The folder comes from the ledger, not from whichever folder is open.
    expect(directories).toEqual([['ses-stage', '/worktrees/issue-5']]);
    expect(deleted).toEqual([['ses-stage']]);
    expect(successToast).toHaveBeenCalled();
    expect(errorToast).not.toHaveBeenCalled();
    // The ledger keeps the run, so the row stays and says the session is gone.
    expect(container.textContent).toContain('Deleted');
  } finally {
    await act(async () => { root.unmount(); });
    deleteSessions.mockRestore();
    setSessionDirectory.mockRestore();
    successToast.mockRestore();
    errorToast.mockRestore();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});
