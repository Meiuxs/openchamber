import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { readOpenCodeCredentialEntries, readOpenCodeCredentials } from '../opencode/auth.js';
import { readConfigLayers } from '../opencode/config-files.js';
import { isRecord, isString } from '../shared/object-guards.js';
import { createAccountResolver } from './policy.js';
import { createRateGateRuntime } from './runtime.js';

type RateGateDependencies = Parameters<typeof createRateGateRuntime>[0];

type ServerRateGateDependencies = Pick<
  RateGateDependencies,
  'readSettings' | 'readPolicy' | 'authorizeRequest' | 'isPluginSupported'
> & Required<Pick<RateGateDependencies, 'broadcast'>> & { instanceDir: string };

const readProviderOptions = (providerID: string) => {
  const providers = readConfigLayers().mergedConfig?.provider;
  if (!isRecord(providers)) return null;
  const provider = providers[providerID];
  if (!isRecord(provider) || !isRecord(provider.options)) return null;
  return provider.options;
};

export const createServerRateGateRuntime = (deps: ServerRateGateDependencies) => createRateGateRuntime({
  instanceDir: deps.instanceDir,
  fs: {
    mkdir: async (target, options) => { await fsPromises.mkdir(target, options); },
    writeFile: (target, data, encoding) => fsPromises.writeFile(target, data, encoding),
  },
  path,
  readSettings: deps.readSettings,
  readPolicy: deps.readPolicy,
  resolveAccount: createAccountResolver({
    readCredentialEntries: async () => (await readOpenCodeCredentialEntries()).map((entry) => ({
      id: entry.id,
      integrationID: entry.integrationID,
      active: entry.active,
      label: entry.label ?? null,
    })),
    readCredentialMap: async () => {
      const credentials = await readOpenCodeCredentials();
      const entries: Record<string, { key: string; label?: string }> = {};
      for (const [providerID, entry] of Object.entries(credentials)) {
        if (entry.type !== 'api') continue;
        entries[providerID] = entry.label === undefined
          ? { key: entry.key }
          : { key: entry.key, label: entry.label };
      }
      return entries;
    },
    readProviderConfig: (providerID) => {
      const options = readProviderOptions(providerID);
      if (!options) return null;
      type ProviderConfig = { apiKey?: string; baseURL?: string };
      const config: ProviderConfig = {};
      if (isString(options.apiKey)) config.apiKey = options.apiKey;
      if (isString(options.baseURL)) config.baseURL = options.baseURL;
      return config;
    },
  }),
  resolveProviderBaseUrl: (providerID) => {
    const baseURL = readProviderOptions(providerID)?.baseURL;
    return isString(baseURL) ? baseURL : null;
  },
  authorizeRequest: deps.authorizeRequest,
  isPluginSupported: deps.isPluginSupported,
  broadcast: deps.broadcast,
});
