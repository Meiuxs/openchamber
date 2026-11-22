import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { normalizeGateway } from './rate-gate/policy.js';

export type EnterprisePolicySource = 'policy-file' | 'environment';

export interface EnterprisePolicyOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readFile?: (filePath: string) => string;
  homedir?: () => string;
}

export interface SkillsCatalogSource {
  id: string;
  label: string;
  description?: string | undefined;
  source: string;
  defaultSubpath?: string | undefined;
  excludedSkills?: string[] | undefined;
}

export interface EnterprisePolicy {
  enterpriseMode: boolean;
  source: EnterprisePolicySource | null;
  organization: string | null;
  policyError: string | null;
  relayUrl: string | null;
  jev: { url: string; model: string | null; apiKey: string | null } | null;
  allowNetworkAccess: boolean;
  allowedExtensions: string[];
  allowLocalExtensions: boolean;
  opencodeBinary: string | null;
  hideBuiltinSkillCatalogs: boolean;
  allowedInsecureGitOrigins: string[];
  modelsDevUrl: string | null;
  npmRegistry: string | null;
  skillsCatalogSources: SkillsCatalogSource[];
  modelRateLimit?: {
    requests?: number | undefined;
    windowMinutes?: number | undefined;
    gateways?: string[] | undefined;
  } | undefined;
}

export type PublicEnterprisePolicy = Pick<EnterprisePolicy, 'enterpriseMode' | 'source' | 'organization' | 'policyError' | 'opencodeBinary'> & { networkAccessBlocked: boolean; modelsDevUrlPinned: boolean };

const hasErrorDetails = (value: unknown): value is { code?: unknown; message?: unknown } =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

const WINDOWS_PROGRAM_DATA = 'C:\\ProgramData';

const defaultHomedir = () => os.homedir();

export const userPolicyFilePath = ({ platform = process.platform, env = process.env, homedir = defaultHomedir }: EnterprisePolicyOptions = {}): string => {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dataDir = (env.OPENCHAMBER_DATA_DIR ?? '').trim();
  if (dataDir) {
    return p.join(p.resolve(dataDir), 'policy.json');
  }
  let home = platform === 'win32'
    ? (env.USERPROFILE ?? env.HOME ?? '').trim()
    : (env.HOME ?? '').trim();
  if (!home) {
    if (platform === process.platform) {
      home = homedir();
    } else {
      home = platform === 'win32' ? 'C:\\Users\\user' : '/home/user';
    }
  }
  return p.join(home, '.config', 'openchamber', 'policy.json');
};

export const policyFilePaths = ({ platform = process.platform, env = process.env, homedir = defaultHomedir }: Pick<EnterprisePolicyOptions, 'platform' | 'env' | 'homedir'> = {}): string[] => {
  const userPath = userPolicyFilePath({ platform, env, homedir });
  const paths = [userPath];
  if (platform === 'darwin') {
    paths.push('/Library/Application Support/OpenChamber/policy.json');
    return paths;
  }
  if (platform === 'win32') {
    const fixed = path.win32.join(WINDOWS_PROGRAM_DATA, 'OpenChamber', 'policy.json');
    const programData = (env.ProgramData ?? '').trim();
    const fromEnv = programData ? path.win32.join(programData, 'OpenChamber', 'policy.json') : null;
    paths.push(fixed);
    if (fromEnv && fromEnv.toLowerCase() !== fixed.toLowerCase()) {
      paths.push(fromEnv);
    }
    return paths;
  }
  paths.push('/etc/openchamber/policy.json');
  return paths;
};

const optionalText = z.string().trim().transform((value) => value || undefined).optional();

const policyFileSchema = z.object({
  enterpriseMode: z.boolean().optional(),
  organization: optionalText,
  relayUrl: optionalText,
  allowNetworkAccess: z.boolean().optional(),
  allowedExtensions: z.array(z.string().trim().min(1)).max(200).optional(),
  allowLocalExtensions: z.boolean().optional(),
  jev: z.object({ url: optionalText, model: optionalText, apiKey: optionalText }).optional(),
  opencodeBinary: optionalText,
  hideBuiltinSkillCatalogs: z.boolean().optional(),
  allowedInsecureGitOrigins: z.array(z.string().trim().min(1).max(512)).max(100).optional(),
  modelsDevUrl: optionalText,
  npmRegistry: optionalText,
  modelRateLimit: z.object({
    requests: z.number().int().min(1).max(10000).optional(),
    windowMinutes: z.number().int().min(1).max(1440).optional(),
    gateways: z.array(
      z.string().trim().min(1).max(512).refine((value) => normalizeGateway(value) !== null, {
        message: 'must be an http(s) URL without credentials, query or fragment',
      }),
    ).max(50).optional(),
  }).optional(),
  skillsCatalogSources: z.array(z.object({
    id: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(128),
    description: optionalText,
    source: z.string().trim().min(1).max(512),
    defaultSubpath: optionalText,
    excludedSkills: z.array(z.string().trim().min(1).max(128)).max(200).optional(),
  })).max(50).optional(),
}).refine((policy) => !policy.jev || policy.jev.url || (!policy.jev.model && !policy.jev.apiKey), {
  message: '"jev" needs a "url"',
  path: ['jev'],
});

