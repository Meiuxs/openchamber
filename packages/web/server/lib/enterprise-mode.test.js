import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  allowedInsecureGitOrigins,
  isCredentialListRequest,
  isEnterpriseMode,
  isNetworkAccessBlocked,
  isProviderConnectRequest,
  policyFilePaths,
  publicEnterprisePolicy,
  readEnterprisePolicy,
  readNpmRegistry,
  readPinnedModelsDevUrl,
  userPolicyFilePath,
  watchEnterprisePolicy,
} from './enterprise-mode.js';

const missing = () => {
  throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
};

/** A machine with `files` (path → content) and nothing else. */
const machine = (files, { platform = 'linux', env = {} } = {}) => ({
  platform,
  env,
  readFile: (filePath) => {
    if (!(filePath in files)) missing();
    const content = files[filePath];
    if (content instanceof Error) throw content;
    return content;
  },
});

const LINUX_POLICY = '/etc/openchamber/policy.json';

// The profile read resolves the data dir exactly like the server does; build
// the fake path with the same call so the test's file key matches on Windows.
const DATA_DIR = '/data';
const PREFERENCES_FILE = path.join(path.resolve(DATA_DIR), 'preferences.json');

describe('enterprise policy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a watch calls back once the policy in effect changes, and stays quiet while it does not', () => {
    vi.useFakeTimers();
    const policies = [{ enterpriseMode: false }, { enterpriseMode: false }, { enterpriseMode: true, allowedExtensions: [] }, { enterpriseMode: true, allowedExtensions: [] }];
    let reads = 0;
    const onChange = vi.fn();
    const stop = watchEnterprisePolicy({ onChange, intervalMs: 1000, read: () => policies[Math.min(reads++, policies.length - 1)] });
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(5000);
    expect(reads).toBe(6);
  });

  it('is off with no policy file and no environment variable', () => {
    expect(readEnterprisePolicy(machine({}))).toEqual({
      enterpriseMode: false,
      source: null,
      organization: null,
      policyError: null,
      relayUrl: null,
      jev: null,
      allowNetworkAccess: false,
      allowedExtensions: [],
      allowLocalExtensions: false,
      opencodeBinary: null,
      hideBuiltinSkillCatalogs: false,
      allowedInsecureGitOrigins: [],
      modelsDevUrl: null,
      npmRegistry: null,
      skillsCatalogSources: [],
    });
  });

  it('turns on from the environment variable alone', () => {
    const options = machine({}, { env: { OPENCHAMBER_ENTERPRISE_MODE: 'true' } });
    expect(isEnterpriseMode(options)).toBe(true);
    expect(readEnterprisePolicy(options).source).toBe('environment');
  });

  it('turns on from the policy file and carries its organization and pins', () => {
    const policy = readEnterprisePolicy(machine({
      [LINUX_POLICY]: JSON.stringify({
        enterpriseMode: true,
        organization: 'Acme',
        relayUrl: 'wss://relay.acme.test/ws',
        jev: { url: 'https://llm.acme.test/v1', model: 'acme-jev', apiKey: 'k' },
        allowedInsecureGitOrigins: ['http://gitlab.acme.test'],
      }),
    }));
    expect(policy).toEqual({
      enterpriseMode: true,
      source: 'policy-file',
      organization: 'Acme',
      policyError: null,
      relayUrl: 'wss://relay.acme.test/ws',
      jev: { url: 'https://llm.acme.test/v1', model: 'acme-jev', apiKey: 'k' },
      allowNetworkAccess: false,
      allowedExtensions: [],
      allowLocalExtensions: false,
      opencodeBinary: null,
      hideBuiltinSkillCatalogs: false,
      allowedInsecureGitOrigins: ['http://gitlab.acme.test'],
      modelsDevUrl: null,
      npmRegistry: null,
      skillsCatalogSources: [],
    });
  });

  it('supports single-line, multi-line comments and trailing commas in policy.json', () => {
    const content = `
      // 头部注释：企业策略配置
      {
        /* 模式控制 */
        "enterpriseMode": true,
        "organization": "Acme Corp", // 行尾注释
        // URL 中包含 // 不应被当成注释截断
        "npmRegistry": "http://nexus.corp.internal/repository/npm/",
        "allowedInsecureGitOrigins": [
          "http://gitlab.corp.internal:8080", // 列表项注释
        ],
      }
    `;
    const policy = readEnterprisePolicy(machine({
      [LINUX_POLICY]: content,
    }));
    expect(policy.enterpriseMode).toBe(true);
    expect(policy.organization).toBe('Acme Corp');
    expect(policy.npmRegistry).toBe('http://nexus.corp.internal/repository/npm/');
    expect(policy.allowedInsecureGitOrigins).toEqual(['http://gitlab.corp.internal:8080']);
  });

  it('validates scripts/delivery/policy.example.json as strict standard JSON with _comment* field descriptions and safe empty defaults', () => {
    const examplePath = path.resolve(import.meta.dirname, '../../../../scripts/delivery/policy.example.json');
    const rawText = fs.readFileSync(examplePath, 'utf8');
    // Must be valid strict JSON without requiring comment stripping
    const parsedJson = JSON.parse(rawText);
    expect(parsedJson._comment).toBeDefined();
    expect(parsedJson.enterpriseMode).toBe(true);

    const policy = readEnterprisePolicy(machine({ [LINUX_POLICY]: rawText }));
    expect(policy.policyError).toBeNull();
    expect(policy.enterpriseMode).toBe(true);
    expect(policy.organization).toBe('企业内网');
    expect(policy.modelsDevUrl).toBeNull();
    expect(policy.npmRegistry).toBeNull();
    expect(policy.relayUrl).toBeNull();
    expect(policy.jev).toBeNull();
    expect(policy.allowedInsecureGitOrigins).toEqual([]);
    expect(policy.allowedExtensions).toEqual([]);
    expect(policy.skillsCatalogSources).toEqual([]);
  });

  describe('pinned model catalog URL', () => {
    it('comes from the file with or without enterprise mode, trimmed', () => {
      expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"modelsDevUrl": " https://models.corp.test/api.json "}' })))
        .toMatchObject({ enterpriseMode: false, modelsDevUrl: 'https://models.corp.test/api.json' });
      expect(readPinnedModelsDevUrl(machine({ [LINUX_POLICY]: '{"enterpriseMode": true, "modelsDevUrl": "http://nginx.corp.test/models.json"}' })))
        .toBe('http://nginx.corp.test/models.json');
    });

    it('is never taken from the environment and is unset when blank', () => {
      expect(readPinnedModelsDevUrl(machine({}, { env: { OPENCHAMBER_ENTERPRISE_MODE: '1', OPENCHAMBER_MODELS_DEV_URL: 'https://x.test/a.json' } }))).toBeNull();
      expect(readPinnedModelsDevUrl(machine({ [LINUX_POLICY]: '{"modelsDevUrl": "  "}' }))).toBeNull();
    });

    it('treats a malformed or credentialed URL as unset', () => {
      for (const value of ['not a url', 'ftp://models.corp.test/a.json', 'https://user:pw@models.corp.test/a.json']) {
        expect(readPinnedModelsDevUrl(machine({ [LINUX_POLICY]: JSON.stringify({ modelsDevUrl: value }) })), value).toBeNull();
      }
    });

    it('pins nothing when the file is broken', () => {
      const options = machine({ [LINUX_POLICY]: '{"modelsDevUrl": 42}' });
      expect(readEnterprisePolicy(options).modelsDevUrl).toBeNull();
      expect(readPinnedModelsDevUrl(options)).toBeNull();
    });
  });

  describe('npm registry', () => {
    it('comes from the file first, with or without enterprise mode', () => {
      expect(readNpmRegistry(machine({ [LINUX_POLICY]: '{"npmRegistry": " https://npm.corp.test/registry "} ' })))
        .toBe('https://npm.corp.test/registry/');
      expect(readNpmRegistry(machine({ [LINUX_POLICY]: '{"enterpriseMode": true, "npmRegistry": "http://npm.corp.test:8080"}' })))
        .toBe('http://npm.corp.test:8080/');
    });

    it('fills the gap from the environment, but never while the file governs', () => {
      expect(readNpmRegistry(machine({}, { env: { OPENCHAMBER_NPM_REGISTRY: 'https://npm.corp.test' } }))).toBe('https://npm.corp.test/');
      expect(readNpmRegistry(machine({ [LINUX_POLICY]: '{"enterpriseMode": true}' }, { env: { OPENCHAMBER_NPM_REGISTRY: 'https://env-npm.corp.test' } }))).toBeNull();
    });

    it('reads the user setting while enterprise mode is off, and never while it is on', () => {
      const prefs = { [PREFERENCES_FILE]: JSON.stringify({ fields: { npmRegistry: { value: 'https://profile-npm.corp.test', updatedAt: 0 } } }) };
      expect(readNpmRegistry(machine(prefs, { env: { OPENCHAMBER_DATA_DIR: DATA_DIR } }))).toBe('https://profile-npm.corp.test/');
      expect(readNpmRegistry(machine(prefs, { env: { OPENCHAMBER_ENTERPRISE_MODE: '1', OPENCHAMBER_DATA_DIR: DATA_DIR } }))).toBeNull();
      expect(readNpmRegistry(machine(prefs, { env: { OPENCHAMBER_DATA_DIR: DATA_DIR, OPENCHAMBER_NPM_REGISTRY: 'https://env-npm.corp.test' } }))).toBe('https://env-npm.corp.test/');
    });

    it('treats a malformed, credentialed or blank value as unset', () => {
      for (const value of ['not a url', 'ftp://npm.corp.test', 'https://user:pw@npm.corp.test', 'https://npm.corp.test?x=1', '  ']) {
        expect(readNpmRegistry(machine({ [LINUX_POLICY]: JSON.stringify({ npmRegistry: value }) })), value).toBeNull();
      }
      expect(readNpmRegistry(machine({ [LINUX_POLICY]: '{"npmRegistry": 42}' }))).toBeNull();
    });
  });

  describe('replacement skill catalogs', () => {
    const entry = { id: 'corp', label: 'Corp', source: 'https://gitlab.corp.test/platform/skills.git', defaultSubpath: ' skills ', excludedSkills: ['draft'] };

    it('come from the file with or without enterprise mode', () => {
      const expected = [{ id: 'corp', label: 'Corp', source: 'https://gitlab.corp.test/platform/skills.git', defaultSubpath: 'skills', excludedSkills: ['draft'] }];
      expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: JSON.stringify({ skillsCatalogSources: [entry] }) })).skillsCatalogSources).toEqual(expected);
      expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: JSON.stringify({ enterpriseMode: true, skillsCatalogSources: [entry] }) })).skillsCatalogSources).toEqual(expected);
    });

    it('are never taken from the environment', () => {
      expect(readEnterprisePolicy(machine({}, { env: { OPENCHAMBER_ENTERPRISE_MODE: '1' } })).skillsCatalogSources).toEqual([]);
    });

    it('offer nothing, and hide the built-in ones, when the file is broken', () => {
      const policy = readEnterprisePolicy(machine({ [LINUX_POLICY]: JSON.stringify({ skillsCatalogSources: [{ id: 'corp' }] }) }));
      expect(policy.skillsCatalogSources).toEqual([]);
      expect(policy.hideBuiltinSkillCatalogs).toBe(true);
    });
  });

  describe('hidden built-in skill catalogs', () => {
    it('comes from the file with or without enterprise mode', () => {
      expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"hideBuiltinSkillCatalogs": true}' })))
        .toMatchObject({ enterpriseMode: false, hideBuiltinSkillCatalogs: true });
      expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"enterpriseMode": true, "hideBuiltinSkillCatalogs": true}' })).hideBuiltinSkillCatalogs)
        .toBe(true);
    });

    it('is never taken from the environment', () => {
      expect(readEnterprisePolicy(machine({}, { env: { OPENCHAMBER_ENTERPRISE_MODE: '1', OPENCHAMBER_HIDE_BUILTIN_SKILL_CATALOGS: '1' } })).hideBuiltinSkillCatalogs)
        .toBe(false);
    });

    it('hides them when the file is broken', () => {
      expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"hideBuiltinSkillCatalogs": "yes"}' })).hideBuiltinSkillCatalogs).toBe(true);
    });
  });

  describe('pinned OpenCode binary', () => {
    const env = { OPENCODE_BINARY: '/home/me/opencode' };

    it('comes from the file with or without enterprise mode', () => {
      expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"opencodeBinary": "/opt/acme/opencode"}' }, { env })))
        .toMatchObject({ enterpriseMode: false, opencodeBinary: '/opt/acme/opencode' });
      expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"enterpriseMode": true, "opencodeBinary": " /opt/acme/opencode "}' })).opencodeBinary)
        .toBe('/opt/acme/opencode');
    });

    it('is never taken from the environment', () => {
      expect(readEnterprisePolicy(machine({}, { env: { ...env, OPENCHAMBER_ENTERPRISE_MODE: '1' } })).opencodeBinary).toBeNull();
    });

    it('pins nothing when blank or when the file is broken', () => {
      expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"opencodeBinary": "  "}' })).opencodeBinary).toBeNull();
      expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"opencodeBinary": 42}' })).opencodeBinary).toBeNull();
    });

    it('is shown to clients', () => {
      expect(publicEnterprisePolicy(machine({ [LINUX_POLICY]: '{"opencodeBinary": "/opt/acme/opencode"}' })).opencodeBinary)
        .toBe('/opt/acme/opencode');
    });
  });

  describe('insecure Git origins', () => {
    it('come from the file with or without enterprise mode', () => {
      expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"allowedInsecureGitOrigins": ["http://git.lab"]}' })))
        .toMatchObject({ enterpriseMode: false, allowedInsecureGitOrigins: ['http://git.lab'] });
      expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"enterpriseMode": true, "allowedInsecureGitOrigins": ["http://git.lab"]}' })).allowedInsecureGitOrigins)
        .toEqual(['http://git.lab']);
    });

    it('come from the environment where the environment turns enterprise mode on', () => {
      expect(readEnterprisePolicy(machine({}, { env: {
        OPENCHAMBER_ENTERPRISE_MODE: '1',
        OPENCHAMBER_ALLOWED_INSECURE_GIT_ORIGINS: 'http://git.lab, http://other.lab:8080',
      } })).allowedInsecureGitOrigins).toEqual(['http://git.lab', 'http://other.lab:8080']);
    });

    it('add nothing from the environment once the file turns enterprise mode on', () => {
      expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"enterpriseMode": true}' }, { env: {
        OPENCHAMBER_ALLOWED_INSECURE_GIT_ORIGINS: 'http://git.lab',
      } })).allowedInsecureGitOrigins).toEqual([]);
    });

    it('take the file value over the environment', () => {
      expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"allowedInsecureGitOrigins": ["http://file.lab"]}' }, { env: {
        OPENCHAMBER_ALLOWED_INSECURE_GIT_ORIGINS: 'http://env.lab',
      } })).allowedInsecureGitOrigins).toEqual(['http://file.lab']);
    });

    it('resolve to exact plain-HTTP origins; anything else counts as unset', () => {
      const options = machine({ [LINUX_POLICY]: JSON.stringify({ allowedInsecureGitOrigins: [
        'http://git.lab', 'http://git.lab/', ' http://port.lab:8443 ', 'https://secure.lab',
        'http://path.lab/group', 'http://user:pw@git.lab', 'not a url', 'http://query.lab?x=1',
        'bare.lab:8080', 'http://*.lab', 'http://',
      ] }) });
      expect(allowedInsecureGitOrigins(options)).toEqual(new Set(['http://git.lab', 'http://port.lab:8443', 'http://bare.lab:8080']));
    });

    it('allow nothing when the file is broken', () => {
      expect(allowedInsecureGitOrigins(machine({ [LINUX_POLICY]: '{"allowedInsecureGitOrigins": "http://git.lab"}' }))).toEqual(new Set());
      expect(allowedInsecureGitOrigins(machine({ [LINUX_POLICY]: '{"allowedInsecureGitOrigins": tru' }))).toEqual(new Set());
    });

    it('are kept off the public policy', () => {
      expect(publicEnterprisePolicy(machine({ [LINUX_POLICY]: '{"allowedInsecureGitOrigins": ["http://git.lab"]}' })))
        .not.toHaveProperty('allowedInsecureGitOrigins');
    });

    describe('from the user setting', () => {
      const prefs = (value) => ({ [PREFERENCES_FILE]: JSON.stringify({ version: 1, fields: { allowedInsecureGitOrigins: { value, updatedAt: 0 } } }) });
      const withPrefs = (files) => machine({ ...files, ...prefs('http://profile.lab') }, { env: { OPENCHAMBER_DATA_DIR: DATA_DIR } });

      it('merges with the file while enterprise mode is off', () => {
        expect(allowedInsecureGitOrigins(withPrefs({ [LINUX_POLICY]: '{"allowedInsecureGitOrigins": ["http://git.lab"]}' })))
          .toEqual(new Set(['http://git.lab', 'http://profile.lab']));
        expect(allowedInsecureGitOrigins(withPrefs({}))).toEqual(new Set(['http://profile.lab']));
      });

      it('counts for nothing once the file turns enterprise mode on', () => {
        expect(allowedInsecureGitOrigins(withPrefs({ [LINUX_POLICY]: '{"enterpriseMode": true}' })))
          .toEqual(new Set());
        expect(allowedInsecureGitOrigins(withPrefs({ [LINUX_POLICY]: '{"enterpriseMode": true, "allowedInsecureGitOrigins": ["http://git.lab"]}' })))
          .toEqual(new Set(['http://git.lab']));
      });

      it('is the same list the environment-only mode ignores', () => {
        const options = machine(prefs('http://profile.lab'), {
          env: { OPENCHAMBER_DATA_DIR: DATA_DIR, OPENCHAMBER_ENTERPRISE_MODE: '1' },
        });
        expect(allowedInsecureGitOrigins(options)).toEqual(new Set());
      });

      it('adds nothing when the preferences file is missing, broken, or holds a value that is not text', () => {
        expect(allowedInsecureGitOrigins(machine({}, { env: { OPENCHAMBER_DATA_DIR: DATA_DIR } })))
          .toEqual(new Set());
        expect(allowedInsecureGitOrigins(machine({ [PREFERENCES_FILE]: '{"fields": {"allowedInsecureGit' }, { env: { OPENCHAMBER_DATA_DIR: DATA_DIR } })))
          .toEqual(new Set());
        expect(allowedInsecureGitOrigins(machine(prefs(['http://profile.lab']), { env: { OPENCHAMBER_DATA_DIR: DATA_DIR } })))
          .toEqual(new Set());
      });

      it('is validated like the file: malformed lines count as unset', () => {
        expect(allowedInsecureGitOrigins(machine(prefs('https://secure.lab\nhttp://user@git.lab\nhttp://group.lab/path\nhttp://profile.lab'),
          { env: { OPENCHAMBER_DATA_DIR: DATA_DIR } })))
          .toEqual(new Set(['http://profile.lab']));
      });
    });
  });

  it('ignores the environment\'s pins and network allowance once the file turns enterprise mode on', () => {
    const policy = readEnterprisePolicy(machine(
      { [LINUX_POLICY]: '{"enterpriseMode": true}' },
      { env: {
        OPENCHAMBER_RELAY_URL: 'wss://my-relay.test/ws',
        OPENCHAMBER_JEV_URL: 'https://my-endpoint.test',
        OPENCHAMBER_ALLOW_NETWORK_ACCESS: '1',
      } },
    ));
    expect(policy.relayUrl).toBeNull();
    expect(policy.jev).toBeNull();
    expect(policy.allowNetworkAccess).toBe(false);
  });

  it('takes the pins and network allowance from the environment when the environment turns it on', () => {
    const policy = readEnterprisePolicy(machine({}, { env: {
      OPENCHAMBER_ENTERPRISE_MODE: '1',
      OPENCHAMBER_RELAY_URL: 'wss://relay.acme.test/ws',
      OPENCHAMBER_ALLOW_NETWORK_ACCESS: 'true',
    } }));
    expect(policy.relayUrl).toBe('wss://relay.acme.test/ws');
    expect(policy.allowNetworkAccess).toBe(true);
  });

  it('takes allowed extension repositories from the file, or from the environment only when the file does not govern', () => {
    const env = { OPENCHAMBER_ALLOWED_EXTENSIONS: 'https://github.com/me/ext, https://github.com/me/other' };
    expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"enterpriseMode": true}' }, { env })).allowedExtensions).toEqual([]);
    expect(readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"enterpriseMode": true, "allowedExtensions": ["https://github.com/acme/ext"]}' }, { env })).allowedExtensions)
      .toEqual(['https://github.com/acme/ext']);
    expect(readEnterprisePolicy(machine({}, { env: { ...env, OPENCHAMBER_ENTERPRISE_MODE: '1' } })).allowedExtensions)
      .toEqual(['https://github.com/me/ext', 'https://github.com/me/other']);
  });

  describe('network access', () => {
    it('is blocked in enterprise mode unless allowed', () => {
      expect(isNetworkAccessBlocked(machine({ [LINUX_POLICY]: '{"enterpriseMode": true}' }))).toBe(true);
      expect(isNetworkAccessBlocked(machine({ [LINUX_POLICY]: '{"enterpriseMode": true, "allowNetworkAccess": true}' }))).toBe(false);
      expect(isNetworkAccessBlocked(machine({}, { env: { OPENCHAMBER_ENTERPRISE_MODE: '1' } }))).toBe(true);
      expect(isNetworkAccessBlocked(machine({}, { env: { OPENCHAMBER_ENTERPRISE_MODE: '1', OPENCHAMBER_ALLOW_NETWORK_ACCESS: '1' } }))).toBe(false);
    });

    it('is never blocked outside enterprise mode', () => {
      expect(isNetworkAccessBlocked(machine({}))).toBe(false);
    });

    it('stays blocked when the policy file is broken', () => {
      expect(isNetworkAccessBlocked(machine({ [LINUX_POLICY]: '{"allowNetworkAccess": tru' }))).toBe(true);
    });
  });

  it('cannot be turned off by the environment once the file turns it on', () => {
    const options = machine(
      { [LINUX_POLICY]: '{"enterpriseMode": true}' },
      { env: { OPENCHAMBER_ENTERPRISE_MODE: '0' } },
    );
    expect(isEnterpriseMode(options)).toBe(true);
  });

  it('lets the environment turn it on when the file leaves it off', () => {
    const options = machine(
      { [LINUX_POLICY]: '{"enterpriseMode": false}' },
      { env: { OPENCHAMBER_ENTERPRISE_MODE: '1' } },
    );
    expect(readEnterprisePolicy(options).source).toBe('environment');
  });

  it('prefers values from the file over their environment variables, and fills the gaps from the environment', () => {
    const env = {
      OPENCHAMBER_RELAY_URL: 'wss://env-relay.test/ws',
      OPENCHAMBER_JEV_URL: 'https://env-jev.test',
      OPENCHAMBER_JEV_MODEL: 'env-model',
    };
    const fileRelayOnly = readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"relayUrl": "wss://file-relay.test/ws"}' }, { env }));
    expect(fileRelayOnly.relayUrl).toBe('wss://file-relay.test/ws');
    expect(fileRelayOnly.jev).toEqual({ url: 'https://env-jev.test', model: 'env-model', apiKey: null });

    const fileJev = readEnterprisePolicy(machine({ [LINUX_POLICY]: '{"jev": {"url": "https://file-jev.test"}}' }, { env }));
    // The file's endpoint comes whole: the environment's model does not mix into it.
    expect(fileJev.jev).toEqual({ url: 'https://file-jev.test', model: null, apiKey: null });
  });

  it.each([
    ['not JSON', '{enterpriseMode: true'],
    ['not an object', '[true]'],
    ['a non-boolean switch', '{"enterpriseMode": "yes"}'],
    ['a non-string relay', '{"relayUrl": 42}'],
    ['a Jev model without a URL', '{"jev": {"model": "m"}}'],
    ['an insecure-origins list of non-strings', '{"allowedInsecureGitOrigins": [42]}'],
  ])('keeps enterprise mode on and pins nothing when the file is %s', (_label, content) => {
    const policy = readEnterprisePolicy(machine(
      { [LINUX_POLICY]: content },
      { env: { OPENCHAMBER_RELAY_URL: 'wss://env-relay.test/ws', OPENCHAMBER_JEV_URL: 'https://env-jev.test' } },
    ));
    expect(policy.enterpriseMode).toBe(true);
    expect(policy.source).toBe('policy-file');
    expect(policy.policyError).toContain(LINUX_POLICY);
    expect(policy.relayUrl).toBeNull();
    expect(policy.jev).toBeNull();
  });

  it('keeps enterprise mode on when the file exists but cannot be read', () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const policy = readEnterprisePolicy(machine({ [LINUX_POLICY]: denied }));
    expect(policy.enterpriseMode).toBe(true);
    expect(policy.policyError).toContain('permission denied');
  });

  it('reads a file saved with a byte-order mark', () => {
    const policy = readEnterprisePolicy(machine({ [LINUX_POLICY]: '\uFEFF{"enterpriseMode": true, "organization": "Acme"}' }));
    expect(policy.policyError).toBeNull();
    expect(policy.organization).toBe('Acme');
  });

  it('ignores unknown keys so newer policy files still apply', () => {
    expect(isEnterpriseMode(machine({ [LINUX_POLICY]: '{"enterpriseMode": true, "future": 1}' }))).toBe(true);
  });

  it('never exposes pinned endpoints or keys to clients', () => {
    const policy = publicEnterprisePolicy(machine({
      [LINUX_POLICY]: '{"enterpriseMode": true, "organization": "Acme", "jev": {"url": "https://x.test", "apiKey": "secret"}}',
    }));
    expect(policy).toEqual({ enterpriseMode: true, source: 'policy-file', organization: 'Acme', policyError: null, networkAccessBlocked: true, opencodeBinary: null, modelsDevUrlPinned: false });
  });

  it('reports a pinned model catalog as a boolean without the address', () => {
    const policy = publicEnterprisePolicy(machine({ [LINUX_POLICY]: '{"modelsDevUrl": "http://models.corp.internal/api.json"}' }));
    expect(policy.modelsDevUrlPinned).toBe(true);
    expect(JSON.stringify(policy)).not.toContain('models.corp.internal');
  });

  describe('file location', () => {
    it('checks user config directory first, then system path per platform', () => {
      const darwinPaths = policyFilePaths({ platform: 'darwin', env: { HOME: '/Users/test' } });
      expect(darwinPaths).toEqual([
        '/Users/test/.config/openchamber/policy.json',
        '/Library/Application Support/OpenChamber/policy.json',
      ]);

      const linuxPaths = policyFilePaths({ platform: 'linux', env: { HOME: '/home/test' } });
      expect(linuxPaths).toEqual([
        '/home/test/.config/openchamber/policy.json',
        LINUX_POLICY,
      ]);

      const winPaths = policyFilePaths({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\test' } });
      expect(winPaths).toEqual([
        'C:\\Users\\test\\.config\\openchamber\\policy.json',
        'C:\\ProgramData\\OpenChamber\\policy.json',
      ]);
    });

    it('respects OPENCHAMBER_DATA_DIR for the user policy path', () => {
      const paths = policyFilePaths({
        platform: 'linux',
        env: { OPENCHAMBER_DATA_DIR: '/custom/data/dir' },
      });
      expect(paths[0]).toBe('/custom/data/dir/policy.json');
      expect(userPolicyFilePath({ platform: 'linux', env: { OPENCHAMBER_DATA_DIR: '/custom/data/dir' } }))
        .toBe('/custom/data/dir/policy.json');
    });

    it('reads policy from user config directory without requiring administrator/root paths', () => {
      const userPolicy = '/home/test/.config/openchamber/policy.json';
      const options = machine({
        [userPolicy]: '{"enterpriseMode": true, "organization": "UserOrg", "modelsDevUrl": "http://models.corp/api.json"}',
      }, { platform: 'linux', env: { HOME: '/home/test' } });

      const policy = readEnterprisePolicy(options);
      expect(policy.enterpriseMode).toBe(true);
      expect(policy.organization).toBe('UserOrg');
      expect(policy.modelsDevUrl).toBe('http://models.corp/api.json');
      expect(policy.source).toBe('policy-file');
    });

    it('on Windows reads user policy, then C:\\ProgramData, then ProgramData env redirect', () => {
      const env = { USERPROFILE: 'C:\\Users\\test', ProgramData: 'D:\\Elsewhere' };
      expect(policyFilePaths({ platform: 'win32', env })).toEqual([
        'C:\\Users\\test\\.config\\openchamber\\policy.json',
        'C:\\ProgramData\\OpenChamber\\policy.json',
        'D:\\Elsewhere\\OpenChamber\\policy.json',
      ]);
      const options = machine({
        'C:\\ProgramData\\OpenChamber\\policy.json': '{"enterpriseMode": true}',
        'D:\\Elsewhere\\OpenChamber\\policy.json': '{"enterpriseMode": false}',
      }, { platform: 'win32', env });
      expect(isEnterpriseMode(options)).toBe(true);
    });

    it('on Windows falls back to the ProgramData folder when the system drive is not C:', () => {
      const options = machine(
        { 'D:\\ProgramData\\OpenChamber\\policy.json': '{"enterpriseMode": true}' },
        { platform: 'win32', env: { ProgramData: 'D:\\ProgramData' } },
      );
      expect(isEnterpriseMode(options)).toBe(true);
    });
  });

  describe('provider-connect requests', () => {
    it.each([
      '/api/integration/openai/connect/key',
      '/api/integration/openai/connect/key?directory=%2Fp',
      '/api/integration/anthropic/connect/oauth',
      '/api/integration/anthropic/connect/oauth/att_1/complete',
      '/api/integration/github-copilot/connect/command',
      '/api/integration/amazon-bedrock/connect/external',
      '/api/experimental/integration/wellknown',
      '/api/integration/openai/connect',
      '/api/integration/openai/connect/key/',
      '/api/credential',
      '/api/credential/',
      '/API//credential;x',
    ])('refuses POST %s', (requestPath) => {
      expect(isProviderConnectRequest('POST', requestPath)).toBe(true);
    });

    // OpenCode routes all of these to the provider connect handlers.
    it.each([
      '/API/integration/openai/connect/key',
      '/api/Integration/openai/Connect/Key',
      '/api//integration/openai/connect/key',
      '/api/integration//openai/connect/key',
      '/api/integration/openai/%63onnect/key',
      '/api/%65xperimental/integration/wellknown',
      '/api/integration/%6Dcp_0123456789abcdef/connect/key',
      '/api/integration\\openai\\connect\\key',
      '/api/integration/openai\\connect/key',
      '/api/Experimental/integration\\wellknown',
      '/api/experimental/integration/wellknown;x',
      '/api/integration/openai/connect/key;x',
    ])('refuses POST %s written another way', (requestPath) => {
      expect(isProviderConnectRequest('POST', requestPath)).toBe(true);
    });

    it.each([
      '/api/integration/openai/connect/../connect/key',
      '/api/integration/mcp_0123456789abcdef/connect/oauth/../../../openai/connect/key',
      '/api/integration/openai/connect/%E0%A4%A',
    ])('refuses POST %s, which cannot be read safely', (requestPath) => {
      expect(isProviderConnectRequest('POST', requestPath)).toBe(true);
    });

    it.each([
      '/api/integration/mcp_0123456789abcdef/connect/oauth',
      '/api/integration/mcp_0123456789abcdef/connect/oauth?location=%2Fp',
      '/api/integration/mcp_0123456789abcdef/connect/OAuth/',
      '/api/integration/mcp_0123456789abcdef/connect/oauth/att_1/complete',
      '/api/integration\\mcp_0123456789abcdef\\connect\\oauth',
      '/api/integration/mcp_0123456789abcdef/connect/oauth;/../../../openai/connect/key',
    ])('lets POST %s sign in to an MCP server', (requestPath) => {
      expect(isProviderConnectRequest('POST', requestPath)).toBe(false);
    });

    it.each([
      '/api/integration/mcp_0123456789abcdef/connect/key',
      '/api/integration/mcp_0123456789abcdef/connect/command',
      '/api/integration/mcp_0123456789abcdef/connect/oauth/att_1/complete/extra',
      '/api/integration/mcp_0123456789abcdef/connect/oauth/att%2F1/complete',
      '/api/integration/MCP_0123456789ABCDEF/connect/oauth',
      '/api/integration/mcp_evil/connect/oauth',
      '/api/integration/mcp_0123456789abcdef%2F..%2Fopenai/connect/oauth',
    ])('refuses POST %s, which is not an MCP sign-in', (requestPath) => {
      expect(isProviderConnectRequest('POST', requestPath)).toBe(true);
    });

    it.each([
      ['GET', '/api/integration/anthropic/connect/oauth/att_1'],
      ['DELETE', '/api/integration/anthropic/connect/oauth/att_1'],
      ['GET', '/api/integration'],
      ['POST', '/api/session'],
      ['POST', '/api/integration/openai/connectors'],
      ['POST', '/health'],
      ['DELETE', '/api/credential/cred_1'],
      ['POST', '/api/credential/cred_1/activate'],
      ['PATCH', '/api/credential/cred_1'],
      ['GET', '/api/credential'],
    ])('leaves %s %s alone', (method, requestPath) => {
      expect(isProviderConnectRequest(method, requestPath)).toBe(false);
    });
  });

  describe('credential list requests', () => {
    // OpenCode routes all of these to the handler that returns every key.
    it.each([
      ['GET', '/api/credential'],
      ['GET', '/api/credential/'],
      ['GET', '/api/credential?directory=%2Fp'],
      ['HEAD', '/api/credential'],
      ['get', '/API/Credential'],
      ['GET', '//api//credential'],
      ['GET', '/api\\credential'],
      ['GET', '/api/%63redential'],
      ['GET', '/api/credential;x'],
    ])('refuses %s %s', (method, requestPath) => {
      expect(isCredentialListRequest(method, requestPath)).toBe(true);
    });

    it.each([
      '/api/x/../credential',
      '/api/%E0%A4%A',
      '/API/%zz',
    ])('refuses GET %s, which cannot be read safely', (requestPath) => {
      expect(isCredentialListRequest('GET', requestPath)).toBe(true);
    });

    it.each([
      '/assets/a%zz.js',
      '/docs/../index.html',
      '/apikeys/%zz',
    ])('leaves GET %s alone, which never reaches OpenCode', (requestPath) => {
      expect(isCredentialListRequest('GET', requestPath)).toBe(false);
    });

    // OpenCode 2.0.20 matches before decoding a separator: these reach its web
    // app page (200 HTML), 404 or 405, never the credential handler.
    it.each([
      '/api%2fcredential',
      '/api%2Fcredential',
      '/api%5ccredential',
    ])('leaves GET %s alone, which OpenCode does not route to the list', (requestPath) => {
      expect(isCredentialListRequest('GET', requestPath)).toBe(false);
    });

    it.each([
      ['POST', '/api/credential'],
      ['PATCH', '/api/credential/cred_1'],
      ['DELETE', '/api/credential/cred_1'],
      ['POST', '/api/credential/cred_1/activate'],
      ['GET', '/api/credentials'],
      ['GET', '/api/integration'],
      ['GET', '/credential'],
    ])('leaves %s %s alone', (method, requestPath) => {
      expect(isCredentialListRequest(method, requestPath)).toBe(false);
    });
  });
});
