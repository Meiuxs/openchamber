import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createRateGateRuntime, WAIT_STAGGER_MS } from './runtime.js';

const DEFAULT_CONFIG = { requests: 3, windowMinutes: 10, gateways: ['http://gw.corp'] };

const makeDeps = (config = DEFAULT_CONFIG, overrides = {}) => {
  let now = 1_000_000;
  const deps = {
    instanceDir: '/tmp/rate-gate-test',
    fs: { mkdir: async () => {}, writeFile: async () => {} },
    path: { join: (...parts) => parts.join('/') },
    readSettings: async () => ({}),
    readPolicy: () => config,
    resolveAccount: async () => ({ key: 'credential:a', label: 'me' }),
    resolveProviderBaseUrl: () => 'http://gw.corp/v1',
    authorizeRequest: () => true,
    isPluginSupported: async () => true,
    now: () => now,
    ...overrides,
  };
  return { deps, advance: (ms) => { now += ms; }, at: () => now };
};

const setup = async (config = DEFAULT_CONFIG, overrides = {}) => {
  const { deps, advance, at } = makeDeps(config, overrides);
  return { runtime: createRateGateRuntime(deps), deps, advance, at };
};

const acquireBody = (overrides = {}) => ({
  providerID: 'intranet',
  modelID: 'm',
  kind: 'primary',
  url: 'http://gw.corp/v1/chat',
  sessionID: 's1',
  ...overrides,
});

