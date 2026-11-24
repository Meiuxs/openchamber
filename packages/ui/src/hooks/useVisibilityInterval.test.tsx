import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';

import { useVisibilityInterval, type VisibilitySignal } from './useVisibilityInterval';

const dom = new Window({ url: 'http://localhost' });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createVisibility = (initial: boolean) => {
  let visible = initial;
  const listeners = new Set<() => void>();
  const signal: VisibilitySignal = {
    isVisible: () => visible,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    signal,
    show() {
      visible = true;
      for (const listener of [...listeners]) listener();
    },
    hide() {
      visible = false;
      for (const listener of [...listeners]) listener();
    },
  };
};

const mount = async (element: React.ReactElement) => {
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
};

describe('useVisibilityInterval', () => {
  test('runs immediately when visible', async () => {
    const visibility = createVisibility(true);
    let calls = 0;
    const Harness = () => {
      useVisibilityInterval(() => { calls += 1; }, 60_000, { visibility: visibility.signal });
      return null;
    };
    const mounted = await mount(<Harness />);
    expect(calls).toBe(1);
    await mounted.unmount();
  });

  test('does not run while hidden and catches up when shown', async () => {
    const visibility = createVisibility(false);
    let calls = 0;
    const Harness = () => {
      useVisibilityInterval(() => { calls += 1; }, 20, { visibility: visibility.signal, immediate: false });
      return null;
    };
    const mounted = await mount(<Harness />);
    await wait(50);
    expect(calls).toBe(0);

    await act(async () => { visibility.show(); });
    expect(calls).toBe(1);
    await wait(50);
    expect(calls).toBeGreaterThan(1);

    await act(async () => { visibility.hide(); });
    const whileHidden = calls;
    await wait(50);
    expect(calls).toBe(whileHidden);
    await mounted.unmount();
  });

  test('stays idle when disabled', async () => {
    const visibility = createVisibility(true);
    let calls = 0;
    const Harness = () => {
      useVisibilityInterval(() => { calls += 1; }, 10, { visibility: visibility.signal, enabled: false });
      return null;
    };
    const mounted = await mount(<Harness />);
    await wait(40);
    expect(calls).toBe(0);
    await mounted.unmount();
  });

  test('stops after unmount', async () => {
    const visibility = createVisibility(true);
    let calls = 0;
    const Harness = () => {
      useVisibilityInterval(() => { calls += 1; }, 10, { visibility: visibility.signal });
      return null;
    };
    const mounted = await mount(<Harness />);
    await wait(30);
    await mounted.unmount();
    const afterUnmount = calls;
    await wait(40);
    expect(calls).toBe(afterUnmount);
  });
});
