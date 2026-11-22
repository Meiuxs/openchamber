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

  it('converts the gateway reset header to epoch milliseconds before reporting', () => {
    // A gateway answering in epoch seconds must not reach the state machine raw.
    const source = buildRateGatePluginSource();
    expect(source).toContain('resetAtFrom(headers)');
    expect(source).toContain('raw > 1e12');
    expect(source).toContain('raw * 1000');
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
