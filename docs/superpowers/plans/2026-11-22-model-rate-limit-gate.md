# Internal model rate limit gate implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `subagent-driven-development` or `executing-plans` to work through this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate every internal-model request on a per-account sliding window so a rate-limited account waits instead of failing, and show the window in the work status panel.

**Architecture:** A new server module owns the window state and exposes `acquire`, `report` and `status` routes. A generated OpenCode plugin calls `acquire` from `session.model.request`, which runs before the transport header timeout, and waits there when the account is out of quota. The plugin reports 429s and rate limit headers back. The shared UI reads the status route, subscribes to a broadcast event, and renders a work status section plus a row above the composer.

**Tech stack:** Node 20+, TypeScript, Express, Zod, Vitest, React, Zustand, Bun workspace scripts.

**Spec:** `docs/superpowers/specs/2026-11-22-model-rate-limit-gate-design.md`

## Global constraints

- Do not modify `d:/Code/opencode`.
- Do not add dependencies.
- Do not run git commands. This repository forbids them unless the user asks. Each task ends at a verification checkpoint, not a commit.
- Fixed identifiers: routes `/api/rate-gate/acquire`, `/api/rate-gate/report`, `/api/rate-gate/status`; event `openchamber:rate-gate`; section id `rateLimit`; settings keys `modelRateLimitRequests`, `modelRateLimitWindowMinutes`, `modelRateLimitGateways`; policy field `modelRateLimit`.
- The gate is enabled only when at least one gateway entry resolves, and only on OpenCode 2.2.7 or newer.
- The window state is in memory. No persistence, no cross-process coordination.
- All user-visible strings go through `t()`. The 15 locale dictionaries are typed against `en.ts`, so a missing key breaks the type check.
- `bun run check:changed` must pass before handoff. Never silence a rule to make it pass.
- Every new server module gets a `DOCUMENTATION.md` in the same shape as `packages/web/server/lib/limit-failover/DOCUMENTATION.md`.

## Review focus

These are the input classes this plan leaves uncovered on purpose, and each has a test where it belongs:

1. A wait longer than the 300 second transport header timeout. Task 13, end-to-end step 4.
2. A response with missing or unparseable rate limit headers. Task 1, `parseRateLimitHeaders` tests.
3. A provider whose credential cannot be resolved. Task 1, resolver fallback test; Task 2, acquire must not throw.
4. A user value above the policy cap, or an empty gateway list. Task 1 config tests; Task 5 sanitizer tests; Task 6 form validation.
5. A 429 with no remembered account key. Task 2 report fallback test.

---

## Task 1: Gateway matching, config resolution, headers, account resolution

**Files:**
- Create `packages/web/server/lib/rate-gate/policy.ts`
- Create `packages/web/server/lib/rate-gate/policy.test.js`
- Modify `packages/web/server/lib/opencode/auth.ts` (expose raw credential entries)

**Interfaces produced:**

```ts
export type RateGateConfig = { requests: number; windowMinutes: number; gateways: string[] };
export type RateGateCaps = { requests: number | null; windowMinutes: number | null };
export type RateGateSettingsInput = {
  modelRateLimitRequests?: unknown;
  modelRateLimitWindowMinutes?: unknown;
  modelRateLimitGateways?: unknown;
};
export type RateGatePolicyInput = { requests?: unknown; windowMinutes?: unknown; gateways?: unknown } | null;
export const RATE_GATE_DEFAULTS: { requests: 100; windowMinutes: 10 };
export const MAX_GATEWAYS = 50;
export const normalizeGateway: (value: unknown) => string | null;
export const normalizeGatewayList: (value: unknown) => string[];
export const parseGatewayText: (value: unknown) => string[];
export const matchesGateway: (url: string | null | undefined, gateways: readonly string[]) => boolean;
export const resolveRateGateConfig: (settings: RateGateSettingsInput | null | undefined, policy: RateGatePolicyInput) => { config: RateGateConfig; caps: RateGateCaps };
export const isRateGateConfigured: (config: RateGateConfig) => boolean;
export const parseRateLimitHeaders: (headers: { get(name: string): string | null }, now?: number) => { remaining: number | null; resetAt: number | null };
export const accountKeyFromSecret: (secret: string) => string;
export type AccountResolution = { key: string; label: string | null };
export type AccountResolverDependencies = {
  readCredentialEntries: () => Promise<Array<{ id: string; integrationID: string; active: boolean; label?: string | null }>>;
  readCredentialMap: () => Promise<Record<string, { key?: string; token?: string; label?: string }>>;
  readProviderConfig: (providerID: string) => { apiKey?: unknown; baseURL?: unknown } | null;
  now?: () => number;
  cacheTtlMs?: number;
};
export const createAccountResolver: (deps: AccountResolverDependencies) => (providerID: string) => Promise<AccountResolution>;
```

- [ ] **Step 1: Write the failing tests** in `policy.test.js`.

```js
import { describe, expect, it } from 'vitest';
import {
  matchesGateway, normalizeGateway, parseGatewayText, parseRateLimitHeaders,
  resolveRateGateConfig, createAccountResolver, accountKeyFromSecret,
} from './policy.js';

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
  const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null });
  it('accepts epoch ms, epoch s and seconds from now for reset', () => {
    const now = 1_700_000_000_000;
    expect(parseRateLimitHeaders(headers({ 'x-ratelimit-remaining': '7', 'x-ratelimit-reset': '1700000600000' }), now).resetAt).toBe(1_700_000_600_000);
    expect(parseRateLimitHeaders(headers({ 'x-ratelimit-reset': '1700000600' }), now).resetAt).toBe(1_700_000_600_000);
    expect(parseRateLimitHeaders(headers({ 'x-ratelimit-reset': '60' }), now).resetAt).toBe(now + 60_000);
  });
  it('ignores missing and garbage values', () => {
    expect(parseRateLimitHeaders(headers({}), 1)).toEqual({ remaining: null, resetAt: null });
    expect(parseRateLimitHeaders(headers({ 'x-ratelimit-remaining': 'lots', 'x-ratelimit-reset': 'soon' }), 1))
      .toEqual({ remaining: null, resetAt: null });
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
    const envOnly = deps({ readCredentialEntries: async () => [], readCredentialMap: async () => ({ intranet: { key: 'env-key' } }) });
    await expect(createAccountResolver(envOnly)('intranet')).resolves.toEqual({ key: `key:${accountKeyFromSecret('env-key')}`, label: null });
    const bare = deps({ readCredentialEntries: async () => [], readCredentialMap: async () => ({}), readProviderConfig: () => null });
    await expect(createAccountResolver(bare)('intranet')).resolves.toEqual({ key: 'provider:intranet', label: null });
  });
  it('caches per provider for the ttl', async () => {
    let reads = 0;
    const cached = deps({ readCredentialEntries: async () => { reads += 1; return [{ id: 'c', integrationID: 'intranet', active: true }]; } });
    const resolve = createAccountResolver(cached);
    await resolve('intranet');
    await resolve('intranet');
    expect(reads).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail.**

Run: `bun x vitest run packages/web/server/lib/rate-gate/policy.test.js`
Expected: module not found.

- [ ] **Step 3: Implement `policy.ts`.**

```ts
import { createHash } from 'node:crypto';

