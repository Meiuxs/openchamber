export const isEventStreamUrl = (url: URL): boolean => url.pathname.endsWith("/event") || url.pathname.endsWith("/log")
export const isUsageStatsUrl = (url: URL): boolean => url.pathname.endsWith("/experimental/session/stats")

// external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/core/src OpenCode treats slash-prefixed Windows UNC paths as POSIX paths; backslashes preserve the share.
export const toOpenCodeDirectory = (directory: string): string =>
  /^\/\/[^/]/.test(directory) ? directory.replace(/\//g, "\\") : directory

// external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/client The generated client appends /api routes to the base path, so it receives the mount parent.
export const toOpencodeClientRoot = (baseUrl: string): string => baseUrl.replace(/\/api\/*$/, "") || "/"

export const requestUrlOf = (input: string | URL | Request): URL => (
  input instanceof URL ? input : new URL(input instanceof Request ? input.url : input)
)

export const requestMethodOf = (input: string | URL | Request, init?: RequestInit): string => (
  String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
)
