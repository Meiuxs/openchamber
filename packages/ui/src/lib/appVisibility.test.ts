import { beforeEach, describe, expect, test, mock } from 'bun:test';
import {
  combineVisibility,
  createNativeAppVisibility,
  type NativeAppStateApi,
  type VisibilitySignal,
} from './appVisibility';

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

type Listener = (state: { isActive: boolean }) => void;

const createFakeApp = (getState: NativeAppStateApi['getState']) => {
  const listeners = new Set<Listener>();
  const app: NativeAppStateApi = {
    getState,
    addListener: async (_event, handler) => {
      listeners.add(handler);
      return { remove: () => { listeners.delete(handler); } };
    },
  };
  return { app, listeners, emit: (isActive: boolean) => listeners.forEach((listener) => listener({ isActive })) };
};

describe('createNativeAppVisibility', () => {
  let changes: number;
  const listen = (signal: VisibilitySignal) => {
    changes = 0;
    return signal.subscribe(() => { changes += 1; });
  };

  beforeEach(() => {
    changes = 0;
  });

  test('stays visible and never loads the app on a non-native runtime', async () => {
    const loadAppState = mock(async () => {
      throw new Error('must not load');
    });
    const signal = createNativeAppVisibility({ isNativeApp: () => false, loadAppState });
    const unsubscribe = listen(signal);

    expect(signal.isVisible()).toBe(true);
    expect(loadAppState).not.toHaveBeenCalled();
    unsubscribe();
  });

  test('hides while the native app is inactive and reports the change', async () => {
    const fake = createFakeApp(async () => ({ isActive: true }));
    const signal = createNativeAppVisibility({ isNativeApp: () => true, loadAppState: async () => fake.app });
    const unsubscribe = listen(signal);
    await flush();
    expect(signal.isVisible()).toBe(true);

    fake.emit(false);
    expect(signal.isVisible()).toBe(false);
    expect(changes).toBe(1);

    fake.emit(true);
    expect(signal.isVisible()).toBe(true);
    expect(changes).toBe(2);
    unsubscribe();
  });

  test('ignores a repeated state so a duplicate event cannot re-fire the listener', async () => {
    const fake = createFakeApp(async () => ({ isActive: true }));
    const signal = createNativeAppVisibility({ isNativeApp: () => true, loadAppState: async () => fake.app });
    const unsubscribe = listen(signal);
    await flush();

    fake.emit(true);
    expect(changes).toBe(0);
    unsubscribe();
  });

  test('stays visible when the app state cannot be read', async () => {
    const signal = createNativeAppVisibility({
      isNativeApp: () => true,
      loadAppState: async () => ({ getState: async () => Promise.reject(new Error('nope')), addListener: async () => ({ remove: () => undefined }) }),
    });
    const unsubscribe = listen(signal);
    await flush();

    expect(signal.isVisible()).toBe(true);
    expect(changes).toBe(0);
    unsubscribe();
  });

  test('combineVisibility is visible only when both signals agree', () => {
    const visible: VisibilitySignal = { isVisible: () => true, subscribe: () => () => undefined };
    const hidden: VisibilitySignal = { isVisible: () => false, subscribe: () => () => undefined };
    expect(combineVisibility(visible, visible).isVisible()).toBe(true);
    expect(combineVisibility(visible, hidden).isVisible()).toBe(false);
    expect(combineVisibility(hidden, visible).isVisible()).toBe(false);
  });

  test('combineVisibility subscribes to both signals and unsubscribes once', () => {
    const unsubscribes: string[] = [];
    const signal = (name: string): VisibilitySignal => ({
      isVisible: () => true,
      subscribe: () => () => { unsubscribes.push(name); },
    });
    const unsubscribe = combineVisibility(signal('document'), signal('native')).subscribe(() => undefined);
    unsubscribe();
    expect(unsubscribes.sort()).toEqual(['document', 'native']);
  });
});
