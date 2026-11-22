import { describe, expect, test } from 'bun:test';

import { useRateGateStore } from './useRateGateStore';
import type { RateGateStatus } from '@/lib/rate-gate/status';

const status = (waiting: Array<{ sessionId: string; until: number }>): RateGateStatus => ({
  enabled: true,
  requests: 100,
  windowMinutes: 10,
  caps: { requests: null, windowMinutes: null },
  accounts: [{
    key: 'credential:a',
    label: 'me',
    providerIds: ['internal'],
    used: 3,
    limit: 100,
    remaining: 97,
    resetAt: 1_700_000_600_000,
    limitedUntil: null,
    authoritative: false,
    waiting,
  }],
});

describe('rate gate store', () => {
  test('waitingUntil finds the session and ignores the rest', () => {
    useRateGateStore.setState({ status: status([{ sessionId: 'ses_1', until: 1_700_000_030_000 }]) });
    expect(useRateGateStore.getState().waitingUntil('ses_1')).toBe(1_700_000_030_000);
    expect(useRateGateStore.getState().waitingUntil('ses_2')).toBeNull();
  });

  test('waitingUntil reports the last moment a session waits, across accounts', () => {
    const twoAccounts: RateGateStatus = {
      ...status([]),
      accounts: [
        { ...status([]).accounts[0]!, key: 'credential:a', waiting: [{ sessionId: 'ses_1', until: 1_700_000_030_000 }] },
        { ...status([]).accounts[0]!, key: 'credential:b', waiting: [{ sessionId: 'ses_1', until: 1_700_000_045_000 }] },
      ],
    };
    useRateGateStore.setState({ status: twoAccounts });
    expect(useRateGateStore.getState().waitingUntil('ses_1')).toBe(1_700_000_045_000);
  });

  test('waitingUntil is null without a status', () => {
    useRateGateStore.setState({ status: null });
    expect(useRateGateStore.getState().waitingUntil('ses_1')).toBeNull();
  });
});

describe('rate gate store read failures', () => {
  const originalFetch = globalThis.fetch;

  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  test('a network failure keeps the last reading instead of blanking the panel', async () => {
    useRateGateStore.setState({ status: status([]) });
    await withFetch(async () => { throw new Error('network blip'); }, async () => {
      await useRateGateStore.getState().fetchStatus();
    });
    expect(useRateGateStore.getState().status).not.toBeNull();
    expect(useRateGateStore.getState().status?.enabled).toBe(true);
  });

  test('a server error keeps the last reading', async () => {
    useRateGateStore.setState({ status: status([]) });
    await withFetch(async () => new Response('', { status: 500 }), async () => {
      await useRateGateStore.getState().fetchStatus();
    });
    expect(useRateGateStore.getState().status).not.toBeNull();
  });

  test('a host without the route clears the reading', async () => {
    // VS Code and an older server answer 404; there is nothing to show there.
    useRateGateStore.setState({ status: status([]) });
    await withFetch(async () => new Response('', { status: 404 }), async () => {
      await useRateGateStore.getState().fetchStatus();
    });
    expect(useRateGateStore.getState().status).toBeNull();
  });

  test('a good answer replaces the reading', async () => {
    useRateGateStore.setState({ status: null });
    const payload = status([{ sessionId: 'ses_1', until: 1_700_000_030_000 }]);
    await withFetch(async () => Response.json(payload), async () => {
      await useRateGateStore.getState().fetchStatus();
    });
    expect(useRateGateStore.getState().status?.accounts[0]?.waiting).toHaveLength(1);
  });
});
