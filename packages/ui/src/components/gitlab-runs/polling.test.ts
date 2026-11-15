import { describe, expect, test } from 'bun:test';

import { shouldPollRuns } from './polling';

describe('shouldPollRuns', () => {
  test('the runs page keeps polling whenever it is open', () => {
    expect(shouldPollRuns(null, false)).toBe(true);
    expect(shouldPollRuns([], false)).toBe(true);
    expect(shouldPollRuns([{ phase: 'done' }], false)).toBe(true);
  });

  test('the board row polls only while a run is still moving', () => {
    expect(shouldPollRuns([{ phase: 'implementing' }], true)).toBe(true);
    expect(shouldPollRuns([{ phase: 'blocked' }, { phase: 'done' }], true)).toBe(true);
    expect(shouldPollRuns([{ phase: 'done' }], true)).toBe(false);
    // Nothing claimed yet: a poll would ask the same question again.
    expect(shouldPollRuns([], true)).toBe(false);
    expect(shouldPollRuns(null, true)).toBe(false);
  });
});
