import type { Application, ExpressFactory, Request, RequestHandler } from '../shared/http-contracts.js';
import { z } from 'zod';

import {
  isRateGateConfigured,
  matchesGateway,
  parseRateLimitRecord,
  parseResetValue,
  resolveRateGateConfig,
} from './policy.js';
import type { AccountResolution, RateGatePolicyInput, RateGateSettingsInput } from './policy.js';
import { buildRateGatePluginSource } from './plugin-source.js';

export const WAITING_TTL_MS = 90_000;
export const WAIT_STAGGER_MS = 250;
const FALLBACK_COOLDOWN_MS = 1_000;
const MAX_STAGGER_POSITIONS = 8;
const SUPPORT_TTL_MS = 30_000;
export type RateGateLogDetails = Record<string, string | number | boolean | null | undefined>;

export type RateGateAcquireInput = {
  providerID: string;
  modelID: string;
  kind: string;
  url?: string | undefined;
  sessionID: string;
};

export type RateGateAcquireAnswer =
  | { action: 'pass'; gated: false }
  | { action: 'pass'; gated: true; accountKey: string; remaining: number; resetAt: number }
  | { action: 'wait'; gated: true; accountKey: string; retryAt: number };

export type RateGateReportInput = ParsedReport;

export type RateGateAccount = {
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
};

export type RateGateStatus = {
  enabled: boolean;
  requests: number;
  windowMinutes: number;
  caps: { requests: number | null; windowMinutes: number | null };
  accounts: RateGateAccount[];
};

type AccountState = {
  label: string | null;
  providerIds: Set<string>;
  grants: number[];
  authoritative: { remaining: number; resetAt: number } | null;
  limitedUntil: number | null;
  waiting: Map<string, number>;
};

export type RateGateRuntimeDependencies = {
  instanceDir: string;
  fs: {
    mkdir(path: string, options: { recursive: true }): Promise<void>;
    writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  };
  path: { join(...parts: string[]): string };
  readSettings: () => Promise<RateGateSettingsInput | null>;
  readPolicy: () => RateGatePolicyInput;
  resolveAccount: (providerID: string) => Promise<AccountResolution>;
  resolveProviderBaseUrl: (providerID: string) => string | null;
  authorizeRequest: (req: Pick<Request, 'socket' | 'headers'>) => boolean;
  isPluginSupported: () => Promise<boolean>;
  broadcast?: (status: RateGateStatus) => void;
  log?: (details: RateGateLogDetails) => void;
  now?: () => number;
};

export type RateGateRuntime = {
  pluginDirectory: string;
  isEnabled: () => Promise<boolean>;
  materializePlugin: () => Promise<string>;
  acquire: (input: RateGateAcquireInput) => Promise<RateGateAcquireAnswer>;
  report: (input: RateGateReportInput) => Promise<void>;
  status: () => Promise<RateGateStatus>;
  registerRoutes: (app: Application, express: Pick<ExpressFactory, 'json'>) => void;
  registerStatusRoute: (app: Application, requireApiAuth: RequestHandler) => void;
};

const acquireSchema = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  kind: z.string().min(1),
  url: z.string().optional(),
  sessionID: z.string().min(1),
});

