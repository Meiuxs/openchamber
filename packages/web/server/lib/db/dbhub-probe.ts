import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { findWindowsCommandInterpreter, findWindowsPackageManagerShim } from '../package-manager-probe.js';
import { readNpmRegistry } from '../enterprise-mode.js';

/** Body of POST /api/db/test: the exact TOML the binding would save. */
export interface DbProbeFields {
  toml?: unknown;
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
const MAX_TOML_BYTES = 8 * 1024;
const MAX_STDOUT_BYTES = 256 * 1024;

const VERSION_PATTERN = /^(?:latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * Boot a one-shot dbhub stdio process against the candidate TOML and run the
 * MCP initialize + tools/list handshake. Nothing is persisted: the TOML goes to
 * a temp directory that is removed on every exit path, and the process is
 * killed as soon as the handshake answers or the timeout fires.
 *
 * The probe deliberately loads the same `--config` file the saved entry will
 * use, so a config shape dbhub no longer accepts fails here instead of only
 * failing after the binding is saved.
 */
export const probeDbhubConnection = async (body: DbProbeFields): Promise<DbProbeResult> => {
  const toml = typeof body.toml === 'string' ? body.toml : '';
  if (!toml.trim()) return { ok: false, error: 'A dbhub.toml payload is required' };
  if (Buffer.byteLength(toml, 'utf8') > MAX_TOML_BYTES) return { ok: false, error: 'dbhub.toml payload is too large' };

  const requestedVersion = typeof body.dbhubVersion === 'string' ? body.dbhubVersion.trim() : '';
  const version = requestedVersion === '' ? 'latest' : requestedVersion;
  if (!VERSION_PATTERN.test(version)) {
    return { ok: false, error: `Invalid dbhub version "${version}". Use a version like 2.1.0 or latest.` };
  }
  const packageSpec = version === 'latest' ? '@bytebase/dbhub' : `@bytebase/dbhub@${version}`;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'openchamber-dbhub-'));
  const configPath = path.join(tempDir, 'dbhub.toml');
  await writeFile(configPath, toml, 'utf8');

  const args = ['-y', packageSpec, '--config', configPath, '--transport', 'stdio'];
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  const registry = readNpmRegistry();
  if (registry) env.npm_config_registry = registry;

  return await new Promise<DbProbeResult>((resolve) => {
    const launch = spawnProbe(args, env);
    if ('error' in launch) {
      void rm(tempDir, { recursive: true, force: true });
      resolve({ ok: false, error: launch.error });
      return;
    }
    const child = launch.child;

    let settled = false;
    let buffer = '';
    let stderrTail = '';
    let nextId = 1;
    const pending = new Map<number, (response: JsonRpcResponse) => void>();

    const finish = (result: DbProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      void rm(tempDir, { recursive: true, force: true });
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
      if (settled) return;
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_STDOUT_BYTES) {
        finish({ ok: false, error: 'dbhub produced too much output during the handshake' });
        return;
      }
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
      try {
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
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
};

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: { serverInfo?: { name?: string; version?: string } };
  error?: { message?: string };
}

/**
 * Node cannot execute the `npx` `.cmd` shim directly on Windows, so go through
 * cmd.exe there. Bun resolves shims itself, but the shipped server runs on Node.
 *
 * The shim usually lives under a path with spaces ("D:\Program Files\nodejs"),
 * which cmd.exe splits unless every argument is quoted and the whole command
 * line is handed over verbatim between the quotes `/s /c` strips.
 */
const spawnProbe = (args: string[], env: Record<string, string>) => {
  if (process.platform === 'win32') {
    const shim = findWindowsPackageManagerShim('npx') ?? findWindowsPackageManagerShim('npm');
    const interpreter = findWindowsCommandInterpreter();
    if (!shim || !interpreter) {
      return { error: 'Could not locate npx on PATH. Install Node.js or add its directory to PATH.' };
    }
    const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
    const line = [quote(shim), ...args.map(quote)].join(' ');
    return {
      child: spawn(interpreter, ['/d', '/s', '/c', `"${line}"`], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'] as const,
        windowsHide: true,
        windowsVerbatimArguments: true,
      }),
    };
  }
  return {
    child: spawn('npx', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'] as const,
      windowsHide: true,
    }),
  };
};

/** npm shims spawn a grandchild; kill the whole tree so no dbhub outlives the probe. */
const killTree = (child: ReturnType<typeof spawn>): void => {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
    } catch {
      // fall through to the direct kill
    }
  }
  try {
    child.kill();
  } catch {
    // already gone
  }
};
