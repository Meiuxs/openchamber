# Rate gate

## Ownership

What keeps model requests to a set of gateways inside a per-account request
budget: the budget accounting (`runtime.ts`), the configuration resolution and
account identity (`policy.ts`), and the managed OpenCode plugin that asks before
each request and reports what the gateway answered (`plugin-source.ts`).

Configuration has two sources, both off by default:

- The enterprise policy file's `modelRateLimit`: `requests`, `windowMinutes` and
  `gateways`. It is read from the file only; there is no environment variable for
  it (`../enterprise-mode.ts`, `readEnterprisePolicy`).
- The user's own `modelRateLimitRequests`, `modelRateLimitWindowMinutes` and
  `modelRateLimitGateways`, set in Settings → Sessions → Request throttle. They
  may only tighten the policy: the resolver clamps the numbers to the policy
  maximum and falls back to the policy gateway list when the user typed none.

The managed config layer lists this plugin only while `isRateGateConfigured`
holds (`../opencode/managed-config-file.ts`), so the plugin loads without a
restart once a gateway is saved.

## Invariants

- A request is counted only when its URL matches a configured gateway. An empty
  gateway list, or a request the plugin reported without a URL, is passed
  through: the gate never blocks a request it cannot attribute to a gateway.
- The window is counted backwards from now, so a grant ages out of the budget
  exactly `windowMinutes` after it was made.
- An account is identified the way limit failover identifies one: a stored
  credential id, else a hash of the stored key, else the provider id. The
  identity is cached briefly because it is read on every request.
- A gateway's own `x-ratelimit-remaining` and `x-ratelimit-reset` are
  authoritative: the smaller of the local remainder and the reported remainder
  is used, and a reported reset time wins as the end of the window. Each grant
  spends one from the reported remainder too, so a report of "3 left" admits
  three requests, not every request until the reset.
- `x-ratelimit-reset` arrives in epoch milliseconds, epoch seconds, or seconds
  from now. The plugin converts before reporting and the server normalises
  again, so an older plugin that forwards the raw value still lands correctly.
- A 429 marks the account exhausted until the latest of the local window end,
  the reported `retryAfterMs` and the reported reset time.
- Budgets live in memory. A restart forgets them and the next requests start a
  fresh window.
- `acquire` and `report` require the agent tool token, so spending from the
  budget is reachable only from the managed plugin. `status` answers under the
  app's own session auth instead: the app reads it, and a plugin token is never
  in a browser.
- The plugin runs only where OpenChamber itself starts OpenCode, only outside
  VS Code, and only on OpenCode 2.2.7 or newer: the gate needs
  `session.model.request`, which earlier versions do not fire. The same boundary
  limit failover has.
- The status is announced as `openchamber:rate-gate` with the same snapshot the
  route answers, throttled to one a second. A surface reads the route on mount
  and follows the event after, so a state change is visible without a poll.

## Decisions

### Why an unattributable request is only gated when the plugin reports a URL

The plugin sends the base URL OpenCode resolved for the request. When it sends
none, the server falls back to the provider's `baseURL` from the merged OpenCode
config. If both are missing the server cannot tell whether the request goes to a
gated gateway, and guessing would either throttle traffic the administrator never
gated or leak the decision into a provider that has no budget. Passing the
request keeps the gate inside the gateways an administrator named; the cost is a
request that escapes the budget when no address is available at all, which shows
up as usage above the limit rather than as blocked work.

### Why a user value is clamped instead of refused

The user's number and the policy number mean the same thing, and the policy one
is the ceiling. Clamping at read time keeps a saved value valid when an
administrator lowers the ceiling later, instead of turning the whole gate off or
surfacing a validation error for a number the user cannot see.

### Why the budget is kept on the server and not in the plugin

Several OpenCode sessions of one account share one budget, and a switch or a
restart must not create a second budget beside the first. The plugin is a
reporter with no state of its own, so the accounting has exactly one owner.

### Why the status route does not use the plugin token

The account labels and the remaining count are read by the work status panel and
the row above the composer, both of which run with the app's session auth. A
plugin token exists only in the OpenCode child environment, so requiring it on
the read left the panel with a 401 and nothing to draw. The write routes keep the
token because they spend from the budget; the read route changes nothing, and it
is only reachable behind the same auth as the rest of `/api`.

### Why a waiting entry outlives the plugin's sleep

The plugin sleeps up to 60 s between two `acquire` calls, so a shorter entry
would drop out of the status while the request still waits and the row above the
composer would blink off and back on. `WAITING_TTL_MS` is 90 s: long enough to
cover one full sleep plus the round trip, short enough that a cancelled session
disappears from the count within a minute and a half.

### Why every grant spends from the reported remainder

The gateway's count is the only place that knows the real budget. Using it only
as a ceiling, without decrementing, meant a report of "3 left" admitted every
request until the reset and the panel kept showing the stale figure. Spending
one per grant makes the reported number behave like the budget it describes; the
next report corrects any drift in either direction.

### Why the reported usage carries the gateway's total

The panel shows `used / limit`. With no gateway remainder the limit is the
configured one and the used count is what this window spent. Once the gateway
reports a remainder, it is authoritative, so the total is what this app spent
plus what the gateway says is left. Deriving the total from the configured limit
instead made a report of "2 left" out of a 100 budget read as `100 / 100`, which
told the user the budget was gone when two slots remained.
