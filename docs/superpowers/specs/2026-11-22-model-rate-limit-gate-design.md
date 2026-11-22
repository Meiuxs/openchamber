# Internal model rate limit gate

**Date:** 2026-11-22
**Status:** Design settled after review. Implementation not started.
**Scope:** Web browser and Electron. VS Code shows no rate section and queues nothing. Mobile is excluded.

## Goal

Company internal models are rate limited per personal account, for example 100 requests per 10 minutes, shared by every model that account can reach. OpenChamber must do two things:

- Show the current request rate of each personal account in the work status panel.
- Keep sessions running when the limit is reached, by holding each model request until the account has quota instead of sending requests that fail with 429.

The rate limit must be configurable, and a rate-limited turn must never end in failure.

## Why the wait happens before the request, not after the failure

OpenCode retries a failed attempt at most 10 times, and that budget includes 429s. Waiting for a 10 minute window by retrying would exhaust it and end the turn. The only place a wait costs no attempt is before the request is prepared.

`session.model.request` runs once per attempt, before the transport starts its 300 second header timeout. A wait there is free of that timeout, and a user interrupt interrupts the hook's fiber, so the request is never sent. `session.http.request` runs inside the header timeout, so a wait longer than about 5 minutes makes the attempt fail as a transport timeout, with 3 timeout retries. That is why the gate lives in `model.request`.

## Non-goals

- No change to `d:/Code/opencode`.
- No local reverse proxy and no rewrite of a user's provider configuration.
- No queueing in VS Code or in an external OpenCode (`OPENCODE_HOST`, skip-start). Both never load OpenChamber's managed plugin.
- No mobile surface for the rate section. The mobile status popover keeps its current cards.
- No replacement for `limit-failover`. Account switching and fallback models stay in that module and can be enabled beside this one.
- No persistence of the window across an OpenChamber restart.
- No cross-machine coordination. The deployment is a single machine per account.
- No per-provider limits. The limit belongs to the account.

## Settled decisions

| Decision | Choice |
| --- | --- |
| Which requests are gated | The provider's `baseURL` matches a configured gateway entry |
| Gating hook | `session.model.request`, outside the transport header timeout |
| Where the limit comes from | `policy.json` provides the default and the maximum; user settings may only tighten |
| Account identity | Server resolves the provider's credential: credential ID when stored, a hash of the resolved key otherwise, provider ID last |
| Retry account lookup | The acquire answer carries `accountKey`; the plugin remembers it per session and provider |
| Window | Sliding window of `windowMinutes`, local count is conservative |
| Gateway headers | Authoritative cap when present, applied when the response body completes |
| Queue mechanism | `acquire` answers `wait` with the next free time; the plugin sleeps and asks again with jitter |
| Priority | Every request kind competes equally |
| 429 handling | Cool the account down, then let the retried attempt pass the gate in the new window |
| Server unreachable | Pass the request and open a 30 second circuit breaker |
| Window persistence | None. A restart may briefly overrun and is corrected by the 429 path |
| Plugin load condition | At least one gateway entry is configured and OpenCode is version 2.2.7 or newer |
| Settings location | Settings → Sessions (Session defaults) |
| Work status section id | `rateLimit`, placed after `usage` |
| Waiting visibility | Work status section plus an inline row above the composer |
| Deployment | One machine per account, no shared counter |

## Runtime scope

- **Web browser:** full feature. The server owns the gate and the UI reads it.
- **Electron:** follows the web server and UI, no separate path.
- **VS Code extension-only runtime:** the managed plugin is never loaded, so nothing is queued. `subscribeOpenchamberEvents` is already a no-op there and the section renders nothing when the status route is unavailable.
- **Mobile:** the section is not added to the mobile status popover.
- **Isolated spaces:** the plugin belongs to the OpenCode process OpenChamber starts for the host. A session inside a space talks to the space server's OpenCode, which loads no gate plugin. Spaces stay uncovered and the panel reads the host server only.
- **OpenCode version:** OpenChamber's minimum is 2.2.4 and its bundled version is 2.3.2. The model and HTTP hooks are present in the 2.2.7 source checkout, so the gate is enabled from 2.2.7. On 2.2.4 to 2.2.6 the settings page says queueing is unavailable and no plugin is materialized. Lowering the floor to 2.2.4 needs a check of that published version and is a follow-up, not part of this change.

