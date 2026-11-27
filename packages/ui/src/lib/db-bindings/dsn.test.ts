import { describe, expect, test } from 'bun:test';
import {
  bindingNameOf,
  buildDbDsn,
  bindingConfigRelativePathOf,
  bindingSlugOf,
  buildDbhubMcpDraft,
  buildDbhubToml,
  dbBindingPromptFor,
  isBindingComplete,
  isDbhubServer,
  isValidBindingAlias,
  listDbBindings,
  parseDbConnectionUrl,
  readDbBindingSpec,
  resolveEffectiveBinding,
  suggestBindingAlias,
  summarizeDbhubError,
  buildDbBindingPrompt,
  type DbConnectionFields,
} from './dsn';
import type { McpServerWithScope } from '@/stores/useMcpConfigStore';

const fields = (overrides: Partial<DbConnectionFields> = {}): DbConnectionFields => ({
  engine: 'mysql',
  host: 'db-internal.local',
  port: '3306',
  database: 'orders',
  username: 'svc_agent',
  password: 'hunter2',
  sslMode: '',
  ...overrides,
});

describe('parseDbConnectionUrl', () => {
  test('parses a mysql URL with credentials', () => {
    expect(parseDbConnectionUrl('mysql://svc_agent:hunter2@db-internal.local:3307/orders?sslmode=require'))
      .toEqual(fields({ port: '3307', sslMode: 'require' }));
  });

  test('parses postgres and postgresql schemes', () => {
    const expected = fields({ engine: 'postgresql', port: '5432', host: 'db.internal', database: 'analytics', username: 'u', password: 'p' });
    expect(parseDbConnectionUrl('postgres://u:p@db.internal/analytics')).toEqual(expected);
    expect(parseDbConnectionUrl('postgresql://u:p@db.internal/analytics')).toEqual(expected);
  });

  test('fills the default port per engine', () => {
    const parsed = parseDbConnectionUrl('mysql://u@host/db');
    expect(parsed?.port).toBe('3306');
    const pg = parseDbConnectionUrl('postgres://u@host/db');
    expect(pg?.port).toBe('5432');
  });

  test('decodes URL-encoded passwords', () => {
    const value = 'ab:cd12';
    const parsed = parseDbConnectionUrl(`mysql://u:${encodeURIComponent(value)}@host/db`);
    expect(parsed?.password).toBe(value);
  });

  test('strips a jdbc: prefix', () => {
    const parsed = parseDbConnectionUrl('jdbc:mysql://u:p@host:3306/db');
    expect(parsed?.host).toBe('host');
    expect(parsed?.database).toBe('db');
  });

  test('rejects non-database URLs', () => {
    expect(parseDbConnectionUrl('https://example.com/path')).toBeNull();
    expect(parseDbConnectionUrl('npx -y @bytebase/dbhub')).toBeNull();
    expect(parseDbConnectionUrl('')).toBeNull();
    expect(parseDbConnectionUrl('mysql://u:p@host/db and more words')).toBeNull();
  });
});

describe('buildDbDsn', () => {
  test('round-trips through the parser', () => {
    const dsn = buildDbDsn(fields());
    expect(parseDbConnectionUrl(dsn)).toEqual(fields());
  });

  test('encodes special characters and optional ssl', () => {
    const value = 'ab:cd12';
    const dsn = buildDbDsn(fields({ password: value, sslMode: 'disable' }));
    expect(dsn).toBe(`mysql://svc_agent:${encodeURIComponent(value)}@db-internal.local:3306/orders?sslmode=disable`);
  });

  test('omits auth when no username and skips empty port', () => {
    const dsn = buildDbDsn(fields({ username: '', password: '', port: '' }));
    expect(dsn).toBe('mysql://db-internal.local/orders');
  });
});

