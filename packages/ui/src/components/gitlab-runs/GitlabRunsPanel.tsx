/**
 * The GitLab automation runs page.
 *
 * One row per run, in work-state order: what waits on the person, what is
 * blocked, what is running, and the finished history. The page reads the
 * server's run ledger and acts through the same GitLab labels and comment
 * commands a person would type, always as the acting bound account; it never
 * writes the ledger and never acts as the bot.
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
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SessionDot } from './RunRail';
import { RunSteps } from './RunSteps';
import { SessionTrail } from './SessionTrail';
import {
  formatAge,
  guideKey,
  phaseLabelKey,
  runActionCommand,
  runActionKind,
  type Phase,
  type Run,
  type RunAction as Action,
  type RunIssueState,
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

/** What each label-moving action does to the issue, so the confirmation can say it. */
const labelChangeOf = (action: Action): { add: string[]; remove: string[] } | null => {
  if (action === 'reset') {
    return { add: ['ai-ready'], remove: ['ai-blocked'] };
  }
  if (action === 'cancel') {
    return { add: ['ai-blocked'], remove: ['ai-working'] };
  }
  return null;
};

// The automation's own inputs, as dots: `ai-blocked` is left out because a
// blocked run already says so in words and a second mark only repeats it.
const ISSUE_LABEL_DOTS = {
  'ai-ready': 'var(--status-success)',
  'ai-working': 'var(--status-info)',
  'ai-done': 'var(--border)',
} satisfies Record<string, string>;

type IssueLabelWithDot = keyof typeof ISSUE_LABEL_DOTS;

const isIssueLabelWithDot = (label: string): label is IssueLabelWithDot => (
  label in ISSUE_LABEL_DOTS
);

const IssueStateBadge = ({ state }: { state: RunIssueState | null }) => {
  const { t } = useI18n();
  if (!state?.state) return null;
  const closed = state.state === 'closed';
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {state.labels
        .filter(isIssueLabelWithDot)
        .map((label) => (
          <span
            key={label}
            title={label}
            className="size-1.5 rounded-full"
            style={{ backgroundColor: ISSUE_LABEL_DOTS[label] }}
          />
        ))}
      <span className={cn(
        'rounded border px-1.5 text-[11px] leading-4',
        closed
          ? 'border-[var(--border)] text-muted-foreground'
          : 'border-[var(--status-success)] text-[var(--status-success)]',
      )}
      >
        {t(closed ? 'gitlabRuns.issue.closed' : 'gitlabRuns.issue.opened')}
      </span>
    </span>
  );
};

/**
 * One run, closed until asked: the title, the phase it is in and the issue's own
 * state are enough to scan a list, and the steps, the branch and the actions are
 * one click away.
 */
