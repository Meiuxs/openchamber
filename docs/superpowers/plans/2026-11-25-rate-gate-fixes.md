# Rate Gate Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the request-rate panel honest while rate-limited, and back off exponentially on repeated headerless 429s instead of retrying every local window.

**Architecture:** The server-side rate-gate runtime gains a per-account `consecutive429` counter used only for the no-gateway-time fallback, reports the real admitted count as `used`, and returns the cooldown as `retryAt` while it is active. The UI collapsed summary shows the cooldown countdown instead of `used/limit` for a limited account.

**Tech Stack:** TypeScript, vitest (server), bun:test + happy-dom (UI).

**Spec:** `docs/superpowers/specs/2026-11-25-rate-gate-fixes-design.md`

## Global Constraints

- Do NOT commit or push; the user has not authorized it.
- Do NOT add dependencies.
- `MAX_BACKOFF_MS = 5 * 60_000`.
- Gateway-provided `retry-after`/reset always wins over backoff.
- Repeated 429 reports inside one active cooldown must not escalate.
- Only reports with `status < 400` reset the counter.
- Server test: `cd packages/web && bunx vitest run server/lib/rate-gate/runtime.test.js`
- UI test: `cd packages/ui && bun test src/components/chat/work-status/WorkStatusRateLimitSection.test.tsx`

## Review Focus

- A 429 that arrives with no `retry-after` while the account has no grants must keep the existing 1-second fallback, not jump to a full window.
- Multiple 429 reports from OpenCode retrying one request must count as one limit cycle.
- A successful response on any model of the same account must clear the escalation.
- A gateway `retry-after` shorter than the local window must still reopen at exactly that time.
- While backing off, `retryAt` must not be shortened by an earlier local window end.

---

### Task 1: Honest `used` count while limited

**Files:**
- Modify: `packages/web/server/lib/rate-gate/runtime.ts:187-190`
- Test: `packages/web/server/lib/rate-gate/runtime.test.js`

**Interfaces:**
- Consumes: existing `createRateGateRuntime`, `runtime.acquire`, `runtime.report`, `runtime.status`.
- Produces: `RateGateStatus.accounts[].used` now equals admitted grants (`min(grants.length, total)`).

- [ ] **Step 1: Write the failing test**

Append inside `describe('the usage a panel reads')` in `runtime.test.js`:

```js
it('counts what was admitted, not a forced zero, while the account is cooling', async () => {
  const { runtime } = await setup({ requests: 100, windowMinutes: 1, gateways: ['http://gw.corp'] });
  await runtime.acquire(acquireBody());
  await runtime.report({ providerID: 'intranet', sessionID: 's1', accountKey: 'credential:a', status: 429 });
  await expect(runtime.status()).resolves.toMatchObject({ accounts: [{ used: 1, limit: 100, remaining: 0 }] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && bunx vitest run server/lib/rate-gate/runtime.test.js -t "counts what was admitted"`
Expected: FAIL — received `used: 100`.

- [ ] **Step 3: Implement**

In `usageOf`, replace `return { used: total - remaining, limit: total };` with:

```ts
return { used: Math.min(state.grants.length, total), limit: total };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && bunx vitest run server/lib/rate-gate/runtime.test.js -t "counts what was admitted"`
Expected: PASS.

---

### Task 2: Exponential backoff for headerless repeated 429

**Files:**
- Modify: `packages/web/server/lib/rate-gate/runtime.ts` (constants, `AccountState`, `getOrCreate`, `applyReport`, `retryAtFor`)
- Test: `packages/web/server/lib/rate-gate/runtime.test.js`

**Interfaces:**
- Consumes: Task 1's runtime.
- Produces: `AccountState.consecutive429: number`; `limitedUntil` and `retryAt` implement the backoff.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block in `runtime.test.js`:

