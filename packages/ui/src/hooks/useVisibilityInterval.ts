import React from 'react';

export type VisibilitySignal = {
  isVisible: () => boolean;
  subscribe: (listener: () => void) => () => void;
};

export type VisibilityIntervalOptions = {
  enabled?: boolean;
  immediate?: boolean;
  runWhenHidden?: boolean;
  visibility?: VisibilitySignal;
};

const documentVisibility: VisibilitySignal = {
  isVisible: () => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'),
  subscribe: (listener) => {
    if (typeof document === 'undefined') return () => undefined;
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};

/**
 * Runs `callback` on an interval only while the page is visible, and fires it
 * once when visibility returns so stale data is refreshed before the next tick.
 * Pass a `visibility` signal to cover runtimes where `visibilitychange` is
 * unreliable (for example a Capacitor WebView).
 */
export const useVisibilityInterval = (
  callback: () => void,
  intervalMs: number,
  options: VisibilityIntervalOptions = {},
): void => {
  const { enabled = true, immediate = true, runWhenHidden = false, visibility } = options;
  const callbackRef = React.useRef(callback);
  callbackRef.current = callback;
  const signal = React.useMemo(() => visibility ?? documentVisibility, [visibility]);

  React.useEffect(() => {
    if (!enabled || !(intervalMs > 0)) return undefined;
    let timer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const clear = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const tick = () => {
      if (!disposed) callbackRef.current();
    };
    const sync = (fireNow: boolean) => {
      if (disposed) return;
      if (!runWhenHidden && !signal.isVisible()) {
        clear();
        return;
      }
      if (timer === null) timer = setInterval(tick, intervalMs);
      if (fireNow) tick();
    };

    sync(immediate);
    const unsubscribe = signal.subscribe(() => sync(true));

    return () => {
      disposed = true;
      unsubscribe();
      clear();
    };
  }, [enabled, immediate, intervalMs, runWhenHidden, signal]);
};
