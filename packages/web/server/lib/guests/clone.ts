import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createGitCredentialBroker } from '../git/credential-broker.js';
import { createHttpsCredentialReference, normalizeGitRemoteEndpoint } from '../git/credential-resolver.js';
import { managedEnvironment } from '../git/network-operations.js';
import type { createGitCredentialResolver } from '../git/credential-resolver.js';
import type { GitIdentityAccount } from '../git/identity-storage.js';
import { isString } from './input-guards.js';

import { allowedInsecureGitOrigins, isEnterpriseMode } from '../enterprise-mode.js';

const CLONE_TIMEOUT_MS = 60_000;
export type ResolvedAddress = { address: string; family: 4 | 6 };
export type AddressLookup = (hostname: string, options: { all: true }) => Promise<Array<{ address: string; family?: number }>>;
export type InstallTrust = { mode: 'strict' | 'open'; origins: Set<string>; hosts: Set<string> };
type InstallPolicyOptions = Parameters<typeof allowedInsecureGitOrigins>[0];
type GitOptions = {
  gitBinary?: string | undefined;
  cwd?: string;
  timeoutMs?: number | undefined;
  capture?: boolean;
  env?: NodeJS.ProcessEnv | undefined;
  baseEnv?: NodeJS.ProcessEnv | undefined;
};
type GitResult = { ok: true; stdout: string } | { ok: false; stderr?: string };
export type GuestGitAccounts = {
  readAccount: (account: GitIdentityAccount) => Promise<{ credentialId: string; credentialRevision: number; providerUserId: string } | null>;
  credentialResolver: Pick<ReturnType<typeof createGitCredentialResolver>, 'resolve'>;
};
type NetworkOptions = {
  gitIdentityId?: string | undefined;
  gitAccounts?: GuestGitAccounts | undefined;
  lookup?: AddressLookup | undefined;
  timeoutMs?: number | undefined;
};
export type GuestGitNetwork = {
  args: string[];
  env?: NodeJS.ProcessEnv;
  baseEnv?: NodeJS.ProcessEnv;
  release?: () => Promise<void>;
};
type CloneOptions = NetworkOptions & GitOptions & { ref?: string | undefined };
export type CloneResult = { ok: true } | { ok: false; code: 'clone-failed' | 'clone-auth-failed' };

const DISALLOWED_IPV4 = [/^169\.254\./, /^0\./];

// Enterprise mode's default host policy: only the public internet, never a
// private, loopback, single-label or `.local`/`.internal` name.
const PRIVATE_IPV4 = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

const ipv6Groups = (host: string): number[] | null => {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const [head, tail = ''] = halves;
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) return null;
  const groups = [...headGroups, ...Array(missing).fill('0'), ...tailGroups];
  if (groups.length !== 8) return null;
  return groups.map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : -1));
};

const isReservedIPv6 = (host: string): boolean => {
  if (host.startsWith('fe80:') || host.startsWith('::ffff:')) return true;
  const groups = ipv6Groups(host);
  if (!groups || groups.some((group) => group < 0)) return true;
  if (groups[4] === 0 && groups[5] === 0xffff) return true;
  return groups.slice(0, 7).every((group) => group === 0) && (groups[7] === 0 || groups[7] === 1);
};

export const isPublicHostname = (hostname: string) => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  const version = net.isIP(host);
  if (version === 4) {
    return !PRIVATE_IPV4.some((pattern) => pattern.test(host));
  }
  if (version === 6) {
    return !(host.startsWith('fc') || host.startsWith('fd')) && !isReservedIPv6(host);
  }
  return host.includes('.');
};

const isDisallowedIpv6 = (host: string) => {
  if (host === '::' || /^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }
  if (!host.startsWith('::ffff:')) {
    return false;
  }
  const mapped = host.slice('::ffff:'.length);
  if (net.isIP(mapped) === 4) {
    return DISALLOWED_IPV4.some((pattern) => pattern.test(mapped));
  }
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
  if (!hex) {
    return false;
  }
  const high = Number.parseInt(hex[1] ?? '', 16);
  return high === 0xa9fe || (high >> 8) === 0;
};

