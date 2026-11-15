import { describe, expect, test } from 'bun:test';

import { runEventSchema, sessionTrailOf, type Run } from './runModel';

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