## Account identity

The gateway limits the person, not the provider. Since `session.model.request` carries no credential headers, the server resolves the account for the `providerID` the plugin reports:

1. The provider's active stored credential, read through `readOpenCodeCredentials()` in `packages/web/server/lib/opencode/auth.ts`, looked up by the provider's integration ID, which OpenCode reports per provider when it differs from the provider ID. The key is `credential:<credentialID>`, which stays stable when an OAuth access token refreshes.
2. The provider's environment key from `projectEnvironmentKeys()`, keyed as `key:<sha256(value).slice(0, 16)>`.
3. The provider's configured key, `provider.<id>.options.apiKey`, resolved through `resolveConfigApiKey` so `{env:...}` and `{file:...}` work, keyed the same way.
4. `provider:<providerID>` when none of the above resolves.

The credential ID is used rather than its token because OAuth tokens rotate: hashing them would start a fresh window after every refresh and under-count. The trade-off is that two providers which each store the same token as separate credentials show as two accounts. The secret itself never leaves the server process and is never sent to the UI or the plugin. A failed credential or config read falls through to the next step instead of failing the acquire, so a slow OpenCode never blocks a model request.

The resolution result is cached for 10 seconds, so an account switch takes at most that long to change the key. An account label travels with the result: the credential's label when present, otherwise the provider name.

When nothing resolves, the provider ID becomes the key. That direction only over-counts, never under-counts, because each provider gets its own window.

## Window model

### Counting

- A slot is consumed when the server answers `pass`, which happens before the request is prepared.
- The window is the last `windowMinutes` milliseconds. Expired grants are pruned on every read and write.
- `used` is the number of grants in the window, `remaining` is `requests - used`.
- A granted slot whose request then fails before reaching the gateway is still counted. Losing one slot is cheaper than overrunning.

Some requests never pass the gate again: compaction and `generate` retry a prepared request at the effect layer, and a failed WebSocket attempt can fall back to HTTP within the same step. Those extra HTTP requests are not counted. The 429 cooldown is the backstop, and this is recorded under residual risks.

### Header calibration

`session.http.response` fires after the response body has been read, not when the headers arrive. Headers are still read from the response object and reported at that point.

When a response carries rate limit headers, the server stores `{ remaining, resetAt }` for the account:

- `x-ratelimit-remaining` is an integer.
- `x-ratelimit-reset` accepts epoch milliseconds when the value is above 1e12, epoch seconds when above 1e9, and a number of seconds from now otherwise.

While the snapshot is live (`resetAt > now`), permitting uses `min(requests - used, authoritative.remaining)`. When either reaches zero, the account waits until the earlier of the next local grant expiry and `resetAt`. An unparseable header is ignored, and a response without them leaves the local count in charge.

Because calibration lands at the end of a stream, a long response corrects the count late. Local counting stays conservative in the meantime.

### 429 handling

`session.retry` has no request or credential in its event, so the plugin reports the `accountKey` it received from the last acquire for that session and provider. The server sets:

```
limitedUntil = max(localNextReset, now + retryAfterMs, reportedResetAt)
```

`localNextReset` is when the oldest local grant leaves the window, or the current time when there are no local grants. Using the current time for an empty local window keeps a gateway `Retry-After` from being stretched to a full window that this process never used.

When the plugin has no remembered key, the server resolves the account from the provider as it does for acquire. When that also fails, every account known for the provider is cooled down. Every acquire for a cooled account waits until `limitedUntil`, and the status carries the value so the panel can show the recovery time.

A 429 does not change `event.decision`; the retried attempt passes the gate as usual.

## Configuration

### Policy file

`policy.json` gains a sibling of the existing fields:

```json
"modelRateLimit": {
  "requests": 100,
  "windowMinutes": 10,
  "gateways": ["http://llm-gw.corp.example.com"]
}
```

Validation lives beside the existing policy schema in `packages/web/server/lib/enterprise-mode.ts`:

- `requests`: integer, 1 to 10000. It is both the default and the maximum.
- `windowMinutes`: integer, 1 to 1440. It is both the default and the maximum.
- `gateways`: at most 50 entries. Each is an `http` or `https` URL with no credentials, query or fragment, normalized to origin plus optional path prefix without a trailing slash.