export const isAllowedInstallHost = (hostname: string) => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) {
    return false;
  }
  const version = net.isIP(host);
  if (version === 4) {
    return !DISALLOWED_IPV4.some((pattern) => pattern.test(host));
  }
  if (version === 6) {
    return !isDisallowedIpv6(host);
  }
  return true;
};

export const installTrust = (policyOptions?: InstallPolicyOptions): InstallTrust => {
  // Outside enterprise mode installs keep the permissive host policy: any
  // public host, a private-network host or an ssh alias is fine, and only
  // link-local/metadata addresses are refused. Enterprise mode opts into the
  // strict model below, where a host must be named in the policy file.
  if (!isEnterpriseMode(policyOptions)) {
    return { mode: 'open', origins: new Set(), hosts: new Set() };
  }
  const origins = allowedInsecureGitOrigins(policyOptions);
  const hosts = new Set<string>();
  for (const origin of origins) {
    hosts.add(new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase());
  }
  return { mode: 'strict', origins, hosts };
};

const isLocalOnlyHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  const version = net.isIP(host);
  if (version === 4) return /^127\./.test(host) || /^0\./.test(host) || /^169\.254\./.test(host);
  if (version === 6) return isReservedIPv6(host);
  return false;
};

const isTrustedHost = (hostname: string, trust: InstallTrust): boolean => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return trust.hosts.has(host) && !isLocalOnlyHost(host);
};

const isInstallHostname = (hostname: string, trust: InstallTrust = installTrust()): boolean => (
  isPublicHostname(hostname) || isTrustedHost(hostname, trust)
);

export const isInstallableUrl = (value: string, trust: InstallTrust = installTrust()): boolean => {
  if (trust.mode === 'open') {
    return isHttpsGitUrl(value);
  }
  try {
    const parsed = new URL(value);
    if (parsed.username !== '' || parsed.password !== '') return false;
    if (parsed.protocol === 'https:') return isInstallHostname(parsed.hostname, trust);
    if (parsed.protocol === 'http:') return trust.origins.has(parsed.origin) && !isLocalOnlyHost(parsed.hostname);
    return false;
  } catch {
    return false;
  }
};

export const resolveInstallAddresses = async (hostname: string, lookup: AddressLookup = (name, options) => dns.lookup(name, options)): Promise<ResolvedAddress[] | null> => {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (!isAllowedInstallHost(host)) {
    return null;
  }
  const literal = net.isIP(host);
  if (literal) {
    return [{ address: host, family: literal === 6 ? 6 : 4 }];
  }
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0 || !addresses.every((entry) => isAllowedInstallHost(entry.address))) {
      return null;
    }
    return addresses.map((entry) => ({ address: entry.address, family: net.isIP(entry.address) === 6 ? 6 : 4 }));
  } catch {
    return null;
  }
};

export const publicAddressesOf = async (hostname: string, lookup: AddressLookup = (name, options) => dns.lookup(name, options), trust: InstallTrust = installTrust()): Promise<ResolvedAddress[] | null> => {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (trust.mode === 'open') {
    return resolveInstallAddresses(host, lookup);
  }
  if (!isInstallHostname(host, trust)) {
    return null;
  }
  const trusted = !isPublicHostname(host);
  const acceptable = (address: string) => (trusted ? !isLocalOnlyHost(address) : isPublicHostname(address));
  const literal = net.isIP(host);
  if (literal) {
    return [{ address: host, family: literal === 6 ? 6 : 4 }];
  }
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0 || !addresses.every((entry) => acceptable(entry.address))) {
      return null;
    }
    return addresses.map((entry) => ({ address: entry.address, family: net.isIP(entry.address) === 6 ? 6 : 4 }));
  } catch {
    return null;
  }
};

