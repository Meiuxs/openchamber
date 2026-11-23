import { describe, expect, it } from 'vitest';

import { buildRateGatePluginSource } from './plugin-source.js';
import { createRateGateRuntime } from './runtime.js';

const runtimeDeps = (overrides = {}) => ({
  instanceDir: '/tmp/rate-gate-test',
  fs: { mkdir: async () => {}, writeFile: async () => {} },
  path: { join: (...parts) => parts.join('/') },
  readSettings: async () => ({}),
  readPolicy: () => ({ requests: 100, windowMinutes: 10, gateways: ['http://gw.corp'] }),
  resolveAccount: async () => ({ key: 'credential:a', label: 'me' }),
  resolveProviderBaseUrl: () => 'http://gw.corp/v1',
  authorizeRequest: () => true,
  isPluginSupported: async () => true,
  now: () => 1_000_000,
  ...overrides,
});

describe('rate gate plugin source', () => {
  it('registers the three hooks and never embeds a token', () => {
    const source = buildRateGatePluginSource();
    expect(source).toContain('hook("model.request"');
    expect(source).toContain('hook("http.response"');
    expect(source).toContain('hook("retry"');
    expect(source).toContain('OPENCHAMBER_AGENT_TOOL_URL');
    expect(source).not.toContain('OPENCHAMBER_AGENT_TOOL_TOKEN =');
  });

  it('waits between acquire attempts and reports the remembered account key', () => {
    const source = buildRateGatePluginSource();
    expect(source).toContain('retryAt');
    expect(source).toContain('accountKey');
    expect(source).toContain('gateOffUntil');
  });

  it('reports the request URL so the server can ignore an ungated provider', () => {
    expect(buildRateGatePluginSource()).toContain('url: event.baseURL');
  });

  it('stops waiting after a bounded time so a cancelled turn stops asking', () => {
    // The loop is not tied to the turn's lifetime, so it has to end on its own.
    expect(buildRateGatePluginSource()).toContain('MAX_WAIT_MS');
  });

  it('forwards the raw rate limit headers so one parser owns the units', () => {
    // The server already understands epoch, duration and suffixed header names;
    // converting in the plugin created a second, weaker parser.
    const source = buildRateGatePluginSource();
    expect(source).toContain('rateLimitHeaders(headers)');
    expect(source).toContain('headers.entries()');
    expect(source).toContain('retry-after');
    expect(source).not.toContain('resetAtFrom');
  });
});

describe('plugin materialization', () => {
  it('writes package.json and index.js into the plugin directory', async () => {
    const files = new Map();
    const runtime = createRateGateRuntime(runtimeDeps({
      fs: {
        mkdir: async () => {},
        writeFile: async (path, data) => { files.set(path, data); },
      },
    }));
    await expect(runtime.materializePlugin()).resolves.toBe('/tmp/rate-gate-test/openchamber-rate-gate');
    expect(JSON.parse(files.get('/tmp/rate-gate-test/openchamber-rate-gate/package.json'))).toMatchObject({
      name: 'openchamber-rate-gate',
      type: 'module',
    });
    expect(files.get('/tmp/rate-gate-test/openchamber-rate-gate/index.js')).toContain('model.request');
  });
});
