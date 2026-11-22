import { describe, expect, it } from 'vitest';

import {
  accountKeyFromSecret,
  createAccountResolver,
  matchesGateway,
  normalizeGateway,
  parseDurationMs,
  parseGatewayText,
  parseRateLimitHeaders,
  parseRateLimitRecord,
  parseResetValue,
  resolveRateGateConfig,
} from './policy.js';

const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null });

describe('gateway normalization', () => {
  it('keeps origin and path prefix, drops trailing slash', () => {
    expect(normalizeGateway('http://llm-gw.corp.example.com/')).toBe('http://llm-gw.corp.example.com');
    expect(normalizeGateway('https://gw.corp/v1/')).toBe('https://gw.corp/v1');
  });

  it('rejects credentials, query, fragment and non-http schemes', () => {
    for (const value of ['http://user:pw@gw.corp', 'http://gw.corp/?x=1', 'http://gw.corp/#a', 'file:///etc/passwd', 'gw.corp']) {
      expect(normalizeGateway(value)).toBeNull();
    }
  });

  it('matches a request URL under the configured prefix only', () => {
    expect(matchesGateway('http://gw.corp/v1/chat/completions', ['http://gw.corp/v1'])).toBe(true);
    expect(matchesGateway('http://gw.corp/v2/chat/completions', ['http://gw.corp/v1'])).toBe(false);
    expect(matchesGateway('http://other.corp/v1/chat', ['http://gw.corp/v1'])).toBe(false);
  });

  it('parses multiline text and caps at 50 entries', () => {
    expect(parseGatewayText('http://a.corp\n\n http://b.corp ')).toEqual(['http://a.corp', 'http://b.corp']);
    expect(parseGatewayText(Array.from({ length: 60 }, (_, i) => `http://gw${i}.corp`))).toHaveLength(50);
  });
});

describe('config resolution', () => {
  it('falls back to defaults with no settings and no policy', () => {
    expect(resolveRateGateConfig(null, null)).toEqual({
      config: { requests: 100, windowMinutes: 10, gateways: [] },
      caps: { requests: null, windowMinutes: null },
    });
  });

  it('lets the user tighten and clamps anything above the policy cap', () => {
    const { config, caps } = resolveRateGateConfig(
      { modelRateLimitRequests: 40, modelRateLimitWindowMinutes: 5 },
      { requests: 100, windowMinutes: 10, gateways: ['http://gw.corp'] },
    );
    expect(config).toEqual({ requests: 40, windowMinutes: 5, gateways: ['http://gw.corp'] });
    expect(caps).toEqual({ requests: 100, windowMinutes: 10 });
    expect(resolveRateGateConfig({ modelRateLimitRequests: 500 }, { requests: 100 }).config.requests).toBe(100);
  });

  it('falls back to policy gateways when the user list is empty', () => {
    expect(resolveRateGateConfig({ modelRateLimitGateways: '' }, { gateways: ['http://gw.corp'] }).config.gateways)
      .toEqual(['http://gw.corp']);
  });
});

