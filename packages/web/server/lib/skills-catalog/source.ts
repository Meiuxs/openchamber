import { allowedInsecureGitOrigins } from '../enterprise-mode.js';
import type { EnterprisePolicyOptions } from '../enterprise-mode.js';

const GITHUB_HOST = 'github.com';

interface SourceOptions {
  subpath?: string | null | undefined;
  policy?: EnterprisePolicyOptions;
}

function isAllowedPlainHttpOrigin(raw: string, options: SourceOptions) {
  try {
    return allowedInsecureGitOrigins(options.policy).has(new URL(raw).origin);
  } catch {
    return false;
  }
}

interface ParsedSourceBase {
  ok: true;
  host: string | null | undefined;
  owner: string;
  repo: string;
  cloneUrlSsh: string;
  cloneUrlHttps: string;
  effectiveSubpath: string | null;
  normalizedRepo: string;
}

interface InvalidSource {
  ok: false;
  error: { kind: 'invalidSource'; message: string };
}

const isSourceString = (value: unknown): value is string => typeof value === 'string';

function normalizeGitOwnerRepo(owner: string | null | undefined, repo: string | null | undefined) {
  const normalizedOwner = String(owner || '').trim();
  const normalizedRepo = String(repo || '').trim().replace(/\.git$/i, '');
  if (!normalizedOwner || !normalizedRepo) {
    return null;
  }
  return { owner: normalizedOwner, repo: normalizedRepo };
}


const GIT_REF_PATTERN = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

function readHttpSource(raw: string) {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    return {
      host: url.hostname.toLowerCase(),
      port: url.port,
      pathSegments: url.pathname.split('/').filter(Boolean),
    };
  } catch {
    return null;
  }
}

function readSshSource(raw: string) {
  const withoutUser = raw.split('@')[1];
  if (!withoutUser) return null;
  const hostPart = withoutUser.split(':')[0];
  const portPart = withoutUser.split(':')[1] ?? '';
  const port = portPart.match(/^\d+/)?.[0] ?? '';
  return hostPart ? { host: hostPart.toLowerCase(), port } : null;
}

function splitSourceRef(source: string) {
  const hashIndex = source.lastIndexOf('#');
  if (hashIndex < 0) return { base: source, ref: null };
  const ref = source.slice(hashIndex + 1).trim();
  return { base: source.slice(0, hashIndex).trim(), ref: ref || null };
}

export function parseSkillRepoSource(input?: string | null, options: SourceOptions = {}): (ParsedSourceBase & { ref: string | null }) | InvalidSource {
  const parsed = parseSkillRepoBase(input, options);
  if (!parsed.ok) return parsed;
  const { ref } = splitSourceRef(isSourceString(input) ? input.trim() : '');
  if (ref !== null && !GIT_REF_PATTERN.test(ref)) {
    return { ok: false, error: { kind: 'invalidSource', message: `Invalid branch or tag "${ref}"` } };
  }
  return { ...parsed, ref };
}

function parseSkillRepoBase(input: string | null | undefined, options: SourceOptions): ParsedSourceBase | InvalidSource {
  const raw = splitSourceRef(isSourceString(input) ? input.trim() : '').base;
  if (!raw) {
    return { ok: false, error: { kind: 'invalidSource', message: 'Repository source is required' } };
  }
  const explicitSubpath = isSourceString(options.subpath) && options.subpath.trim() ? options.subpath.trim() : null;

  const isPlainHttp = raw.slice(0, 7).toLowerCase() === 'http://';
  if (isPlainHttp && !isAllowedPlainHttpOrigin(raw, options)) {
    return { ok: false, error: { kind: 'invalidSource', message: 'Plain HTTP sources must be listed in allowedInsecureGitOrigins' } };
  }

  const urlFormat = raw.startsWith('https://') || isPlainHttp ? 'https' : raw.startsWith('git@') ? 'ssh' : 'shorthand';
  const scheme = isPlainHttp ? 'http' : 'https';
  const urlParts = urlFormat === 'https' ? readHttpSource(raw) : null;
  const sshParts = urlFormat === 'ssh' ? readSshSource(raw) : null;
  const gitHost = urlParts ? urlParts.host : sshParts ? sshParts.host : null;

  if (gitHost === null && urlFormat !== 'shorthand') {
    return { ok: false, error: { kind: 'invalidSource', message: 'Invalid repository URL format' } };
  }

  const sshPath = raw.split('@')[1] ?? '';
  const pathSegments = urlParts
    ? urlParts.pathSegments
    : urlFormat === 'ssh'
      ? (sshPath.split(':')[1] ?? '').split('/').filter(Boolean)
      : null;

  const repoName = pathSegments && pathSegments.length > 0
    ? pathSegments.at(-1)?.replace(/\.git$/i, '') ?? null
    : null;

  const gitOwner = pathSegments && pathSegments.length > 1
    ? pathSegments.slice(0, -1).join('/')
    : (pathSegments && pathSegments.length === 1 ? pathSegments[0] : null);


  if (urlFormat === 'ssh' || urlFormat === 'https') {
    const parsed = normalizeGitOwnerRepo(gitOwner, repoName);
    if (!parsed) {
      return { ok: false, error: { kind: 'invalidSource', message: `Invalid ${urlFormat} repository URL` } };
    }

    const sourcePort = urlParts ? urlParts.port : sshParts ? sshParts.port : '';
    const sshCloneUrl = sourcePort
      ? `ssh://git@${gitHost}:${sourcePort}/${parsed.owner}/${parsed.repo}.git`
      : `git@${gitHost}:${parsed.owner}/${parsed.repo}.git`;

    return {
      ok: true,
      host: gitHost,
      owner: parsed.owner,
      repo: parsed.repo,
      cloneUrlSsh: sshCloneUrl,
      cloneUrlHttps: `${scheme}://${sourcePort ? `${gitHost}:${sourcePort}` : gitHost}/${parsed.owner}/${parsed.repo}.git`,
      effectiveSubpath: explicitSubpath,
      normalizedRepo: `${parsed.owner}/${parsed.repo}`,
    };
  }

  const shorthandMatch = raw.match(/^([^/\s]+)\/([^/\s]+)(?:\/(.+))?$/);
  if (shorthandMatch) {
    const parsed = normalizeGitOwnerRepo(shorthandMatch[1], shorthandMatch[2]);
    if (!parsed) {
      return { ok: false, error: { kind: 'invalidSource', message: 'Invalid repository source' } };
    }

    const shorthandSubpath = shorthandMatch[3]?.trim() || null;
    const effectiveSubpath = explicitSubpath || shorthandSubpath;

    return {
      ok: true,
      host: GITHUB_HOST,
      owner: parsed.owner,
      repo: parsed.repo,
      cloneUrlSsh: `git@github.com:${parsed.owner}/${parsed.repo}.git`,
      cloneUrlHttps: `https://github.com/${parsed.owner}/${parsed.repo}.git`,
      effectiveSubpath,
      normalizedRepo: `${parsed.owner}/${parsed.repo}`,
    };
  }

  return { ok: false, error: { kind: 'invalidSource', message: 'Unsupported repository source format' } };
}