An invalid `modelRateLimit` object invalidates the policy file the same way other invalid fields do, and the existing `policyError` path reports it.

### User settings

Profile-scoped settings, registered in `packages/ui/src/lib/settings/registry.ts` and sanitized in `packages/web/server/lib/settings/settings-helpers.ts`:

| Key | Type | Range |
| --- | --- | --- |
| `modelRateLimitRequests` | number | 1 to the policy maximum, else 10000 |
| `modelRateLimitWindowMinutes` | number | 1 to the policy maximum, else 1440 |
| `modelRateLimitGateways` | text, one entry per line | same validation as the policy list, at most 50 |

A stored value above the policy maximum is clamped to it by the sanitizer. The settings form refuses such a value with a message instead of silently writing a different number.

The settings snapshot `packages/web/server/lib/settings/settings-registry.json` is regenerated with `bun run settings-registry:generate`.

### Effective configuration

Resolution runs on the server in this order:

1. A valid user value.
2. The policy value.
3. Built-in defaults: 100 requests, 10 minutes, no gateways.

User values are clamped to the policy maximum when the policy defines one. Gateways use the user list when it is non-empty, else the policy list, so clearing the text field cannot switch the gate off. When both are empty the feature is disabled: no plugin is materialized, every route answers `enabled: false`, and no request is delayed.

### Settings UI

A block in Settings → Sessions, below session defaults, with three inputs: requests, window in minutes, and gateways as multi-line text. The block shows the effective source of each value (user, policy, default), shows the policy maximum, and refuses a value above it. It also states that the gate is off while no gateway is configured, and shows the version warning when OpenCode is older than 2.2.7.

## Server module

New module `packages/web/server/lib/rate-gate/`:

- `policy.ts`: config resolution, gateway normalization and matching, account resolution, schemas.
- `runtime.ts`: window state, waiting map, routes, broadcast, plugin materialization.
- `DOCUMENTATION.md`: ownership, invariants, decisions, per the module documentation rule.
- `runtime.test.js`: focused tests.

### State

In memory only, keyed by `accountKey`:

```ts
type AccountState = {
  label: string | null;
  providerIds: Set<string>;
  grants: number[];
  authoritative: { remaining: number; resetAt: number } | null;
  limitedUntil: number | null;
  waiting: Map<string, number>; // sessionID -> expiry
};
```

Account resolution results and their secrets are cached separately for 10 seconds. Acquire, report and status prune expired grants and expired waiting entries before reading. No locking is needed: Node runs the state transitions on one thread.

### Routes

| Route | Body | Answer |
| --- | --- | --- |
| `POST /api/rate-gate/acquire` | `{ providerID, modelID, kind, url?, sessionID }` | `{ action: 'pass', accountKey }`, `{ action: 'pass', gated: false }` or `{ action: 'wait', accountKey, retryAt }` |
| `POST /api/rate-gate/report` | `{ providerID, sessionID, accountKey?, status, retryAfterMs?, remaining?, resetAt? }` | `{ ok: true }` |
| `GET /api/rate-gate/status` | none | `{ enabled, requests, windowMinutes, accounts }` |

`acquire` rules:

- A URL outside every configured gateway answers `pass` with `gated: false`, creates no account and records no slot. When the plugin sends no URL, the server matches the provider's configured base URL.
- With a free slot, the grant is recorded and the answer is `pass` with the account key.
- With no free slot, the answer is `wait` with `retryAt`, the earliest time the account can free a slot, and the session is recorded as waiting for 30 seconds. Every further `wait` answer refreshes that entry. No request is held open on the server.
- The plugin adds 0 to 250 milliseconds of jitter before asking again, so a wake-up crowd does not race on the same instant.

Both write routes reuse `limit-failover`'s authorization: the agent tool request token read from the plugin environment. Unauthorized answers 401 before any state changes.

### Status contract

```ts
type RateGateStatus = {
  enabled: boolean;
  requests: number;
  windowMinutes: number;
  caps: { requests: number | null; windowMinutes: number | null };
  accounts: Array<{
    key: string;
    label: string | null;
    providerIds: string[];
    used: number;
    limit: number;
    remaining: number;
    resetAt: number;
    limitedUntil: number | null;
    authoritative: boolean;
    waiting: Array<{ sessionId: string; until: number }>;
  }>;
};
```

