import React from 'react';

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isMobileDeviceViaCSS } from '@/lib/device';
import { isDesktopShell } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';

export const NESTED_REPOSITORY_SCAN_DEPTHS = ['shallow', 'deep', 'all'] as const;
export type NestedRepositoryScanDepth = typeof NESTED_REPOSITORY_SCAN_DEPTHS[number];

const STORAGE_KEY = 'nestedRepositoryScanDepth';
const CHANGE_EVENT = 'nested-repository-scan-depth-change';

const isDepth = (value: string | null): value is NestedRepositoryScanDepth => (
  value === 'shallow' || value === 'deep' || value === 'all'
);

const readStoredDepth = (): NestedRepositoryScanDepth => {
  if (typeof window === 'undefined') return 'shallow';
  try {
    const stored = getDeferredSafeStorage().getItem(STORAGE_KEY);
    return isDepth(stored) ? stored : 'shallow';
  } catch {
    return 'shallow';
  }
};

const notifyChanged = () => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(CHANGE_EVENT));
};

export const getNestedRepositoryScanDepth = (): NestedRepositoryScanDepth => readStoredDepth();

export const setNestedRepositoryScanDepth = (value: NestedRepositoryScanDepth) => {
  if (typeof window === 'undefined') return;
  try {
    getDeferredSafeStorage().setItem(STORAGE_KEY, value);
    notifyChanged();
  } catch {
    // Ignore storage failures; the server preference still carries the choice.
  }
};

export const useNestedRepositoryScanDepth = (): NestedRepositoryScanDepth => {
  const [depth, setDepth] = React.useState(readStoredDepth);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleChange = () => setDepth(readStoredDepth());
    window.addEventListener('storage', handleChange);
    window.addEventListener(CHANGE_EVENT, handleChange);
    return () => {
      window.removeEventListener('storage', handleChange);
      window.removeEventListener(CHANGE_EVENT, handleChange);
    };
  }, []);

  return depth;
};

export const usesWebNestedRepositoryScan = (): boolean => (
  getRegisteredRuntimeAPIs()?.runtime.platform === 'web'
  && !isDesktopShell()
  && !isMobileSurfaceRuntime()
  && (typeof document === 'undefined' || !isMobileDeviceViaCSS())
);