describe('rate gate window', () => {
  it('grants exactly requests slots and then answers wait at the oldest expiry', async () => {
    const { runtime, advance } = await setup();
    for (let index = 0; index < 3; index += 1) {
      expect(await runtime.acquire(acquireBody())).toMatchObject({ action: 'pass', gated: true, accountKey: 'credential:a' });
      advance(1_000);
    }
    const answer = await runtime.acquire(acquireBody());
    expect(answer).toMatchObject({ action: 'wait', gated: true, accountKey: 'credential:a' });
    expect(answer.retryAt).toBe(1_000_000 + 600_000);
    advance(600_000);
    expect((await runtime.acquire(acquireBody())).action).toBe('pass');
  });

  it('lets an authoritative remaining tighten the local count', async () => {
    // A real epoch clock: `resetAt` in epoch seconds only converts correctly
    // when the value it is compared against is of the same order.
    const resetAt = Date.now() + 60_000;
    const { runtime } = await setup(
      { requests: 100, windowMinutes: 10, gateways: ['http://gw.corp'] },
      { now: () => Date.now() },
    );
    await runtime.report({
      providerID: 'intranet',
      sessionID: 's1',
      accountKey: 'credential:a',
      status: 200,
      remaining: 0,
      resetAt,
    });
    const answer = await runtime.acquire(acquireBody());
    expect(answer.action).toBe('wait');
    expect(answer.retryAt).toBe(resetAt);
  });

  it('cools the account on 429, using the reported account key', async () => {
    const { runtime, at } = await setup({ requests: 100, windowMinutes: 10, gateways: ['http://gw.corp'] });
    await runtime.report({ providerID: 'intranet', sessionID: 's1', accountKey: 'credential:a', status: 429, retryAfterMs: 120_000 });
    const answer = await runtime.acquire(acquireBody());
    expect(answer.retryAt).toBe(at() + 120_000);
  });

  it('resolves the account when a 429 arrives without a remembered key', async () => {
    const { runtime, at } = await setup({ requests: 100, windowMinutes: 10, gateways: ['http://gw.corp'] });
    await runtime.report({ providerID: 'intranet', sessionID: 's1', status: 429, retryAfterMs: 90_000 });
    const answer = await runtime.acquire(acquireBody());
    expect(answer.retryAt).toBe(at() + 90_000);
  });

  it('keeps a waiting session visible past the plugin longest sleep', async () => {
    const { runtime, advance } = await setup({ requests: 1, windowMinutes: 10, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await runtime.acquire(acquireBody());
    expect((await runtime.status()).accounts[0].waiting).toEqual([{ sessionId: 's1', until: 1_090_000 }]);
    // The plugin sleeps up to 60 s before asking again; the row has to survive it.
    advance(60_000);
    expect((await runtime.status()).accounts[0].waiting).toEqual([{ sessionId: 's1', until: 1_090_000 }]);
    advance(31_000);
    expect((await runtime.status()).accounts[0].waiting).toEqual([]);
  });

  it('passes a URL outside the gateways without creating an account', async () => {
    const { runtime } = await setup();
    expect(await runtime.acquire(acquireBody({ providerID: 'openai', url: 'https://api.openai.com/v1' })))
      .toEqual({ action: 'pass', gated: false });
    expect((await runtime.status()).accounts).toEqual([]);
  });

  it('ignores a report from a URL outside the gateways', async () => {
    // The response of an ungated provider is not this gate's business, so it
    // must not create an account row or tighten a budget.
    const { runtime } = await setup();
    await runtime.report({
      providerID: 'openai',
      sessionID: 's1',
      url: 'https://api.openai.com/v1/chat/completions',
      status: 200,
      headers: { 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '60' },
    });
    expect((await runtime.status()).accounts).toEqual([]);
  });

  it('ignores a report it cannot attribute to a URL', async () => {
    const { runtime } = await setup(DEFAULT_CONFIG, { resolveProviderBaseUrl: () => null });
    await runtime.report({ providerID: 'intranet', sessionID: 's1', status: 200, remaining: 5, resetAt: '600s' });
    expect((await runtime.status()).accounts).toEqual([]);
  });

  it('stops applying reports to a gateway the configuration no longer lists', async () => {
    // Removing a gateway mid-session must also stop the responses a plugin
    // still holds an account key for from spending that account's budget.
    let config = DEFAULT_CONFIG;
    const { runtime } = await setup(DEFAULT_CONFIG, { readPolicy: () => config });
    await runtime.acquire(acquireBody());
    config = { ...DEFAULT_CONFIG, gateways: ['http://other.corp'] };
    await runtime.report({
      providerID: 'intranet',
      sessionID: 's1',
      accountKey: 'credential:a',
      url: 'http://gw.corp/v1/chat',
      status: 200,
      remaining: 5,
      resetAt: '600s',
    });
    await expect(runtime.status()).resolves.toMatchObject({
      accounts: [{ key: 'credential:a', authoritative: false, remaining: 2 }],
    });
  });

  it('keeps working when account resolution throws', async () => {
    const { runtime } = await setup(DEFAULT_CONFIG, {
      resolveAccount: async () => { throw new Error('credential store offline'); },
    });
    await expect(runtime.acquire(acquireBody()))
      .resolves.toMatchObject({ action: 'pass', gated: true, accountKey: 'provider:intranet' });
  });

  it('reports enabled with configured caps', async () => {
    const { runtime } = await setup({ requests: 100, windowMinutes: 10, gateways: ['http://gw.corp'] });
    await expect(runtime.status()).resolves.toMatchObject({
      enabled: true,
      requests: 100,
      windowMinutes: 10,
      caps: { requests: 100, windowMinutes: 10 },
    });
  });

  it('reports disabled when the host cannot load the plugin', async () => {
    // Nothing throttles in this runtime, so the panel must not claim it does.
    const { runtime } = await setup(DEFAULT_CONFIG, { isPluginSupported: async () => false });
    await expect(runtime.status()).resolves.toMatchObject({ enabled: false });
  });
});

describe('rate gate routes', () => {
  const mount = async (authorizeRequest) => {
    const app = express();
    app.use(express.json());
    const { runtime } = await setup(DEFAULT_CONFIG, { authorizeRequest });
    runtime.registerRoutes(app, express);
    // The app's own auth, which the status route answers under.
    runtime.registerStatusRoute(app, (req, res, next) => (
      req.headers.authorization === 'Bearer session' ? next() : res.status(401).json({ error: 'Unauthorized' })
    ));
    return app;
  };

  it('rejects unauthorized writes before touching state', async () => {
    await request(await mount(() => false))
      .post('/api/rate-gate/acquire')
      .send(acquireBody())
      .expect(401);
  });

  it('rejects a body without a session id', async () => {
    await request(await mount(() => true))
      .post('/api/rate-gate/acquire')
      .send({ providerID: 'intranet', modelID: 'm', kind: 'primary' })
      .expect(400);
  });

  it('answers the status route under the app session, not the plugin token', async () => {
    // The plugin token must not reach it, because a browser never holds one.
    const pluginOnly = await mount(() => true);
    await request(pluginOnly).get('/api/rate-gate/status').set('authorization', 'Bearer plugin').expect(401);

    const app = await mount(() => false);
    await request(app).get('/api/rate-gate/status').set('authorization', 'Bearer session').expect(200);
    const response = await request(app).get('/api/rate-gate/status').set('authorization', 'Bearer session');
    expect(response.body).toMatchObject({ enabled: true, accounts: [] });
  });

  it('keeps the budget writable only with the plugin token', async () => {
    // A session may read the status but cannot spend from the budget.
    const app = await mount(() => false);
    await request(app)
      .post('/api/rate-gate/acquire')
      .set('authorization', 'Bearer session')
      .send(acquireBody())
      .expect(401);
  });
});

describe('gateway reported quota is spent by grants', () => {
  it('stops admitting once the reported remainder is used up', async () => {
    // A gateway that answers "3 left" must not keep admitting until the reset.
    const { runtime } = await setup({ requests: 100, windowMinutes: 10, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await runtime.report({ providerID: 'intranet', sessionID: 's1', status: 200, remaining: 3, resetAt: 1_000_000 + 600_000 });

    const answers = [];
    for (let index = 0; index < 6; index += 1) answers.push((await runtime.acquire(acquireBody({ sessionID: `s${index}` }))).action);
    expect(answers).toEqual(['pass', 'pass', 'pass', 'wait', 'wait', 'wait']);
    await expect(runtime.status()).resolves.toMatchObject({ accounts: [{ remaining: 0, authoritative: true }] });
  });

  it('calibrates from the raw OpenAI-style headers a gateway sends', async () => {
    const { runtime } = await setup({ requests: 100, windowMinutes: 10, gateways: ['http://gw.corp'] });
    await runtime.report({
      providerID: 'intranet',
      sessionID: 's1',
      accountKey: 'credential:a',
      status: 200,
      headers: {
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-remaining-tokens': '9000',
        'x-ratelimit-reset-requests': '1s',
        'x-ratelimit-reset-tokens': '30s',
      },
    });
    const answer = await runtime.acquire(acquireBody());
    expect(answer).toMatchObject({ action: 'wait', retryAt: 1_001_000 });
  });

  it('normalises an epoch-seconds reset an older plugin forwards raw', async () => {
    const { runtime } = await setup({ requests: 100, windowMinutes: 10, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    const resetSeconds = Math.floor((1_000_000 + 300_000) / 1000);
    await runtime.report({ providerID: 'intranet', sessionID: 's1', status: 200, remaining: 0, resetAt: resetSeconds });
    await expect(runtime.status()).resolves.toMatchObject({ accounts: [{ authoritative: true, remaining: 0 }] });
  });

  it('attributes a report from a forgotten account key to the current account', async () => {
    // A credential switch leaves the plugin holding the previous key. Creating
    // an account for it shows a row that never receives a grant again.
    const { runtime } = await setup({ requests: 100, windowMinutes: 10, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await runtime.report({
      providerID: 'intranet',
      sessionID: 's1',
      accountKey: 'credential:old',
      status: 200,
      remaining: 5,
      resetAt: '600s',
    });
    const { accounts } = await runtime.status();
    expect(accounts.map((account) => account.key)).toEqual(['credential:a']);
    expect(accounts[0]).toMatchObject({ authoritative: true, remaining: 5 });
  });
});

describe('gateway recovery time on 429', () => {
  it('uses the gateway retry time instead of stretching it to the local window end', async () => {
    const { runtime, advance } = await setup({ requests: 2, windowMinutes: 10, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    advance(1_000);
    await runtime.report({ providerID: 'intranet', sessionID: 's1', accountKey: 'credential:a', status: 429, retryAfterMs: 2_000 });
    // The local window would stay closed until 1_600_000; the gateway asked for 2 s.
    expect(await runtime.acquire(acquireBody())).toMatchObject({ action: 'wait', retryAt: 1_003_000 });
  });

  it('uses the reported reset header as the recovery time', async () => {
    const { runtime } = await setup({ requests: 2, windowMinutes: 10, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await runtime.report({
      providerID: 'intranet',
      sessionID: 's1',
      accountKey: 'credential:a',
      status: 429,
      headers: { 'retry-after': '3' },
    });
    expect(await runtime.acquire(acquireBody())).toMatchObject({ action: 'wait', retryAt: 1_003_000 });
  });

  it('falls back to the local window end when the gateway names no time', async () => {
    const { runtime } = await setup({ requests: 2, windowMinutes: 10, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await runtime.report({ providerID: 'intranet', sessionID: 's1', accountKey: 'credential:a', status: 429 });
    expect(await runtime.acquire(acquireBody())).toMatchObject({ action: 'wait', retryAt: 1_600_000 });
  });

  it('lets the gateway retry time reopen an account an earlier report had closed', async () => {
    // A "0 left" report used to outvote the gateway's own retry time, so a two
    // second 429 still froze the account until the reset header.
    const { runtime, advance } = await setup({ requests: 2, windowMinutes: 10, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await runtime.report({ providerID: 'intranet', sessionID: 's1', status: 200, remaining: 0, resetAt: '600s' });
    expect((await runtime.acquire(acquireBody({ sessionID: 's2' }))).action).toBe('wait');
    await runtime.report({ providerID: 'intranet', sessionID: 's1', status: 429, retryAfterMs: 2_000 });
    advance(3_000);
    expect((await runtime.acquire(acquireBody({ sessionID: 's3' }))).action).toBe('pass');
  });

  it('still cools for a moment when a 429 arrives with nothing spent in the window', async () => {
    const { runtime } = await setup({ requests: 2, windowMinutes: 10, gateways: ['http://gw.corp'] });
    await runtime.report({ providerID: 'intranet', sessionID: 's1', accountKey: 'credential:a', status: 429 });
    await expect(runtime.status()).resolves.toMatchObject({ accounts: [{ limitedUntil: 1_001_000 }] });
  });
});

describe('waiting order', () => {
  it('staggers queued sessions so the first waiter wakes first and keeps its place', async () => {
    const { runtime } = await setup({ requests: 1, windowMinutes: 10, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody({ sessionID: 's1' }));
    const first = await runtime.acquire(acquireBody({ sessionID: 's2' }));
    const second = await runtime.acquire(acquireBody({ sessionID: 's3' }));
    expect(second.retryAt - first.retryAt).toBe(WAIT_STAGGER_MS);
    const again = await runtime.acquire(acquireBody({ sessionID: 's2' }));
    expect(again.retryAt).toBe(first.retryAt);
  });
});

describe('diagnostic log', () => {
  it('reports grants, waits and calibrations', async () => {
    const events = [];
    const { runtime } = await setup(
      { requests: 1, windowMinutes: 10, gateways: ['http://gw.corp'] },
      { log: (details) => events.push(details) },
    );
    await runtime.acquire(acquireBody());
    await runtime.acquire(acquireBody({ sessionID: 's2' }));
    await runtime.report({ providerID: 'intranet', sessionID: 's2', accountKey: 'credential:a', status: 200, remaining: 0, resetAt: 1_600_000_000_000 });
    expect(events.map((event) => event.event)).toEqual(['grant', 'wait', 'report']);
    expect(events[1]).toMatchObject({ sessionID: 's2', granted: 1, limit: 1, queuePosition: 0, waiters: 1 });
    expect(events[2]).toMatchObject({ status: 200, remaining: 0, resetAt: 1_600_000_000_000 });
  });
});

describe('rate gate broadcast', () => {
  // The announcement is computed after the answer is returned, so a test has to
  // let that microtask run before it reads what was sent.
  const settle = async () => {
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
  };

  it('announces a granted request and a waiting one', async () => {
    const sent = [];
    const { runtime, advance } = await setup(
      { requests: 1, windowMinutes: 10, gateways: ['http://gw.corp'] },
      { broadcast: (status) => sent.push(status) },
    );

    await runtime.acquire(acquireBody());
    await settle();
    expect(sent.at(-1)).toMatchObject({ enabled: true, requests: 1 });
    expect(sent.at(-1).accounts[0]).toMatchObject({ used: 1, remaining: 0, waiting: [] });

    advance(1_000);
    await runtime.acquire(acquireBody({ sessionID: 's2' }));
    await settle();
    expect(sent.at(-1).accounts[0].waiting).toEqual([
      { sessionId: 's2', until: 1_091_000 },
    ]);
  });

  it('throttles bursts to one announcement a second', async () => {
    const sent = [];
    const { runtime, advance, at } = await setup(
      { requests: 100, windowMinutes: 10, gateways: ['http://gw.corp'] },
      { broadcast: (status) => sent.push(status) },
    );

    for (let index = 0; index < 5; index += 1) await runtime.acquire(acquireBody());
    await settle();
    // Five grants in the same instant, one announcement.
    expect(sent.length).toBe(1);
    advance(1_000);
    await runtime.acquire(acquireBody());
    await settle();
    expect(sent.length).toBe(2);
  });
});

describe('plugin support gate', () => {
  it('reports enabled only while the host says the plugin can load', async () => {
    const { runtime: supported } = await setup(DEFAULT_CONFIG, { isPluginSupported: async () => true });
    await expect(supported.isEnabled()).resolves.toBe(true);

    const { runtime: unsupported } = await setup(DEFAULT_CONFIG, { isPluginSupported: async () => false });
    await expect(unsupported.isEnabled()).resolves.toBe(false);
  });

  it('stays disabled without a gateway, whatever the host supports', async () => {
    const { runtime } = await setup({ requests: 10, windowMinutes: 10, gateways: [] }, { isPluginSupported: async () => true });
    await expect(runtime.isEnabled()).resolves.toBe(false);
  });

  it('treats a failing support probe as unsupported', async () => {
    const { runtime } = await setup(DEFAULT_CONFIG, {
      isPluginSupported: async () => { throw new Error('version probe failed'); },
    });
    await expect(runtime.isEnabled()).resolves.toBe(false);
  });
});

describe('the usage a panel reads', () => {
  it('counts what this app spent, with the gateway total when one is reported', async () => {
    const { runtime } = await setup({ requests: 100, windowMinutes: 10, gateways: ['http://gw.corp'] });
    await runtime.report({ providerID: 'intranet', sessionID: 's1', status: 200, remaining: 2, resetAt: 1_000_000 + 60_000 });
    await runtime.acquire(acquireBody());
    // One slot spent here, one left, so the gateway's window holds two.
    await expect(runtime.status()).resolves.toMatchObject({ accounts: [{ used: 1, limit: 2, remaining: 1 }] });
  });

  it('uses the configured limit when the gateway has not reported', async () => {
    const { runtime } = await setup({ requests: 100, windowMinutes: 10, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await runtime.acquire(acquireBody({ sessionID: 's2' }));
    await expect(runtime.status()).resolves.toMatchObject({ accounts: [{ used: 2, limit: 100, remaining: 98 }] });
  });

  it('counts what was admitted, not a forced zero, while the account is cooling', async () => {
    const { runtime } = await setup({ requests: 100, windowMinutes: 1, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await runtime.report({ providerID: 'intranet', sessionID: 's1', accountKey: 'credential:a', status: 429 });
    await expect(runtime.status()).resolves.toMatchObject({ accounts: [{ used: 1, limit: 100, remaining: 0 }] });
  });
});

describe('backoff on repeated 429 without a gateway time', () => {
  const cool = (runtime, sessionID = 's1') => runtime.report({
    providerID: 'intranet', sessionID, accountKey: 'credential:a', status: 429,
  });

  it('doubles the cooldown for each 429 after the previous one expired', async () => {
    const { runtime, advance, at } = await setup({ requests: 100, windowMinutes: 1, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await cool(runtime);
    expect((await runtime.status()).accounts[0].limitedUntil).toBe(at() + 60_000);
    advance(60_000);
    await runtime.acquire(acquireBody({ sessionID: 's2' }));
    await cool(runtime, 's2');
    expect((await runtime.status()).accounts[0].limitedUntil).toBe(at() + 120_000);
  });

  it('does not escalate for the retries of one 429', async () => {
    const { runtime, at } = await setup({ requests: 100, windowMinutes: 1, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await cool(runtime);
    await cool(runtime);
    await cool(runtime);
    expect((await runtime.status()).accounts[0].limitedUntil).toBe(at() + 60_000);
  });

  it('starts over after a success', async () => {
    const { runtime, advance, at } = await setup({ requests: 100, windowMinutes: 1, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await cool(runtime);
    advance(60_000);
    await runtime.acquire(acquireBody({ sessionID: 's2' }));
    await cool(runtime, 's2');
    advance(120_000);
    await runtime.acquire(acquireBody({ sessionID: 's3' }));
    await runtime.report({ providerID: 'intranet', sessionID: 's3', accountKey: 'credential:a', status: 200 });
    await cool(runtime, 's3');
    expect((await runtime.status()).accounts[0].limitedUntil).toBe(at() + 60_000);
  });

  it('keeps the whole backoff even when the local window ends sooner', async () => {
    const { runtime, advance } = await setup({ requests: 100, windowMinutes: 1, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await cool(runtime);
    advance(60_000);
    await runtime.acquire(acquireBody({ sessionID: 's2' }));
    await cool(runtime, 's2');
    const limitedUntil = (await runtime.status()).accounts[0].limitedUntil;
    expect(limitedUntil).toBe(1_000_000 + 60_000 + 120_000);
    expect((await runtime.acquire(acquireBody({ sessionID: 's3' }))).retryAt).toBe(limitedUntil);
  });

  it('honours a gateway retry time instead of escalating', async () => {
    const { runtime, advance, at } = await setup({ requests: 100, windowMinutes: 1, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await runtime.report({ providerID: 'intranet', sessionID: 's1', accountKey: 'credential:a', status: 429, retryAfterMs: 2_000 });
    advance(2_000);
    await runtime.acquire(acquireBody({ sessionID: 's2' }));
    await runtime.report({ providerID: 'intranet', sessionID: 's2', accountKey: 'credential:a', status: 429, retryAfterMs: 2_000 });
    expect((await runtime.status()).accounts[0].limitedUntil).toBe(at() + 2_000);
  });

  it('keeps the end of a cooldown when a duplicate 429 arrives later in it', async () => {
    const { runtime, advance, at } = await setup({ requests: 100, windowMinutes: 1, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await cool(runtime);
    const until = at() + 60_000;
    advance(30_000);
    await cool(runtime);
    expect((await runtime.status()).accounts[0].limitedUntil).toBe(until);
  });

  it('does not shorten a gateway cooldown with a headerless duplicate', async () => {
    const { runtime, at } = await setup({ requests: 100, windowMinutes: 1, gateways: ['http://gw.corp'] });
    await runtime.report({ providerID: 'intranet', sessionID: 's1', accountKey: 'credential:a', status: 429, retryAfterMs: 120_000 });
    await cool(runtime);
    expect((await runtime.status()).accounts[0].limitedUntil).toBe(at() + 120_000);
  });

  it('does not collapse a backoff once the window has rolled during it', async () => {
    const { runtime, advance, at } = await setup({ requests: 100, windowMinutes: 1, gateways: ['http://gw.corp'] });
    await runtime.acquire(acquireBody());
    await cool(runtime);
    advance(60_000);
    await runtime.acquire(acquireBody({ sessionID: 's2' }));
    await cool(runtime, 's2');
    const until = at() + 120_000;
    advance(60_000);
    await cool(runtime, 's2');
    expect((await runtime.status()).accounts[0].limitedUntil).toBe(until);
  });
});
