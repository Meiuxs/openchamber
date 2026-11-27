/**
 * Database binding helpers for the dbhub MCP preset.
 *
 * A binding is a project-scope local MCP entry whose stdio command runs
 * bytebase/dbhub with a generated dbhub.toml. The TOML carries the DSN and the
 * per-tool read-only setting: dbhub 2.x dropped the `--readonly` flag and now
 * configures it as `[[tools]] name = "execute_sql" readonly = true`. The DSN is
 * mirrored into the DSN environment variable so the edit form can read a
 * binding back without touching the filesystem (dbhub prefers the TOML).
 */
import type { McpDraft, McpServerWithScope } from '@/stores/useMcpConfigStore';
import { MCP_DRAFT_OAUTH_UNSET } from '@/components/sections/mcp/mcpDraft';

export type DbEngine = 'mysql' | 'postgresql';

/** libpq-style sslmode values; anything else is dropped instead of guessed at. */
export const DB_SSL_MODES = ['', 'disable', 'prefer', 'require', 'verify-ca', 'verify-full'] as const;

export type DbSslMode = (typeof DB_SSL_MODES)[number];

export interface DbConnectionFields {
  engine: DbEngine;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  sslMode: DbSslMode;
}

export interface DbBindingSpec extends DbConnectionFields {
  alias: string;
  readonly: boolean;
  dbhubVersion: string;
}

export const DBHUB_PACKAGE = '@bytebase/dbhub';
export const DEFAULT_DBHUB_VERSION = 'latest';
export const DSN_ENV = 'DSN';
/** Marker the binding writes so the form can round-trip the read-only switch. */
export const READONLY_ENV = 'OPENCHAMBER_DB_READONLY';

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

const isSslMode = (value: unknown): value is DbSslMode =>
  typeof value === 'string' && (DB_SSL_MODES as readonly string[]).includes(value.toLowerCase());

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
  // Split the still-encoded path first: a database named `my%2Fdb` decodes to
  // `my/db` and must not be truncated at the decoded slash.
  const encodedDatabase = url.pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  const database = safeDecode(encodedDatabase);
  const rawSsl = url.searchParams.get('sslmode') ?? '';
  const sslMode = isSslMode(rawSsl) ? (rawSsl.toLowerCase() as DbSslMode) : '';

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

