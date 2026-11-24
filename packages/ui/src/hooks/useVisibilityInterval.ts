import React from 'react';
import { isCapacitorApp } from '@/lib/platform';
import { combineVisibility, createNativeAppVisibility, type VisibilitySignal } from '@/lib/appVisibility';

export type { VisibilitySignal } from '@/lib/appVisibility';

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

// A Capacitor WebView keeps `visibilityState` at "visible" when the app goes to
// the background, so the native app state has to pause polling there as well.
const defaultVisibility: VisibilitySignal = combineVisibility(
  documentVisibility,
  createNativeAppVisibility({
    isNativeApp: isCapacitorApp,
    loadAppState: () => import('@capacitor/app').then(({ App }) => App),
  }),
);

/**
 * Runs `callback` on an interval only while the page is visible, and fires it
 * once when visibility returns so stale data is refreshed before the next tick.
 * Pass a `visibility` signal to override the default (page visibility combined
 * with the native app state on Capacitor).
 */
export const useVisibilityInterval = (
  callback: () => void,
  intervalMs: number,
  options: VisibilityIntervalOptions = {},
): void => {
  const { enabled = true, immediate = true, runWhenHidden = false, visibility } = options;
  const callbackRef = React.useRef(callback);
  callbackRef.current = callback;
  const signal = React.useMemo(() => visibility ?? defaultVisibility, [visibility]);

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
