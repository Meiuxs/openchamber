import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { useRateGateStore } from '@/stores/useRateGateStore';
import type { RateGateStatus } from '@/lib/rate-gate/status';
import { RateGateWaitingRow } from './RateGateWaitingRow';

const NOW = 1_700_000_000_000;
const realNow = Date.now;

const statusWith = (waiting: Array<{ sessionId: string; until: number }>): RateGateStatus => ({
  enabled: true,
  requests: 100,
  windowMinutes: 10,
  caps: { requests: null, windowMinutes: null },
  accounts: [{
    key: 'credential:a',
    label: 'me',
    providerIds: ['internal'],
    used: 100,
    limit: 100,
    remaining: 0,
    resetAt: NOW + 600_000,
    limitedUntil: null,
    authoritative: false,
    waiting,
  }],
});

describe('composer request throttle row', () => {
  let win: Window;
  let root: Root;
  let container: HTMLElement;
  let restore: () => void;
  let fetchSpy: ReturnType<typeof spyOn>;
  let served: RateGateStatus;

  const render = async (sessionId: string | null) => {
    await act(async () => root.render(<I18nProvider><RateGateWaitingRow sessionId={sessionId} /></I18nProvider>));
    await act(async () => { useRateGateStore.setState({ status: served, loading: false }); });
  };

  beforeEach(() => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win, document: win.document, navigator: win.navigator,
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
      ResizeObserver: win.ResizeObserver, MutationObserver: win.MutationObserver,
      requestAnimationFrame: win.requestAnimationFrame.bind(win),
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
    served = statusWith([]);
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(served));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    Date.now = realNow;
    useRateGateStore.setState({ status: null, loading: false });
    fetchSpy.mockRestore();
    await win.happyDOM.close();
    restore();
  });

  test('draws nothing while the session is not waiting', async () => {
    await render('ses_1');
    expect(container.textContent).toBe('');
  });

  test('shows the time left for the session that waits', async () => {
    served = statusWith([{ sessionId: 'ses_1', until: NOW + 95_000 }]);
    await render('ses_1');
    expect(container.textContent).toContain('Waiting for quota');
    expect(container.textContent).toContain('1:35');
  });

  test('ignores another session and a moment that already passed', async () => {
    served = statusWith([{ sessionId: 'ses_2', until: NOW + 95_000 }]);
    await render('ses_1');
    expect(container.textContent).toBe('');

    served = statusWith([{ sessionId: 'ses_1', until: NOW - 1_000 }]);
    await render('ses_1');
    expect(container.textContent).toBe('');
  });
});
