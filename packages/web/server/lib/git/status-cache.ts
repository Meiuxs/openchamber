export type KeyedTtlCache<T> = {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  invalidate(key: string): void;
  clear(): void;
};

type Entry<T> = { value: T; at: number };

/**
 * Small keyed cache whose entries expire after `ttlMs`. `now` is injectable so
 * tests can drive the clock without sleeping.
 */
export const createKeyedTtlCache = <T>({
  ttlMs,
  now = Date.now,
}: {
  ttlMs: number;
  now?: () => number;
}): KeyedTtlCache<T> => {
  const entries = new Map<string, Entry<T>>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      entries.set(key, { value, at: now() });
    },
    invalidate(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
};
