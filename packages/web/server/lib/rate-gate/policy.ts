import { createHash } from 'node:crypto';
import { z } from 'zod';

export const RATE_GATE_DEFAULTS = { requests: 100, windowMinutes: 10 } as const;
export const MAX_GATEWAYS = 50;
const MAX_REQUESTS = 10000;
const MAX_WINDOW_MINUTES = 1440;

export type RateGateConfig = { requests: number; windowMinutes: number; gateways: string[] };
export type RateGateCaps = { requests: number | null; windowMinutes: number | null };
export type RateGateResolution = { config: RateGateConfig; caps: RateGateCaps };
export type RateLimitHeaders = { remaining: number | null; resetAt: number | null; retryAfterMs: number | null };
export type RateGateSettingsInput = {
  modelRateLimitRequests?: unknown;
  modelRateLimitWindowMinutes?: unknown;
  modelRateLimitGateways?: unknown;
};
export type RateGatePolicyInput = { requests?: unknown; windowMinutes?: unknown; gateways?: unknown } | null;
export type AccountResolution = { key: string; label: string | null };
export type CredentialEntryLike = { id: string; integrationID: string; active: boolean; label?: string | null };
export type AccountResolverDependencies = {
  readCredentialEntries: () => Promise<CredentialEntryLike[]>;
  readCredentialMap: () => Promise<Record<string, { key?: string; token?: string; label?: string }>>;
  readProviderConfig: (providerID: string) => { apiKey?: string; baseURL?: string } | null;
  now?: () => number;
  cacheTtlMs?: number;
};

const numericInput = z.union([z.number(), z.string().transform((raw) => Number(raw))]);
const gatewayInput = z.union([z.string(), z.array(z.string()), z.array(z.unknown())]);

const settingsSchema = z.object({
  modelRateLimitRequests: numericInput.optional().catch(undefined),
  modelRateLimitWindowMinutes: numericInput.optional().catch(undefined),
  modelRateLimitGateways: gatewayInput.optional().catch(undefined),
});

const policySchema = z.object({
  requests: numericInput.optional().catch(undefined),
  windowMinutes: numericInput.optional().catch(undefined),
  gateways: gatewayInput.optional().catch(undefined),
});

type ParsedRateGateNumbers = {
  requests?: number | undefined;
  windowMinutes?: number | undefined;
  gateways?: unknown;
};

const clampInt = (value: number | undefined, min: number, max: number): number | null => {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, Math.round(value)));
};