/** A dbhub preset MCP entry: a local command that runs @bytebase/dbhub. */
export const isDbhubServer = (server: McpServerWithScope): boolean => {
  if (server.type !== 'local') return false;
  return (server.command ?? []).some((part) => part.includes(DBHUB_PACKAGE));
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
 * prefill. The password comes back with it: an empty box used to mean
 * "leave it alone", but the draft rebuilds the DSN from the form, so an empty
 * password silently wiped the stored one. Showing the masked value
 * keeps "save without touching the password" lossless.
 */
export const readDbBindingSpec = (server: McpServerWithScope): DbBindingSpec | null => {
  const dsn = dsnOfServer(server);
  const fields = dsn ? parseDbConnectionUrl(dsn) : null;
  const alias = server.name.startsWith(DBHUB_NAME_PREFIX)
    ? server.name.slice(DBHUB_NAME_PREFIX.length)
    : server.name;
  const env = server.environment ?? {};
  return {
    alias,
    engine: fields?.engine ?? 'mysql',
    host: fields?.host ?? '',
    port: fields?.port ?? '',
    database: fields?.database ?? '',
    username: fields?.username ?? '',
    password: fields?.password ?? '',
    sslMode: fields?.sslMode ?? '',
    readonly: env[READONLY_ENV] !== '0',
    dbhubVersion: versionOfServer(server),
  };
};

export const bindingNameOf = (alias: string): string =>
  `${DBHUB_NAME_PREFIX}${alias.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'db'}`;

/**
 * The name without its `dbhub-` prefix, accepting either form. Callers that
 * hold an entry name used to feed it back through `bindingNameOf`, which
 * produced `dbhub-dbhub-…` and removed the wrong config file.
 */
export const bindingSlugOf = (aliasOrName: string): string => {
  const alias = aliasOrName.startsWith(DBHUB_NAME_PREFIX)
    ? aliasOrName.slice(DBHUB_NAME_PREFIX.length)
    : aliasOrName;
  return bindingNameOf(alias).slice(DBHUB_NAME_PREFIX.length);
};

/** Where the generated config lives, relative to the project directory. */
export const bindingConfigRelativePathOf = (alias: string): string =>
  `.opencode/dbhub/${bindingNameOf(alias)}.toml`;

/**
 * The dbhub.toml for one binding. dbhub 2.x configures read-only per tool, and
 * defining `execute_sql` this way is what replaces the removed `--readonly`.
 */
export const buildDbhubToml = (spec: DbBindingSpec): string => {
  const lines = [
    '[[sources]]',
    'id = "default"',
    `dsn = ${JSON.stringify(buildDbDsn(spec))}`,
    '',
    '[[tools]]',
    'name = "execute_sql"',
    'source = "default"',
    `readonly = ${spec.readonly ? 'true' : 'false'}`,
    '',
  ];
  return lines.join('\n');
};

/**
 * Assemble the McpDraft the dbhub preset saves. `configPath` is the absolute
 * path of the TOML the server wrote for this binding; the npm registry env is
 * injected when an intranet mirror is configured so npx resolves against it.
 */
export const buildDbhubMcpDraft = (
  spec: DbBindingSpec,
  npmRegistry: string | null,
  configPath: string,
): McpDraft => {
  const versionTag = spec.dbhubVersion.trim() && spec.dbhubVersion.trim() !== 'latest'
    ? `${DBHUB_PACKAGE}@${spec.dbhubVersion.trim()}`
    : DBHUB_PACKAGE;
  const environment = [
    { key: DSN_ENV, value: buildDbDsn(spec) },
    { key: READONLY_ENV, value: spec.readonly ? '1' : '0' },
  ];
  const registry = npmRegistry?.trim();
  if (registry) environment.push({ key: 'npm_config_registry', value: registry });
  return {
    name: bindingNameOf(spec.alias),
    scope: 'project',
    type: 'local',
    command: ['npx', '-y', versionTag, '--config', configPath, '--transport', 'stdio'],
    url: '',
    environment,
    headers: [],
    ...MCP_DRAFT_OAUTH_UNSET,
    oauthAuthServerMetadataUrl: '',
    protocol: 'legacy',
    timeoutStartup: '20000',
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

/** Where the project's default binding is recorded (see the server's binding-config). */
export const PRIMARY_CONFIG_RELATIVE_PATH = '.opencode/dbhub/primary.json';

export interface DbBindingChoice {
  entryName: string;
  spec: DbBindingSpec;
}

/** Every dbhub preset entry in this project, in config order. */
export const listDbBindings = (servers: readonly McpServerWithScope[]): DbBindingChoice[] =>
  servers
    .filter(isDbhubServer)
    .map((server) => ({ entryName: server.name, spec: readDbBindingSpec(server) }))
    .filter((choice): choice is DbBindingChoice => choice.spec !== null);

/**
 * The binding a session should use: an explicit per-session pick wins, then the
 * project's primary, then the first binding. A stale name (deleted binding) is
 * ignored instead of leaving the session pointing at nothing.
 */
export const resolveEffectiveBinding = (
  bindings: readonly DbBindingChoice[],
  primaryName: string | null,
  selectedEntry: string | null,
): DbBindingChoice | null => {
  const byName = (name: string | null) =>
    name ? bindings.find((binding) => binding.entryName === name) ?? null : null;
  return byName(selectedEntry) ?? byName(primaryName) ?? bindings[0] ?? null;
};

/** Default wording for {@link buildDbBindingPrompt}; callers pass the localized template. */
export const DB_BINDING_PROMPT_TEMPLATE =
  '本会话数据库：{name}（{entry}，{target}，{mode}）。未明确指定其它库时请使用它；查库优先调用 {entry}_execute_sql / {entry}_search_objects。';

/**
 * Tells the session which database it is meant to use. This is a preference,
 * not a restriction: every other binding's tools stay available.
 */
export const buildDbBindingPrompt = (
  choice: DbBindingChoice,
  template: string = DB_BINDING_PROMPT_TEMPLATE,
  modeLabel?: { readonly: string; readwrite: string },
): string => {
  const { spec, entryName } = choice;
  const name = spec.alias.trim() || entryName.slice(DBHUB_NAME_PREFIX.length);
  const target = `${spec.host.trim()}:${spec.port.trim()}/${spec.database.trim()}`;
  const mode = spec.readonly
    ? (modeLabel?.readonly ?? '只读')
    : (modeLabel?.readwrite ?? '读写');
  return template
    .replaceAll('{name}', name)
    .replaceAll('{entry}', entryName)
    .replaceAll('{target}', target)
    .replaceAll('{mode}', mode);
};

/**
 * The prompt to inject before a send, or null when this session already saw the
 * same binding announced (so a long conversation does not repeat it).
 */
export const dbBindingPromptFor = (input: {
  bindings: readonly DbBindingChoice[];
  primaryName: string | null;
  selectedEntry: string | null;
  announcedEntry: string | null;
  template?: string;
  modeLabel?: { readonly: string; readwrite: string };
}): { entryName: string; text: string } | null => {
  const choice = resolveEffectiveBinding(input.bindings, input.primaryName, input.selectedEntry);
  if (!choice || choice.entryName === input.announcedEntry) return null;
  return {
    entryName: choice.entryName,
    text: buildDbBindingPrompt(choice, input.template, input.modeLabel),
  };
};