describe('dbhub mcp entry helpers', () => {
  test('builds a project-scope draft with DSN in env and registry mirror', () => {
    const draft = buildDbhubMcpDraft(
      { ...fields(), alias: 'Orders DB', readonly: true, dbhubVersion: '0.9.0' },
      'https://npm.mirror.local/',
      'D:/proj/.opencode/dbhub/dbhub-orders-db.toml',
    );
    expect(draft.name).toBe('dbhub-orders-db');
    expect(draft.scope).toBe('project');
    expect(draft.type).toBe('local');
    // dbhub 2.x dropped --readonly; the config file carries it now.
    expect(draft.command).toEqual([
      'npx', '-y', '@bytebase/dbhub@0.9.0',
      '--config', 'D:/proj/.opencode/dbhub/dbhub-orders-db.toml',
      '--transport', 'stdio',
    ]);
    expect(draft.command).not.toContain('--readonly');
    const env = Object.fromEntries(draft.environment.map((e) => [e.key, e.value]));
    expect(env.DSN).toBe(buildDbDsn(fields()));
    expect(env.OPENCHAMBER_DB_READONLY).toBe('1');
    expect(env.npm_config_registry).toBe('https://npm.mirror.local/');
  });

  test('defaults to unpinned dbhub and skips empty registry', () => {
    const draft = buildDbhubMcpDraft(
      { ...fields(), alias: 'analytics', readonly: false, dbhubVersion: 'latest' },
      null,
      '/p/.opencode/dbhub/dbhub-analytics.toml',
    );
    expect(draft.command).toEqual([
      'npx', '-y', '@bytebase/dbhub',
      '--config', '/p/.opencode/dbhub/dbhub-analytics.toml',
      '--transport', 'stdio',
    ]);
    expect(draft.environment.some((e) => e.key === 'npm_config_registry')).toBe(false);
    expect(Object.fromEntries(draft.environment.map((e) => [e.key, e.value])).OPENCHAMBER_DB_READONLY).toBe('0');
  });

  test('writes the read-only switch into [[tools]] config', () => {
    const ro = buildDbhubToml({ ...fields(), alias: 'orders', readonly: true, dbhubVersion: 'latest' });
    expect(ro).toContain('[[sources]]');
    expect(ro).toContain(`dsn = ${JSON.stringify(buildDbDsn(fields()))}`);
    expect(ro).toContain('name = "execute_sql"');
    expect(ro).toContain('readonly = true');

    const rw = buildDbhubToml({ ...fields(), alias: 'orders', readonly: false, dbhubVersion: 'latest' });
    expect(rw).toContain('readonly = false');
    expect(bindingConfigRelativePathOf('Orders DB')).toBe('.opencode/dbhub/dbhub-orders-db.toml');
  });

  const server = (command: string[], environment: Record<string, string> = {}): McpServerWithScope =>
    ({ name: 'dbhub-orders', type: 'local', command, environment, scope: 'project' }) as McpServerWithScope;

  test('recognizes dbhub entries by command', () => {
    expect(isDbhubServer(server(['npx', '-y', '@bytebase/dbhub'], { DSN: 'mysql://h/db' }))).toBe(true);
    expect(isDbhubServer(server(['npx', '-y', '@bytebase/dbhub']))).toBe(true);
    // A third-party server that happens to use a DSN env var is not ours.
    expect(isDbhubServer(server(['npx', '-y', 'other-server'], { DSN: 'mysql://h/db' }))).toBe(false);
    expect(isDbhubServer(server(['npx', '-y', 'other-server']))).toBe(false);
    expect(isDbhubServer(({ name: 'x', type: 'remote', url: 'https://x' }) as unknown as McpServerWithScope)).toBe(false);
  });

  test('reads a binding spec back with the password so saving does not wipe it', () => {
    const spec = readDbBindingSpec(server(
      ['npx', '-y', '@bytebase/dbhub@0.9.0', '--config', '/p/x.toml', '--transport', 'stdio'],
      { DSN: buildDbDsn(fields({ password: 'secret' })) },
    ));
    expect(spec).toMatchObject({
      alias: 'orders',
      engine: 'mysql',
      host: 'db-internal.local',
      port: '3306',
      database: 'orders',
      readonly: true,
      dbhubVersion: '0.9.0',
      password: 'secret',
    });
  });
});

