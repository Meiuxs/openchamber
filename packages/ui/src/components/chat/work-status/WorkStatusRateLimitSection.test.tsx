import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { useRateGateStore } from '@/stores/useRateGateStore';
import { useUIStore } from '@/stores/useUIStore';
import type { RateGateStatus } from '@/lib/rate-gate/status';
import { WorkStatusRateLimitSection } from './WorkStatusRateLimitSection';

const NOW = 1_700_000_000_000;
const realNow = Date.now;

const account = (overrides: Partial<RateGateStatus['accounts'][number]> = {}): RateGateStatus['accounts'][number] => ({
  key: 'credential:a',
  label: 'me',
  providerIds: ['internal'],
  used: 3,
  limit: 100,
  remaining: 97,
  resetAt: NOW + 240_000,
  limitedUntil: null,
  authoritative: false,
  waiting: [],
  ...overrides,
});

const statusWith = (overrides: Partial<RateGateStatus> = {}): RateGateStatus => ({
  enabled: true,
  requests: 100,
  windowMinutes: 10,
  caps: { requests: null, windowMinutes: null },
  accounts: [account()],
  ...overrides,
});

describe('work status request rate section', () => {
  let win: Window;
  let root: Root;
  let container: HTMLElement;
  let restore: () => void;
  let previousExpanded: Record<string, boolean>;
  let fetchSpy: ReturnType<typeof spyOn>;
  let served: RateGateStatus;

  const render = async () => {
    await act(async () => root.render(<I18nProvider><WorkStatusRateLimitSection /></I18nProvider>));
    await act(async () => { useRateGateStore.setState({ status: served, loading: false }); });
  };

  beforeEach(() => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win, document: win.document, navigator: win.navigator,
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      HTMLButtonElement: win.HTMLButtonElement, localStorage: win.localStorage,
      getComputedStyle: win.getComputedStyle.bind(win), ResizeObserver: win.ResizeObserver,
      MutationObserver: win.MutationObserver, requestAnimationFrame: win.requestAnimationFrame.bind(win),
      cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    restore = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    Date.now = () => NOW;
    served = statusWith();
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(served));
    previousExpanded = useUIStore.getState().workStatusExpandedSections;
    useUIStore.setState({ workStatusExpandedSections: { rateLimit: true } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    Date.now = realNow;
    useRateGateStore.setState({ status: null, loading: false });
    useUIStore.setState({ workStatusExpandedSections: previousExpanded });
    fetchSpy.mockRestore();
    await win.happyDOM.close();
    restore();
  });

  test('a disabled or empty status draws nothing', async () => {
    served = statusWith({ enabled: false });
    await render();
    expect(container.textContent).toBe('');

    served = statusWith({ accounts: [] });
    await render();
    expect(container.textContent).toBe('');
  });

  test('one row per account, tightest first, with used over limit', async () => {
    served = statusWith({
      accounts: [
        account({ key: 'credential:loose', label: 'loose', providerIds: ['p2'], used: 10, limit: 100, remaining: 90, resetAt: NOW + 300_000 }),
        account({ key: 'credential:tight', label: 'tight', providerIds: ['p1'], used: 95, limit: 100, remaining: 5, resetAt: NOW + 60_000 }),
      ],
    });
    await render();

    const text = container.textContent ?? '';
    expect(text).toContain('tight');
    expect(text).toContain('95/100');
    expect(text).toContain('loose');
    // The head of the section names the account with the least left.
    expect(text.indexOf('95/100')).toBeLessThan(text.indexOf('10/100'));
    expect(container.querySelectorAll('[data-work-status-section="rateLimit"] [data-work-status-row]').length).toBe(0);
  });

  test('a cooled account says when it recovers, and a waiting one counts the queue', async () => {
    served = statusWith({
      accounts: [account({
        used: 100,
        remaining: 0,
        resetAt: NOW + 600_000,
        limitedUntil: NOW + 600_000,
        authoritative: true,
        waiting: [{ sessionId: 'ses_1', until: NOW + 30_000 }],
      })],
    });
    await render();

    const text = container.textContent ?? '';
    expect(text).toContain('limited until');
    expect(text).toContain('10:00');
    expect(text).toContain('1 queued');
  });

  test('an account with quota says when its window resets', async () => {
    await render();
    const text = container.textContent ?? '';
    expect(text).toContain('resets in');
    expect(text).toContain('4:00');
  });
});