const RunCard: React.FC<{
  run: Run;
  /** `@root` of the account the actions would act as; null when none is bound. */
  account: string | null;
  /** More than one candidate account for this origin: the attribution is
      ambiguous, so the actions wait for the person to pick one in settings. */
  multiAccounts: boolean;
  onOpenSession: (run: Run, sessionId: string) => void;
  onOpenUrl: (url: string) => void;
  onAction: (run: Run, action: Action) => void;
  onOpenSettings: (projectEntryId: string | null) => void;
}> = ({ run, account, multiAccounts, onOpenSession, onOpenUrl, onAction, onOpenSettings }) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  // SAFETY: the ledger only fills `phase` with a phase name (or `blocked`).
  const phase = run.phase as Phase;
  // SAFETY: `kind` is the schema's `bug`/`feature` enum, and both have a
  // `gitlabRuns.kind.*` entry in the i18n dictionaries.
  const kindKey = run.kind ? `gitlabRuns.kind.${run.kind}` as I18nKey : null;
  const age = formatAge(run.since ?? run.updatedAt);
  const unbound = !account;
  const waiting = phase === 'waiting-approval';
  const blocked = phase === 'blocked';

  return (
    <article className="rounded-lg bg-[var(--surface-subtle)] px-4 py-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-start"
          aria-expanded={open}
          aria-label={t('gitlabRuns.action.details')}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? 'arrow-down' : 'arrow-right'} className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate typography-ui-label font-medium">{run.title ?? run.key}</span>
          {kindKey ? (
            <span className="shrink-0 typography-meta text-muted-foreground">
              {t(kindKey)}
            </span>
          ) : null}
        </button>
        <IssueStateBadge state={run.issueState ?? null} />
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 ps-5 typography-meta text-muted-foreground">
        <span
          className="inline-flex items-center gap-1 font-medium"
          style={{ color: blocked ? 'var(--status-error-text)' : waiting ? 'var(--status-warning-text)' : undefined }}
        >
          {blocked ? <Icon name="error-warning" className="size-3" /> : null}
          {t(phaseLabelKey(phase))}
          {/* A working session moves; saying so at rest keeps the list readable
              without opening every card. */}
          {run.sessionStatus === 'busy' ? <SessionDot status="busy" /> : null}
        </span>
        {/* A finished run says "Done" whether it merged or was closed without a
            change; the outcome is the only thing that tells them apart. */}
        {run.outcome === 'not-an-issue' ? (
          <span>{t('gitlabRuns.outcome.not-an-issue')}</span>
        ) : null}
        {age ? <span>{age}</span> : null}
        {run.reviewRounds > 0 ? (
          <span>{t('gitlabRuns.review.round', { round: run.reviewRounds, max: 3 })}</span>
        ) : null}
        {run.feedbackRounds > 0 ? (
          <span>{t('gitlabRuns.feedback.round', { round: run.feedbackRounds })}</span>
        ) : null}
        {/* The last review verdict: a folded card that says "needs changes" is
            why a person opens it. */}
        {run.reviewVerdict ? (
          <span>
            {t(run.reviewVerdict === 'approve'
              ? 'gitlabRuns.review.verdict.approve'
              : 'gitlabRuns.review.verdict.changes')}
          </span>
        ) : null}
      </div>

      {/* Folded, the card still answers "which sessions did this run open":
          the expanded step view already carries the full trail. */}
      {!open ? (
        <div className="mt-1 ps-5">
          <SessionTrail run={run} onOpenSession={(sessionId) => onOpenSession(run, sessionId)} />
        </div>
      ) : null}

      {waiting ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 ps-5">
          <Button size="sm" disabled={unbound} onClick={() => onAction(run, 'approve')}>
            {t('gitlabRuns.action.approve')}
          </Button>
          <Button size="sm" variant="outline" disabled={unbound} onClick={() => onAction(run, 'reject')}>
            {t('gitlabRuns.action.reject')}
          </Button>
          {run.issueUrl && run.kind === 'feature' ? (
            // SAFETY: the guard above just checked `run.issueUrl` against null.
            <Button size="sm" variant="ghost" onClick={() => onOpenUrl(run.issueUrl as string)}>
              {t('gitlabRuns.action.plan')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Blocked means a person has to act: the reason and its buttons stay on
          the folded card, not one expansion away. */}
      {blocked ? (
        <div className="mt-2 rounded-md bg-[var(--status-error-background)] px-3 py-2">
          <p className="typography-meta text-[var(--status-error-text)]">
            {t(guideKey(run.blockedReason))}
          </p>
          {/* What actually failed, when the server said more than the reason
              code: "the target branch does not exist", the session's own
              timeout sentence, the git error behind a failed push. */}
          {run.lastError ? (
            <p className="mt-1 break-words typography-meta text-foreground">{run.lastError}</p>
          ) : null}
        </div>
      ) : null}

      {blocked || (!waiting && phase !== 'done') ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 ps-5">
          {blocked ? (
            <>
              {run.blockedReason === 'missing-credential' ? (
                <Button size="sm" disabled={unbound} onClick={() => onAction(run, 'take')}>
                  {t('gitlabRuns.action.takeOver')}
                </Button>
              ) : null}
              <Button size="sm" variant="outline" disabled={unbound || multiAccounts} onClick={() => onAction(run, 'reset')}>
                {t('gitlabRuns.action.reset')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" disabled={unbound || multiAccounts} onClick={() => onAction(run, 'cancel')}>
              {t('gitlabRuns.action.cancelRun')}
            </Button>
          )}
          {unbound || multiAccounts ? (
            <Button size="sm" variant="ghost" onClick={() => onOpenSettings(run.projectEntryId ?? null)}>
              {t('gitlabRuns.action.settings')}
            </Button>
          ) : null}
          {account ? (
            <span className="typography-meta text-muted-foreground">
              {t('gitlabRuns.attribution', { account })}
            </span>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <div className="ps-5">
          <RunSteps run={run} onOpenSession={(sessionId) => onOpenSession(run, sessionId)} />

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 typography-meta text-muted-foreground">
            {run.branch ? <code className="truncate text-[11px]">{run.branch}</code> : null}
            {/* Real anchors: the page these open lives outside the app, and a
                link that only underlines on hover reads as plain text. */}
            {run.mrUrl ? (
              <a
                href={run.mrUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[var(--primary-text)] hover:underline"
              >
                MR !{run.mrIid}
                <Icon name="external-link" className="size-3" />
              </a>
            ) : null}
            {run.issueUrl ? (
              <a
                href={run.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[var(--primary-text)] hover:underline"
              >
                {t('gitlabRuns.action.issue', { iid: run.iid })}
                <Icon name="external-link" className="size-3" />
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
};

/**
 * The runs page, or the same list inside the board's own tab.
 *
 * Embedded, the board already names what is listed (its kind switch) and which
 * project it is (its scope picker), so the page header, the project/global
 * switch and the close button stay out, and the list reads the directory the
 * board passes instead of the page's own project.
 */
export const GitlabRunsPanel: React.FC<{
  embedded?: boolean;
  directory?: string | null;
  projectId?: string | null;
}> = ({ embedded = false, directory: embeddedDirectory, projectId: embeddedProjectId }) => {
  const { t } = useI18n();
  const pageProjectId = useUIStore((state) => state.gitlabRunsPageProjectId);
  const projectId = embedded ? (embeddedProjectId ?? null) : pageProjectId;
  const project = useProjectsStore((state) => (
    state.projects.find((entry) => entry.id === projectId) ?? null
  ));
  const scopeGlobal = !embedded && projectId === '__all__';
  // Remembered while the global view is open, so the switch can come back.
  const lastProjectId = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (project) lastProjectId.current = project.id;
  }, [project]);
  const directory = embedded ? (embeddedDirectory ?? null) : scopeGlobal ? null : (project?.path ?? null);
  const { runs, bot, error, loading, notBound, refresh } = useGitlabRuns(directory);
  const [pending, setPending] = React.useState<PendingAction | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const accountsFor = useRunAccounts();

  const close = React.useCallback(() => {
    useUIStore.getState().setGitlabRunsPageProjectId(null);
  }, []);

  const openProjectSettings = React.useCallback((forProjectId?: string | null) => {
    // The global view has no single project; the row that asked knows which.
    const target = forProjectId ?? project?.id ?? null;
    if (!target) return;
    const ui = useUIStore.getState();
    ui.setGitlabRunsPageProjectId(null);
    ui.setSettingsProjectsSelectedId(target);
    ui.setSettingsPage('projects');
    ui.setSettingsDialogOpen(true);
  }, [project]);

  const openSession = React.useCallback((run: Run, sessionId: string) => {
    useSessionUIStore.getState().setCurrentSession(sessionId, run.origin);
  }, []);

  const submit = React.useCallback(async () => {
    if (!pending) return;
    // In the global view the run names its own settings entry, which is where
    // the directory for the action comes from.
    const target = project ?? useProjectsStore.getState().projects
      .find((entry) => entry.id === pending.run.projectEntryId) ?? null;
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
  }, [pending, project, refresh, t]);

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

  const waiting = (runs ?? []).filter((run) => run.phase === 'waiting-approval');
  const blocked = (runs ?? []).filter((run) => run.phase === 'blocked');
  const active = (runs ?? []).filter((run) => (
    run.phase !== 'waiting-approval' && run.phase !== 'blocked' && run.phase !== 'done'
  ));
  const history = (runs ?? []).filter((run) => run.phase === 'done');

  const actionLabel = (action: Action): I18nKey => ({
    cancel: 'gitlabRuns.action.cancelRun',
    reset: 'gitlabRuns.action.reset',
    approve: 'gitlabRuns.action.approve',
    reject: 'gitlabRuns.action.reject',
    take: 'gitlabRuns.action.takeOver',
  } satisfies Record<Action, I18nKey>)[action];

  // What the confirmation promises, spelled out: the action's label changes are
  // read here, so a person sees the move instead of trusting the verb.
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

  const renderTile = (run: Run) => {
    const options = accountsFor(run.origin);
    return (
      <RunCard
        key={run.key}
        run={run}
        account={options.length > 0 ? `@${options[0].username}` : null}
        multiAccounts={options.length > 1}
        onOpenSession={openSession}
        onOpenUrl={(url) => { void openExternalUrl(url); }}
        onAction={requestAction}
        onOpenSettings={openProjectSettings}
      />
    );
  };

  const caption = (key: I18nKey, count: number) => (
    <div className="mb-2 mt-6 flex items-baseline gap-2">
      <span className="typography-meta text-muted-foreground">{t(key)}</span>
      <span className="typography-meta tabular-nums text-muted-foreground/60">{count}</span>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {embedded ? null : (
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-2 pt-4">
          <span className="typography-ui-label font-medium">{t('gitlabRuns.page.title')}</span>
          <span className="min-w-0 truncate typography-meta text-muted-foreground">
            {scopeGlobal ? t('gitlabRuns.page.scope.global') : (project?.path ?? '')}
          </span>
          <div className="ms-auto flex items-center gap-2">
            <span className="typography-meta tabular-nums text-muted-foreground/70">
              {error ? t('gitlabRuns.page.poll.failed') : null}
            </span>
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

      <div className={cn('min-h-0 flex-1 overflow-y-auto px-4 pb-10', embedded && 'pt-4')}>
        {bot === 'invalid' || bot === 'missing' ? (
          <div className="mb-4 mt-2 rounded-lg bg-[var(--status-error-background)] px-4 py-3">
            <p className="typography-ui-label font-medium text-[var(--status-error-text)]">
              {t('gitlabRuns.page.botInvalid.title')}
            </p>
            <p className="mt-1 typography-meta text-muted-foreground">
              {t('gitlabRuns.page.botInvalid.detail')}
            </p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => openProjectSettings()}>
              {t('gitlabRuns.page.botInvalid.openSettings')}
            </Button>
          </div>
        ) : null}

        {error ? (
          <div className="mb-4 mt-2 flex items-center justify-between rounded-lg bg-[var(--status-error-background)] px-4 py-3">
            <span className="typography-meta text-[var(--status-error-text)]">
              {t('gitlabRuns.page.error.title')} · {t('gitlabRuns.page.error.detail')}
            </span>
            <Button size="sm" variant="outline" onClick={refresh}>
              {t('gitlabRuns.page.error.retry')}
            </Button>
          </div>
        ) : null}

        {loading && runs === null ? (
          <p className="mt-8 typography-meta text-muted-foreground">{t('gitlabRuns.page.loading')}</p>
        ) : null}

        {notBound ? (
          <div className="mt-8 rounded-lg px-4 py-6">
            <p className="typography-ui-label font-medium">{t('gitlabIssue.error.notGitlab')}</p>
            <p className="mt-1 typography-meta text-muted-foreground">
              {t('gitlabRuns.page.empty.description')}
            </p>
          </div>
        ) : null}

        {!notBound && runs !== null && runs.length === 0 ? (
          <div className="mt-8 rounded-lg px-4 py-6">
            <p className="typography-ui-label font-medium">{t('gitlabRuns.page.empty.title')}</p>
            <p className="mt-1 typography-meta text-muted-foreground">
              {t('gitlabRuns.page.empty.description')}
            </p>
          </div>
        ) : null}

        {waiting.length ? (
          <>
            {caption('gitlabRuns.caption.waiting', waiting.length)}
            <div className="space-y-2">{waiting.map(renderTile)}</div>
          </>
        ) : null}

        {blocked.length ? (
          <>
            {caption('gitlabRuns.caption.blocked', blocked.length)}
            <div className="space-y-2">{blocked.map(renderTile)}</div>
          </>
        ) : null}

        {active.length ? (
          <>
            {caption('gitlabRuns.caption.active', active.length)}
            <div className="space-y-2">{active.map(renderTile)}</div>
          </>
        ) : null}

        {history.length ? (
          <details className="mt-6">
            <summary className="cursor-pointer typography-meta text-muted-foreground">
              {t('gitlabRuns.caption.historySummary')}
              <span className="ms-2 tabular-nums text-muted-foreground/60">{history.length}</span>
            </summary>
            <div className="mt-2 space-y-2">{history.map(renderTile)}</div>
          </details>
        ) : null}
      </div>

      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open && !submitting) setPending(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pending ? t(actionLabel(pending.action)) : ''}
            </DialogTitle>
            <DialogDescription>
              {pending
                ? t(
                  pending.kind === 'comment' ? 'gitlabRuns.confirm.comment' : 'gitlabRuns.confirm.labels',
                  { iid: pending.run.iid, account: pending.accountName },
                )
                : ''}
              {/* A comment action posts words to a page other people read: the
                  confirmation shows those words, not just the verb. */}
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
