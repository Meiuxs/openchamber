import { fetchWithTimeout, GitLabRequestError } from './network.js';
import { parseGitLabUser } from './user.js';

// A personal access token travels as a bearer token on current GitLab releases.
// Self-managed instances that predate that accept it only in the PRIVATE-TOKEN
// header and answer 401 to the bearer form (12.7 among them), so a refused
// first attempt is repeated once with the older header before the token is
// called invalid.
const credentialHeaders = (token) => [
  { Accept: 'application/json', Authorization: `Bearer ${token}` },
  { Accept: 'application/json', 'PRIVATE-TOKEN': token },
];

export async function verifyGitLabToken({ origin, token, fetch: fetchImpl = fetch, timeoutMs = 10_000 }) {
  let response = null;
  for (const headers of credentialHeaders(token)) {
    try {
      response = await fetchWithTimeout(fetchImpl, `${origin}/api/v4/user`, { headers }, timeoutMs);
    } catch (error) {
      throw new GitLabRequestError('unreachable', error?.message || 'GitLab instance is unreachable');
    }
    if (response.status !== 401) break;
  }
  if (response.status === 401) throw new GitLabRequestError('invalid-token', 'GitLab token is invalid', response.status);
  if (response.status === 403) throw new GitLabRequestError('unavailable', 'GitLab token verification is forbidden', response.status);
  if (response.status === 429 || response.status >= 500) throw new GitLabRequestError('temporarily-unavailable', 'GitLab is temporarily unavailable', response.status);
  if (!response.ok) throw new GitLabRequestError('provider-error', 'Failed to verify GitLab token', response.status);
  return parseGitLabUser(await response.json());
}