describe('validation', () => {
  test('validates aliases', () => {
    expect(isValidBindingAlias('orders-db')).toBe(true);
    expect(isValidBindingAlias('Orders DB')).toBe(true);
    expect(isValidBindingAlias('a')).toBe(true);
    expect(isValidBindingAlias('-bad')).toBe(false);
    expect(isValidBindingAlias('bad-')).toBe(false);
    expect(isValidBindingAlias('')).toBe(false);
  });

  test('binding completeness requires alias, host, database', () => {
    expect(isBindingComplete({ ...fields(), alias: 'orders', readonly: true, dbhubVersion: 'latest' })).toBe(true);
    expect(isBindingComplete({ ...fields(), host: '', alias: 'orders', readonly: true, dbhubVersion: 'latest' })).toBe(false);
    expect(isBindingComplete({ ...fields(), database: '', alias: 'orders', readonly: true, dbhubVersion: 'latest' })).toBe(false);
    expect(isBindingComplete({ ...fields(), alias: 'bad!', readonly: true, dbhubVersion: 'latest' })).toBe(false);
  });

  test('bindingNameOf normalizes aliases', () => {
    expect(bindingNameOf('Orders DB')).toBe('dbhub-orders-db');
    expect(bindingNameOf('--weird--')).toBe('dbhub-weird');
    expect(bindingNameOf('')).toBe('dbhub-db');
  });

  test('bindingSlugOf accepts the alias or the full entry name', () => {
    expect(bindingSlugOf('orders-2')).toBe('orders-2');
    // Feeds the delete/rename cleanup path: the entry name must not be prefixed twice.
    expect(bindingSlugOf('dbhub-orders-2')).toBe('orders-2');
    expect(bindingSlugOf('dbhub-Orders DB')).toBe('orders-db');
    expect(bindingSlugOf('')).toBe('db');
  });

  test('suggestBindingAlias derives a free alias from the database name', () => {
    expect(suggestBindingAlias('orders_archive', [])).toBe('orders-archive');
    expect(suggestBindingAlias('Orders.DB', [])).toBe('orders-db');
    expect(suggestBindingAlias('', ['x'])).toBe('db');
    expect(suggestBindingAlias('orders', ['orders'])).toBe('orders-2');
    expect(suggestBindingAlias('orders', ['orders', 'orders-2'])).toBe('orders-3');
    expect(suggestBindingAlias('Orders', ['orders'])).toBe('orders-2');
  });

  test('summarizeDbhubError keeps the cause and drops stack frames', () => {    const denied = [
      'Configuration source: environment variable Connecting to 1 database source(s)...',
      '- default: mysql://app@db.local:3306/orders',
      'Failed to connect to MySQL database: Error: connect ECONNREFUSED 10.0.0.9:3306',
      '    at _MySQLConnector.connect (file:///tmp/dbhub/dist/mysql.js:201:38)',
      '    at async ConnectorManager.connectSource (file:///tmp/dbhub/dist/chunk.js:2324:7)',
      'Fatal error: Error: connect ECONNREFUSED 10.0.0.9:3306',
      '    at main (file:///tmp/dbhub/dist/index.js:1975:5)',
    ].join('\n');
    expect(summarizeDbhubError(denied)).toBe('connect ECONNREFUSED 10.0.0.9:3306');

    const sqlMessage = 'boom ... { code: \'ER_ACCESS_DENIED_ERROR\', sqlMessage: "Access denied for user \'app\'@\'10.1.1.1\'" }';
    expect(summarizeDbhubError(sqlMessage)).toBe("Access denied for user 'app'@'10.1.1.1'");

    expect(summarizeDbhubError('Connection test timed out')).toBe('Connection test timed out');
  });
});

describe('session binding choice', () => {
  const srv = (name: string, host: string) => ({
    name,
    type: 'local',
    scope: 'project',
    command: ['npx', '-y', '@bytebase/dbhub'],
    environment: { DSN: `mysql://u@${host}:3306/orders`, OPENCHAMBER_DB_READONLY: '1' },
  }) as unknown as McpServerWithScope;

  test('lists only dbhub entries and resolves primary/selection', () => {
    const all = [
      srv('dbhub-orders', 'db.a'),
      srv('dbhub-archive', 'db.b'),
      { name: 'x', type: 'remote', url: 'https://x' } as unknown as McpServerWithScope,
    ];
    const list = listDbBindings(all);
    expect(list.map((binding) => binding.entryName)).toEqual(['dbhub-orders', 'dbhub-archive']);
    expect(resolveEffectiveBinding(list, 'dbhub-archive', null)?.entryName).toBe('dbhub-archive');
    expect(resolveEffectiveBinding(list, 'dbhub-archive', 'dbhub-orders')?.entryName).toBe('dbhub-orders');
    // A stale primary or a stale selection falls back to the first binding.
    expect(resolveEffectiveBinding(list, 'dbhub-gone', null)?.entryName).toBe('dbhub-orders');
    expect(resolveEffectiveBinding(list, null, 'dbhub-gone')?.entryName).toBe('dbhub-orders');
    expect(resolveEffectiveBinding([], null, null)).toBeNull();
  });

  test('builds a prompt with name, target and mode only', () => {
    const list = listDbBindings([srv('dbhub-orders', 'db.a')]);
    const text = buildDbBindingPrompt(list[0]!);
    expect(text).toContain('dbhub-orders');
    expect(text).toContain('db.a:3306/orders');
    expect(text).toContain('只读');
    expect(text).toContain('dbhub-orders_execute_sql');
    expect(text).not.toContain('hunter2');
  });

  test('announces once per binding', () => {
    const bindings = listDbBindings([srv('dbhub-orders', 'db.a')]);
    const input = { bindings, primaryName: null, selectedEntry: null, announcedEntry: null };
    expect(dbBindingPromptFor(input)?.entryName).toBe('dbhub-orders');
    expect(dbBindingPromptFor({ ...input, announcedEntry: 'dbhub-orders' })).toBeNull();
    expect(dbBindingPromptFor({ ...input, bindings: [] })).toBeNull();
  });
});
