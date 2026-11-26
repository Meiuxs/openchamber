/**
 * Database binding helpers for the dbhub MCP preset.
 *
 * A binding is a project-scope local MCP entry whose stdio command runs
 * bytebase/dbhub and whose DSN travels in the DSN environment variable
 * (never on the command line, so passwords stay out of process lists).
 */
import type { McpDraft, McpServerWithScope } from '@/stores/useMcpConfigStore';
import { MCP_DRAFT_OAUTH_UNSET } from '@/components/sections/mcp/mcpDraft';

export type DbEngine = 'mysql' | 'postgresql';

export interface DbConnectionFields {
  engine: DbEngine;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  sslMode: '' | 'disable' | 'require';
}

export interface DbBindingSpec extends DbConnectionFields {
  alias: string;
  readonly: boolean;
  dbhubVersion: string;
}

export const DBHUB_PACKAGE = '@bytebase/dbhub';
export const DEFAULT_DBHUB_VERSION = 'latest';
export const DSN_ENV = 'DSN';

export const DB_ENGINE_PORTS: Record<DbEngine, string> = {
  mysql: '3306',
  postgresql: '5432',
};

const DB_ENGINE_BY_SCHEME: Record<string, DbEngine> = {
  'mysql:': 'mysql',
  'mariadb:': 'mysql',
  'postgres:': 'postgresql',
  'postgresql:': 'postgresql',
};

const isSslMode = (value: unknown): value is DbConnectionFields['sslMode'] =>
  value === '' || value === 'disable' || value === 'require';

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Parse a pasted connection URL (`mysql://user:password@host:3306/db`,
 * `postgres://…`, `postgresql://…`, `mariadb://…`) into form fields.
 * Returns null when the text is not a database URL we understand.
 */
export const parseDbConnectionUrl = (raw: string): DbConnectionFields | null => {
  const text = raw.trim().replace(/^jdbc:/, '');
  if (!text || /\s/.test(text)) return null;
  const colon = text.indexOf(':');
  if (colon < 1) return null;
  const engine = DB_ENGINE_BY_SCHEME[text.slice(0, colon + 1).toLowerCase()];
  if (!engine) return null;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  const host = safeDecode(url.hostname);
  if (!host) return null;
  const database = safeDecode(url.pathname.replace(/^\/+/, '')).split(/[?/]/)[0] ?? '';
  const rawSsl = url.searchParams.get('sslmode') ?? '';
  const sslMode = isSslMode(rawSsl) ? rawSsl : '';

  return {
    engine,
    host,
    port: url.port || DB_ENGINE_PORTS[engine],
    database,
    username: safeDecode(url.username),
    password: safeDecode(url.password),
    sslMode,
  };
};

/** Build the DSN dbhub receives through DSN. */
export const buildDbDsn = (fields: DbConnectionFields): string => {
  const auth = fields.username
    ? `${encodeURIComponent(fields.username)}${fields.password ? `:${encodeURIComponent(fields.password)}` : ''}@`
    : '';
  const port = fields.port.trim() ? `:${fields.port.trim()}` : '';
  const ssl = fields.sslMode ? `?sslmode=${fields.sslMode}` : '';
  const scheme = fields.engine === 'mysql' ? 'mysql' : 'postgresql';
  return `${scheme}://${auth}${fields.host.trim()}${port}/${encodeURIComponent(fields.database.trim())}${ssl}`;
};

export const DBHUB_NAME_PREFIX = 'dbhub-';

/** A dbhub preset MCP entry: command mentions @bytebase/dbhub and carries a DSN. */
export const isDbhubServer = (server: McpServerWithScope): boolean => {
  if (server.type !== 'local') return false;
  const command = server.command ?? [];
  const mentionsDbhub = command.some((part) => part.includes(DBHUB_PACKAGE));
  const hasDsn = Object.keys(server.environment ?? {}).includes(DSN_ENV);
  return mentionsDbhub || hasDsn;
};

const dsnOfServer = (server: McpServerWithScope): string => {
  const env = server.environment ?? {};
  return typeof env[DSN_ENV] === 'string' ? env[DSN_ENV] : '';
};

const versionOfServer = (server: McpServerWithScope): string => {
  const command = server.type === 'local' ? server.command : undefined;
  const spec = (command ?? []).find((part) => part.startsWith(`${DBHUB_PACKAGE}@`));
  return spec ? spec.slice(DBHUB_PACKAGE.length + 1) : DEFAULT_DBHUB_VERSION;
};

