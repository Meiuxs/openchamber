export const RATE_GATE_PLUGIN_ROUTE = '/api/rate-gate';

const PLUGIN_BODY = `
const JITTER_MS = 50
const MAX_SLEEP_MS = 60000
const MAX_WAIT_MS = 600000
const ADMITTED_LIMIT = 256
let gateOffUntil = 0
let gateFailureLogged = false
let waitDeadlineLogged = false
let reportFailureLogged = false
const admitted = new Map()

const callback = () => {
  const base = process.env.OPENCHAMBER_AGENT_TOOL_URL
  const token = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN
  if (!base || !token || !URL.canParse(base)) return null
  return { url: new URL(ROUTE, base).href, token }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const keyOf = (sessionID, providerID) => sessionID + "\\n" + providerID

// A long-lived process answers for many sessions over days; the map only
// carries the account key from an acquire to the response that follows it.
const remember = (key, accountKey) => {
  admitted.delete(key)
  admitted.set(key, accountKey)
  while (admitted.size > ADMITTED_LIMIT) {
    const oldest = admitted.keys().next().value
    if (oldest === undefined) break
    admitted.delete(oldest)
  }
}

const send = async (target, path, body) => {
  const response = await fetch(target.url + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + target.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error("rate gate answered " + response.status)
  return response.json()
}

const RATE_HEADER = /^(?:x-ratelimit-|anthropic-ratelimit-|retry-after|ratelimit-)/
const rateLimitHeaders = (headers) => {
  const picked = {}
  for (const [name, value] of headers.entries()) {
    const key = name.toLowerCase()
    if (RATE_HEADER.test(key)) picked[key] = value
  }
  return picked
}

const gateFailed = (error) => {
  if (!gateFailureLogged) {
    gateFailureLogged = true
    console.warn("[openchamber-rate-gate] request throttle unavailable; passing requests for 30s:", error && error.message ? error.message : error)
  }
  gateOffUntil = Date.now() + 30000
}

// A report never admits or blocks a request, so its own failure stays out of
// the circuit breaker that gates requests.
const reportFailed = (error) => {
  if (!reportFailureLogged) {
    reportFailureLogged = true
    console.warn("[openchamber-rate-gate] could not report a response:", error && error.message ? error.message : error)
  }
}

export default {
  id: "openchamber-rate-gate",
  setup: async (ctx) => {
    await ctx.session.hook("model.request", async (event) => {
      if (Date.now() < gateOffUntil) return
      const target = callback()
      if (!target) return
      const model = event.model
      if (!model) return
      const body = {
        providerID: model.providerID,
        modelID: model.id,
        kind: event.kind || "model",
        url: event.baseURL,
        sessionID: event.sessionID,
      }
      try {
        const deadline = Date.now() + MAX_WAIT_MS
        for (;;) {
          const answer = await send(target, "/acquire", body)
          if (answer.action !== "wait") {
            if (answer.gated !== false && typeof answer.accountKey === "string") {
              remember(keyOf(event.sessionID, event.model.providerID), answer.accountKey)
            }
            return
          }
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            // The turn this was waiting for may already be cancelled, and a
            // loop with no end keeps a queue slot and can spend a grant for a
            // request nobody sends. Passing is the failure behavior the gate
            // already declares for itself.
            if (!waitDeadlineLogged) {
              waitDeadlineLogged = true
              console.warn("[openchamber-rate-gate] no slot within " + MAX_WAIT_MS / 1000 + "s; sending the request instead")
            }
            return
          }
          const wait = Math.max(0, Number(answer.retryAt) - Date.now())
          await sleep(Math.min(wait + Math.floor(Math.random() * JITTER_MS), MAX_SLEEP_MS, remaining))
        }
      } catch (error) {
        gateFailed(error)
      }
    })

    await ctx.session.hook("http.response", async (event) => {
      try {
        const target = callback()
        if (!target || Date.now() < gateOffUntil) return
        const model = event.model
        const headers = event.response && event.response.headers
        if (!model || !headers) return
        send(target, "/report", {
          providerID: model.providerID,
          sessionID: event.sessionID,
          accountKey: admitted.get(keyOf(event.sessionID, model.providerID)),
          url: event.baseURL,
          status: event.response.status,
          headers: rateLimitHeaders(headers),
        }).catch(() => {})
      } catch (error) {
        reportFailed(error)
      }
    })

    await ctx.session.hook("retry", async (event) => {
      try {
        const target = callback()
        if (!target || Date.now() < gateOffUntil) return
        if (event.error?.status !== 429 && event.error?.type !== "provider.rate-limit") return
        const model = event.model
        if (!model) return
        send(target, "/report", {
          providerID: model.providerID,
          sessionID: event.sessionID,
          accountKey: admitted.get(keyOf(event.sessionID, model.providerID)),
          url: event.baseURL,
          status: 429,
          retryAfterMs: event.error?.retryAfterMs,
        }).catch(() => {})
      } catch (error) {
        reportFailed(error)
      }
    })
  },
}
`;

export const buildRateGatePluginSource = () =>
  `const ROUTE = ${JSON.stringify(RATE_GATE_PLUGIN_ROUTE)}\n${PLUGIN_BODY}`;
