/**
 * Asking the server to act on one run.
 *
 * The action is cast as the bound account the caller names, exactly as the
 * runs page does it: the same route, the same timeout, and the server's own
 * error code passed back to the caller to translate.
 */
import { runtimeFetch } from '@/lib/runtime-fetch';

import type { RunAction } from './runModel';

export const requestRunAction = async (input: {
  directory: string;
  key: string;
  action: RunAction;
  accountId: string;
}): Promise<void> => {
  const response = await runtimeFetch('/api/gitlab-issues/runs/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify(input),
  });
  // SAFETY: the error body is the server's `{ error: code }` envelope; a body
  // the fetch could not read falls back to the status-line message.
  const data = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(data?.error ?? `gitlab-runs ${response.status}`);
};
