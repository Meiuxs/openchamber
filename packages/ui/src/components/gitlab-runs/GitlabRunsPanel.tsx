/**
 * The GitLab automation runs page.
 *
 * Two levels rather than a split: the list gets the whole width to scan, and a
 * run opens into its own full-width report. A split view squeezed the report
 * into a narrow column, which is the opposite of what the page is for.
 *
 * The page reads the server's run ledger and acts through the same GitLab
 * labels and comment commands a person would type, always as the acting bound
 * account; it never writes the ledger. That account may be the project's bot
 * account too — the dispatcher tags its own notes with a hidden marker rather
 * than relying on author identity, so one GitLab account can serve both roles.
 */
import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { RunDetail } from './RunDetail';
import {
  formatAge,
  phaseLabelKey,
  projectLabelOf,
  runActionCommand,
  runActionKind,
  type Phase,
  type Run,
  type RunAction as Action,
} from './runModel';
import { requestRunAction } from './runAction';
import { useGitlabRuns } from './useGitlabRuns';
import { useRunAccounts } from './useRunAccounts';

type PendingAction = {
  run: Run;
  action: Action;
  accountId: string;
  /** `@root`: the address that will appear on the issue, not the whole identity. */
  accountName: string;
  kind: 'comment' | 'labels';
};

type StatusFilter = 'all' | 'waiting' | 'blocked' | 'active' | 'done';

const STATUS_OF: Record<string, StatusFilter> = {
  'waiting-approval': 'waiting',
  blocked: 'blocked',
  done: 'done',
};

const statusOf = (phase: string): StatusFilter => STATUS_OF[phase] ?? 'active';

/** What each label-moving action does to the issue, so the confirmation can say it. */
const labelChangeOf = (action: Action): { add: string[]; remove: string[] } | null => {
  if (action === 'reset') return { add: ['ai-ready'], remove: ['ai-blocked'] };
  if (action === 'cancel') return { add: ['ai-blocked'], remove: ['ai-working'] };
  return null;
};