export const RATE_GATE_DEFAULTS = { requests: 100, windowMinutes: 10 } as const;
export const MAX_GATEWAYS = 50;
const MAX_REQUESTS = 10000;
const MAX_WINDOW_MINUTES = 1440;

const clampInt = (value: unknown, min: number, max: number): number | null => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, Math.round(number)));
};

export const normalizeGateway = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
};

export const normalizeGatewayList = (value: unknown): string[] => {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const normalized = normalizeGateway(entry);
    if (normalized) seen.add(normalized);
    if (seen.size >= MAX_GATEWAYS) break;
  }
  return [...seen];
};

export const parseGatewayText = (value: unknown) => normalizeGatewayList(value);

export const matchesGateway = (url: string | null | undefined, gateways: readonly string[]) => {
  if (!url || gateways.length === 0) return false;
  let target: URL;
  try { target = new URL(url); } catch { return false; }
  const href = target.href;
  return gateways.some((gateway) => href === gateway || href.startsWith(`${gateway}/`) || href.startsWith(`${gateway}?`));
};

export const resolveRateGateConfig = (settings: RateGateSettingsInput | null | undefined, policy: RateGatePolicyInput) => {
  const policyRequests = clampInt(policy?.requests, 1, MAX_REQUESTS);
  const policyWindow = clampInt(policy?.windowMinutes, 1, MAX_WINDOW_MINUTES);
  const policyGateways = normalizeGatewayList(policy?.gateways);
  const userRequests = clampInt(settings?.modelRateLimitRequests, 1, policyRequests ?? MAX_REQUESTS);
  const userWindow = clampInt(settings?.modelRateLimitWindowMinutes, 1, policyWindow ?? MAX_WINDOW_MINUTES);
  const userGateways = normalizeGatewayList(settings?.modelRateLimitGateways);
  return {
    config: {
      requests: userRequests ?? policyRequests ?? RATE_GATE_DEFAULTS.requests,
      windowMinutes: userWindow ?? policyWindow ?? RATE_GATE_DEFAULTS.windowMinutes,
      gateways: userGateways.length > 0 ? userGateways : policyGateways,
    },
    caps: { requests: policyRequests, windowMinutes: policyWindow },
  };
};

export const isRateGateConfigured = (config: RateGateConfig) => config.gateways.length > 0;

export const parseRateLimitHeaders = (headers: { get(name: string): string | null }, now = Date.now()) => {
  const remainingRaw = headers.get('x-ratelimit-remaining');
  const resetRaw = headers.get('x-ratelimit-reset');
  const remaining = remainingRaw !== null && remainingRaw.trim() !== '' && Number.isFinite(Number(remainingRaw))
    ? Math.max(0, Math.floor(Number(remainingRaw))) : null;
  let resetAt: number | null = null;
  const reset = resetRaw !== null && resetRaw.trim() !== '' ? Number(resetRaw) : NaN;
  if (Number.isFinite(reset) && reset > 0) {
    if (reset > 1e12) resetAt = Math.round(reset);
    else if (reset > 1e9) resetAt = Math.round(reset * 1000);
    else resetAt = now + Math.round(reset * 1000);
  }
  return { remaining, resetAt };
};

export const accountKeyFromSecret = (secret: string) => createHash('sha256').update(secret).digest('hex').slice(0, 16);

export const createAccountResolver = (deps: AccountResolverDependencies) => {
  const cache = new Map<string, { value: AccountResolution; expiresAt: number }>();
  const now = deps.now ?? Date.now;
  const ttl = deps.cacheTtlMs ?? 10_000;
  return async (providerID: string): Promise<AccountResolution> => {
    const cached = cache.get(providerID);
    if (cached && cached.expiresAt > now()) return cached.value;
    let value: AccountResolution | null = null;
    try {
      const entries = await deps.readCredentialEntries();
      const entry = entries.find((candidate) => candidate.active && candidate.integrationID === providerID);
      if (entry) value = { key: `credential:${entry.id}`, label: entry.label ?? null };
    } catch {}
    if (!value) {
      try {
        const map = await deps.readCredentialMap();
        const secret = map[providerID]?.key ?? map[providerID]?.token;
        if (secret) value = { key: `key:${accountKeyFromSecret(secret)}`, label: map[providerID]?.label ?? null };
      } catch {}
    }
    if (!value) {
      try {
        const config = deps.readProviderConfig(providerID);
        const secret = typeof config?.apiKey === 'string' ? config.apiKey : null;
        if (secret) value = { key: `key:${accountKeyFromSecret(secret)}`, label: null };
      } catch {}
    }
    value ??= { key: `provider:${providerID}`, label: null };
    cache.set(providerID, { value, expiresAt: now() + ttl });
    return value;
  };
};
```

- [ ] **Step 4: Expose raw credential entries from `auth.ts`.**

Add next to `readOpenCodeCredentials`:

```ts
export async function readOpenCodeCredentialEntries(): Promise<CredentialEntry[]> {
  if (!source?.list) throw new Error('OpenCode is not connected yet');
  return source.list();
}
```

The type already exists in that module. Keep the export unwrapped so the credential id survives; `readOpenCodeCredentials` keeps projecting its map for existing callers.

- [ ] **Step 5: Run the tests again.**

Run: `bun x vitest run packages/web/server/lib/rate-gate/policy.test.js`
Expected: all pass.

- [ ] **Step 6: Checkpoint.** `bun x tsc -p packages/web/tsconfig.json --noEmit` for type errors introduced by the new export.

---

## Task 2: Window state, acquire, report, status, routes

**Files:**
- Create `packages/web/server/lib/rate-gate/runtime.ts`
- Create `packages/web/server/lib/rate-gate/runtime.test.js`

**Interfaces produced:**

```ts
export type RateGateAcquireInput = { providerID: string; modelID: string; kind: string; url?: string; sessionID: string };
export type RateGateAcquireAnswer =
  | { action: 'pass'; gated: false }
  | { action: 'pass'; gated: true; accountKey: string; remaining: number; resetAt: number }
  | { action: 'wait'; gated: true; accountKey: string; retryAt: number };