```js
describe('backoff on repeated 429 without a gateway time', () => {
  const cool = (runtime, sessionID = 's1') => runtime.report({
    providerID: 'intranet', sessionID, accountKey: 'credential:a', status: 429,
  });

  it('doubles the cooldown for each 429 after the previous one expired', async () => {
    const { runtime, advance, at } = await setup({ requests: 100, windowMinutes: 1, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await cool(runtime);
    expect((await runtime.status()).accounts[0].limitedUntil).toBe(at() + 60_000);
    advance(60_000);
    await runtime.acquire(acquireBody({ sessionID: 's2' }));
    await cool(runtime, 's2');
    expect((await runtime.status()).accounts[0].limitedUntil).toBe(at() + 120_000);
  });

  it('does not escalate for the retries of one 429', async () => {
    const { runtime, at } = await setup({ requests: 100, windowMinutes: 1, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await cool(runtime);
    await cool(runtime);
    await cool(runtime);
    expect((await runtime.status()).accounts[0].limitedUntil).toBe(at() + 60_000);
  });

  it('starts over after a success', async () => {
    const { runtime, advance, at } = await setup({ requests: 100, windowMinutes: 1, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await cool(runtime);
    advance(60_000);
    await runtime.acquire(acquireBody({ sessionID: 's2' }));
    await cool(runtime, 's2');
    advance(120_000);
    await runtime.acquire(acquireBody({ sessionID: 's3' }));
    await runtime.report({ providerID: 'intranet', sessionID: 's3', accountKey: 'credential:a', status: 200 });
    await cool(runtime, 's3');
    expect((await runtime.status()).accounts[0].limitedUntil).toBe(at() + 60_000);
  });

  it('keeps the whole backoff even when the local window ends sooner', async () => {
    const { runtime, advance } = await setup({ requests: 100, windowMinutes: 1, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await cool(runtime);
    advance(60_000);
    await runtime.acquire(acquireBody({ sessionID: 's2' }));
    await cool(runtime, 's2');
    const limitedUntil = (await runtime.status()).accounts[0].limitedUntil;
    expect(limitedUntil).toBe(1_000_000 + 60_000 + 120_000);
    expect((await runtime.acquire(acquireBody({ sessionID: 's3' }))).retryAt).toBe(limitedUntil);
  });

  it('honours a gateway retry time instead of escalating', async () => {
    const { runtime, advance, at } = await setup({ requests: 100, windowMinutes: 1, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await runtime.report({ providerID: 'intranet', sessionID: 's1', accountKey: 'credential:a', status: 429, retryAfterMs: 2_000 });
    advance(2_000);
    await runtime.acquire(acquireBody({ sessionID: 's2' }));
    await runtime.report({ providerID: 'intranet', sessionID: 's2', accountKey: 'credential:a', status: 429, retryAfterMs: 2_000 });
    expect((await runtime.status()).accounts[0].limitedUntil).toBe(at() + 2_000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/web && bunx vitest run server/lib/rate-gate/runtime.test.js -t "backoff on repeated 429"`
Expected: FAIL — `limitedUntil` stays at one window (or `retryAt` is the window end).

- [ ] **Step 3: Implement**

In `runtime.ts`:

1. Add `const MAX_BACKOFF_MS = 5 * 60_000;` next to `FALLBACK_COOLDOWN_MS`.
2. Add `consecutive429: number;` to `AccountState`, exactly after `limitedUntil`.
3. Initialize `consecutive429: 0` in `getOrCreate`'s `created` object.
4. Replace the body of the `if (input.status === 429)` branch in `applyReport` with:

