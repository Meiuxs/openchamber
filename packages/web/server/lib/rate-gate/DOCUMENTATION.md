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
- A report is filtered the same way: a response from a URL outside the
  gateways changes no account state and creates no account row. The plugin
  sends the request URL with each report, and a URL that arrives is always
  checked, so removing a gateway takes effect on the next response. Only a
  report with no URL whose account key already has a state is attributed
  without the check, because that key exists only after acquire matched. A
  report with no URL and no known key uses the provider's configured address,
  and is dropped when there is none.
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
- The plugin forwards the raw rate limit headers; the server parses them once.
  It reads the request dimension of the three naming styles gateways use
  (`x-ratelimit-remaining`, OpenAI's `x-ratelimit-remaining-requests`,
  Anthropic's `anthropic-ratelimit-requests-remaining`, and the matching reset
  headers). Token counters are ignored: a token remainder is not a request slot.
- `x-ratelimit-reset` arrives in epoch milliseconds, epoch seconds, seconds from
  now, a Go-style duration (`1s`, `1m30s`) or an HTTP date. `retry-after` and
  `retry-after-ms` are read as the gateway's own recovery delay, in seconds, as
  the same duration forms, or as an HTTP date. An older plugin that forwards
  numbers instead of headers still lands correctly.
- A 429 marks the account exhausted until the gateway's own recovery time: the
  later of `retryAfterMs` and the reported reset. The end of the local window is
  used only when the gateway named no time at all, because that end is a guess
  about a quota the server does not see. A 429 also drops the reported
  remainder, so an earlier "0 left" report cannot keep the account closed past
  the recovery time the gateway just named.
- Waiting sessions wake in queue order: each `wait` answer pushes the wake-up
  back by its position in the waiting list, so the first waiter gets the freed
  slot instead of losing a race against every other session.
- A debug-level log line records each grant, wait, report and cooldown with the
  account, the counts, the authoritative remainder and the queue position.
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
- `enabled` is true only when a gateway is configured and this runtime can load
  the plugin. A surface never shows throttling the app cannot perform. The
  status holds the support answer for 30 s because the probe may spawn the
  OpenCode CLI. The managed config asks it directly, because a cached failure
  would leave the plugin out of the child's configuration.
- A report whose account key the server does not know is attributed to the
  account resolved now. Creating an account for the forgotten key left a row
  that never received a grant again after a credential switch.
- The plugin's waiting loop ends after ten minutes with the request passed.
  The loop is not tied to the turn that started it, and a cancelled turn
  otherwise keeps a queue slot and can spend a grant for a request nobody
  sends. While the circuit breaker is open, the plugin sends no reports
  either: the whole gate is off for those 30 s.
- The plugin remembers the account key of the most recent 256 session and
  provider pairs. It is a per-process map read by the next response only.

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

### Why the gateway's retry time wins over the local window end

A 429 used to cool the account until the oldest local grant aged out, up to a
full window. That made a gateway asking for two seconds freeze the account for
ten minutes, because the local window is a shadow of a quota the server cannot
read. The gateway's `Retry-After` and reset headers are the only statement about
its real recovery, so they set the cooldown on their own. The local window end
remains the fallback for a gateway that says nothing, where waiting out the
window is still better than hammering it.

### Why the plugin forwards raw headers instead of converting them

The plugin used to convert `x-ratelimit-reset` to epoch milliseconds and pick
one unsuffixed header name before reporting. That left a second, weaker parser
in the generated plugin: it could not read duration strings such as `1s`, and it
missed the `-requests` names. The server already normalises every accepted
shape, so the plugin now forwards the rate limit headers it sees and the server
is the single owner of names and units. Older plugins that send numbers keep
working because the report accepts both.

### Why queued sessions wake in queue order

Every waiter used to wake at the same instant and race on a 250 ms jitter, so a
session could lose the freed slot to a newer arrival for many windows in a row.
The wait answer now adds its position in the waiting list, capped at eight
positions, to the wake-up time. The first waiter wakes first, takes the slot, and
the rest re-queue one place closer. The queue is still advisory: a request that
never waited can take a free slot, because holding the slot for a session that
may have been interrupted would waste it.

### Why a report is filtered like an acquire

The plugin reports every model response, including providers outside the
gateway list. Applying those reports created an account row for a provider the
gate never throttles, and a 429 from a provider sharing the same credential
could cool it. The plugin now sends the request URL with the report, and the
server applies the same match as acquire. A report that arrives without a URL
and carries a known account key skips the check and the provider address read,
because that key exists only after acquire matched. A URL the plugin does send
is still checked, so an administrator removing a gateway stops new reports
immediately.

### Why the status reports disabled when the plugin cannot load

`enabled` used to mean "a gateway is configured". Where the plugin never loads,
such as VS Code or an external OpenCode, the panel and the waiting row promised
throttling that could not happen. The status now asks the same support probe the
managed config uses, cached for 30 s because the probe may spawn the CLI and the
status is recomputed on every announcement.

### Why a 429 drops the reported remainder

A successful response can report "0 left" with a reset ten minutes away, and a
later 429 can name a recovery two seconds away. Keeping the reported remainder
meant the older figure outvoted the gateway's own recovery time, and the
account stayed closed until the reset. The 429 path clears the reported
remainder so the recovery time it names decides when the account reopens; the
next report restores it.

### Why the waiting loop has a deadline

The loop lives inside the hook handler, not inside the turn. When the turn is
cancelled the promise is discarded but the loop keeps sleeping and asking, and
when a slot frees it can spend a grant for a request nobody sends. Ten minutes
is longer than the default window, so a real wait is not cut short, and past it
the request passes. The gate already prefers availability over the limit when
it cannot do its job.