export const normalizeGateway = (value: string): string | null => {
  if (value.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
};

const gatewayText = z.string().transform((raw) => raw.split(/\r?\n/));

export const normalizeGatewayList = (value: ParsedRateGateNumbers['gateways']): string[] => {
  const parsed = z.union([gatewayText, z.array(z.string())]).safeParse(value);
  if (!parsed.success) return [];
  const entries = parsed.data;
  const seen = new Set<string>();
  for (const entry of entries) {
    const normalized = normalizeGateway(entry);
    if (normalized) seen.add(normalized);
    if (seen.size >= MAX_GATEWAYS) break;
  }
  return [...seen];
};

export const parseGatewayText = (value: string | string[]): string[] => normalizeGatewayList(value);

export const matchesGateway = (url: string | null | undefined, gateways: readonly string[]) => {  if (!url || gateways.length === 0) return false;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const href = target.href;
  return gateways.some((gateway) => href === gateway || href.startsWith(`${gateway}/`) || href.startsWith(`${gateway}?`));
};

export const resolveRateGateConfig = (
  settings: RateGateSettingsInput | null | undefined,
  policy: RateGatePolicyInput,
): RateGateResolution => {
  const parsedSettings = settingsSchema.safeParse(settings ?? {}).data;
  const parsedPolicy = policySchema.safeParse(policy ?? {}).data;
  const policyRequests = clampInt(parsedPolicy?.requests, 1, MAX_REQUESTS);
  const policyWindow = clampInt(parsedPolicy?.windowMinutes, 1, MAX_WINDOW_MINUTES);
  const policyGateways = normalizeGatewayList(parsedPolicy?.gateways);
  const userRequests = clampInt(parsedSettings?.modelRateLimitRequests, 1, policyRequests ?? MAX_REQUESTS);
  const userWindow = clampInt(parsedSettings?.modelRateLimitWindowMinutes, 1, policyWindow ?? MAX_WINDOW_MINUTES);
  const userGateways = normalizeGatewayList(parsedSettings?.modelRateLimitGateways);
  const config: RateGateConfig = {
    requests: userRequests ?? policyRequests ?? RATE_GATE_DEFAULTS.requests,
    windowMinutes: userWindow ?? policyWindow ?? RATE_GATE_DEFAULTS.windowMinutes,
    gateways: userGateways.length > 0 ? userGateways : policyGateways,
  };
  return {
    config,
    caps: { requests: policyRequests, windowMinutes: policyWindow },
  };
};

export const isRateGateConfigured = (config: RateGateConfig) => config.gateways.length > 0;

export const normalizeResetAt = (value: number, now = Date.now()): number => {
  if (value > 1e12) return Math.round(value);
  if (value > 1e9) return Math.round(value * 1000);
  return now + Math.round(value * 1000);
};

const DURATION_PATTERN = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/;
const DURATION_PART = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
const PLAIN_NUMBER = /^\d+(?:\.\d+)?$/;

const durationUnitMs = (unit: string): number => {
  switch (unit) {
    case 'ms': return 1;
    case 's': return 1_000;
    case 'm': return 60_000;
    case 'h': return 3_600_000;
    case 'd': return 86_400_000;
    default: return 1;
  }
};

const REMAINING_HEADERS = ['x-ratelimit-remaining', 'x-ratelimit-remaining-requests', 'anthropic-ratelimit-requests-remaining'];
const RESET_HEADERS = ['x-ratelimit-reset', 'x-ratelimit-reset-requests', 'anthropic-ratelimit-requests-reset'];

export const parseDurationMs = (raw: string): number | null => {
  const text = raw.trim().toLowerCase();
  if (!DURATION_PATTERN.test(text)) return null;
  let total = 0;
  for (const match of text.matchAll(DURATION_PART)) total += Number(match[1]) * durationUnitMs(match[2] ?? 'ms');
  return total;
};

const firstHeader = (record: Record<string, string>, names: readonly string[]): string | null => {
  for (const name of names) {
    const value = record[name];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return null;
};

const parseRetryAfterMs = (record: Record<string, string>, now: number): number | null => {
  const millis = firstHeader(record, ['retry-after-ms']);
  if (millis !== null) {
    const value = Number(millis);
    if (Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  const raw = firstHeader(record, ['retry-after']);
  if (raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000));
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
};

export const parseResetValue = (raw: number | string, now = Date.now()): number | null => {
  const text = String(raw).trim();
  if (text === '') return null;
  if (PLAIN_NUMBER.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) && value > 0 ? normalizeResetAt(value, now) : null;
  }
  const duration = parseDurationMs(text);
  if (duration !== null) return now + Math.round(duration);
  const date = Date.parse(text);
  return Number.isNaN(date) ? null : date;
};

export const parseRateLimitRecord = (record: Record<string, string>, now = Date.now()): RateLimitHeaders => {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value.trim() !== '') lower[key.toLowerCase()] = value;
  }

  const remainingRaw = firstHeader(lower, REMAINING_HEADERS);
  const remaining = remainingRaw !== null && Number.isFinite(Number(remainingRaw))
    ? Math.max(0, Math.floor(Number(remainingRaw)))
    : null;

  const resetRaw = firstHeader(lower, RESET_HEADERS);
  const resetAt = resetRaw === null ? null : parseResetValue(resetRaw, now);

  return { remaining, resetAt, retryAfterMs: parseRetryAfterMs(lower, now) };
};

export const parseRateLimitHeaders = (
  headers: { get(name: string): string | null },
  now = Date.now(),
): RateLimitHeaders => {
  const record: Record<string, string> = {};
  const read = (name: string) => {
    const value = headers.get(name);
    if (value !== null) record[name] = value;
  };
  for (const name of [...REMAINING_HEADERS, ...RESET_HEADERS, 'retry-after', 'retry-after-ms']) read(name);
  return parseRateLimitRecord(record, now);
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
    } catch {
      void 0;
    }

    if (!value) {
      try {
        const map = await deps.readCredentialMap();
        const secret = map[providerID]?.key ?? map[providerID]?.token;
        if (secret) value = { key: `key:${accountKeyFromSecret(secret)}`, label: map[providerID]?.label ?? null };
      } catch {
        void 0;
      }
    }

    if (!value) {
      try {
        const secret = deps.readProviderConfig(providerID)?.apiKey ?? null;
        if (secret) value = { key: `key:${accountKeyFromSecret(secret)}`, label: null };
      } catch {
        void 0;
      }
    }

    value ??= { key: `provider:${providerID}`, label: null };
    cache.set(providerID, { value, expiresAt: now() + ttl });
    return value;
  };
};