const reportSchema = z.object({
  providerID: z.string().min(1),
  sessionID: z.string().min(1),
  accountKey: z.string().min(1).optional(),
  url: z.string().optional(),
  status: z.number().int(),
  retryAfterMs: z.number().finite().nonnegative().optional(),
  remaining: z.union([z.number().finite(), z.string()]).optional(),
  resetAt: z.union([z.number().finite(), z.string()]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

type ParsedReport = z.infer<typeof reportSchema>;

export const createRateGateRuntime = (deps: RateGateRuntimeDependencies): RateGateRuntime => {
  const now = deps.now ?? Date.now;
  const states = new Map<string, AccountState>();
  const pluginDirectory = deps.path.join(deps.instanceDir, 'openchamber-rate-gate');
  let lastBroadcastAt = 0;
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  let supportCache: { at: number; supported: boolean } | null = null;

  const log = (details: RateGateLogDetails) => {
    try {
      deps.log?.(details);
    } catch {
      void 0;
    }
  };

  const resolveConfigAsync = async () => {
    const settings = await deps.readSettings().catch(() => null);
    let policy: RateGatePolicyInput = null;
    try {
      policy = deps.readPolicy();
    } catch {
      policy = null;
    }
    return resolveRateGateConfig(settings, policy);
  };

  const pluginSupported = async (): Promise<boolean> => {
    const at = now();
    if (supportCache && at - supportCache.at < SUPPORT_TTL_MS) return supportCache.supported;
    const supported = await deps.isPluginSupported().catch(() => false);
    supportCache = { at, supported };
    return supported;
  };

  const getOrCreate = (account: AccountResolution, providerID: string): AccountState => {
    const existing = states.get(account.key);
    if (existing) {
      existing.providerIds.add(providerID);
      if (!existing.label && account.label) existing.label = account.label;
      return existing;
    }
    const created: AccountState = {
      label: account.label,
      providerIds: new Set([providerID]),
      grants: [],
      authoritative: null,
      limitedUntil: null,
      waiting: new Map(),
    };
    states.set(account.key, created);
    return created;
  };

  const prune = (state: AccountState, at: number, windowMs: number) => {
    state.grants = state.grants.filter((grantedAt) => grantedAt > at - windowMs);
    if (state.limitedUntil !== null && state.limitedUntil <= at) state.limitedUntil = null;
    if (state.authoritative && state.authoritative.resetAt <= at) state.authoritative = null;
    for (const [sessionId, until] of state.waiting) {
      if (until <= at) state.waiting.delete(sessionId);
    }
  };

  const effectiveRemaining = (state: AccountState, limit: number) => {
    let remaining = limit - state.grants.length;
    if (state.authoritative) remaining = Math.min(remaining, state.authoritative.remaining);
    if (state.limitedUntil !== null) remaining = 0;
    return Math.max(0, remaining);
  };

  const usageOf = (state: AccountState, remaining: number, limit: number) => {
    const total = state.authoritative ? state.grants.length + remaining : limit;
    return { used: total - remaining, limit: total };
  };

  const spendGrant = (state: AccountState, at: number) => {
    state.grants.push(at);
    if (state.authoritative) {
      state.authoritative.remaining = Math.max(0, state.authoritative.remaining - 1);
    }
  };

  const retryAtFor = (state: AccountState, at: number, windowMs: number) => {
    const candidates: number[] = [];
    if (state.grants[0]) candidates.push(state.grants[0] + windowMs);
    if (state.authoritative) candidates.push(state.authoritative.resetAt);
    if (state.limitedUntil !== null) candidates.push(state.limitedUntil);
    const future = candidates.filter((value) => value > at);
    return future.length > 0 ? Math.min(...future) : at + 1_000;
  };

  const reportLimits = (input: RateGateReportInput, at: number) => {
    const parsed = input.headers ? parseRateLimitRecord(input.headers, at) : null;
    const remaining = input.remaining === undefined
      ? parsed?.remaining ?? null
      : Math.max(0, Math.floor(Number(input.remaining)));
    const resetAt = input.resetAt === undefined
      ? parsed?.resetAt ?? null
      : parseResetValue(input.resetAt, at);
    const retryAfterMs = Math.max(input.retryAfterMs ?? 0, parsed?.retryAfterMs ?? 0) || null;
    return { remaining: Number.isFinite(remaining) ? remaining : null, resetAt, retryAfterMs };
  };

  const applyReport = (state: AccountState, input: RateGateReportInput, at: number, windowMs: number) => {
    const limits = reportLimits(input, at);
    const reportedReset = limits.resetAt !== null && limits.resetAt > at ? limits.resetAt : 0;
    if (input.status === 429) {
      prune(state, at, windowMs);
      state.authoritative = null;
      const localNext = state.grants[0] ? state.grants[0] + windowMs : at + FALLBACK_COOLDOWN_MS;
      const gatewayNext = Math.max(at + (limits.retryAfterMs ?? 0), reportedReset);
      state.limitedUntil = gatewayNext > at ? gatewayNext : localNext;
      return;
    }
    if (limits.remaining !== null && reportedReset > at) {
      state.authoritative = { remaining: limits.remaining, resetAt: reportedReset };
    }
  };

  const computeStatus = async (): Promise<RateGateStatus> => {
    const { config, caps } = await resolveConfigAsync();
    const enabled = isRateGateConfigured(config) && await pluginSupported();
    const at = now();
    const windowMs = config.windowMinutes * 60_000;
    const accounts = [...states.entries()].map(([key, state]) => {
      prune(state, at, windowMs);
      const remaining = effectiveRemaining(state, config.requests);
      const usage = usageOf(state, remaining, config.requests);
      const resetAt = state.authoritative?.resetAt
        ?? (state.grants[0] ? state.grants[0] + windowMs : at);
      return {
        key,
        label: state.label,
        providerIds: [...state.providerIds],
        used: usage.used,
        limit: usage.limit,
        remaining,
        resetAt,
        limitedUntil: state.limitedUntil,
        authoritative: Boolean(state.authoritative),
        waiting: [...state.waiting].map(([sessionId, until]) => ({ sessionId, until })),
      };
    });
    return {
      enabled,
      requests: config.requests,
      windowMinutes: config.windowMinutes,
      caps,
      accounts,
    };
  };

  const scheduleBroadcast = () => {
    if (!deps.broadcast) return;
    const at = now();
    const fire = () => {
      void computeStatus()
        .then((value) => deps.broadcast?.(value))
        .catch(() => {});
    };
    if (at - lastBroadcastAt >= 1_000) {
      lastBroadcastAt = at;
      fire();
      return;
    }
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      lastBroadcastAt = now();
      fire();
    }, Math.max(0, 1_000 - (at - lastBroadcastAt)));
    broadcastTimer.unref?.();
  };

  const acquire = async (input: RateGateAcquireInput): Promise<RateGateAcquireAnswer> => {
    const { config } = await resolveConfigAsync();
    if (!isRateGateConfigured(config)) return { action: 'pass', gated: false };

    const url = input.url ?? deps.resolveProviderBaseUrl(input.providerID) ?? null;
    if (!matchesGateway(url, config.gateways)) return { action: 'pass', gated: false };

    let account: AccountResolution;
    try {
      account = await deps.resolveAccount(input.providerID);
    } catch {
      account = { key: `provider:${input.providerID}`, label: null };
    }

    const at = now();
    const windowMs = config.windowMinutes * 60_000;
    const state = getOrCreate(account, input.providerID);
    prune(state, at, windowMs);

    const remaining = effectiveRemaining(state, config.requests);
    if (remaining > 0) {
      state.waiting.delete(input.sessionID);
      spendGrant(state, at);
      const answer = {
        action: 'pass' as const,
        gated: true as const,
        accountKey: account.key,
        remaining: effectiveRemaining(state, config.requests),
        resetAt: retryAtFor(state, at, windowMs),
      };
      log({
        event: 'grant',
        accountKey: account.key,
        providerID: input.providerID,
        modelID: input.modelID,
        kind: input.kind,
        sessionID: input.sessionID,
        granted: state.grants.length,
        limit: config.requests,
        remaining: answer.remaining,
        resetAt: answer.resetAt,
        limitedUntil: state.limitedUntil,
        authoritativeRemaining: state.authoritative?.remaining ?? null,
      });
      scheduleBroadcast();
      return answer;
    }

    state.waiting.set(input.sessionID, at + WAITING_TTL_MS);
    const queuePosition = Math.max(0, [...state.waiting.keys()].indexOf(input.sessionID));
    const retryAt = retryAtFor(state, at, windowMs) + Math.min(queuePosition, MAX_STAGGER_POSITIONS) * WAIT_STAGGER_MS;
    log({
      event: 'wait',
      accountKey: account.key,
      providerID: input.providerID,
      modelID: input.modelID,
      kind: input.kind,
      sessionID: input.sessionID,
      granted: state.grants.length,
      limit: config.requests,
      remaining,
      queuePosition,
      retryAt,
      resetAt: retryAtFor(state, at, windowMs),
      limitedUntil: state.limitedUntil,
      authoritativeRemaining: state.authoritative?.remaining ?? null,
      waiters: state.waiting.size,
    });
    scheduleBroadcast();
    return { action: 'wait', gated: true, accountKey: account.key, retryAt };
  };

  const reportTargets = async (input: RateGateReportInput): Promise<{ key: string | null; states: AccountState[] }> => {
    const remembered = input.accountKey ? states.get(input.accountKey) : undefined;
    if (remembered) return { key: input.accountKey ?? null, states: [remembered] };

    let resolvedKey: string | null = null;
    try {
      resolvedKey = (await deps.resolveAccount(input.providerID)).key;
    } catch {
      resolvedKey = null;
    }
    const key = resolvedKey ?? input.accountKey ?? null;
    if (key) return { key, states: [getOrCreate({ key, label: null }, input.providerID)] };
    return {
      key: null,
      states: [...states.values()].filter((state) => state.providerIds.has(input.providerID)),
    };
  };

  const report = async (input: RateGateReportInput): Promise<void> => {
    const { config } = await resolveConfigAsync();
    if (!isRateGateConfigured(config)) return;

    const alreadyGated = Boolean(input.accountKey && states.has(input.accountKey));
    const reportUrl = input.url ?? (alreadyGated ? null : deps.resolveProviderBaseUrl(input.providerID) ?? null);
    const attributedByKey = alreadyGated && input.url === undefined;
    if (!attributedByKey && !matchesGateway(reportUrl, config.gateways)) return;

    const at = now();
    const windowMs = config.windowMinutes * 60_000;
    const targets = await reportTargets(input);
    for (const state of targets.states) applyReport(state, input, at, windowMs);

    const limits = reportLimits(input, at);
    log({
      event: 'report',
      accountKey: targets.key,
      providerID: input.providerID,
      sessionID: input.sessionID,
      status: input.status,
      remaining: limits.remaining,
      resetAt: limits.resetAt,
      retryAfterMs: limits.retryAfterMs,
      limitedUntil: targets.states[0]?.limitedUntil ?? null,
      headers: input.headers ? Object.keys(input.headers).join(',') : null,
    });
    scheduleBroadcast();
  };

  const isEnabled = async () => {
    const { config } = await resolveConfigAsync();
    if (!isRateGateConfigured(config)) return false;
    return deps.isPluginSupported().catch(() => false);
  };

  const materializePlugin = async () => {
    await deps.fs.mkdir(pluginDirectory, { recursive: true });
    await deps.fs.writeFile(
      deps.path.join(pluginDirectory, 'package.json'),
      JSON.stringify({ name: 'openchamber-rate-gate', version: '1.0.0', type: 'module', main: 'index.js' }, null, 2),
      'utf8',
    );
    await deps.fs.writeFile(deps.path.join(pluginDirectory, 'index.js'), buildRateGatePluginSource(), 'utf8');
    return pluginDirectory;
  };

  const registerRoutes = (app: Application, express: Pick<ExpressFactory, 'json'>) => {
    const readJson = express.json({ limit: '16kb' });
    app.post('/api/rate-gate/acquire', readJson, async (req, res) => {
      if (!deps.authorizeRequest(req)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const parsed = acquireSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      res.json(await acquire(parsed.data));
    });

    app.post('/api/rate-gate/report', readJson, async (req, res) => {
      if (!deps.authorizeRequest(req)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const parsed = reportSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      await report(parsed.data);
      res.json({ ok: true });
    });
  };

  const registerStatusRoute = (app: Application, requireApiAuth: RequestHandler) => {
    app.get('/api/rate-gate/status', requireApiAuth, async (_req, res) => {
      res.json(await computeStatus());
    });
  };

  return {
    pluginDirectory,
    isEnabled,
    materializePlugin,
    acquire,
    report,
    status: computeStatus,
    registerRoutes,
    registerStatusRoute,
  };
};
