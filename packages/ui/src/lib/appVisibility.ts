export type VisibilitySignal = {
  isVisible: () => boolean;
  subscribe: (listener: () => void) => () => void;
};

export type NativeAppStateApi = {
  getState: () => Promise<{ isActive?: boolean } | null>;
  addListener: (
    event: 'appStateChange',
    handler: (state: { isActive: boolean }) => void,
  ) => Promise<{ remove: () => void | Promise<void> }>;
};

export type NativeAppVisibilityOptions = {
  isNativeApp: () => boolean;
  loadAppState: () => Promise<NativeAppStateApi>;
};

/**
 * Visibility for a native shell (Capacitor), where `visibilitychange` in the
 * WebView often stays "visible" while the app is in the background. Unknown
 * state counts as visible so a slow or failing bridge never pauses polling.
 */
export const createNativeAppVisibility = ({
  isNativeApp,
  loadAppState,
}: NativeAppVisibilityOptions): VisibilitySignal => {
  let active: boolean | null = null;
  let watching = false;
  const listeners = new Set<() => void>();

  const setActive = (next: boolean) => {
    if (active === next) return;
    const wasKnown = active !== null;
    active = next;
    // The first known `true` is not a visibility change: unknown already counts
    // as visible, so only report it when it hides or when we had a real value.
    if (wasKnown || next === false) {
      for (const listener of [...listeners]) listener();
    }
  };

  const watch = () => {
    if (watching) return;
    watching = true;
    void loadAppState()
      .then(async (app) => {
        const state = await app.getState().catch(() => null);
        if (state && typeof state.isActive === 'boolean') setActive(state.isActive);
        const handle = await app.addListener('appStateChange', ({ isActive }) => setActive(isActive === true));
        return handle;
      })
      .catch(() => undefined);
  };

  return {
    isVisible: () => active !== false,
    subscribe: (listener) => {
      if (!isNativeApp()) return () => undefined;
      listeners.add(listener);
      watch();
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/** Visible only while both signals agree; one listener unsubscribes both. */
export const combineVisibility = (first: VisibilitySignal, second: VisibilitySignal): VisibilitySignal => ({
  isVisible: () => first.isVisible() && second.isVisible(),
  subscribe: (listener) => {
    const unsubscribeFirst = first.subscribe(listener);
    const unsubscribeSecond = second.subscribe(listener);
    return () => {
      unsubscribeFirst();
      unsubscribeSecond();
    };
  },
});
