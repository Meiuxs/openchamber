import React from 'react';
import { create } from 'zustand';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { rateGateStatusSchema, type RateGateStatus } from '@/lib/rate-gate/status';
import { nextReleaseAt } from '@/lib/rate-gate/nextRelease';
import { scheduleAt } from '@/lib/timing/scheduleAt';
import { subscribePolling } from '@/lib/timing/subscribePolling';

const POLL_INTERVAL_MS = 30_000;
const LOAD_TIMEOUT_MS = 8_000;
const RELEASE_REFRESH_GRACE_MS = 250;

type RateGateStore = {
  status: RateGateStatus | null;
  loading: boolean;
  fetchStatus: () => Promise<void>;
  waitingUntil: (sessionId: string) => number | null;
};

let stopSubscription: (() => void) | null = null;
let consumers = 0;
let releaseTimer: (() => void) | null = null;

const cancelReleaseRefresh = (): void => {
  releaseTimer?.();
  releaseTimer = null;
};

const scheduleReleaseRefresh = (status: RateGateStatus | null): void => {
  cancelReleaseRefresh();
  if (status === null || consumers === 0) return;
  const at = nextReleaseAt(status.accounts, Date.now());
  if (at === null) return;
  releaseTimer = scheduleAt(at + RELEASE_REFRESH_GRACE_MS, () => {
    releaseTimer = null;
    void useRateGateStore.getState().fetchStatus();
  });
};

const subscribe = (): void => {
  consumers += 1;
  if (consumers > 1) return;

  const read = () => {
    void useRateGateStore.getState().fetchStatus();
  };
  const unsubscribeEvents = subscribeOpenchamberEvents((event) => {
    if (event.type !== 'rate-gate') return;
    useRateGateStore.setState({ status: event.status });
    scheduleReleaseRefresh(event.status);
  });
  const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => {
    useRateGateStore.setState({ status: null });
    cancelReleaseRefresh();
    read();
  });
  const unsubscribePolling = subscribePolling(read, POLL_INTERVAL_MS);
  read();

  stopSubscription = () => {
    unsubscribeEvents();
    unsubscribeRuntime();
    unsubscribePolling();
    cancelReleaseRefresh();
  };
};

const unsubscribe = (): void => {
  consumers = Math.max(0, consumers - 1);
  if (consumers > 0) return;
  stopSubscription?.();
  stopSubscription = null;
};

export const useRateGateStore = create<RateGateStore>((set, get) => ({
  status: null,
  loading: false,
  fetchStatus: async () => {
    set({ loading: true });
    try {
      const response = await runtimeFetch('/api/rate-gate/status', {
        signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        if (response.status === 404) set({ status: null });
        return;
      }
      const parsed = rateGateStatusSchema.safeParse(await response.json());
      if (parsed.success) {
        set({ status: parsed.data });
        scheduleReleaseRefresh(parsed.data);
      }
    } catch {
      return;
    } finally {
      set({ loading: false });
    }
  },
  waitingUntil: (sessionId) => {
    const accounts = get().status?.accounts ?? [];
    let until: number | null = null;
    for (const account of accounts) {
      for (const entry of account.waiting) {
        if (entry.sessionId !== sessionId) continue;
        if (until === null || entry.until > until) until = entry.until;
      }
    }
    return until;
  },
}));

export const useRateGateStatus = (): RateGateStatus | null => {
  const status = useRateGateStore((state) => state.status);

  React.useEffect(() => {
    subscribe();
    return unsubscribe;
  }, []);

  return status;
};