const stripJsonComments = (text: string): string => {
  const withoutComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (_match, stringLiteral?: string) =>
    stringLiteral ?? ''
  );
  return withoutComments.replace(/,(\s*[}\]])/g, '$1');
};

const parsePolicyFile = (text: string) => {
  let raw: unknown;
  try {
    const cleaned = stripJsonComments(text.replace(/^\uFEFF/, ''));
    raw = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`not valid JSON (${hasErrorDetails(error) ? error.message : undefined})`);
  }
  const parsed = policyFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues.at(0);
    if (!issue) throw parsed.error;
    const field = issue.path.length > 0 ? `"${issue.path.join('.')}": ` : '';
    throw new Error(`${field}${issue.message}`);
  }
  const { enterpriseMode, organization, relayUrl, allowNetworkAccess, allowedExtensions, allowLocalExtensions, jev, opencodeBinary, hideBuiltinSkillCatalogs, allowedInsecureGitOrigins, modelsDevUrl, npmRegistry, skillsCatalogSources, modelRateLimit } = parsed.data;
  return {
    enterpriseMode: enterpriseMode === true,
    organization: organization ?? null,
    relayUrl,
    allowNetworkAccess,
    allowedExtensions,
    allowLocalExtensions,
    jev: jev?.url ? { url: jev.url, model: jev.model ?? null, apiKey: jev.apiKey ?? null } : undefined,
    opencodeBinary: opencodeBinary ?? null,
    hideBuiltinSkillCatalogs: hideBuiltinSkillCatalogs === true,
    allowedInsecureGitOrigins: allowedInsecureGitOrigins ?? [],
    modelsDevUrl: modelsDevUrl ?? null,
    npmRegistry: npmRegistry ?? null,
    skillsCatalogSources: skillsCatalogSources ?? [],
    modelRateLimit: modelRateLimit ?? undefined,
  };
};

const defaultReadFile = (filePath: string) => fs.readFileSync(filePath, 'utf8');

let lastWarning: string | null = null;
const warnOnce = (message: string) => {
  if (message === lastWarning) return;
  lastWarning = message;
  console.warn(`[enterprise] ${message}`);
};

type PolicyFileRead =
  | { status: 'invalid'; path: string; error: string }
  | { status: 'ok'; path: string; policy: ReturnType<typeof parsePolicyFile> }
  | { status: 'absent' };

