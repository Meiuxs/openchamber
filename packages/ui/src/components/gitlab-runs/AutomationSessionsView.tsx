/**
 * The automation session archive.
 *
 * Automation sessions are hidden from the normal session list, so the runs
 * ledger is their index. Rows are grouped by issue — one issue is one run — so
 * every session that issue opened sits together, which is how a person follows
 * one problem from judgement to review. Opening a row opens its chat tab and
 * leaves this page; the session is hidden from the sidebar but still readable
 * by ID, with the run's worktree as the directory hint.
 */
import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { removeProjectWorktree } from '@/lib/worktrees/worktreeManager';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { removeAutomationSession } from './automationSessionRemoval';
import { useGitlabRuns } from './useGitlabRuns';
import { useRunAccounts } from './useRunAccounts';
import {
  clockOf,
  phaseLabelKey,
  projectLabelOf,
  type Phase,
  type Run,
} from './runModel';

const sessionsOf = (run: Run) => (
  run.sessions.length > 0
    ? run.sessions
    : run.sessionId
      ? [{ sessionId: run.sessionId, stage: run.phase, at: run.since }]
      : []
);

export const AutomationSessionsView: React.FC<{
  layout?: 'page' | 'mobile';
  onLeave: () => void;
}> = ({ onLeave }) => {
  const { t } = useI18n();
  const { runs, error, loading, refresh } = useGitlabRuns(null, { includeDone: true });
  const accountsFor = useRunAccounts();
  const projects = useProjectsStore((state) => state.projects);
  const [projectFilter, setProjectFilter] = React.useState('__all__');
  const [query, setQuery] = React.useState('');

  const openSession = React.useCallback((run: Run, sessionId: string) => {
    useSessionUIStore.getState().setCurrentSession(sessionId, run.worktreePath ?? undefined);
    onLeave();
  }, [onLeave]);

  const openRun = React.useCallback((run: Run) => {
    useUIStore.getState().setGitlabRunsPageProjectId(run.projectEntryId ?? '__all__');
  }, []);

  const allRuns = React.useMemo(() => runs ?? [], [runs]);
  const projectLabelFor = (run: Run) => projectLabelOf(projects.find((entry) => entry.id === run.projectEntryId));

  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [removedSessionIds, setRemovedSessionIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [removingSessionIds, setRemovingSessionIds] = React.useState<ReadonlySet<string>>(() => new Set());
  // A second deletion may be confirmed while the first request is in flight, so
  // the worktree decision reads the latest set rather than this render's copy.
  const removedSessionIdsRef = React.useRef<ReadonlySet<string>>(removedSessionIds);
  React.useEffect(() => {
    removedSessionIdsRef.current = removedSessionIds;
  }, [removedSessionIds]);

  // The ledger keeps its record; only the session on this machine goes away, so
  // the row stays and says what happened to it.
  const removeSession = React.useCallback(async (run: Run, sessionId: string) => {
    const accepted = await confirm({
      title: t('gitlabRuns.archive.delete.title'),
      message: t('gitlabRuns.archive.delete.message', { iid: run.iid }),
      action: t('gitlabRuns.archive.delete.action'),
      destructive: true,
    });
    if (!accepted) return;
    setRemovingSessionIds((previous) => new Set(previous).add(sessionId));
    try {
      const project = projects.find((entry) => entry.id === run.projectEntryId) ?? null;
      const removed = new Set(removedSessionIdsRef.current).add(sessionId);
      const result = await removeAutomationSession(
        { run, sessionId, project, runs: allRuns, removedSessionIds: removed },
        {
          setSessionDirectory: (id, directory) => useSessionUIStore.getState().setSessionDirectory(id, directory),
          deleteSessions: (ids) => useSessionUIStore.getState().deleteSessions(ids),
          removeWorktree: (target, worktree) => removeProjectWorktree(target, worktree, { deleteLocalBranch: true }),
        },
      );
      if (!result.deleted) {
        toast.error(t('gitlabRuns.archive.delete.failed'));
        return;
      }
      removedSessionIdsRef.current = removed;
      setRemovedSessionIds(removed);
      toast.success(t('gitlabRuns.archive.delete.done'));
      if (result.worktree === 'failed') toast.error(t('gitlabRuns.archive.delete.worktreeFailed'));
    } finally {
      setRemovingSessionIds((previous) => {
        const next = new Set(previous);
        next.delete(sessionId);
        return next;
      });
    }
  }, [allRuns, confirm, projects, t]);

  const issues = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allRuns.filter((run) => {
      if (projectFilter !== '__all__' && run.projectEntryId !== projectFilter) return false;
      if (!needle) return true;
      const stages = sessionsOf(run).map((session) => t(phaseLabelKey((session.stage ?? run.phase) as Phase))).join(' ');
      return `${run.title ?? ''} #${run.iid} ${stages}`.toLowerCase().includes(needle);
    });
  }, [allRuns, projectFilter, query, t]);

  const totalSessions = issues.reduce((sum, run) => sum + sessionsOf(run).length, 0);

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 px-4 pb-2 pt-4">
        <span className="typography-ui-label font-medium">{t('gitlabRuns.archive.title')}</span>
        <select
          value={projectFilter}
          onChange={(event) => setProjectFilter(event.target.value)}
          className="rounded-md bg-[var(--surface-subtle)] px-2 py-1 typography-meta text-foreground"
          aria-label={t('gitlabRuns.archive.project')}
        >
          <option value="__all__">{t('gitlabRuns.page.scope.global')}</option>
          {[...new Set(allRuns.map((run) => run.projectEntryId).filter((id): id is string => Boolean(id)))]
            .map((id) => (
              <option key={id} value={id}>
                {projectLabelOf(projects.find((project) => project.id === id)) || id}
              </option>
            ))}
        </select>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('gitlabRuns.archive.search')}
          className="w-48 rounded-md bg-[var(--surface-subtle)] px-2 py-1 typography-meta text-foreground placeholder:text-muted-foreground"
          aria-label={t('gitlabRuns.archive.search')}
        />
        <span className="typography-meta text-muted-foreground">
          {t('gitlabRuns.archive.counts', { issues: issues.length, sessions: totalSessions })}
        </span>
        <div className="ms-auto flex items-center gap-2">
          {error ? <Button size="sm" variant="outline" onClick={refresh}>{t('gitlabRuns.page.error.retry')}</Button> : null}
          <Button size="sm" variant="ghost" onClick={onLeave} aria-label={t('gitlabRuns.page.close')}>
            <Icon name="close" className="size-4" />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-8">
        {loading && runs === null ? (
          <p className="mt-8 px-2 typography-meta text-muted-foreground">{t('gitlabRuns.page.loading')}</p>
        ) : null}
        {!loading && issues.length === 0 ? (
          <div className="mt-8 px-2">
            <p className="typography-ui-label font-medium">{t('gitlabRuns.archive.empty.title')}</p>
            <p className="mt-1 typography-meta text-muted-foreground">{t('gitlabRuns.archive.empty.description')}</p>
          </div>
        ) : null}

        {issues.map((run) => {
          const sessions = sessionsOf(run);
          const projectLabel = projectLabelFor(run);
          const account = accountsFor(run.origin)[0];
          return (
            <section key={run.key} className="mb-2 rounded-lg bg-[var(--surface-subtle)]">
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className={cn(
                  'size-2 shrink-0 rounded-full',
                  run.phase === 'blocked' ? 'bg-[var(--status-error-text)]'
                    : run.phase === 'waiting-approval' ? 'bg-[var(--status-warning-text)]'
                      : run.phase === 'done' ? 'bg-[var(--status-success)]' : 'bg-[var(--status-info)]',
                )}
                />
                <span className="min-w-0 truncate typography-ui-label font-medium">
                  #{run.iid} {run.title ?? run.key}
                </span>
                {projectLabel ? (
                  <span className="rounded-full bg-[var(--surface-elevated)] px-2 py-0.5 typography-meta text-muted-foreground">
                    {projectLabel}
                  </span>
                ) : null}
                <span className="typography-meta text-muted-foreground">{t(phaseLabelKey(run.phase as Phase))}</span>
                <span className="typography-meta text-muted-foreground">
                  {t('gitlabRuns.archive.sessionsCount', { count: sessions.length })}
                </span>
                {account ? <span className="typography-meta text-muted-foreground">@{account.username}</span> : null}
                <button
                  type="button"
                  onClick={() => openRun(run)}
                  className="ms-auto shrink-0 typography-meta text-[var(--primary-text)] hover:underline"
                >
                  {t('gitlabRuns.archive.viewRun')}
                </button>
              </div>
              <div className="ms-5 border-s border-edge-muted pb-1 ps-3">
                {sessions.map((session) => {
                  const removed = removedSessionIds.has(session.sessionId);
                  const removing = removingSessionIds.has(session.sessionId);
                  return (
                    <div
                      key={session.sessionId}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 typography-meta hover:bg-[var(--surface-elevated)]"
                    >
                      <button
                        type="button"
                        onClick={() => openSession(run, session.sessionId)}
                        disabled={removed || removing}
                        className="flex min-w-0 flex-1 items-center gap-2 text-start disabled:cursor-default"
                      >
                        <span className={cn('min-w-0 flex-1 truncate text-foreground', removed && 'text-muted-foreground line-through')}>
                          {t(phaseLabelKey((session.stage ?? run.phase) as Phase))}
                        </span>
                        {session.at ? (
                          <span className="shrink-0 tabular-nums text-muted-foreground">{clockOf(session.at)}</span>
                        ) : null}
                        {removed ? null : (
                          <span className="shrink-0 text-[var(--primary-text)]">{t('gitlabRuns.detail.logDetail')}</span>
                        )}
                      </button>
                      {removed ? (
                        <span className="shrink-0 rounded-full bg-[var(--surface-subtle)] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {t('gitlabRuns.archive.deleted')}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => { void removeSession(run, session.sessionId); }}
                          disabled={removing}
                          aria-label={t('gitlabRuns.archive.deleteSession', { iid: run.iid })}
                          title={t('gitlabRuns.archive.deleteSession', { iid: run.iid })}
                          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-[var(--surface-subtle)] hover:text-[var(--status-error-text)] disabled:opacity-40"
                        >
                          <Icon name="delete-bin" className="size-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      {confirmDialog}
    </div>
  );
};

export const AutomationSessionsViewPage: React.FC = () => {
  const open = useUIStore((state) => state.isAutomationSessionsPageOpen);
  const openCount = useUIStore((state) => state.automationSessionsPageOpenCount);
  const setOpen = useUIStore((state) => state.setAutomationSessionsPageOpen);
  const leave = React.useCallback(() => setOpen(false), [setOpen]);
  if (!open) return null;
  return <AutomationSessionsView key={openCount} onLeave={leave} />;
};
