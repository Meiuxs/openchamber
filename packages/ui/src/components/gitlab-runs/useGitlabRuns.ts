/**
 * The runs ledger of one directory (or of every project, when `null`).
 *
 * The page polls while it is open. The board's per-item status asks for
 * `pollWhileActive` instead: the ledger answers for a whole directory, so
 * polling a preview that has no active run asks the same question every ten
 * seconds and gets the same answer.
 */
import * as React from 'react';

import { runtimeFetch } from '@/lib/runtime-fetch';

import { shouldPollRuns } from './polling';
import { POLL_INTERVAL_MS, runsResponseSchema, type Run } from './runModel';

type RunsState = {
  runs: Run[] | null;
  bot: 'valid' | 'invalid' | 'missing' | null;
  error: boolean;
  loading: boolean;
  // The directory is not bound to GitLab at all. That is not a ledger failure,
  // so it gets its own answer instead of the "ledger could not be read" panel.
  notBound: boolean;
};

type UseGitlabRunsResult = RunsState & { refresh: () => void };

export const useGitlabRuns = (
  directory: string | null,
  options?: { pollWhileActive?: boolean; includeDone?: boolean },
): UseGitlabRunsResult => {
  const pollWhileActive = options?.pollWhileActive === true;
  const includeDone = options?.includeDone === true;
  const [state, setState] = React.useState<RunsState>({
    runs: null, bot: null, error: false, loading: true, notBound: false,
  });
  const revision = React.useRef(0);

  const load = React.useCallback(async () => {
    const current = ++revision.current;
    try {
      const query = new URLSearchParams();
      if (directory) query.set('directory', directory);
      if (includeDone && !directory) query.set('includeDone', '1');
      const suffix = query.toString();
      const url = `/api/gitlab-issues/runs${suffix ? `?${suffix}` : ''}`;
      const response = await runtimeFetch(url);
      if (!response.ok) {
        // SAFETY: the error body is the server's `{ error: code }` envelope;
        // only its unbound-project codes are read here, anything else stays a
        // failure.
        const body = await response.json().catch(() => null) as { error?: string } | null;
        const unbound = body?.error === 'not-gitlab-project' || body?.error === 'project-not-found';
        if (unbound) {
          if (current !== revision.current) return;
          setState({ runs: [], bot: null, error: false, loading: false, notBound: true });
          return;
        }
        throw new Error(`gitlab-runs ${response.status}`);
      }
      const parsed = runsResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('invalid gitlab-runs payload');
      if (current !== revision.current) return;
      setState({
        runs: parsed.data.runs,
        bot: parsed.data.bot?.status ?? null,
        error: false,
        loading: false,
        notBound: false,
      });
    } catch {
      if (current !== revision.current) return;
      // A failed read keeps the last list visible and says so.
      setState((previous) => ({ ...previous, error: true, loading: false }));
    }
  }, [directory, includeDone]);

  React.useEffect(() => {
    setState((previous) => ({ ...previous, loading: previous.runs === null }));
    void load();
  }, [load]);

  const runs = state.runs;
  // Without an active run there is nothing a poll could change; a person who
  // just labeled the issue refreshes, or comes back to the page.
  const polling = shouldPollRuns(runs, pollWhileActive);

  React.useEffect(() => {
    if (!polling) return undefined;
    const tick = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const timer = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load, polling]);

  // Coming back to the tab reads once even when polling has stopped, so a run
  // that started elsewhere shows up without a manual refresh.
  React.useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  return { ...state, refresh: () => { void load(); } };
};
