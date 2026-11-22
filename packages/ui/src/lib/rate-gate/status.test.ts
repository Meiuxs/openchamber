import { describe, expect, test } from 'bun:test';

import { rateGateStatusSchema } from '@/lib/rate-gate/status';

const account = {
  key: 'credential:a',
  label: 'me',
  providerIds: ['internal'],
  used: 3,
  limit: 100,
  remaining: 97,
  resetAt: 1_700_000_600_000,
  limitedUntil: null,
  authoritative: false,
  waiting: [{ sessionId: 'ses_1', until: 1_700_000_030_000 }],
};

const status = {
  enabled: true,
  requests: 100,
  windowMinutes: 10,
  caps: { requests: null, windowMinutes: null },
  accounts: [account],
};

describe('rate gate status payload', () => {
  test('parses the answer the server sends', () => {
    const parsed = rateGateStatusSchema.parse(status);
    expect(parsed.accounts[0]?.waiting[0]?.sessionId).toBe('ses_1');
  });

  test('refuses a waiting entry without a session', () => {
    // A row the plugin reported without a session cannot be shown beside the
    // composer, so it must not reach the store as one.
    expect(rateGateStatusSchema.safeParse({
      ...status,
      accounts: [{ ...account, waiting: [{ until: 1 }] }],
    }).success).toBe(false);
  });

  test('refuses a status without caps', () => {
    const { caps: _caps, ...withoutCaps } = status;
    expect(rateGateStatusSchema.safeParse(withoutCaps).success).toBe(false);
  });

  test('keeps a null label and a null cooldown', () => {
    const parsed = rateGateStatusSchema.parse({
      ...status,
      accounts: [{ ...account, label: null, limitedUntil: null, waiting: [] }],
    });
    expect(parsed.accounts[0]?.label).toBeNull();
    expect(parsed.accounts[0]?.limitedUntil).toBeNull();
  });
});