const httpTarget = (value: string): { hostname: string; port: string } | null => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return { hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80') };
  } catch {
    return null;
  }
};

export const gitNetworkArgs = async (url: string, lookup?: AddressLookup, trust: InstallTrust = installTrust()) => {
  const target = httpTarget(url);
  if (target === null) {
    return [];
  }
  if (trust.mode === 'open') {
    return isHttpsGitUrl(url) ? ['-c', 'http.followRedirects=false'] : [];
  }
  if (!isInstallableUrl(url, trust)) {
    return null;
  }
  const addresses = await publicAddressesOf(target.hostname, lookup, trust);
  if (!addresses) {
    return null;
  }
  return [
    '-c', 'http.followRedirects=false',
    '-c', `http.curloptResolve=${target.hostname}:${target.port}:${addresses.map((entry) => entry.address).join(',')}`,
  ];
};

const isHttpsGitUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && isAllowedInstallHost(parsed.hostname);
  } catch {
    return false;
  }
};

const parseSshGitUrl = (value: string, trust: InstallTrust = installTrust()) => {
  if (/[\s\\\0]/.test(value)) return null;
  let hostname;
  let username;
  let repository;
  let port;
  let hasExplicitUser = false;
  let isUri = false;
  if (value.slice(0, 6).toLowerCase() === 'ssh://') {
    isUri = true;
    try {
      const url = new URL(value);
      if (url.password || url.search || url.hash) return null;
      hostname = url.hostname;
      username = url.username;
      repository = url.pathname;
      port = url.port;
      if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return null;
    } catch { return null; }
  } else {
    const match = /^(?:([A-Za-z0-9_][A-Za-z0-9_.-]*)@)?([A-Za-z0-9][A-Za-z0-9._-]*):(.+)$/.exec(value);
    if (!match) return null;
    username = match[1] ?? '';
    hasExplicitUser = Boolean(match[1]);
    hostname = match[2] ?? '';
    repository = match[3] ?? '';
  }
  if (trust.mode === 'open') {
    const unbracketed = hostname.replace(/^\[|\]$/g, '');
    const isIp = net.isIP(unbracketed) !== 0;
    if (!isIp && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(hostname)) return null;
    if (!isUri && !hasExplicitUser && !isIp && !hostname.includes('.')) return null;
    if (!isAllowedInstallHost(hostname) || (username && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(username))) return null;
  } else {
    if (!/^[A-Za-z0-9.-]+$/.test(hostname) && !net.isIP(hostname.replace(/^\[|\]$/g, ''))) return null;
    if (!isInstallHostname(hostname, trust) || (username && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(username))) return null;
  }
  if (!/^\/?[A-Za-z0-9_.~][A-Za-z0-9_./~-]*$/.test(repository) || repository.split('/').includes('..')) return null;
  return port ? { hostname, port } : { hostname };
};

export const isInstallableZipUrl = (value: string, trust: InstallTrust = installTrust()) => {
  if (!isInstallableUrl(value, trust)) {
    return false;
  }
  try {
    return new URL(value).pathname.toLowerCase().endsWith('.zip');
  } catch {
    return false;
  }
};

export const isHttpsZipUrl = (value: string) => {
  if (!isHttpsGitUrl(value)) {
    return false;
  }
  try {
    return new URL(value).pathname.toLowerCase().endsWith('.zip');
  } catch {
    return false;
  }
};

const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

export const isGitRef = (value: string) => (
  GIT_REF_PATTERN.test(value)
  && !value.includes('..')
  && !value.endsWith('/')
  && !value.endsWith('.lock')
  && !value.includes('//')
);

