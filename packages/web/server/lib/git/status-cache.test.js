import { describe, expect, test } from 'vitest';
import { createKeyedTtlCache } from './status-cache.js';

describe('createKeyedTtlCache', () => {
  test('returns a fresh value until the ttl elapses', () => {
    let now = 1000;
    const cache = createKeyedTtlCache({ ttlMs: 5000, now: () => now });
    cache.set('a', 'value');
    expect(cache.get('a')).toBe('value');
    now = 5999;
    expect(cache.get('a')).toBe('value');
    now = 6000;
    expect(cache.get('a')).toBeUndefined();
  });

  test('invalidate removes one key only', () => {
    const cache = createKeyedTtlCache({ ttlMs: 5000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.invalidate('a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
  });

  test('clear removes every key', () => {
    const cache = createKeyedTtlCache({ ttlMs: 5000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  test('a missing key is undefined', () => {
    const cache = createKeyedTtlCache({ ttlMs: 5000 });
    expect(cache.get('missing')).toBeUndefined();
  });
});
