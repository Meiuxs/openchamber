import { describe, expect, test } from 'bun:test';

import { removeAutomationSession, type AutomationRemovalDeps } from './automationSessionRemoval';
import type { Run } from './runModel';

// A full run record, in the shape the schema infers, so the overrides stay
// checked and no test relies on a blind cast.
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
  sessions: [],
  events: [],
  issueState: null,
  triage: null,
  plan: null,
  evidence: null,
  reviewFindings: [],
  reviewImpact: null,
  ...overrides,
});

const project = { id: 'project-1', path: '/repo' };

const recordingDeps = (
  calls: string[],
  overrides: Partial<AutomationRemovalDeps> = {},
): AutomationRemovalDeps => ({
  setSessionDirectory: (sessionId, directory) => {
    calls.push(`directory:${sessionId}:${directory ?? ''}`);
  },
  deleteSessions: async (ids) => {
    calls.push(`delete:${ids.join(',')}`);
    return { deletedIds: ids };
  },
  removeWorktree: async (target, worktree) => {
    calls.push(`worktree:${target.id}:${worktree.path}`);
  },
  ...overrides,
});

describe('automation session removal', () => {
  // The session never reached this client's list, so the folder has to be known
  // before the request; answering in the open folder would delete the wrong one.
  test('registers the session folder before deleting it', async () => {
    const calls: string[] = [];
    const target = run({ sessions: [{ sessionId: 'stage', stage: 'implementing', at: null }] });

    const result = await removeAutomationSession(
      { run: target, sessionId: 'stage', project, runs: [target], removedSessionIds: new Set(['stage']) },
      recordingDeps(calls),
    );

    expect(calls).toEqual(['directory:stage:/worktrees/issue-5', 'delete:stage', 'worktree:project-1:/worktrees/issue-5']);
    expect(result).toEqual({ deleted: true, worktree: 'removed' });
  });

  test('keeps the worktree when the deletion does not happen', async () => {
    const calls: string[] = [];
    const target = run({ sessions: [{ sessionId: 'stage', stage: 'implementing', at: null }] });

    const result = await removeAutomationSession(
      { run: target, sessionId: 'stage', project, runs: [target], removedSessionIds: new Set(['stage']) },
      recordingDeps(calls, { deleteSessions: async () => ({ deletedIds: [] }) }),
    );

    expect(calls.some((call) => call.startsWith('worktree:'))).toBe(false);
    expect(result).toEqual({ deleted: false, worktree: 'unused' });
  });

  // Every stage of a run works in the same folder, so one deletion must not pull
  // it out from under a stage that is still there.
  test('keeps the worktree while another stage of the run needs it', async () => {
    const calls: string[] = [];
    const target = run({
      sessions: [
        { sessionId: 'implement', stage: 'implementing', at: null },
        { sessionId: 'review', stage: 'reviewing', at: null },
      ],
    });

    const result = await removeAutomationSession(
      { run: target, sessionId: 'implement', project, runs: [target], removedSessionIds: new Set(['implement']) },
      recordingDeps(calls),
    );

    expect(calls.some((call) => call.startsWith('worktree:'))).toBe(false);
    expect(result).toEqual({ deleted: true, worktree: 'unused' });
  });

  test('keeps the deletion when the worktree removal throws', async () => {
    const target = run({ sessions: [{ sessionId: 'stage', stage: 'implementing', at: null }] });

    const result = await removeAutomationSession(
      { run: target, sessionId: 'stage', project, runs: [target], removedSessionIds: new Set(['stage']) },
      recordingDeps([], { removeWorktree: async () => { throw new Error('folder in use'); } }),
    );

    expect(result).toEqual({ deleted: true, worktree: 'failed' });
  });
});