export const parseGitInstallUrl = (value: string, trust: InstallTrust = installTrust()) => {
  const hashAt = value.indexOf('#');
  const rawUrl = hashAt === -1 ? value : value.slice(0, hashAt);
  const url = rawUrl.replace(/^ssh:\/\//i, 'ssh://');
  const ref = hashAt === -1 ? '' : value.slice(hashAt + 1);
  if (!isInstallableUrl(url, trust) && !parseSshGitUrl(url, trust)) {
    return null;
  }
  if (hashAt !== -1 && !isGitRef(ref)) {
    return null;
  }
  return ref ? { url, ref } : { url };
};

const STDERR_TAIL_BYTES = 4096;
const KILL_GRACE_MS = 3_000;

export const runGit = (args: string[], { gitBinary = 'git', cwd, timeoutMs = CLONE_TIMEOUT_MS, capture = false, env = {}, baseEnv = process.env }: GitOptions = {}) => (
  new Promise<GitResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(
        gitBinary,
        args,
        {
          cwd,
          windowsHide: true,
          env: {
            ...baseEnv,
            ...env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: 'echo',
          },
          stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'],
        },
      );
    } catch {
      resolve({ ok: false });
      return;
    }
    const chunks: Buffer[] = [];
    if (capture && child.stdout) {
      child.stdout.on('data', (chunk) => chunks.push(chunk));
    }
    let stderrTail = Buffer.alloc(0);
    child.stderr?.on('data', (chunk) => {
      const joined = Buffer.concat([stderrTail, chunk]);
      stderrTail = joined.subarray(Math.max(0, joined.length - STDERR_TAIL_BYTES));
    });
    let settled = false;
    const finish = (result: GitResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ ok: false });
      }, KILL_GRACE_MS);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      finish({ ok: false });
    });
    child.on('close', (exit) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      finish(exit === 0 ? { ok: true, stdout: Buffer.concat(chunks).toString('utf8') } : { ok: false, stderr: stderrTail.toString('utf8') });
    });
  })
);

const quoteSshPath = (value: string) => {
  const expanded = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  const normalized = process.platform === 'win32' ? expanded.replace(/\\/g, '/') : expanded;
  return `'${normalized.replace(/'/g, "'\\''")}'`;
};

const accountHttpsNetwork = async (source: string, networkArgs: string[], account: GitIdentityAccount, accounts: GuestGitAccounts, timeoutMs: number): Promise<GuestGitNetwork | null> => {
  const stored = await accounts.readAccount(account);
  if (!stored || stored.credentialId !== account.accountId) return null;
  const operationId = randomUUID();
  const credential = await accounts.credentialResolver.resolve({
    mode: 'managed',
    credentialId: createHttpsCredentialReference({
      provider: account.provider,
      instance: account.instance,
      credentialId: stored.credentialId,
      credentialRevision: stored.credentialRevision,
      providerUserId: stored.providerUserId,
    }),
    endpoint: normalizeGitRemoteEndpoint(source),
    operationId,
    deadline: Date.now() + timeoutMs,
  });
  if (!('transport' in credential) || credential.transport !== 'https') return null;
  const broker = createGitCredentialBroker({ capacity: 1, ttlMs: timeoutMs });
  await broker.start();
  let lease;
  try {
    lease = broker.issue({ operationId, credential });
  } catch (error) {
    await broker.close();
    throw error;
  }
  return {
    args: [
      '-c', 'http.proxy=',
      '-c', 'http.sslVerify=true',
      '-c', 'http.extraHeader=',
      '-c', 'http.cookieFile=',
      '-c', 'credential.interactive=false',
      ...lease.gitConfigArgs,
      ...networkArgs,
    ],
    env: lease.env,
    baseEnv: managedEnvironment(process.env, process.platform),
    release: async () => {
      lease.revoke();
      await broker.close().catch(() => {});
    },
  };
};

