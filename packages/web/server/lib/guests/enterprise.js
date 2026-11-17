import { requestedGuestCapabilities } from '@openchamber/sdk';

import { readEnterprisePolicy } from '../enterprise-mode.js';

/**
 * Enterprise mode and extensions. An extension that can send what it sees
 * off this machine answers to the administrator:
 * - `network`: host requests to its integration's API origin;
 * - `origins`: its frame fetching approved https origins directly;
 * - `service`: an unsandboxed process with the user's access;
 * - `transcript`: session content (the agent's answers, questions and
 *   permission requests) posted to that process, so it is gated with it;
 * - `sessionControl`: that process starting sessions and sending to them;
 * - `sessionAnswers`: that process allowing what the agent asks to do;
 * - `instructions` and `skills`: text every agent reads, which can steer what
 *   it sends where;
 * - `opencodePlugin`: code that runs inside OpenCode itself, with every
 *   provider call and tool result in reach.
 * - `opencode`: that process reading sessions, messages and live events from
 *   OpenCode.
 * Such a package installs and runs from a Git repository listed in the
 * policy (`allowedExtensions`; an entry ending in `/` allows every
 * repository under it, such as a whole organization), from an offline `.zip`
 * archive (`source === 'zip'`), or from a local folder where
 * `allowLocalExtensions` is set for developers. Everything else installs as
 * usual.
 * The list names repositories, not package ids: a package declares its own
 * id, so an id would let a user ship any code under an allowed name.
 */
const ENTERPRISE_GATED_CAPABILITIES = ['network', 'origins', 'service', 'transcript', 'sessionControl', 'sessionAnswers', 'instructions', 'skills', 'opencodePlugin', 'opencode'];

const repositoryKey = (value) => {
  const trimmed = String(value).trim().replace(/#.*$/, '');
  const scp = trimmed.match(/^[^@/\s]+@([^:/\s]+):(.+)$/);
  let host;
  let pathname;
  if (scp) {
    [, host, pathname] = scp;
  } else {
    try {
      const url = new URL(trimmed);
      host = url.hostname;
      pathname = url.pathname;
    } catch {
      return null;
    }
  }
  const cleanPath = pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  return cleanPath ? `${host.toLowerCase()}/${cleanPath}` : null;
};

const isAllowedRepository = (gitUrl, allowed) => {
  const key = gitUrl ? repositoryKey(gitUrl) : null;
  if (key === null) return false;
  return allowed.some((entry) => {
    const allowedKey = repositoryKey(entry);
    if (allowedKey === null) return false;
    return entry.trim().endsWith('/') ? key.startsWith(`${allowedKey}/`) : key === allowedKey;
  });
};

export const enterpriseBlockedCapabilities = (guest, { source, gitUrl } = {}, policy = readEnterprisePolicy()) => {
  if (!policy.enterpriseMode) return [];
  const gated = requestedGuestCapabilities(guest).filter((capability) => ENTERPRISE_GATED_CAPABILITIES.includes(capability));
  if (gated.length === 0) return [];
  if (source === 'zip') return [];
  if (source === 'git' && isAllowedRepository(gitUrl, policy.allowedExtensions)) return [];
  if (source === 'path' && policy.allowLocalExtensions) return [];
  return gated;
};
