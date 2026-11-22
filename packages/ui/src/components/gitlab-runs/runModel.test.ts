import { describe, expect, test } from 'bun:test';

import { runEventSchema, projectLabelOf, sessionTrailOf, worktreeFreedBy, type Run } from './runModel';

// A full run record, in the shape the schema infers, so the overrides stay
// checked and no test relies on a blind cast.
const run = (overrides: Partial<Run> = {}): Run => ({
  key: 'run-1',
  origin: 'gitlab.example.com',
  projectEntryId: null,
  iid: 5,
  title: 'a run',
  kind: 'bug',
  phase: 'implementing',
  blockedReason: null,
  blockedFrom: null,
  lastError: null,
  branch: null,
  targetBranch: null,
  worktreePath: null,
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

describe('gitlab run events', () => {
  // A ledger written before every event carried a time must still list: an
  // entry without one only loses its clock, it does not invalidate the answer.
  test('accepts an event the server recorded without a time', () => {
    const parsed = runEventSchema.safeParse({ kind: 'phase', from: 'claimed', to: 'preparing' });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.at).toBeNull();
  });

  test('keeps the time when the server sent one', () => {
    const parsed = runEventSchema.safeParse({
      at: '2026-11-15T09:20:35.390Z', kind: 'session', phase: 'implementing',
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.at).toBe('2026-11-15T09:20:35.390Z');
  });
});

describe('project label', () => {
  // A run row names its project the way the sidebar does: the project's label,
  // never the directory path it happens to live at.
  test('prefers the label the sidebar shows', () => {
    expect(projectLabelOf({ label: '  openchamber  ', path: '/home/me/code/openchamber' })).toBe('openchamber');
  });

  test('falls back to the folder name, not the whole path', () => {
    expect(projectLabelOf({ label: '', path: '/home/me/code/openchamber' })).toBe('openchamber');
    expect(projectLabelOf({ path: 'D:\\code\\openchamber' })).toBe('openchamber');
  });

  test('answers empty for a run whose project is unknown', () => {
    expect(projectLabelOf(null)).toBe('');
    expect(projectLabelOf({ path: '' })).toBe('');
  });
});

describe('worktree cleanup', () => {
  const worktreePath = '/worktrees/issue-5';
  const stages = [
    { sessionId: 'implement', stage: 'implementing', at: '2026-11-15T09:41:00.000Z' },
    { sessionId: 'review', stage: 'reviewing', at: '2026-11-15T10:15:00.000Z' },
  ];

  // Every stage of a run works in the same folder; deleting one session must not
  // pull the folder out from under the stage that is still there.
  test('keeps the worktree while another stage of the same run needs it', () => {
    const target = run({ worktreePath, sessions: stages });

    expect(worktreeFreedBy(target, [target], new Set(['implement']))).toBe(false);
  });

  test('frees the worktree once its last session is gone', () => {
    const target = run({ worktreePath, sessions: stages });

    expect(worktreeFreedBy(target, [target], new Set(['implement', 'review']))).toBe(true);
  });

  test('keeps a worktree another run still points at', () => {
    const target = run({ worktreePath, sessions: stages });
    const other = run({
      key: 'run-2',
      worktreePath,
      sessions: [{ sessionId: 'other', stage: 'implementing', at: null }],
    });

    expect(worktreeFreedBy(target, [target, other], new Set(['implement', 'review']))).toBe(false);
  });

  test('answers false for a run that never had a worktree', () => {
    const target = run({ sessions: stages });

    expect(worktreeFreedBy(target, [target], new Set(['implement', 'review']))).toBe(false);
  });
});

describe('session trail', () => {
  test('draws a feedback session at the mr-open stop it loops from', () => {
    const trail = sessionTrailOf(run({
      sessions: [
        { sessionId: 's1', stage: 'implementing', at: '2026-11-15T09:41:00.000Z' },
        { sessionId: 's2', stage: 'addressing', at: '2026-11-15T10:15:00.000Z' },
      ],
    }));

    expect(trail.map((session) => session.stage)).toEqual(['implementing', 'mr-open']);
  });

  test('falls back to the live session for a ledger that kept no trail', () => {
    const trail = sessionTrailOf(run({
      sessionId: 's9', phase: 'implementing',
    }));

    expect(trail).toEqual([{
      sessionId: 's9', stage: 'implementing', at: '2026-11-15T09:40:00.000Z',
    }]);
  });

  test('answers empty when there is nothing to show', () => {
    expect(sessionTrailOf(run({}))).toEqual([]);
  });
});