Accounts appear after their first granted request, so a fresh server reports an empty list and the panel shows nothing until a model request happens. That avoids inventing an account before one is seen.

Material changes (grant, cooldown, authority update, first and last waiter) broadcast `openchamber:rate-gate` with the status snapshot, throttled to at most once per second.

## Plugin

Managed plugin `openchamber-rate-gate`, materialized the same way as `openchamber-limit-failover` in `packages/web/server/lib/opencode/managed-config-file.ts`. It is listed only while `isRateGateConfigured` holds and OpenCode is at least 2.2.7. The three settings keys join `MANAGED_PLUGIN_SETTINGS_KEYS` so a settings write reloads the managed config, and the enterprise policy watcher already refreshes the same config on a policy edit.

The generated plugin uses no imports, matching the failover plugin.

### Hooks

- `session.model.request`: send `{ providerID, modelID, kind, url: baseURL, sessionID }` to `acquire`. On `wait`, sleep until `retryAt` plus jitter and ask again. On `pass` with an account key, remember it under `sessionID` and `providerID`. The loop ends on `pass`, on an ungated answer, or when OpenCode interrupts the fiber. An interrupted fiber discards the pending promise and the request is never sent.
- `session.http.response`: report `status` and the rate limit headers, fire and forget with a 5 second timeout.
- `session.retry`: report a 429 with the remembered account key and `retryAfterMs` when present. The plugin leaves `event.decision` untouched.

### Failure behavior

- A network error, a non-2xx answer or a 5 second timeout on `acquire` passes the request, logs once per process, and ignores the gate for 30 seconds. The circuit breaker keeps a broken gate from stalling every session.
- `report` failures never block the response.
- The callback address and token always exist because `createChildEnv` is unconditional, so a disabled agent control tool does not disable the gate.

Plugin cost is one local HTTP round trip per model attempt. Attempts for providers outside the gateway list pay it too, because the server is the only place that knows the current list.

## Work status section

New section id `rateLimit` in `packages/ui/src/components/chat/work-status/sections.ts`, labeled `chat.workStatus.section.rateLimit`, placed after `usage` in the default order.

Rendering:

- Collapsed summary: the tightest account, `used / limit`, and `N 排队` while any session waits.
- Rows, one per account: label, `used / limit`, reset countdown, queued count. An account inside `limitedUntil` shows the restricted state with the recovery time.
- A refresh control beside the section title, matching the usage section.
- No rows when `enabled` is false, when the request fails, or when the account list is empty. The section then renders `null` like the usage section does without providers.

Data: a small store in `packages/ui/src/stores/` with `fetchStatus`, refreshed on the `openchamber:rate-gate` event and on a 30 second interval while the panel is visible. The store exposes `waitingUntil(sessionId)` for the inline row. The event type is added to `packages/ui/src/lib/openchamberEvents.ts`.

## Inline waiting notice

While a session has a waiting entry, a row above the composer shows "等待额度，预计 X 后继续" with the countdown, and disappears when the wait ends. It reuses the placement and visual treatment of `QueuedMessagesStrip`, so it reads as part of the composer rather than as chat history.

The row is not a toast: a disappearing toast is missed during a long wait. It is not a chat message: waiting is not part of the conversation.

New strings for the section, the settings block and the inline row are added to `packages/ui/src/lib/i18n/messages/en.ts` and to all 15 locale dictionaries, since the dictionaries are typed against the English key set.

## Invariants

- A request that passes the gate is counted before it is prepared, so the local count never runs below what the normal path has sent.
- An authoritative remaining value can only tighten the local allowance, never widen it.
- A 429 cools the account once, not once per waiting session.
- Waiting consumes no OpenCode retry attempt, because the gate waits before the transport starts.
- Every request kind competes equally; no kind is prioritized or starved.
- An account with no requests creates no state and no UI row.
- The feature is inert until a gateway entry exists, so installing this change alone changes no existing behavior.
- A failing gate passes requests. Availability of the app outranks the limit.
- VS Code never gates and never shows the section.

## Residual risks