export type RateGateReportInput = {
  providerID: string; sessionID: string; accountKey?: string; status: number;
  retryAfterMs?: number; remaining?: number; resetAt?: number;
};
export type RateGateStatus = { enabled: boolean; requests: number; windowMinutes: number; caps: { requests: number | null; windowMinutes: number | null }; accounts: RateGateAccount[] };
export type RateGateAccount = {
  key: string; label: string | null; providerIds: string[]; used: number; limit: number; remaining: number;
  resetAt: number; limitedUntil: number | null; authoritative: boolean;
  waiting: Array<{ sessionId: string; until: number }>;
};
export const WAITING_TTL_MS = 30_000;
export type RateGateRuntimeDependencies = {
  instanceDir: string;
  fs: { mkdir(path: string, options: { recursive: true }): Promise<unknown>; writeFile(path: string, data: string, encoding: 'utf8'): Promise<unknown> };
  path: { join(...parts: string[]): string };
  readSettings: () => Promise<RateGateSettingsInput | null>;
  readPolicy: () => RateGatePolicyInput;
  resolveAccount: (providerID: string) => Promise<AccountResolution>;
  resolveProviderBaseUrl: (providerID: string) => string | null;
  authorizeRequest: (req: unknown) => boolean;
  isPluginSupported: () => Promise<boolean>;
  broadcast?: (status: RateGateStatus) => void;
  now?: () => number;
};
export const createRateGateRuntime: (deps: RateGateRuntimeDependencies) => {
  pluginDirectory: string;
  isEnabled: () => Promise<boolean>;
  materializePlugin: () => Promise<string>;
  acquire: (input: RateGateAcquireInput) => Promise<RateGateAcquireAnswer>;
  report: (input: RateGateReportInput) => Promise<void>;
  status: () => Promise<RateGateStatus>;
  registerRoutes: (app: Express, express: { Router(): Router }) => void;
};
```

- [ ] **Step 1: Write failing tests** with a fake clock and no HTTP for the state functions.

```js
import { describe, expect, it } from 'vitest';
import { createRateGateRuntime } from './runtime.js';

const setup = async (config = { requests: 3, windowMinutes: 10, gateways: ['http://gw.corp'] }) => {
  let now = 1_000_000;
  const runtime = createRateGateRuntime({
    instanceDir: '/tmp/rate-gate-test',
    fs: { mkdir: async () => {}, writeFile: async () => {} },
    path: { join: (...parts) => parts.join('/') },
    readSettings: async () => ({}),
    readPolicy: () => config,
    resolveAccount: async () => ({ key: 'credential:a', label: 'me' }),
    resolveProviderBaseUrl: () => 'http://gw.corp/v1',
    authorizeRequest: () => true,
    isPluginSupported: async () => true,
    now: () => now,
  });
  return { runtime, advance: (ms) => { now += ms; }, at: () => now };
};

it('grants exactly requests slots and then answers wait at the oldest expiry', async () => {
  const { runtime, advance, at } = await setup();
  for (let i = 0; i < 3; i += 1) {
    expect(await runtime.acquire({ providerID: 'intranet', modelID: 'm', kind: 'primary', url: 'http://gw.corp/v1/chat', sessionID: 's1' }))
      .toMatchObject({ action: 'pass', gated: true, accountKey: 'credential:a' });
    advance(1_000);
  }
  const answer = await runtime.acquire({ providerID: 'intranet', modelID: 'm', kind: 'primary', url: 'http://gw.corp/v1/chat', sessionID: 's1' });
  expect(answer.action).toBe('wait');
  expect(answer.retryAt).toBe(1_000_000 + 600_000);
  advance(600_000);
  expect((await runtime.acquire({ providerID: 'intranet', modelID: 'm', kind: 'primary', url: 'http://gw.corp/v1/chat', sessionID: 's1' })).action).toBe('pass');
});

it('lets an authoritative remaining tighten the local count', async () => {
  const { runtime } = await setup({ requests: 100, windowMinutes: 10, gateways: ['http://gw.corp'] });
  await runtime.acquire({ providerID: 'intranet', modelID: 'm', kind: 'primary', url: 'http://gw.corp/v1', sessionID: 's1' });
  await runtime.report({ providerID: 'intranet', sessionID: 's1', accountKey: 'credential:a', status: 200, remaining: 0, resetAt: 1_000_000 + 60_000 });
  expect((await runtime.acquire({ providerID: 'intranet', modelID: 'm', kind: 'primary', url: 'http://gw.corp/v1', sessionID: 's1' })).action).toBe('wait');
});

it('cools the account on 429, using the reported account key', async () => {
  const { runtime, at } = await setup({ requests: 100, windowMinutes: 10, gateways: ['http://gw.corp'] });
  await runtime.report({ providerID: 'intranet', sessionID: 's1', accountKey: 'credential:a', status: 429, retryAfterMs: 120_000 });
  const answer = await runtime.acquire({ providerID: 'intranet', modelID: 'm', kind: 'primary', url: 'http://gw.corp/v1', sessionID: 's1' });
  expect(answer.retryAt).toBe(at() + 120_000);
});

it('resolves the account when a 429 arrives without a remembered key', async () => {
  const { runtime, at } = await setup({ requests: 100, windowMinutes: 10, gateways: ['http://gw.corp'] });
  await runtime.report({ providerID: 'intranet', sessionID: 's1', status: 429, retryAfterMs: 90_000 });
  const answer = await runtime.acquire({ providerID: 'intranet', modelID: 'm', kind: 'primary', url: 'http://gw.corp/v1', sessionID: 's1' });
  expect(answer.retryAt).toBe(at() + 90_000);
});

it('keeps working when account resolution throws', async () => {
  const runtime = createRateGateRuntime({
    instanceDir: '/tmp/rate-gate-test',
    fs: { mkdir: async () => {}, writeFile: async () => {} },
    path: { join: (...parts) => parts.join('/') },
    readSettings: async () => ({}),
    readPolicy: () => ({ requests: 5, windowMinutes: 10, gateways: ['http://gw.corp'] }),
    resolveAccount: async () => { throw new Error('credential store offline'); },
    resolveProviderBaseUrl: () => 'http://gw.corp/v1',
    authorizeRequest: () => true,
    isPluginSupported: async () => true,
    now: () => 1_000_000,
  });
  await expect(runtime.acquire({ providerID: 'intranet', modelID: 'm', kind: 'primary', url: 'http://gw.corp/v1', sessionID: 's1' }))
    .resolves.toMatchObject({ action: 'pass', gated: true, accountKey: 'provider:intranet' });
});

it('records waiting sessions for 30 seconds', async () => {
  const { runtime, advance } = await setup({ requests: 1, windowMinutes: 10, gateways: ['http://gw.corp'] });
  await runtime.acquire({ providerID: 'intranet', modelID: 'm', kind: 'primary', url: 'http://gw.corp/v1', sessionID: 's1' });
  await runtime.acquire({ providerID: 'intranet', modelID: 'm', kind: 'primary', url: 'http://gw.corp/v1', sessionID: 's1' });
  expect((await runtime.status()).accounts[0].waiting).toHaveLength(1);
  advance(31_000);
  expect((await runtime.status()).accounts[0].waiting).toHaveLength(0);
});