describe('rate limit headers', () => {
  it('accepts epoch ms, epoch s and seconds from now for reset', () => {
    const now = 1_700_000_000_000;
    expect(parseRateLimitHeaders(headers({ 'x-ratelimit-remaining': '7', 'x-ratelimit-reset': '1700000600000' }), now).resetAt).toBe(1_700_000_600_000);
    expect(parseRateLimitHeaders(headers({ 'x-ratelimit-reset': '1700000600' }), now).resetAt).toBe(1_700_000_600_000);
    expect(parseRateLimitHeaders(headers({ 'x-ratelimit-reset': '60' }), now).resetAt).toBe(now + 60_000);
  });

  it('reads the request dimension of OpenAI and Anthropic style headers', () => {
    const now = 1_700_000_000_000;
    expect(parseRateLimitHeaders(headers({
      'x-ratelimit-remaining-requests': '42',
      'x-ratelimit-remaining-tokens': '9000',
      'x-ratelimit-reset-requests': '1s',
      'x-ratelimit-reset-tokens': '10s',
    }), now)).toEqual({ remaining: 42, resetAt: now + 1_000, retryAfterMs: null });

    expect(parseRateLimitHeaders(headers({
      'anthropic-ratelimit-requests-remaining': '3',
      'anthropic-ratelimit-requests-reset': '2026-11-22T10:00:00Z',
    }), now)).toEqual({ remaining: 3, resetAt: Date.parse('2026-11-22T10:00:00Z'), retryAfterMs: null });
  });

  it('parses durations, retry-after headers and an already-decoded record', () => {
    const now = 1_700_000_000_000;
    expect(parseDurationMs('1m30s')).toBe(90_000);
    expect(parseDurationMs('250ms')).toBe(250);
    expect(parseDurationMs('soon')).toBeNull();
    expect(parseResetValue('2m', now)).toBe(now + 120_000);
    expect(parseRateLimitRecord({ 'Retry-After': '2' }, now).retryAfterMs).toBe(2_000);
    expect(parseRateLimitRecord({ 'retry-after-ms': '750' }, now).retryAfterMs).toBe(750);
  });

  it('ignores missing and garbage values', () => {
    expect(parseRateLimitHeaders(headers({}), 1)).toEqual({ remaining: null, resetAt: null, retryAfterMs: null });
    expect(parseRateLimitHeaders(headers({ 'x-ratelimit-remaining': 'lots', 'x-ratelimit-reset': 'soon' }), 1))
      .toEqual({ remaining: null, resetAt: null, retryAfterMs: null });
  });
});

describe('account resolution', () => {
  const deps = (overrides = {}) => ({
    readCredentialEntries: async () => [{ id: 'cred-1', integrationID: 'intranet', active: true, label: 'me@corp' }],
    readCredentialMap: async () => ({}),
    readProviderConfig: () => null,
    now: () => 0,
    cacheTtlMs: 10_000,
    ...overrides,
  });

  it('keys a stored credential by its stable id and keeps the label', async () => {
    await expect(createAccountResolver(deps())('intranet')).resolves.toEqual({ key: 'credential:cred-1', label: 'me@corp' });
  });

  it('falls back to a key hash, then the provider id', async () => {
    const envOnly = deps({
      readCredentialEntries: async () => [],
      readCredentialMap: async () => ({ intranet: { key: 'env-key' } }),
    });
    await expect(createAccountResolver(envOnly)('intranet')).resolves.toEqual({
      key: `key:${accountKeyFromSecret('env-key')}`,
      label: null,
    });

    const configured = deps({
      readCredentialEntries: async () => [],
      readCredentialMap: async () => ({}),
      readProviderConfig: () => ({ apiKey: 'config-key' }),
    });
    await expect(createAccountResolver(configured)('intranet')).resolves.toEqual({
      key: `key:${accountKeyFromSecret('config-key')}`,
      label: null,
    });

    const bare = deps({ readCredentialEntries: async () => [], readCredentialMap: async () => ({}) });
    await expect(createAccountResolver(bare)('intranet')).resolves.toEqual({ key: 'provider:intranet', label: null });
  });

  it('keeps the account key when the token rotates', async () => {
    const first = deps({ readCredentialEntries: async () => [{ id: 'cred-1', integrationID: 'intranet', active: true }] });
    const second = deps({ readCredentialEntries: async () => [{ id: 'cred-1', integrationID: 'intranet', active: true, label: 'rotated' }] });
    expect((await createAccountResolver(first)('intranet')).key).toBe((await createAccountResolver(second)('intranet')).key);
  });

  it('caches per provider for the ttl', async () => {
    let reads = 0;
    const cached = deps({
      readCredentialEntries: async () => {
        reads += 1;
        return [{ id: 'c', integrationID: 'intranet', active: true }];
      },
    });
    const resolve = createAccountResolver(cached);
    await resolve('intranet');
    await resolve('intranet');
    expect(reads).toBe(1);
  });

  it('falls through when the credential store throws', async () => {
    const broken = deps({
      readCredentialEntries: async () => { throw new Error('offline'); },
      readCredentialMap: async () => ({ intranet: { key: 'env-key' } }),
    });
    await expect(createAccountResolver(broken)('intranet')).resolves.toMatchObject({ key: `key:${accountKeyFromSecret('env-key')}` });
  });
});