- **Restart gap.** A server restart empties the window. Requests may briefly overrun until the gateway answers 429, which the cooldown handles without ending the turn.
- **External usage.** Another client on the same account can consume the quota between two grants. The first affected request takes a 429 and the account cools down; that turn waits one window.
- **Uncounted re-sends.** Compaction and `generate` retries at the effect layer, and a WebSocket to HTTP fallback, send extra requests that do not pass the gate. They are corrected by the 429 path.
- **SDK plugin providers.** A provider loaded through an AI SDK plugin can retry inside the SDK, below both hooks. Internal providers configured as native openai-compatible providers are unaffected.
- **Retry budget.** If the account is exhausted by someone else for 10 consecutive windows, the retried turn can exhaust OpenCode's attempts. The gate makes this require roughly 100 minutes of continuous external saturation.
- **Duplicate account rows.** Two providers that each store the same token as separate credentials show as two accounts. The direction is conservative.

## Testing and verification

Unit tests, `packages/web/server/lib/rate-gate/runtime.test.js`:

- Sliding window grants exactly `requests` in a window and the next acquire answers `wait` with the earliest free time.
- An authoritative remaining of zero blocks even with local slots left; the block lifts at `resetAt`.
- `x-ratelimit-reset` accepts epoch milliseconds, epoch seconds and a seconds-from-now value, and ignores garbage.
- A 429 sets `limitedUntil` to the later of local reset and `Retry-After`.
- A waiting entry expires after 30 seconds and disappears from the status.
- Config resolution prefers the user value, clamps it to the policy maximum, then falls back to policy and defaults.
- An empty user gateway list falls back to the policy list; both empty disables the gate.
- Account resolution uses the stored credential ID, then a hash of the environment key, then a hash of the configured key, then the provider ID.
- Gateway matching accepts the configured prefix and rejects another origin.

End-to-end in an isolated dev instance, per `openchamber-change-discipline` and `references/live-dev-instance.md`:

1. Run a fake internal gateway that counts 100 requests per 10 minutes, sends rate limit headers, and answers 429 past the limit.
2. Point one provider's `baseURL` at it and configure it as a gateway.
3. Drive 120 model requests from sessions. Watch requests 101 onward wait, then all complete, and the work status section show the account near its limit.
4. Force a wait longer than 5 minutes with a small window and a saturated account. Confirm the turn is still running after the transport header timeout would have fired, then completes. This is the regression that justifies gating in `model.request`.
5. Make the gateway answer 429 before the local count reaches the limit. Confirm the account cools down, the inline row and the section show the recovery time, and the turn completes after the reset without a failed turn.
6. Interrupt a session while it waits. Confirm no request reaches the gateway for that attempt.
7. Stop the gate route. Confirm requests pass after the circuit breaker instead of stalling.

Then run `bun run check:changed` on the finished diff, and read `packages/web/server/lib/rate-gate/DOCUMENTATION.md` against the final code for decisions that changed while building.

## Files touched

- `packages/web/server/lib/rate-gate/policy.ts`, `runtime.ts`, `DOCUMENTATION.md`, `runtime.test.js` (new)
- `packages/web/server/lib/enterprise-mode.ts` (policy field)
- `packages/web/server/lib/settings/settings-helpers.ts` (sanitize, clamp and defaults)
- `packages/web/server/lib/settings/settings-runtime.ts` (managed plugin settings keys)
- `packages/web/server/lib/opencode/managed-config-file.ts` (materialize condition and version check)
- `packages/web/server/lib/server-frame/bootstrap-runtime.ts` (route registration)
- `packages/web/server/runtime.ts` (construct the runtime, broadcast, policy watch refresh)
- `packages/ui/src/lib/settings/registry.ts` and the generated `settings-registry.json` files
- `packages/ui/src/components/sections/openchamber/DefaultsSettings.tsx` (settings block)
- `packages/ui/src/components/chat/work-status/sections.ts`, `WorkStatusSectionList.tsx`, `WorkStatusRateLimitSection.tsx` (new)
- `packages/ui/src/components/chat/composer/RateGateWaitingRow.tsx` (new)
- `packages/ui/src/stores/useRateGateStore.ts` (new)
- `packages/ui/src/lib/openchamberEvents.ts` (event type)
- `packages/ui/src/lib/i18n/messages/en.ts` and 14 locale dictionaries
