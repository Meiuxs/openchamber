import { spawn } from 'node:child_process';

import { readNpmRegistry } from '../enterprise-mode.js';

/** Connection fields the /api/db/test endpoint accepts (mirrors the UI form). */
export interface DbProbeFields {
  engine?: unknown;
  host?: unknown;
  port?: unknown;
  database?: unknown;
  username?: unknown;
  password?: unknown;
  sslMode?: unknown;
  dbhubVersion?: unknown;
}

export interface DbProbeOk {
  ok: true;
  detail: string;
}

export interface DbProbeError {
  ok: false;
  error: string;
}

export type DbProbeResult = DbProbeOk | DbProbeError;

const PROBE_TIMEOUT_MS = 45_000;

const isString = (value: unknown): value is string => typeof value === 'string';

interface DsnFields {
  engine: 'mysql' | 'postgresql';
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  sslMode: '' | 'disable' | 'require';
}

const buildDsn = (fields: DsnFields): string => {
  const auth = fields.username
    ? `${encodeURIComponent(fields.username)}${fields.password ? `:${encodeURIComponent(fields.password)}` : ''}@`
    : '';
  const port = fields.port.trim() ? `:${fields.port.trim()}` : '';
  const ssl = fields.sslMode ? `?sslmode=${fields.sslMode}` : '';
  return `${fields.engine}://${auth}${fields.host.trim()}${port}/${encodeURIComponent(fields.database.trim())}${ssl}`;
};

const readFields = (body: DbProbeFields): DbProbeOkFields | DbProbeError => {
  const engine = body.engine === 'mysql' || body.engine === 'postgresql' ? body.engine : null;
  const host = isString(body.host) ? body.host.trim() : '';
  const database = isString(body.database) ? body.database.trim() : '';
  if (!engine) return { ok: false, error: 'engine must be mysql or postgresql' };
  if (!host) return { ok: false, error: 'host is required' };
  if (!database) return { ok: false, error: 'database is required' };
  const sslMode = body.sslMode === 'disable' || body.sslMode === 'require' ? body.sslMode : '';
  return {
    ok: true,
    engine,
    host,
    port: isString(body.port) ? body.port.trim() : '',
    database,
    username: isString(body.username) ? body.username : '',
    password: isString(body.password) ? body.password : '',
    sslMode,
    dbhubVersion: isString(body.dbhubVersion) ? body.dbhubVersion.trim() : '',
  };
};

type DbProbeOkFields = {
  ok: true;
  engine: 'mysql' | 'postgresql';
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  sslMode: '' | 'disable' | 'require';
  dbhubVersion: string;
};

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: { serverInfo?: { name?: string; version?: string } };
  error?: { message?: string };
}

/**
 * Boot a one-shot dbhub stdio process against the candidate DSN and run the
 * MCP initialize + tools/list handshake. Nothing is written to disk; the
 * process is killed as soon as the handshake answers or the timeout fires.
 */
export const probeDbhubConnection = async (body: DbProbeFields): Promise<DbProbeResult> => {
  const fields = readFields(body);
  if (!fields.ok) return fields;

  const versionTag = fields.dbhubVersion && fields.dbhubVersion !== 'latest'
    ? `@bytebase/dbhub@${fields.dbhubVersion}`
    : '@bytebase/dbhub';
  const env: Record<string, string> = { ...process.env as Record<string, string>, DBHUB_DSN: buildDsn(fields) };
  const registry = readNpmRegistry();
  if (registry) env.npm_config_registry = registry;

  return await new Promise<DbProbeResult>((resolve) => {
    const child = spawn('npx', ['-y', versionTag, '--transport', 'stdio'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let settled = false;
    let buffer = '';
    let stderrTail = '';
    let nextId = 1;
    const pending = new Map<number, (response: JsonRpcResponse) => void>();

    const finish = (result: DbProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'Connection test timed out' });
    }, PROBE_TIMEOUT_MS);

    child.on('error', (error) => {
      finish({ ok: false, error: `Could not start npx: ${error.message}` });
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2000);
    });

    const send = (message: Record<string, unknown>) => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    };

    const request = (method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> => {
      const id = nextId++;
      return new Promise((answer) => {
        pending.set(id, answer);
        send({ jsonrpc: '2.0', id, method, params });
      });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        let parsed: JsonRpcResponse;
        try {
          parsed = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue;
        }
        if (typeof parsed.id === 'number' && pending.has(parsed.id)) {
          const answer = pending.get(parsed.id);
          if (answer) {
            pending.delete(parsed.id);
            answer(parsed);
          }
        }
      }
    });

    child.on('close', () => {
      finish({ ok: false, error: stderrTail.trim() || 'dbhub exited before answering' });
    });

    void (async () => {
      const initialized = await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'openchamber-db-test', version: '0.0.0' },
      });
      if (initialized.error) {
        finish({ ok: false, error: initialized.error.message ?? 'initialize failed' });
        return;
      }
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const tools = await request('tools/list', {});
      if (tools.error) {
        finish({ ok: false, error: tools.error.message ?? 'tools/list failed' });
        return;
      }
      const server = initialized.result?.serverInfo;
      const detail = server?.version ? `${server.name ?? 'dbhub'} ${server.version}` : (server?.name ?? 'dbhub');
      finish({ ok: true, detail });
    })();
  });
};