export const prepareGuestGitNetwork = async (source: string, { gitIdentityId, gitAccounts, lookup, timeoutMs = CLONE_TIMEOUT_MS, trust = installTrust() }: NetworkOptions & { trust?: InstallTrust } = {}): Promise<GuestGitNetwork | null> => {
  let sshCommand = process.env.GIT_SSH_COMMAND?.trim() || '';
  let account: GitIdentityAccount | null = null;
  if (gitIdentityId && gitIdentityId !== 'global') {
    const { getProfile, toPublicGitIdentityProfile } = await import('../git/identity-storage.js');
    const profile = getProfile(gitIdentityId);
    if (!profile) return null;
    const { sshKey } = profile;
    if (isString(sshKey) && sshKey) sshCommand = `ssh -i ${quoteSshPath(sshKey)} -o IdentitiesOnly=yes`;
    const { transport, account: profileAccount } = toPublicGitIdentityProfile(profile);
    if (transport === 'account') account = profileAccount;
  }
  const ssh = parseSshGitUrl(source, trust);
  if (ssh) {
    if (trust.mode === 'strict') {
      const addresses = await publicAddressesOf(ssh.hostname, lookup, trust);
      if (!addresses) return null;
    }
    if (!sshCommand) {
      const { getGlobalIdentity } = await import('../git/index.js');
      const globalIdentity = await getGlobalIdentity();
      sshCommand = globalIdentity.sshCommand || (process.env.GIT_SSH ? quoteSshPath(process.env.GIT_SSH) : 'ssh');
    }
    sshCommand += ' -o BatchMode=yes -o StrictHostKeyChecking=accept-new';
    return { args: [], env: { GIT_SSH_COMMAND: sshCommand, GIT_SSH_VARIANT: 'ssh' } };
  }
  const args = trust.mode === 'strict'
    ? await gitNetworkArgs(source, lookup, trust)
    : (isHttpsGitUrl(source) ? ['-c', 'http.followRedirects=false'] : []);
  if (!args) return null;
  if (account) {
    if (!gitAccounts || !isHttpsGitUrl(source)) return null;
    return accountHttpsNetwork(source, args, account, gitAccounts, timeoutMs);
  }
  return sshCommand ? { args, env: { GIT_SSH_COMMAND: sshCommand } } : { args };
};

export const runGitNetwork = async (args: string[], options: GitOptions) => {
  const result = await runGit(args, options);
  if (result.ok) return result;
  const supported = /Unsupported SSL backend[\s\S]*?Supported SSL backends:\s*([\w-]+)/i.exec(result.stderr ?? '')?.[1];
  const retried = supported ? await runGit(['-c', `http.sslBackend=${supported}`, ...args], options) : result;
  if (!retried.ok) {
    console.warn('[guests] git network command failed:', (retried.stderr ?? '').trim() || 'no output');
  }
  return retried;
};

const AUTH_FAILURE_PATTERN = /Authentication failed|could not read (?:Username|Password)|Invalid username or (?:password|token)|HTTP Basic: Access denied|Permission denied \(publickey/i;

export const isGitAuthFailure = (stderr: string | undefined) => AUTH_FAILURE_PATTERN.test(stderr ?? '');

export const cloneGitRepository = async (source: string, dest: string, { gitBinary = 'git', timeoutMs = CLONE_TIMEOUT_MS, ref, gitIdentityId, gitAccounts }: CloneOptions = {}): Promise<CloneResult> => {
  if (ref !== undefined && !isGitRef(ref)) {
    return { ok: false, code: 'clone-failed' };
  }
  const network = await prepareGuestGitNetwork(source, { gitIdentityId, gitAccounts, timeoutMs }).catch(() => null);
  if (!network) {
    return { ok: false, code: 'clone-failed' };
  }
  const args = [...network.args, 'clone', '--depth', '1'];
  if (ref) {
    args.push('--branch', ref);
  }
  args.push('--', source, dest);
  const result = await runGitNetwork(args, { gitBinary, timeoutMs, env: network.env, baseEnv: network.baseEnv })
    .finally(() => network.release?.());
  if (result.ok) {
    return { ok: true };
  }
  return { ok: false, code: isGitAuthFailure(result.stderr) ? 'clone-auth-failed' : 'clone-failed' };
};
