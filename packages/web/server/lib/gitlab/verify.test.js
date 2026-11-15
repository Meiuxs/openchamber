import { describe, expect, it, vi } from 'vitest';
import { verifyGitLabToken } from './verify.js';

const json = (body, status = 200) => Response.json(body, { status });
const user = () => json({ id: 9, username: 'root', name: 'Administrator' });
const origin = 'http://localhost:8929';

describe('GitLab token verification', () => {
  it('sends a bearer token first', async () => {
    const fetch = vi.fn(async () => user());
    await expect(verifyGitLabToken({ origin, token: 'pat', fetch })).resolves.toMatchObject({ id: 9, login: 'root' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer pat' });
  });

  it('retries with the private-token header when an older instance refuses the bearer form', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ message: '401 Unauthorized' }, 401))
      .mockResolvedValueOnce(user());

    await expect(verifyGitLabToken({ origin, token: 'pat', fetch })).resolves.toMatchObject({ id: 9 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].headers).toMatchObject({ 'PRIVATE-TOKEN': 'pat' });
  });

  it('calls the token invalid once both headers are refused', async () => {
    const fetch = vi.fn(async () => json({ message: '401 Unauthorized' }, 401));
    await expect(verifyGitLabToken({ origin, token: 'bad', fetch })).rejects.toMatchObject({ kind: 'invalid-token', status: 401 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a forbidden verification', async () => {
    const fetch = vi.fn(async () => json({ message: '403 Forbidden' }, 403));
    await expect(verifyGitLabToken({ origin, token: 'pat', fetch })).rejects.toMatchObject({ kind: 'unavailable', status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