/**
 * Read a binding spec back out of an existing MCP entry so the edit form can
 * prefill. The password is never echoed back — editing always
 * re-enters it.
 */
export const readDbBindingSpec = (server: McpServerWithScope): DbBindingSpec | null => {
  const dsn = dsnOfServer(server);
  const fields = dsn ? parseDbConnectionUrl(dsn) : null;
  const alias = server.name.startsWith(DBHUB_NAME_PREFIX)
    ? server.name.slice(DBHUB_NAME_PREFIX.length)
    : server.name;
  return {
    alias,
    engine: fields?.engine ?? 'mysql',
    host: fields?.host ?? '',
    port: fields?.port ?? '',
    database: fields?.database ?? '',
    username: fields?.username ?? '',
    password: '',
    sslMode: fields?.sslMode ?? '',
    readonly: (server.type === 'local' ? server.command ?? [] : []).includes('--readonly'),
    dbhubVersion: versionOfServer(server),
  };
};

export const bindingNameOf = (alias: string): string =>
  `${DBHUB_NAME_PREFIX}${alias.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'db'}`;

/**
 * Assemble the McpDraft the dbhub preset saves. The npm registry env is
 * injected when an intranet mirror is configured so npx resolves against it.
 */
export const buildDbhubMcpDraft = (
  spec: DbBindingSpec,
  npmRegistry: string | null,
): McpDraft => {
  const versionTag = spec.dbhubVersion.trim() && spec.dbhubVersion.trim() !== 'latest'
    ? `${DBHUB_PACKAGE}@${spec.dbhubVersion.trim()}`
    : DBHUB_PACKAGE;
  const environment = [{ key: DSN_ENV, value: buildDbDsn(spec) }];
  const registry = npmRegistry?.trim();
  if (registry) environment.push({ key: 'npm_config_registry', value: registry });
  return {
    name: bindingNameOf(spec.alias),
    scope: 'project',
    type: 'local',
    command: ['npx', '-y', versionTag, '--transport', 'stdio', ...(spec.readonly ? ['--readonly'] : [])],
    url: '',
    environment,
    headers: [],
    ...MCP_DRAFT_OAUTH_UNSET,
    oauthAuthServerMetadataUrl: '',
    protocol: 'legacy',
    timeoutStartup: '15000',
    timeoutCatalog: '',
    timeoutExecution: '30000',
    codemode: 'default',
    disabled: false,
  };
};

/** True when the alias is usable as an MCP server name suffix (spaces normalize to dashes). */
export const isValidBindingAlias = (alias: string): boolean =>
  /^[a-z0-9]([a-z0-9- ]*[a-z0-9])?$/.test(alias.trim().toLowerCase());

/**
 * dbhub reports a failed probe as one run-on line that repeats the cause at the
 * end, wrapped in stack frames. Pull the cause back out so the dialog can say
 * "Access denied…" or "connect ETIMEDOUT" instead of 2 KB of " at …" frames.
 */
export const summarizeDbhubError = (raw: string): string => {
  const flat = raw.replace(/\s+/g, ' ').trim();
  const withoutFrames = flat
    .replace(/ at (?:async )?[\w$.]+ ?\([^)]*\)/g, '')
    .replace(/ at (?:async )?\S+/g, '')
    .replace(/Fatal error:\s*/gi, '')
    .trim();
  const sqlMessage = withoutFrames.match(/sqlMessage:\s*"([^"]{1,300})"/i);
  if (sqlMessage?.[1]) return sqlMessage[1];
  const failed = withoutFrames.match(
    /Failed to connect[^:]*:\s*(?:Error:\s*)?(.{1,300}?)(?=\s+(?:Error:|Fatal)|\s*\{|$)/i,
  );
  if (failed?.[1]?.trim()) return failed[1].trim();
  const generic = withoutFrames.match(/(?:^|\s)(?:Error|error):\s*(.{1,300}?)(?:\s*\{|$)/);
  if (generic?.[1]?.trim()) return generic[1].trim();
  return withoutFrames.length > 300 ? `${withoutFrames.slice(0, 300)}…` : withoutFrames;
};

/**
 * Propose a binding alias from a database (or host) name, kept clear of the
 * aliases already bound in this project so pasting two URLs never collides.
 */
export const suggestBindingAlias = (source: string, taken: readonly string[]): string => {
  const base =
    source.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'db';
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
};

/** Fields the save button requires before the binding can be built. */
export const isBindingComplete = (spec: DbBindingSpec): boolean =>
  isValidBindingAlias(spec.alias) && spec.host.trim() !== '' && spec.database.trim() !== '';