const readPolicyFile = ({ platform = process.platform, env = process.env, readFile = defaultReadFile }: EnterprisePolicyOptions = {}): PolicyFileRead => {
  for (const filePath of policyFilePaths({ platform, env })) {
    let text;
    try {
      text = readFile(filePath);
    } catch (error) {
      if (hasErrorDetails(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
      const message = `cannot read ${filePath}: ${hasErrorDetails(error) ? error.message || error : error}`;
      warnOnce(`${message}; enterprise mode stays on`);
      return { status: 'invalid', path: filePath, error: message };
    }
    try {
      return { status: 'ok', path: filePath, policy: parsePolicyFile(text) };
    } catch (error) {
      const message = `${filePath}: ${hasErrorDetails(error) ? error.message : undefined}`;
      warnOnce(`${message}; enterprise mode stays on`);
      return { status: 'invalid', path: filePath, error: message };
    }
  }
  return { status: 'absent' };
};

const envFlag = (env: NodeJS.ProcessEnv, name: string) => {
  const value = (env[name] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true';
};

const envString = (env: NodeJS.ProcessEnv, name: string) => (env[name] ?? '').trim() || null;

const envList = (env: NodeJS.ProcessEnv, name: string) => (env[name] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);

export const watchEnterprisePolicy = ({ onChange, intervalMs = 15_000, read = readEnterprisePolicy }: {
  onChange: () => void;
  intervalMs?: number;
  read?: () => EnterprisePolicy;
}) => {
  let last = JSON.stringify(read());
  const timer = setInterval(() => {
    const next = JSON.stringify(read());
    if (next === last) return;
    last = next;
    onChange();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
};

export const readEnterprisePolicy = (options: EnterprisePolicyOptions = {}): EnterprisePolicy => {
  const env = options.env ?? process.env;
  const file = readPolicyFile(options);

  if (file.status === 'invalid') {
    return {
      enterpriseMode: true,
      source: 'policy-file',
      organization: null,
      policyError: file.error,
      relayUrl: null,
      jev: null,
      allowNetworkAccess: false,
      allowedExtensions: [],
      allowLocalExtensions: false,
      opencodeBinary: null,
      allowedInsecureGitOrigins: [],
      hideBuiltinSkillCatalogs: true,
      modelsDevUrl: null,
      skillsCatalogSources: [],
      npmRegistry: null,
    };
  }

  const fromFile = file.status === 'ok' ? file.policy : null;
  const fileGoverns = fromFile?.enterpriseMode === true;
  const enterpriseMode = fileGoverns || envFlag(env, 'OPENCHAMBER_ENTERPRISE_MODE');

  const envJevUrl = fileGoverns ? null : envString(env, 'OPENCHAMBER_JEV_URL');
  const jev = fromFile?.jev
    ?? (envJevUrl
      ? { url: envJevUrl, model: envString(env, 'OPENCHAMBER_JEV_MODEL'), apiKey: envString(env, 'OPENCHAMBER_JEV_API_KEY') }
      : null);
  const relayUrl = fromFile?.relayUrl ?? (fileGoverns ? null : envString(env, 'OPENCHAMBER_RELAY_URL'));
  const allowNetworkAccess = fromFile?.allowNetworkAccess
    ?? (fileGoverns ? false : envFlag(env, 'OPENCHAMBER_ALLOW_NETWORK_ACCESS'));
  const allowedExtensions = fromFile?.allowedExtensions
    ?? (fileGoverns ? [] : envList(env, 'OPENCHAMBER_ALLOWED_EXTENSIONS'));
  const allowLocalExtensions = fromFile?.allowLocalExtensions
    ?? (fileGoverns ? false : envFlag(env, 'OPENCHAMBER_ALLOW_LOCAL_EXTENSIONS'));

  const policy: EnterprisePolicy = {
    enterpriseMode,
    source: fileGoverns ? 'policy-file' : enterpriseMode ? 'environment' : null,
    organization: fromFile?.organization ?? null,
    policyError: null,
    relayUrl,
    jev,
    allowNetworkAccess,
    allowedExtensions,
    allowLocalExtensions,
    opencodeBinary: fromFile?.opencodeBinary ?? null,
    hideBuiltinSkillCatalogs: fromFile?.hideBuiltinSkillCatalogs === true,
    allowedInsecureGitOrigins: fromFile?.allowedInsecureGitOrigins
      ?? (fileGoverns ? [] : envList(env, 'OPENCHAMBER_ALLOWED_INSECURE_GIT_ORIGINS')),
    modelsDevUrl: fromFile?.modelsDevUrl ?? null,
    npmRegistry: fromFile?.npmRegistry
      ?? (fileGoverns ? null : envString(env, 'OPENCHAMBER_NPM_REGISTRY')),
    skillsCatalogSources: fromFile?.skillsCatalogSources ?? [],
  };
  const modelRateLimit = fromFile?.modelRateLimit;
  if (modelRateLimit) policy.modelRateLimit = modelRateLimit;
  return policy;
};

export const readPinnedModelsDevUrl = (options?: EnterprisePolicyOptions): string | null => {
  const value = readEnterprisePolicy(options).modelsDevUrl;
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
};

export const isEnterpriseMode = (options?: EnterprisePolicyOptions) => readEnterprisePolicy(options).enterpriseMode;

export const readNpmRegistry = (options: EnterprisePolicyOptions = {}): string | null => {
  const policy = readEnterprisePolicy(options);
  const raw = policy.npmRegistry
    ?? (policy.enterpriseMode ? null : readProfileNpmRegistry(options));
  if (!raw) return null;
  try {
    const registry = new URL(raw);
    if (!['http:', 'https:'].includes(registry.protocol) || registry.search || registry.hash) return null;
    if (registry.username || registry.password) return null;
    return `${registry.protocol}//${registry.host}${registry.pathname.replace(/\/+$/, '')}/`;
  } catch {
    return null;
  }
};

const readProfileNpmRegistry = ({ env = process.env, readFile = defaultReadFile }: EnterprisePolicyOptions = {}): string | null => {
  const dir = env.OPENCHAMBER_DATA_DIR
    ? path.resolve(env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
  let text;
  try {
    text = readFile(path.join(dir, 'preferences.json'));
  } catch {
    return null;
  }
  try {
    const fields = JSON.parse(text.replace(/^\uFEFF/, ''))?.fields;
    const parsed = z.string().safeParse(fields?.npmRegistry?.value);
    return parsed.success ? parsed.data.trim() || null : null;
  } catch {
    return null;
  }
};

const readProfileInsecureGitOrigins = ({ env = process.env, readFile = defaultReadFile }: EnterprisePolicyOptions = {}): string[] => {
  const dir = env.OPENCHAMBER_DATA_DIR
    ? path.resolve(env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
  let text;
  try {
    text = readFile(path.join(dir, 'preferences.json'));
  } catch {
    return [];
  }
  let fields;
  try {
    fields = JSON.parse(text.replace(/^\uFEFF/, ''))?.fields;
  } catch {
    return [];
  }
  const parsed = z.string().safeParse(fields?.allowedInsecureGitOrigins?.value);
  return parsed.success
    ? parsed.data.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
};

export const normalizeInsecureGitOrigin = (raw: string): string | null => {
  const value = raw.trim();
  if (!value || value.length > 512) return null;
  let url;
  try {
    url = new URL(value.includes('://') ? value : `http://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '' && url.pathname !== '/') return null;
  if (!url.hostname || url.hostname.includes('*')) return null;
  return url.origin;
};

export const allowedInsecureGitOrigins = (options?: EnterprisePolicyOptions): Set<string> => {
  const policy = readEnterprisePolicy(options);
  const entries = [...policy.allowedInsecureGitOrigins];
  if (!policy.enterpriseMode) entries.push(...readProfileInsecureGitOrigins(options));
  const origins = new Set<string>();
  for (const entry of entries) {
    const origin = normalizeInsecureGitOrigin(entry);
    if (origin) origins.add(origin);
  }
  return origins;
};

export const isNetworkAccessBlocked = (options?: EnterprisePolicyOptions) => {
  const policy = readEnterprisePolicy(options);
  return policy.enterpriseMode && !policy.allowNetworkAccess;
};

export const NETWORK_ACCESS_BLOCKED_ERROR = 'Enterprise mode keeps OpenChamber on this machine: it does not listen on a network address. '
  + 'An administrator can allow it with "allowNetworkAccess": true in the policy file, or OPENCHAMBER_ALLOW_NETWORK_ACCESS=1 where the environment turns enterprise mode on.';

export const publicEnterprisePolicy = (options?: EnterprisePolicyOptions): PublicEnterprisePolicy => {
  const { enterpriseMode, source, organization, policyError, allowNetworkAccess, opencodeBinary } = readEnterprisePolicy(options);
  return {
    enterpriseMode,
    source,
    organization,
    policyError,
    networkAccessBlocked: enterpriseMode && !allowNetworkAccess,
    opencodeBinary,
    modelsDevUrlPinned: readPinnedModelsDevUrl(options) !== null,
  };
};

const MCP_INTEGRATION_ID = /^mcp_[0-9a-f]{16}$/;
const ATTEMPT_ID = /^[A-Za-z0-9_-]+$/;

const routeSegments = (requestPath: string) => {
  const [pathOnly = ''] = String(requestPath).split(/[?#;]/, 1);
  const segments = [];
  for (const raw of pathOnly.split(/[\\/]/)) {
    if (!raw) continue;
    let segment;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === '.' || segment === '..') return null;
    segments.push(segment);
  }
  return segments;
};

const isMcpSignIn = (integrationId: string | undefined, rest: string[]) => (
  MCP_INTEGRATION_ID.test(String(integrationId))
  && rest[0]?.toLowerCase() === 'oauth'
  && (rest.length === 1 || (rest.length === 3 && ATTEMPT_ID.test(String(rest[1])) && rest[2]?.toLowerCase() === 'complete'))
);

export const isProviderConnectRequest = (method: string, requestPath: string) => {
  if (String(method).toUpperCase() !== 'POST') return false;
  const segments = routeSegments(requestPath);
  if (segments === null) return true;
  const [api, group, ...tail] = segments.map((segment) => segment.toLowerCase());
  if (api !== 'api') return false;
  if (group === 'credential') return tail.length === 0;
  if (group === 'experimental') return tail[0] === 'integration' && tail[1] === 'wellknown';
  if (group !== 'integration' || tail[1] !== 'connect') return false;
  return !isMcpSignIn(segments[2], segments.slice(4));
};

export const ENTERPRISE_MODE_ERROR = 'Not available in enterprise mode: this server keeps conversations with the model providers configured in OpenCode.';

export const isCredentialListRequest = (method: string, requestPath: string) => {
  const upper = String(method).toUpperCase();
  if (upper !== 'GET' && upper !== 'HEAD') return false;
  const segments = routeSegments(requestPath);
  if (segments === null) return /^[\\/]*api(?:[\\/?#;]|$)/i.test(String(requestPath));
  return segments.length === 2 && segments[0]?.toLowerCase() === 'api' && segments[1]?.toLowerCase() === 'credential';
};

export const CREDENTIAL_LIST_ERROR = 'OpenChamber does not hand stored provider keys to clients.';