it('passes a URL outside the gateways without creating an account', async () => {
  const { runtime } = await setup();
  expect(await runtime.acquire({ providerID: 'openai', modelID: 'gpt', kind: 'primary', url: 'https://api.openai.com/v1', sessionID: 's1' }))
    .toEqual({ action: 'pass', gated: false });
  expect((await runtime.status()).accounts).toHaveLength(0);
});
```

- [ ] **Step 2: Run and watch fail.** `bun x vitest run packages/web/server/lib/rate-gate/runtime.test.js`

- [ ] **Step 3: Implement the state machine.**

Core rules, in `runtime.ts`:

```ts
const windowMs = config.windowMinutes * 60_000;
const prune = (state: AccountState, at: number) => {
  state.grants = state.grants.filter((grantedAt) => grantedAt > at - windowMs);
  if (state.limitedUntil !== null && state.limitedUntil <= at) state.limitedUntil = null;
  if (state.authoritative && state.authoritative.resetAt <= at) state.authoritative = null;
  for (const [sessionId, until] of state.waiting) if (until <= at) state.waiting.delete(sessionId);
};

const effectiveRemaining = (state: AccountState, at: number) => {
  let remaining = config.requests - state.grants.length;
  if (state.authoritative) remaining = Math.min(remaining, state.authoritative.remaining);
  if (state.limitedUntil !== null) remaining = 0;
  return Math.max(0, remaining);
};

const retryAtFor = (state: AccountState, at: number) => {
  const candidates = [state.grants[0] ? state.grants[0] + windowMs : at + 1_000];
  if (state.authoritative) candidates.push(state.authoritative.resetAt);
  if (state.limitedUntil !== null) candidates.push(state.limitedUntil);
  return Math.min(...candidates.filter((value) => value > at));
};
```

`acquire`:

```ts
const url = input.url ?? deps.resolveProviderBaseUrl(input.providerID) ?? null;
if (!matchesGateway(url, config.gateways)) return { action: 'pass', gated: false };
const account = await deps.resolveAccount(input.providerID);
const state = getOrCreate(account, input.providerID);
[state] prune;
if (effectiveRemaining(state, at) > 0) {
  state.grants.push(at);
  broadcastSoon();
  return { action: 'pass', gated: true, accountKey: account.key, remaining: effectiveRemaining(state, at), resetAt: retryAtFor(state, at) };
}
state.waiting.set(input.sessionID, at + WAITING_TTL_MS);
broadcastSoon();
return { action: 'wait', gated: true, accountKey: account.key, retryAt: retryAtFor(state, at) };
```

`report`:

```ts
const accountKey = input.accountKey
  ?? (await deps.resolveAccount(input.providerID).catch(() => null))?.key
  ?? null;
if (!accountKey) { for (const state of states.values()) if (state.providerIds.has(input.providerID)) applyReport(state); return; }
applyReport(getOrCreate({ key: accountKey, label: null }, input.providerID));
```

`applyReport` sets the cooldown for 429 or the authoritative snapshot for a 2xx/4xx with headers. Guard against `resetAt` in the past. In `acquire`, wrap `deps.resolveAccount` in a try/catch and fall back to `{ key: `provider:${input.providerID}`, label: null }`, so a credential store failure never blocks a model request.

The cooldown baseline uses the oldest local grant, or the current time when there are no local grants (an external client consumed the quota):

```ts
const localNext = state.grants[0] ? state.grants[0] + windowMs : at;
state.limitedUntil = Math.max(localNext, at + (input.retryAfterMs ?? 0), input.resetAt && input.resetAt > at ? input.resetAt : 0);
```

`status` returns `enabled: isRateGateConfigured(config)` and, for each account, prunes first, then maps fields with `label ?? providerIds[0]`.

- [ ] **Step 4: Add the Express routes** in the same file. Add `import { z } from 'zod';` and `import type { Express } from 'express';` at the top.

```ts
const acquireSchema = z.object({
  providerID: z.string().min(1), modelID: z.string().min(1), kind: z.string().min(1),
  url: z.string().optional(), sessionID: z.string().min(1),
});
const reportSchema = z.object({
  providerID: z.string().min(1), sessionID: z.string().min(1), accountKey: z.string().min(1).optional(),
  status: z.number().int(), retryAfterMs: z.number().finite().nonnegative().optional(),
  remaining: z.number().int().nonnegative().optional(), resetAt: z.number().finite().optional(),
});