```ts
prune(state, at, windowMs);
state.authoritative = null;
const localNext = state.grants[0] ? state.grants[0] + windowMs : at + FALLBACK_COOLDOWN_MS;
const gatewayNext = Math.max(at + (limits.retryAfterMs ?? 0), reportedReset);
if (gatewayNext > at) {
  state.consecutive429 = 0;
  state.limitedUntil = gatewayNext;
  return;
}
const wasLimited = state.limitedUntil !== null && state.limitedUntil > at;
if (!wasLimited) state.consecutive429 += 1;
const base = state.grants[0] ? windowMs : FALLBACK_COOLDOWN_MS;
const factor = 2 ** Math.max(0, state.consecutive429 - 1);
const cooldown = Math.min(base * factor, MAX_BACKOFF_MS);
state.limitedUntil = Math.max(localNext, at + cooldown);
return;
```

5. After the `if (limits.remaining !== null && reportedReset > at)` block in the non-429 path, add:

```ts
if (input.status < 400) state.consecutive429 = 0;
```

6. At the top of `retryAtFor`, before building `candidates`, add:

```ts
if (state.limitedUntil !== null && state.limitedUntil > at) return state.limitedUntil;
```

- [ ] **Step 4: Run the full rate-gate suite**

Run: `cd packages/web && bunx vitest run server/lib/rate-gate/runtime.test.js`
Expected: PASS (all pre-existing 429/recovery tests included).

---

### Task 3: UI summary shows the cooldown while limited

**Files:**
- Modify: `packages/ui/src/components/chat/work-status/WorkStatusRateLimitSection.tsx:42-54`
- Test: `packages/ui/src/components/chat/work-status/WorkStatusRateLimitSection.test.tsx`

- [ ] **Step 1: Write the failing test**

Add inside `describe('work status request rate section')`:

```tsx
test('a limited summary shows the cooldown instead of a misleading used count', async () => {
  served = statusWith({
    accounts: [account({
      used: 1,
      limit: 100,
      remaining: 0,
      resetAt: NOW + 38_000,
      limitedUntil: NOW + 38_000,
      waiting: [{ sessionId: 'ses_1', until: NOW + 30_000 }],
    })],
  });
  await render();

  const heading = container.querySelector('[data-work-status-section="rateLimit"] [data-work-status-heading]');
  const text = heading?.textContent ?? '';
  expect(text).toContain('limited until');
  expect(text).toContain('0:38');
  expect(text).toContain('1 queued');
  expect(text).not.toContain('1/100');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ui && bun test src/components/chat/work-status/WorkStatusRateLimitSection.test.tsx -t "a limited summary"`
Expected: FAIL — heading contains `1/100` and no `limited until`.

- [ ] **Step 3: Implement**

In `WorkStatusRateLimitSection.tsx`, compute `const tightestUntil = tightest.limitedUntil;` and replace the summary's first child:

```tsx
{tightestUntil !== null && tightestUntil > now ? (
  <WorkStatusValue tone="error">
    {t('chat.workStatus.rateLimit.limitedUntil', { time: clock(tightestUntil, now) })}
  </WorkStatusValue>
) : (
  <WorkStatusValue tone={toneOf(tightest, now)}>
    {`${tightest.used}/${tightest.limit}`}
  </WorkStatusValue>
)}
```

- [ ] **Step 4: Run the UI test file**

Run: `cd packages/ui && bun test src/components/chat/work-status/WorkStatusRateLimitSection.test.tsx`
Expected: PASS.

---

### Task 4: Type check the touched packages

- [ ] **Step 1: Server types**

Run: `cd packages/web && bun run type-check:server`
Expected: exit 0.

- [ ] **Step 2: UI types**

Run: `cd packages/ui && bun run type-check`
Expected: exit 0.

## Self-Review

- Spec coverage: honest used (Task 1), backoff + retryAt (Task 2), per-model not implemented by design, UI summary (Task 3), type checks (Task 4).
- Type consistency: `consecutive429` is added to `AccountState` only; no schema changes; UI uses existing `limitedUntil`.
- Review Focus tests: no-grants 1s fallback is covered by the existing `still cools for a moment…` test; duplicate reports by Task 2 test 2; success reset by Task 2 test 3; gateway retry by Task 2 test 5; retryAt not shortened by Task 2 test 4.
