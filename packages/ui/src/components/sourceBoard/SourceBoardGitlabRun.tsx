/**
 * What the GitLab automation is doing with the item the board is showing.
 *
 * The ledger answers per directory, not per item, so one read covers the whole
 * repository and the row picks its own entry: an issue by `iid`, a change
 * request by `mrIid`. A run that already finished is not shown here — the runs
 * page keeps the history, and a board preview is about the item now.
 *
 * Approving or rejecting a plan stays on the runs page: that decision wants the
 * context of the whole list, while canceling, resetting and taking over are
 * things a person does because this one item is stuck.
 */
import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { RunRail, SessionDot } from '@/components/gitlab-runs/RunRail';
import {
  formatAge,
  guideKey,
  isActiveRun,
  phaseLabelKey,
  type Phase,
  type RunAction,
} from '@/components/gitlab-runs/runModel';
import { requestRunAction } from '@/components/gitlab-runs/runAction';
import { SessionTrail } from '@/components/gitlab-runs/SessionTrail';
import { useGitlabRuns } from '@/components/gitlab-runs/useGitlabRuns';
import { useRunAccounts } from '@/components/gitlab-runs/useRunAccounts';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';

export const SourceBoardGitlabRun: React.FC<{
  /** The repository the item was listed from; the ledger is read for it. */
  directory: string;
  /** The item's number: an issue's `iid`, or a change request's `mrIid`. */
  number: number;
  kind: 'issue' | 'pull';
}> = ({ directory, number, kind }) => {
  const { t } = useI18n();
  const accountsFor = useRunAccounts();
  const { runs, refresh } = useGitlabRuns(directory, { pollWhileActive: true });
  const [busy, setBusy] = React.useState(false);

  const run = React.useMemo(() => {
    const found = (runs ?? []).find((entry) => (
      kind === 'issue' ? entry.iid === number : entry.mrIid === number
    ));
    return found && isActiveRun(found) ? found : null;
  }, [kind, number, runs]);

  const act = React.useCallback(async (action: RunAction) => {
    if (!run) return;
    const options = accountsFor(run.origin);
    const account = options[0];
    if (!account) {
      toast.error(t('gitlabRuns.action.settings'));
      return;
    }
    // More than one candidate would make the action's attribution a guess.
    if (options.length > 1) {
      toast.error(t('gitlabRuns.action.settings'));
      return;
    }
    setBusy(true);
    try {
      await requestRunAction({
        directory,
        key: run.key,
        action,
        accountId: account.reference.accountId,
      });
      refresh();
    } catch (failure) {
      toast.error(t('gitlabRuns.page.error.detail'), {
        description: failure instanceof Error ? failure.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }, [accountsFor, directory, refresh, run, t]);

  if (!run) return null;

  // SAFETY: the ledger only fills `phase` with a phase name (or `blocked`).
  const phase = run.phase as Phase;
  const blocked = phase === 'blocked';
  const age = formatAge(run.since ?? run.updatedAt);
  const sessionId = run.sessionId;
  const mrUrl = run.mrUrl;
  // Ambiguous attribution: the buttons wait for the person to pick an account.
  const multiAccounts = accountsFor(run.origin).length > 1;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 typography-meta">
        <span className="font-medium text-foreground">{t('sourceBoard.gitlabRun.title')}</span>
        <span
          className={cn('inline-flex items-center gap-1 font-medium', !blocked && 'text-muted-foreground')}
          style={blocked
            ? { color: 'var(--status-error-text)' }
            : phase === 'waiting-approval' ? { color: 'var(--status-warning-text)' } : undefined}
        >
          {blocked ? <Icon name="error-warning" className="size-3" /> : null}
          {t(phaseLabelKey(phase))}
        </span>
        {age ? <span className="text-muted-foreground">{age}</span> : null}
        {run.feedbackRounds > 0 ? (
          <span className="text-muted-foreground">{t('gitlabRuns.feedback.round', { round: run.feedbackRounds })}</span>
        ) : null}
        {run.branch ? <code className="truncate text-[11px] text-muted-foreground">{run.branch}</code> : null}
        {sessionId ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-foreground hover:underline"
            onClick={() => useSessionUIStore.getState().setCurrentSession(sessionId, run.worktreePath ?? undefined)}
          >
            <SessionDot status={run.sessionStatus} />
            {t('gitlabRuns.action.openSession')}
          </button>
        ) : null}
        {mrUrl ? (
          <a
            href={mrUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[var(--primary-text)] hover:underline"
          >
            MR !{run.mrIid}
            <Icon name="external-link" className="size-3" />
          </a>
        ) : null}
        <span className="ms-auto flex items-center gap-1">
          {blocked ? (
            <>
              {run.blockedReason === 'missing-credential' ? (
                <Button size="sm" variant="outline" disabled={busy || multiAccounts} onClick={() => void act('take')}>
                  {t('gitlabRuns.action.takeOver')}
                </Button>
              ) : null}
              <Button size="sm" variant="outline" disabled={busy || multiAccounts} onClick={() => void act('reset')}>
                {t('gitlabRuns.action.reset')}
              </Button>
            </>
          ) : phase === 'waiting-approval' ? null : (
            <Button size="sm" variant="ghost" disabled={busy || multiAccounts} onClick={() => void act('cancel')}>
              {t('gitlabRuns.action.cancelRun')}
            </Button>
          )}
        </span>
      </div>
      <RunRail run={run} />
      {/* The sessions the fix and its reviews opened stay reachable from the
          folded card: the panel's step view is one click further away. */}
      <div className="mt-1 ps-5">
        <SessionTrail run={run} />
      </div>
      {blocked ? (
        <p className="rounded-md bg-[var(--status-error-background)] px-3 py-2 typography-meta text-[var(--status-error-text)]">
          {t(guideKey(run.blockedReason))}
        </p>
      ) : null}
    </div>
  );
};