app.post('/api/rate-gate/acquire', async (req, res) => {
  if (!deps.authorizeRequest(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const parsed = acquireSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_payload' }); return; }
  res.json(await acquire(parsed.data));
});
app.post('/api/rate-gate/report', async (req, res) => {
  if (!deps.authorizeRequest(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_payload' }); return; }
  await report(parsed.data);
  res.json({ ok: true });
});
app.get('/api/rate-gate/status', async (_req, res) => { res.json(await status()); });
```

- [ ] **Step 5: Add the route tests** with supertest.

```js
import express from 'express';
import request from 'supertest';

const mount = (authorizeRequest) => {
  const app = express();
  app.use(express.json());
  const runtime = createRateGateRuntime({ ...deps, authorizeRequest });
  runtime.registerRoutes(app, express);
  return app;
};

it('rejects unauthorized writes before touching state', async () => {
  await request(mount(() => false)).post('/api/rate-gate/acquire')
    .send({ providerID: 'intranet', modelID: 'm', kind: 'primary', sessionID: 's1' })
    .expect(401);
});

it('rejects a body without a session id', async () => {
  await request(mount(() => true)).post('/api/rate-gate/acquire')
    .send({ providerID: 'intranet', modelID: 'm', kind: 'primary' })
    .expect(400);
});

it('answers the status route without authorization', async () => {
  const response = await request(mount(() => false)).get('/api/rate-gate/status').expect(200);
  expect(response.body).toMatchObject({ enabled: true });
});
```

- [ ] **Step 6: Broadcast throttling.** Keep `lastBroadcastAt`; if less than 1000 ms since the last broadcast, set a single 1000 ms timer; otherwise broadcast now. The timer must be `unref()`ed so tests and shutdown are not held open.

- [ ] **Step 7: Run the tests.** `bun x vitest run packages/web/server/lib/rate-gate`
Expected: all pass.

---

## Task 3: Plugin source and materialization

**Files:**
- Create `packages/web/server/lib/rate-gate/plugin-source.ts`
- Modify `packages/web/server/lib/rate-gate/runtime.ts` (`materializePlugin`, `isEnabled`)
- Create `packages/web/server/lib/rate-gate/plugin-source.test.js`

**Interfaces produced:**

```ts
export const RATE_GATE_PLUGIN_ROUTE = '/api/rate-gate';
export const buildRateGatePluginSource: () => string;
```

- [ ] **Step 1: Write the plugin source** as a template string with no imports. Mirror `packages/web/server/lib/limit-failover/runtime.ts`'s `callback()` and `new URL(ROUTE, base)` pattern.

```js
const ROUTE = "/api/rate-gate"
const JITTER_MS = 250
const MAX_SLEEP_MS = 60_000
let gateOffUntil = 0
const admitted = new Map()

const callback = () => {
  const base = process.env.OPENCHAMBER_AGENT_TOOL_URL
  const token = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN
  if (!base || !token || !URL.canParse(base)) return null
  return { url: new URL(ROUTE, base).href, token }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const keyOf = (sessionID, providerID) => sessionID + "\n" + providerID

const send = async (target, path, body) => {
  const response = await fetch(target.url + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + target.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error("rate gate answered " + response.status)
  return response.json()
}

export default {
  id: "openchamber-rate-gate",
  setup: async (ctx) => {
    await ctx.session.hook("model.request", async (event) => {
      if (Date.now() < gateOffUntil) return
      const target = callback()
      if (!target) return
      const body = {
        providerID: event.model.providerID,
        modelID: event.model.id,
        kind: event.kind,
        url: event.baseURL,
        sessionID: event.sessionID,
      }
      try {
        for (;;) {
          const answer = await send(target, "/acquire", body)
          if (answer.action !== "wait") {
            if (answer.gated !== false) admitted.set(keyOf(event.sessionID, event.model.providerID), answer.accountKey)
            return
          }
          const wait = Math.max(0, Number(answer.retryAt) - Date.now())
          await sleep(Math.min(wait + Math.floor(Math.random() * JITTER_MS), MAX_SLEEP_MS))
        }
      } catch {
        gateOffUntil = Date.now() + 30_000
      }
    })

    await ctx.session.hook("http.response", async (event) => {
      const target = callback()
      if (!target || Date.now() < gateOffUntil) return
      const headers = event.response?.headers
      if (!headers) return
      const headerNumber = (name) => {
        const raw = headers.get(name)
        if (raw === null || raw === "") return undefined
        const value = Number(raw)
        return Number.isFinite(value) ? value : undefined
      }
      const body = {
        providerID: event.model.providerID,
        sessionID: event.sessionID,
        accountKey: admitted.get(keyOf(event.sessionID, event.model.providerID)),
        status: event.response.status,
        remaining: headerNumber("x-ratelimit-remaining"),
        resetAt: headerNumber("x-ratelimit-reset"),
      }
      send(target, "/report", body).catch(() => {})
    })

    await ctx.session.hook("retry", async (event) => {
      const target = callback()
      if (!target || Date.now() < gateOffUntil) return
      if (event.error?.status !== 429 && event.error?.type !== "provider.rate-limit") return
      send(target, "/report", {
        providerID: event.model.providerID,
        sessionID: event.sessionID,
        accountKey: admitted.get(keyOf(event.sessionID, event.model.providerID)),
        status: 429,
        retryAfterMs: event.error?.retryAfterMs,
      }).catch(() => {})
    })
  },
}
```

- [ ] **Step 2: Test the generated source.**

```js
import { describe, expect, it } from 'vitest';
import { buildRateGatePluginSource } from './plugin-source.js';

it('registers the three hooks and never embeds a token', () => {
  const source = buildRateGatePluginSource();
  expect(source).toContain('hook("model.request"');
  expect(source).toContain('hook("http.response"');
  expect(source).toContain('hook("retry"');
  expect(source).not.toContain('OPENCHAMBER_AGENT_TOOL_TOKEN =');
});
```

- [ ] **Step 3: Implement `materializePlugin`.**

```ts
const pluginDirectory = path.join(instanceDir, 'openchamber-rate-gate');
const materializePlugin = async () => {
  await fs.mkdir(pluginDirectory, { recursive: true });
  await fs.writeFile(path.join(pluginDirectory, 'package.json'),
    JSON.stringify({ name: 'openchamber-rate-gate', version: '1.0.0', type: 'module', main: 'index.js' }, null, 2), 'utf8');
  await fs.writeFile(path.join(pluginDirectory, 'index.js'), buildRateGatePluginSource(), 'utf8');
  return pluginDirectory;
};
```

- [ ] **Step 4: Implement `isEnabled`.**

```ts
const isEnabled = async () => {
  const settings = await deps.readSettings().catch(() => null);
  const { config } = resolveRateGateConfig(settings, deps.readPolicy());
  if (!isRateGateConfigured(config)) return false;
  return deps.isPluginSupported().catch(() => false);
};
```

- [ ] **Step 5: Run the tests.** `bun x vitest run packages/web/server/lib/rate-gate`

---

## Task 4: Policy field

**Files:**
- Modify `packages/web/server/lib/enterprise-mode.ts`

- [ ] **Step 1: Add the schema** beside the existing policy object fields:

```ts
const rateLimitSchema = z.object({
  requests: z.number().int().min(1).max(10000).optional(),
  windowMinutes: z.number().int().min(1).max(1440).optional(),
  gateways: z.array(z.string()).max(50).optional(),
});
```

Add `modelRateLimit: rateLimitSchema.optional()` to the policy schema and `modelRateLimit` to the returned policy type.

- [ ] **Step 2: Test** in the existing enterprise-mode test file: a valid object round-trips; `requests: 0` invalidates the policy through the existing `policyError` path.

- [ ] **Step 3: Run.** `bun x vitest run packages/web/server/lib/enterprise-mode.test.js`

---

## Task 5: Settings server plumbing

**Files:**
- Modify `packages/web/server/lib/settings/settings-helpers.ts`
- Modify `packages/web/server/lib/settings/settings-runtime.ts`
- Regenerate `packages/ui/src/lib/settings/settings-registry.json` and the server copy

- [ ] **Step 1: Register the keys in the sanitizer types.** In `settings-helpers.ts`, add `'modelRateLimitRequests' | 'modelRateLimitWindowMinutes'` to `NumberSettingsKey` and `'modelRateLimitGateways'` to `StringSettingsKey`.

- [ ] **Step 2: Sanitize the three keys** inside `sanitizeSettingsUpdate`, next to `sidebarSessionBatchSize`:

```ts
if (isFiniteNumber(candidate.modelRateLimitRequests)) {
  result.modelRateLimitRequests = Math.max(1, Math.min(10000, Math.round(candidate.modelRateLimitRequests)));
}
if (isFiniteNumber(candidate.modelRateLimitWindowMinutes)) {
  result.modelRateLimitWindowMinutes = Math.max(1, Math.min(1440, Math.round(candidate.modelRateLimitWindowMinutes)));
}
if (isString(candidate.modelRateLimitGateways)) {
  result.modelRateLimitGateways = normalizeGatewayList(candidate.modelRateLimitGateways).join('\n');
}
```

Note: the policy cap clamp happens in `resolveRateGateConfig` at read time, because policy can change after the settings were written. The sanitizer keeps only the absolute bounds.

- [ ] **Step 3: Defaults in `formatSettingsResponse`**: `modelRateLimitRequests: 100`, `modelRateLimitWindowMinutes: 10`, `modelRateLimitGateways: ''`.

- [ ] **Step 4: Add the keys to `MANAGED_PLUGIN_SETTINGS_KEYS`** in `settings-runtime.ts` so saving reloads the managed config.

- [ ] **Step 5: Generate the snapshot.** `bun run settings-registry:generate`

- [ ] **Step 6: Test** sanitize: a non-number is dropped, 0 becomes 1, a 20000 becomes 10000, gateway lines are normalized and deduped.

- [ ] **Step 7: Run** `bun x vitest run packages/web/server/lib/settings`

---

## Task 6: Settings UI plumbing (store, registry, parsers)

**Files:**
- Modify `packages/ui/src/stores/types.ts`, `initialState.ts`, `preferenceActions.ts`
- Modify `packages/ui/src/lib/settings/registry.ts`
- Modify `packages/ui/src/lib/settings/parsers.ts` if a shared helper is needed

- [ ] **Step 1: Add the three fields and setters** to the UI store: `modelRateLimitRequests: number`, `modelRateLimitWindowMinutes: number`, `modelRateLimitGateways: string`, plus `setModelRateLimitRequests`, `setModelRateLimitWindowMinutes`, `setModelRateLimitGateways`, following `sidebarSessionBatchSize` exactly (type, initial value, persistence key list).

- [ ] **Step 2: Register the fields** in `registry.ts` with `scope: 'profile'`:

```ts
modelRateLimitRequests: field({
  scope: 'profile',
  parse: parseIntegerInRange(1, 10000),
  ui: uiStore('modelRateLimitRequests', setUi((state) => state.setModelRateLimitRequests)),
}),
modelRateLimitWindowMinutes: field({
  scope: 'profile',
  parse: parseIntegerInRange(1, 1440),
  ui: uiStore('modelRateLimitWindowMinutes', setUi((state) => state.setModelRateLimitWindowMinutes)),
}),
modelRateLimitGateways: field({
  scope: 'profile',
  parse: parseTrimmedString,
  ui: uiStore('modelRateLimitGateways', setUi((state) => state.setModelRateLimitGateways)),
}),
```

- [ ] **Step 3: Run** `bun run settings-registry:generate` if the script also owns the UI snapshot. Check the script output for both file paths.

- [ ] **Step 4: Test** the settings document round trip in the existing settings parser test: values survive parse and serialize; a gateways string with blank lines serializes normalized.

---

## Task 7: Settings UI block

**Files:**
- Create `packages/ui/src/components/sections/openchamber/RateLimitSettings.tsx`
- Create `packages/ui/src/components/sections/openchamber/RateLimitSettings.test.tsx`
- Modify `packages/ui/src/components/sections/openchamber/DefaultsSettings.tsx`

- [ ] **Step 1: Implement the block** with `SettingsSection` and `SettingsFieldRow` from `@/components/sections/shared/SettingsSection`. Read the effective caps from `useRateGateStore`, and call `start()` plus `fetchStatus()` in an effect because the work status panel is not mounted on the settings page. Inputs are controlled by the UI store values. On change of the numeric fields, refuse values above `caps` and show the helper text instead of calling the setter.

```tsx
export const RateLimitSettings: React.FC = () => {
  const { t } = useI18n();
  const requests = useUIStore((state) => state.modelRateLimitRequests);
  const windowMinutes = useUIStore((state) => state.modelRateLimitWindowMinutes);
  const gateways = useUIStore((state) => state.modelRateLimitGateways);
  const setRequests = useUIStore((state) => state.setModelRateLimitRequests);
  const setWindow = useUIStore((state) => state.setModelRateLimitWindowMinutes);
  const setGateways = useUIStore((state) => state.setModelRateLimitGateways);
  const caps = useRateGateStore((state) => state.status?.caps ?? null);
  const [error, setError] = React.useState<'requests' | 'window' | null>(null);

  const commitRequests = (raw: string) => {
    const next = Number(raw);
    if (!Number.isFinite(next) || next < 1) { setError('requests'); return; }
    if (caps?.requests != null && next > caps.requests) { setError('requests'); return; }
    setError(null); setRequests(Math.round(next));
  };
  const commitWindow = (raw: string) => {
    const next = Number(raw);
    if (!Number.isFinite(next) || next < 1) { setError('window'); return; }
    if (caps?.windowMinutes != null && next > caps.windowMinutes) { setError('window'); return; }
    setError(null); setWindow(Math.round(next));
  };
  const sourceLabel = (value: number, cap: number | null, fallback: number) => {
    if (cap != null && value === cap) return t('settings.sessions.rateLimit.sourcePolicy');
    if (value === fallback) return t('settings.sessions.rateLimit.sourceDefault');
    return t('settings.sessions.rateLimit.sourceUser');
  };
  return (
    <SettingsSection title={t('settings.sessions.rateLimit.title')} description={t('settings.sessions.rateLimit.description')}>
      <SettingsFieldRow
        label={t('settings.sessions.rateLimit.requests')}
        info={caps?.requests != null ? t('settings.sessions.rateLimit.cap', { value: caps.requests }) : sourceLabel(requests, null, 100)}
      >
        <input type="number" min={1} max={caps?.requests ?? 10000} value={requests} onChange={(event) => commitRequests(event.target.value)} />
      </SettingsFieldRow>
      <SettingsFieldRow
        label={t('settings.sessions.rateLimit.windowMinutes')}
        info={caps?.windowMinutes != null ? t('settings.sessions.rateLimit.cap', { value: caps.windowMinutes }) : sourceLabel(windowMinutes, null, 10)}
      >
        <input type="number" min={1} max={caps?.windowMinutes ?? 1440} value={windowMinutes} onChange={(event) => commitWindow(event.target.value)} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.sessions.rateLimit.gateways')} info={t('settings.sessions.rateLimit.gatewaysHelp')}>
        <textarea rows={3} value={gateways} onChange={(event) => setGateways(event.target.value)} />
      </SettingsFieldRow>
      {error !== null ? (
        <p className={SETTINGS_HELPER_CLASS}>
          {t('settings.sessions.rateLimit.overCap', { value: error === 'requests' ? caps?.requests : caps?.windowMinutes })}
        </p>
      ) : null}
      {gateways.trim() === '' ? <p className={SETTINGS_HELPER_CLASS}>{t('settings.sessions.rateLimit.disabled')}</p> : null}
    </SettingsSection>
  );
};
```

Input and textarea styling follows the numeric field in `CompactionSettings.tsx`. Import `SETTINGS_HELPER_CLASS` from `@/components/sections/shared/SettingsSection`.

- [ ] **Step 2: Render it** in `DefaultsSettings.tsx` after the compaction block: `<RateLimitSettings />`.

- [ ] **Step 3: Test** the component: above-cap input does not update the store; a valid value does; the policy cap text is shown.

---

## Task 8: Server wiring

**Files:**
- Modify `packages/web/server/lib/opencode/managed-config-file.ts`
- Modify `packages/web/server/lib/server-frame/bootstrap-runtime.ts`
- Modify `packages/web/server/runtime.ts`

- [ ] **Step 1: Add the dependency** where `limitFailoverRuntime` is declared in `managed-config-file.ts`:

```ts
rateGateRuntime?: { isEnabled(): Promise<boolean>; materializePlugin(): Promise<string> };
```

- [ ] **Step 2: Materialize beside the failover plugin.** In `materializeEnabledPlugins`, after the failover block:

```ts
const rateGatePlugin = agentToolRuntime && rateGateRuntime && await rateGateRuntime.isEnabled().catch(() => false)
  ? await rateGateRuntime.materializePlugin()
  : null;
```

Add `rateGatePlugin` to the same directory list that already contains `limitFailoverPlugin`.

- [ ] **Step 3: Register the routes** in `bootstrap-runtime.ts` next to `limitFailoverRuntime?.registerRoutes(app, express);`:

```ts
rateGateRuntime?.registerRoutes(app, express);
```

Add `rateGateRuntime?: { registerRoutes(app: Express, express: typeof import('express')): void }` to the bootstrap dependency type.

- [ ] **Step 4: Construct the runtime** in `runtime.ts` after `limitFailoverRuntime`:

```ts
const rateGateRuntime = createRateGateRuntime({
  instanceDir: OPENCHAMBER_DATA_DIR,
  fs: fsPromises,
  path,
  readSettings: () => readSettingsFromDiskMigrated(),
  readPolicy: () => readEnterprisePolicy()?.modelRateLimit ?? null,
  resolveAccount: createAccountResolver({
    readCredentialEntries: () => readOpenCodeCredentialEntries(),
    readCredentialMap: () => readOpenCodeCredentials(),
    readProviderConfig: (providerID) => {
      const provider = readConfigLayers().mergedConfig?.provider?.[providerID];
      return provider && typeof provider === 'object'
        ? { apiKey: provider.options?.apiKey, baseURL: provider.options?.baseURL }
        : null;
    },
  }),
  resolveProviderBaseUrl: (providerID) => {
    const provider = readConfigLayers().mergedConfig?.provider?.[providerID];
    const baseURL = provider && typeof provider === 'object' ? provider.options?.baseURL : undefined;
    return typeof baseURL === 'string' ? baseURL : null;
  },
  authorizeRequest,
  isPluginSupported: async () => {
    const { version } = await getOpenCodeCompatibility();
    return version !== null && !isOpenCodeOlderThan(version, '2.2.7');
  },
  broadcast: (status) => broadcastOpenChamberUiEvent({ type: 'openchamber:rate-gate', properties: status }),
});
```

Use the same `authorizeRequest` the failover runtime uses, and cache `isPluginSupported` for 60 seconds to avoid spawning `opencode --version` on every managed config write. Narrow the `provider` value with the existing `isRecord` guard before reading `options`, and import `createAccountResolver`, `readOpenCodeCredentialEntries`, `readConfigLayers` and `isOpenCodeOlderThan`.

- [ ] **Step 5: Pass it through.** Add `rateGateRuntime` to the dependency object passed to `createManagedConfigRuntime` (next to `limitFailoverRuntime` around line 2460) and to the object passed to `bootstrapRuntime.setupBaseRoutes` (next to `limitFailoverRuntime` around line 2815).

- [ ] **Step 6: Verify.** `bun x tsc -p packages/web/tsconfig.json --noEmit`, then start the app and confirm the managed config file lists the new plugin only after a gateway is configured.

---

## Task 9: UI store and event type

**Files:**
- Modify `packages/ui/src/lib/openchamberEvents.ts`
- Create `packages/ui/src/stores/useRateGateStore.ts`
- Create `packages/ui/src/stores/useRateGateStore.test.ts`

- [ ] **Step 1: Add the event type** `'openchamber:rate-gate'` to `OpenChamberEventType` and `OpenChamberEventProperties`. The properties are the `RateGateStatus` shape; duplicate the type in the store or import a shared type if one already crosses the boundary.

- [ ] **Step 2: Implement the store**. Imports: `create` from `zustand`, `runtimeFetch` from `@/lib/runtime-fetch`, `subscribeOpenchamberEvents` from `@/lib/openchamberEvents`, `subscribeRuntimeEndpointChanged` from `@/lib/runtime-switch`:

```ts
type RateGateStore = {
  status: RateGateStatus | null;
  loading: boolean;
  start: () => void;
  fetchStatus: () => Promise<void>;
  waitingUntil: (sessionId: string) => number | null;
};

export const useRateGateStore = create<RateGateStore>((set, get) => ({
  status: null,
  loading: false,
  start: () => { startRateGateSubscription(); },
  fetchStatus: async () => {
    set({ loading: true });
    try {
      const response = await runtimeFetch('/api/rate-gate/status');
      if (response.ok) set({ status: await response.json() });
    } catch {
      set({ status: null });
    } finally {
      set({ loading: false });
    }
  },
  waitingUntil: (sessionId) => {
    const accounts = get().status?.accounts ?? [];
    for (const account of accounts) {
      const entry = account.waiting.find((item) => item.sessionId === sessionId);
      if (entry) return entry.until;
    }
    return null;
  },
}));
```

`startRateGateSubscription` keeps a module-level flag, subscribes with `subscribeOpenchamberEvents` (the event carries the status as `properties`), fetches once, and sets a 30 second interval only while a caller is mounted. It also calls `subscribeRuntimeEndpointChanged` to clear `status` and refetch, so switching between the web and desktop runtimes never shows the other runtime's accounts. Guard against the VS Code no-op subscription by ignoring a missing status route: `fetchStatus` leaves `status` at `null`, and both consumers render nothing.

- [ ] **Step 3: Test** the store: an event updates the status; a failed fetch clears it; `waitingUntil` returns the entry for a session and null otherwise.

---

## Task 10: Work status section

**Files:**
- Modify `packages/ui/src/components/chat/work-status/sections.ts`
- Modify `packages/ui/src/components/chat/work-status/WorkStatusSectionList.tsx`
- Modify `packages/ui/src/components/chat/work-status/useUnavailableWorkStatusSections.ts`
- Create `packages/ui/src/components/chat/work-status/WorkStatusRateLimitSection.tsx`
- Create `packages/ui/src/components/chat/work-status/WorkStatusRateLimitSection.test.tsx`

- [ ] **Step 1: Register the id.** Add `'rateLimit'` after `'usage'` in `WORK_STATUS_SECTION_IDS`, add `rateLimit: 'chat.workStatus.section.rateLimit'` to `WORK_STATUS_SECTION_LABEL_KEYS`, and add `['rateLimit', 'usage']` to `PLACED_AFTER` so stored orders place it after usage.

- [ ] **Step 2: Render it.** In `WorkStatusSectionList.tsx`, add `rateLimit: <WorkStatusRateLimitSection visible={visible} />` to `secondarySections`.

- [ ] **Step 3: Hide it where it cannot work.** In `useUnavailableWorkStatusSections`, add `'rateLimit'` when `isMobile` is true. VS Code is covered by the empty status: the section returns null. Do not add it to the mobile popover.

- [ ] **Step 4: Implement the component** with `WorkStatusCollapsibleSection`, `WorkStatusRow`, `WorkStatusValue`, `useReportWorkStatusPresence('rateLimit', accounts.length > 0)`, and a 1 second ticker for the countdown:

```tsx
const summary = accounts.length > 0
  ? `${Math.min(...accounts.map((a) => a.remaining))}/${accounts[0].limit}`
  : null;
```

Rows: `label ?? providerIds[0]`, `used / limit`, `resetIn` or `limitedUntil` countdown, and `waiting.length` when non-zero. Sort accounts by `remaining` ascending. Render `null` when `status === null || !status.enabled || accounts.length === 0`.

- [ ] **Step 5: Test** the component with a fixed store state: renders one row per account, hides without a status, shows the restricted state when `limitedUntil` is in the future.

---

## Task 11: Inline waiting row

**Files:**
- Create `packages/ui/src/components/chat/composer/input/RateGateWaitingRow.tsx`
- Create `packages/ui/src/components/chat/composer/input/RateGateWaitingRow.test.tsx`
- Modify `packages/ui/src/components/chat/composer/input/useComposerRows.tsx`

- [ ] **Step 1: Implement the row.**

```tsx
export const RateGateWaitingRow: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { t } = useI18n();
  const until = useRateGateStore((state) => state.waitingUntil(sessionId));
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    if (until === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  if (until === null || until <= now) return null;
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  const eta = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <div role="status" className="flex oc-composer-row items-center gap-2 border-b border-edge ps-3 pe-3 typography-meta text-muted-foreground">
      <Icon name="time" className="size-3.5 shrink-0" />
      <span>{t('chat.rateLimit.waiting', { time: eta })}</span>
    </div>
  );
};
```

- [ ] **Step 2: Render it** in `useComposerRows.tsx` right after `queueRow`, guarded the same way:

```tsx
const rateGateRow = !isBtwActive && !newSessionDraftOpen && currentSessionId
  ? <RateGateWaitingRow sessionId={currentSessionId} />
  : null;
```

Include `rateGateRow` in the returned row list in the same position.

- [ ] **Step 3: Test** that it renders nothing without a waiting entry, shows the ETA with one, and disappears when `until` passes.

---

## Task 12: Translations

**Files:**
- Modify `packages/ui/src/lib/i18n/messages/en.ts` and all 14 other locale dictionaries.

- [ ] **Step 1: Add the keys to `en.ts`**:

```ts
'chat.workStatus.section.rateLimit': 'Request rate',
'chat.workStatus.rateLimit.resetIn': 'resets in {time}',
'chat.workStatus.rateLimit.limitedUntil': 'limited until {time}',
'chat.workStatus.rateLimit.queued': '{count} queued',
'chat.rateLimit.waiting': 'Waiting for quota, resuming in {time}',
'settings.sessions.rateLimit.title': 'Internal model rate limit',
'settings.sessions.rateLimit.description': 'Requests to configured gateways wait for a free slot instead of failing.',
'settings.sessions.rateLimit.requests': 'Requests per window',
'settings.sessions.rateLimit.windowMinutes': 'Window (minutes)',
'settings.sessions.rateLimit.gateways': 'Gateway addresses',
'settings.sessions.rateLimit.gatewaysHelp': 'One origin per line. Requests to these addresses are rate limited.',
'settings.sessions.rateLimit.cap': 'The policy allows at most {value}.',
'settings.sessions.rateLimit.overCap': 'Enter a value up to {value}.',
'settings.sessions.rateLimit.sourceUser': 'Set by you',
'settings.sessions.rateLimit.sourcePolicy': 'Using the policy value',
'settings.sessions.rateLimit.sourceDefault': 'Using the built-in default',
'settings.sessions.rateLimit.disabled': 'The gate is off until a gateway address is configured.',
'settings.sessions.rateLimit.versionUnsupported': 'Queueing needs OpenCode 2.2.7 or newer.',
```

- [ ] **Step 2: Add the same keys to every other dictionary.** Run `bun x tsc -p packages/ui/tsconfig.json --noEmit`; missing keys in a dictionary fail the build. Translators can keep `en` text where a translation is unknown, but the placeholders must match exactly.

- [ ] **Step 3: Check.** `bun run check:changed`

---

## Task 13: Verification

**Files:** none committed; the fake gateway is created under the OS temp directory and removed afterwards.

- [ ] **Step 1: Unit and component suites.**

Run: `bun x vitest run packages/web/server/lib/rate-gate packages/ui/src/components/chat/work-status packages/ui/src/stores/useRateGateStore.test.ts`
Expected: all pass.

- [ ] **Step 2: Start the fake gateway.** Write `rate-gate-gateway.mjs` in the temp directory:

```js
import { createServer } from 'node:http';
const requests = [];
const LIMIT = Number(process.env.LIMIT ?? 100);
const WINDOW = Number(process.env.WINDOW_MS ?? 600000);
createServer((req, res) => {
  const now = Date.now();
  while (requests.length && requests[0] <= now - WINDOW) requests.shift();
  const reset = Math.ceil(((requests[0] ?? now) + WINDOW - now) / 1000);
  if (requests.length >= LIMIT) {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(reset), 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
    res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    return;
  }
  requests.push(now);
  res.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-remaining': String(LIMIT - requests.length), 'x-ratelimit-reset': String(reset) });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
}).listen(4319, '127.0.0.1');
```

- [ ] **Step 3: Run the isolated dev instance** per `openchamber-change-discipline` and `references/live-dev-instance.md`. Configure an openai-compatible provider whose `baseURL` is `http://127.0.0.1:4319/v1` and set `modelRateLimit` in the policy (or the user settings) with that gateway, `requests: 5`, `windowMinutes: 1`. This keeps the scenario under a minute.

- [ ] **Step 4: Saturation.** Drive 120 requests. Confirm requests 6 onward wait, the work status section shows the account near its limit, the inline row shows the countdown, and every request eventually completes.

- [ ] **Step 5: Long wait, the core regression.** Set `requests: 1`, `windowMinutes: 10`, fire one request, then fire a second. Confirm the second is still alive after 300 seconds and completes at the window boundary. This proves the wait is outside the transport header timeout. With a 10 minute window this step takes 10 minutes; keep it in the verification run, not in CI.

- [ ] **Step 6: 429 path.** Make the gateway answer 429 early by sending a request from outside the app with the same fixture (or set `LIMIT` lower at startup than the configured value). Confirm the account cools down, the UI shows the recovery time, the turn survives, and it completes after the reset.

- [ ] **Step 7: Interrupt.** Start a wait, then stop the session. Confirm no request reaches the gateway for that attempt (the gateway log stays unchanged).

- [ ] **Step 8: Broken gate.** Stop the OpenChamber server's gate route (block the port) while the app runs. Confirm requests pass after the 30 second circuit breaker and the app does not stall.

- [ ] **Step 9: Final checks.** `bun run check:changed`, then read `packages/web/server/lib/rate-gate/DOCUMENTATION.md` against the final code and update it where a decision changed during the build.

---

## Self-review notes for the executor

- `session.model.request` is the only safe wait location. If a later OpenCode version moves the hook inside the transport timeout, the long-wait test in Task 13 Step 5 is the regression that catches it.
- Do not add a second acquire call in `session.http.request`. It reintroduces the timeout that this design removes.
- Do not persist the window. The restart gap is covered by the 429 path and is documented.
- The UI must degrade to nothing without the status route. That is what keeps VS Code and old servers from showing an empty section.
- Every new settings key must appear in three places: the UI registry, the server sanitizer/defaults, and the generated snapshot. A missing snapshot entry makes the value disappear after a reload.