const RunRow: React.FC<{
  run: Run;
  projectLabel: string;
  onSelect: () => void;
}> = ({ run, projectLabel, onSelect }) => {
  const { t } = useI18n();
  const phase = run.phase as Phase;
  const waiting = phase === 'waiting-approval';
  const blocked = phase === 'blocked';
  const age = formatAge(run.since ?? run.updatedAt);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-start hover:bg-[var(--surface-subtle)]"
    >
      <span className={cn(
        'size-2 shrink-0 rounded-full',
        blocked ? 'bg-[var(--status-error-text)]' : waiting ? 'bg-[var(--status-warning-text)]' : 'bg-[var(--status-info)]',
      )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate typography-ui-label font-medium">{run.title ?? run.key}</span>
          <span className="shrink-0 typography-meta text-muted-foreground">#{run.iid}</span>
          {projectLabel ? (
            <span className="shrink-0 rounded-full bg-[var(--surface-subtle)] px-2 py-0.5 typography-meta text-muted-foreground">
              {projectLabel}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 typography-meta text-muted-foreground">
          <span className={cn(
            'font-medium',
            blocked && 'text-[var(--status-error-text)]',
            waiting && 'text-[var(--status-warning-text)]',
          )}
          >
            {t(phaseLabelKey(phase))}
          </span>
          {run.feedbackRounds > 0 ? <span>{t('gitlabRuns.feedback.round', { round: run.feedbackRounds })}</span> : null}
          {run.mrUrl ? <span>MR !{run.mrIid}</span> : null}
          {age ? <span>{age}</span> : null}
        </div>
      </div>
      <Icon name="arrow-right" className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
};

export const GitlabRunsPanel: React.FC<{
  embedded?: boolean;
  directory?: string | null;
  projectId?: string | null;
}> = ({ embedded = false, directory: embeddedDirectory, projectId: embeddedProjectId }) => {
  const { t } = useI18n();
  const pageProjectId = useUIStore((state) => state.gitlabRunsPageProjectId);
  const projectId = embedded ? (embeddedProjectId ?? null) : pageProjectId;
  const projects = useProjectsStore((state) => state.projects);
  const project = projects.find((entry) => entry.id === projectId) ?? null;
  const scopeGlobal = !embedded && projectId === '__all__';
  const lastProjectId = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (project) lastProjectId.current = project.id;
  }, [project]);
  const directory = embedded ? (embeddedDirectory ?? null) : scopeGlobal ? null : (project?.path ?? null);
  const { runs, bot, error, loading, notBound, refresh } = useGitlabRuns(directory);
  const [pending, setPending] = React.useState<PendingAction | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<StatusFilter>('all');
  const [query, setQuery] = React.useState('');

  const accountsFor = useRunAccounts();

  const close = React.useCallback(() => {
    useUIStore.getState().setGitlabRunsPageProjectId(null);
  }, []);

  const openProjectSettings = React.useCallback((forProjectId?: string | null) => {
    const target = forProjectId ?? project?.id ?? null;
    if (!target) return;
    const ui = useUIStore.getState();
    ui.setGitlabRunsPageProjectId(null);
    ui.setSettingsProjectsSelectedId(target);
    ui.setSettingsPage('projects');
    ui.setSettingsDialogOpen(true);
  }, [project]);

  const openSession = React.useCallback((run: Run, sessionId: string) => {
    // Leave the runs page first: ChatView is hidden while a surface page is
    // open, so a session opened behind it would look like nothing happened.
    useSessionUIStore.getState().setCurrentSession(sessionId, run.worktreePath ?? undefined);
    if (!embedded) useUIStore.getState().setGitlabRunsPageProjectId(null);
  }, [embedded]);

  const submit = React.useCallback(async () => {
    if (!pending) return;
    const target = project ?? projects.find((entry) => entry.id === pending.run.projectEntryId) ?? null;
    if (!target) {
      toast.error(t('gitlabRuns.page.error.detail'));
      return;
    }
    setSubmitting(true);
    try {
      await requestRunAction({
        directory: target.path,
        key: pending.run.key,
        action: pending.action,
        accountId: pending.accountId,
      });
      setPending(null);
      refresh();
    } catch (failure) {
      toast.error(t('gitlabRuns.page.error.detail'), {
        description: failure instanceof Error ? failure.message : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  }, [pending, project, projects, refresh, t]);

  const requestAction = React.useCallback((run: Run, action: Action) => {
    const options = accountsFor(run.origin);
    if (options.length === 0) {
      toast.error(t('gitlabRuns.action.settings'));
      return;
    }
    setPending({
      run,
      action,
      accountId: options[0].reference.accountId,
      accountName: `@${options[0].username}`,
      kind: runActionKind(action),
    });
  }, [accountsFor, t]);

  const allRuns = React.useMemo(() => runs ?? [], [runs]);
  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allRuns.filter((run) => {
      if (filter !== 'all' && statusOf(run.phase) !== filter) return false;
      if (!needle) return true;
      return `${run.title ?? ''} #${run.iid}`.toLowerCase().includes(needle);
    });
  }, [allRuns, filter, query]);
  const counts = React.useMemo(() => ({
    all: allRuns.length,
    waiting: allRuns.filter((run) => statusOf(run.phase) === 'waiting').length,
    blocked: allRuns.filter((run) => statusOf(run.phase) === 'blocked').length,
    active: allRuns.filter((run) => statusOf(run.phase) === 'active').length,
    done: allRuns.filter((run) => statusOf(run.phase) === 'done').length,
  }), [allRuns]);
  const projectLabelFor = (run: Run) => projectLabelOf(projects.find((entry) => entry.id === run.projectEntryId));
  const selected = allRuns.find((run) => run.key === selectedKey) ?? null;
  const selectedAccount = selected ? accountsFor(selected.origin) : [];

  const actionLabel = (action: Action): I18nKey => ({
    cancel: 'gitlabRuns.action.cancelRun',
    reset: 'gitlabRuns.action.reset',
    approve: 'gitlabRuns.action.approve',
    reject: 'gitlabRuns.action.reject',
    take: 'gitlabRuns.action.takeOver',
  } satisfies Record<Action, I18nKey>)[action];

  const labelChangeLine = (action: Action) => {
    const change = labelChangeOf(action);
    if (!change) return null;
    return (
      <span className="mt-2 block tabular-nums">
        {[
          ...change.add.map((label) => t('gitlabRuns.confirm.add', { labels: label })),
          ...change.remove.map((label) => t('gitlabRuns.confirm.remove', { labels: label })),
        ].join(' · ')}
      </span>
    );
  };

  if (selected) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <RunDetail
          run={selected}
          account={selectedAccount.length > 0 ? `@${selectedAccount[0].username}` : null}
          multiAccounts={selectedAccount.length > 1}
          onBack={() => setSelectedKey(null)}
          onOpenSession={(sessionId) => openSession(selected, sessionId)}
          onAction={requestAction}
          onOpenSettings={openProjectSettings}
        />
      </div>
    );
  }

  const filterChip = (value: StatusFilter, label: string, count: number) => (
    <button
      key={value}
      type="button"
      onClick={() => setFilter(value)}
      className={cn(
        'rounded-full px-2.5 py-1 typography-meta',
        filter === value
          ? 'bg-[var(--selected-bg)] font-medium text-[var(--primary-text)]'
          : 'text-muted-foreground hover:bg-[var(--surface-subtle)]',
      )}
    >
      {label} <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {embedded ? null : (
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-2 pt-4">
          <span className="typography-ui-label font-medium">{t('gitlabRuns.page.title')}</span>
          <span className="min-w-0 truncate typography-meta text-muted-foreground">
            {scopeGlobal ? t('gitlabRuns.page.scope.global') : projectLabelOf(project)}
          </span>
          <div className="ms-auto flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-md bg-[var(--surface-subtle)] p-0.5">
              <Button
                size="sm"
                variant={scopeGlobal ? 'ghost' : 'secondary'}
                onClick={() => {
                  const target = project?.id ?? lastProjectId.current;
                  if (target) useUIStore.getState().setGitlabRunsPageProjectId(target);
                }}
                disabled={!project && !lastProjectId.current}
              >
                {t('gitlabRuns.page.scope.project')}
              </Button>
              <Button
                size="sm"
                variant={scopeGlobal ? 'secondary' : 'ghost'}
                onClick={() => { useUIStore.getState().setGitlabRunsPageProjectId('__all__'); }}
              >
                {t('gitlabRuns.page.scope.global')}
              </Button>
            </div>
            <Button size="sm" variant="ghost" onClick={close} aria-label={t('gitlabRuns.page.close')}>
              <Icon name="close" className="size-4" />
            </Button>
          </div>
        </header>
      )}

      <div className={cn('min-h-0 flex-1 overflow-y-auto', embedded && 'pt-4')}>
        {bot === 'invalid' || bot === 'missing' ? (
          <div className="mx-4 mb-3 rounded-lg bg-[var(--status-error-background)] px-4 py-3">
            <p className="typography-ui-label font-medium text-[var(--status-error-text)]">
              {t('gitlabRuns.page.botInvalid.title')}
            </p>
            <p className="mt-1 typography-meta text-muted-foreground">{t('gitlabRuns.page.botInvalid.detail')}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => openProjectSettings()}>
              {t('gitlabRuns.page.botInvalid.openSettings')}
            </Button>
          </div>
        ) : null}

        {error ? (
          <div className="mx-4 mb-3 flex items-center justify-between rounded-lg bg-[var(--status-error-background)] px-4 py-3">
            <span className="typography-meta text-[var(--status-error-text)]">
              {t('gitlabRuns.page.error.title')} · {t('gitlabRuns.page.error.detail')}
            </span>
            <Button size="sm" variant="outline" onClick={refresh}>{t('gitlabRuns.page.error.retry')}</Button>
          </div>
        ) : null}

        {loading && runs === null ? (
          <p className="mx-4 mt-8 typography-meta text-muted-foreground">{t('gitlabRuns.page.loading')}</p>
        ) : null}

        {notBound || (!loading && runs !== null && allRuns.length === 0) ? (
          <div className="mx-4 mt-8 rounded-lg px-4 py-6">
            <p className="typography-ui-label font-medium">
              {t(notBound ? 'gitlabIssue.error.notGitlab' : 'gitlabRuns.page.empty.title')}
            </p>
            <p className="mt-1 typography-meta text-muted-foreground">{t('gitlabRuns.page.empty.description')}</p>
          </div>
        ) : null}

        {allRuns.length > 0 ? (
          <div className="px-3 pb-8">
            <div className="flex flex-wrap items-center gap-1 px-1 py-2">
              {filterChip('all', t('gitlabRuns.filter.all'), counts.all)}
              {filterChip('waiting', t('gitlabRuns.caption.waiting'), counts.waiting)}
              {filterChip('blocked', t('gitlabRuns.caption.blocked'), counts.blocked)}
              {filterChip('active', t('gitlabRuns.caption.active'), counts.active)}
              {filterChip('done', t('gitlabRuns.caption.historySummary'), counts.done)}
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('gitlabRuns.filter.search')}
                className="ms-auto w-44 rounded-md bg-[var(--surface-subtle)] px-2.5 py-1 typography-meta text-foreground placeholder:text-muted-foreground"
                aria-label={t('gitlabRuns.filter.search')}
              />
            </div>
            <div className="space-y-0.5">
              {filtered.length === 0 ? (
                <p className="px-3 py-6 typography-meta text-muted-foreground">{t('gitlabRuns.filter.empty')}</p>
              ) : (
                filtered.map((run) => (
                  <RunRow
                    key={run.key}
                    run={run}
                    projectLabel={projectLabelFor(run)}
                    onSelect={() => setSelectedKey(run.key)}
                  />
                ))
              )}
            </div>
          </div>
        ) : null}
      </div>

      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open && !submitting) setPending(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{pending ? t(actionLabel(pending.action)) : ''}</DialogTitle>
            <DialogDescription>
              {pending
                ? t(
                  pending.kind === 'comment' ? 'gitlabRuns.confirm.comment' : 'gitlabRuns.confirm.labels',
                  { iid: pending.run.iid, account: pending.accountName },
                )
                : ''}
              {pending && pending.kind === 'comment' ? (
                <code className="mt-2 block rounded bg-[var(--surface-subtle)] px-2 py-1 font-mono text-xs">
                  {runActionCommand(pending.action)}
                </code>
              ) : null}
              {pending ? labelChangeLine(pending.action) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={submitting}>
              {t('gitlabRuns.confirm.cancel')}
            </Button>
            <Button onClick={() => { void submit(); }} disabled={submitting}>
              {pending ? t(actionLabel(pending.action)) : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
