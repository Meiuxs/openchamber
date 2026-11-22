import { describe, expect, test } from 'bun:test';

import type { RateGateAccount } from './status';
import { nextReleaseAt } from './nextRelease';

const NOW = 1_700_000_000_000;

const account = (overrides: Partial<RateGateAccount> = {}): RateGateAccount => ({
  key: 'credential:a',
  label: 'me',
  providerIds: ['internal'],
  used: 3,
  limit: 100,
  remaining: 97,
  resetAt: NOW + 60_000,
  limitedUntil: null,
  authoritative: false,
  waiting: [],
  ...overrides,
});

describe('next release time', () => {
  test('picks the earliest grant expiry among accounts with spent budget', () => {
    expect(nextReleaseAt([
      account({ key: 'a', used: 90, remaining: 10, resetAt: NOW + 240_000 }),
      account({ key: 'b', used: 95, remaining: 5, resetAt: NOW + 60_000 }),
    ], NOW)).toBe(NOW + 60_000);
  });

  test('prefers a running cooldown over the grant expiry', () => {
    expect(nextReleaseAt([
      account({ used: 100, remaining: 0, resetAt: NOW + 240_000, limitedUntil: NOW + 30_000 }),
    ], NOW)).toBe(NOW + 30_000);
  });

  test('ignores accounts at their full budget and instants that already passed', () => {
    expect(nextReleaseAt([account({ used: 0, remaining: 100 })], NOW)).toBeNull();
    expect(nextReleaseAt([account({ used: 100, remaining: 0, resetAt: NOW })], NOW)).toBeNull();
    expect(nextReleaseAt([], NOW)).toBeNull();
  });
});
