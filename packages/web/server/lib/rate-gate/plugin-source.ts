export const RATE_GATE_PLUGIN_ROUTE = '/api/rate-gate';

const PLUGIN_BODY = `
const JITTER_MS = 50
const MAX_SLEEP_MS = 60000
let gateOffUntil = 0
let gateFailureLogged = false
const admitted = new Map()

const callback = () => {
  const base = process.env.OPENCHAMBER_AGENT_TOOL_URL
  const token = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN
  if (!base || !token || !URL.canParse(base)) return null
  return { url: new URL(ROUTE, base).href, token }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const keyOf = (sessionID, providerID) => sessionID + "\\n" + providerID

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
        kind: event.kind || "model",
        url: event.baseURL,
        sessionID: event.sessionID,
      }
      try {
        for (;;) {
          const answer = await send(target, "/acquire", body)
          if (answer.action !== "wait") {
            if (answer.gated !== false && typeof answer.accountKey === "string") {
              admitted.set(keyOf(event.sessionID, event.model.providerID), answer.accountKey)
            }
            return
          }
          const wait = Math.max(0, Number(answer.retryAt) - Date.now())
          await sleep(Math.min(wait + Math.floor(Math.random() * JITTER_MS), MAX_SLEEP_MS))
        }
      } catch (error) {
        gateFailed(error)
      }
    })

    await ctx.session.hook("http.response", async (event) => {
      const target = callback()
      if (!target || Date.now() < gateOffUntil) return
      const headers = event.response && event.response.headers
      if (!headers) return
      send(target, "/report", {
        providerID: event.model.providerID,
        sessionID: event.sessionID,
        accountKey: admitted.get(keyOf(event.sessionID, event.model.providerID)),
        status: event.response.status,
        headers: rateLimitHeaders(headers),
      }).catch(() => {})
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
`;

export const buildRateGatePluginSource = () =>
  `const ROUTE = ${JSON.stringify(RATE_GATE_PLUGIN_ROUTE)}\n${PLUGIN_BODY}`;
