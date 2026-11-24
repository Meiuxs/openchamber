/**
 * One run, read as a delivery report rather than a live trace.
 *
 * The user-facing question is "what did this issue produce, and can I verify and
 * merge it?", so the page is ordered by deliverable: summary, requirements and
 * design, the execution plan, every changed file, the review report, the merge
 * impact report, then the verification commands. The technical step/event trace
 * is gone; who ran what and when is still reachable through the sessions on the
 * automation session view.
 */
import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

import {
  guideKey,
  phaseLabelKey,
  type Phase,
  type Run,
  type RunAction as Action,
} from './runModel';
import { useRunFiles } from './useRunFiles';

const Section: React.FC<{
  id: string;
  title: string;
  hint?: string;
  right?: React.ReactNode;
  sectionRef: (id: string, element: HTMLElement | null) => void;
  children: React.ReactNode;
}> = ({ id, title, hint, right, sectionRef, children }) => (
  <section
    id={`run-section-${id}`}
    ref={(element) => sectionRef(id, element)}
    className="mb-3 rounded-lg bg-[var(--surface-subtle)] px-4 py-3"
  >
    <div className="mb-2 flex flex-wrap items-baseline gap-2">
      <h3 className="typography-ui-label font-medium">{title}</h3>
      {hint ? <span className="typography-meta text-muted-foreground">{hint}</span> : null}
      {right ? <div className="ms-auto">{right}</div> : null}
    </div>
    {children}
  </section>
);

const KV: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="grid grid-cols-[92px_1fr] gap-2 py-1 typography-meta">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="m-0 min-w-0 break-words text-foreground">{children}</dd>
  </div>
);

const Empty: React.FC<{ text: string }> = ({ text }) => (
  <p className="typography-meta text-muted-foreground">{text}</p>
);

export const RunDetail: React.FC<{
  run: Run;
  account: string | null;
  multiAccounts: boolean;
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
  onAction: (run: Run, action: Action) => void;
  onOpenSettings: (projectEntryId: string | null) => void;
}> = ({ run, account, multiAccounts, onBack, onOpenSession, onAction, onOpenSettings }) => {
  const { t } = useI18n();
  const { files, loading } = useRunFiles(run);
  const phase = run.phase as Phase;
  const waiting = phase === 'waiting-approval';
  const blocked = phase === 'blocked';
  const unbound = !account;
  const kindKey = run.kind ? `gitlabRuns.kind.${run.kind}` as I18nKey : null;
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const sections = React.useRef<Record<string, HTMLElement | null>>({});
  const sectionRef = React.useCallback((id: string, element: HTMLElement | null) => {
    sections.current[id] = element;
  }, []);
  const jump = (id: string) => {
    sections.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const totalAdded = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const totalRemoved = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  const reviewFindings = run.reviewFindings;
  const triage = run.triage;
  const plan = run.plan;
  const impact = run.reviewImpact;
  const evidence = run.evidence;
  const recordPath = run.recordPath ?? null;
  const projectDirectory = run.projectDirectory ?? null;

  const triageLabel = triage
    ? t(triage.verdict === 'valid'
      ? 'gitlabRuns.detail.summary.valid'
      : triage.verdict === 'not-an-issue'
        ? 'gitlabRuns.outcome.not-an-issue'
        : 'gitlabRuns.detail.summary.insufficient')
    : t('gitlabRuns.detail.empty');
  const reviewLabel = run.reviewVerdict
    ? t(run.reviewVerdict === 'approve' ? 'gitlabRuns.review.verdict.approve' : 'gitlabRuns.review.verdict.changes')
    : t('gitlabRuns.detail.empty');

  const nav = [
    { id: 'triage', label: t('gitlabRuns.detail.triage') },
    { id: 'plan', label: t('gitlabRuns.detail.plan') },
    { id: 'files', label: t('gitlabRuns.detail.changedFiles') },
    { id: 'review', label: t('gitlabRuns.detail.review') },
    { id: 'impact', label: t('gitlabRuns.detail.impact') },
    { id: 'tests', label: t('gitlabRuns.detail.tests') },
  ];

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge-muted px-4 py-2.5">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 typography-meta text-muted-foreground hover:text-foreground"
        >
          <Icon name="arrow-left" className="size-3.5" />
          {t('gitlabRuns.detail.back')}
        </button>
        <h2 className="min-w-0 flex-1 truncate typography-ui-label font-medium">
          {run.title ?? run.key}
          <span className="ms-2 typography-meta font-normal text-muted-foreground">#{run.iid}</span>
        </h2>
        {account && !multiAccounts ? (
          <span
            className="shrink-0 rounded-full bg-[var(--surface-subtle)] px-2 py-0.5 typography-meta text-muted-foreground"
            title={t('gitlabRuns.attribution', { account })}
          >
            {account}
          </span>
        ) : null}
        <span className={cn(
          'rounded-full px-2 py-0.5 typography-meta',
          blocked
            ? 'bg-[var(--status-error-background)] text-[var(--status-error-text)]'
            : waiting
              ? 'bg-[var(--status-warning-background)] text-[var(--status-warning-text)]'
              : 'bg-[var(--surface-elevated)] text-muted-foreground',
        )}
        >
          {t(phaseLabelKey(phase))}
        </span>
        {waiting ? (
          <>
            <Button size="sm" disabled={unbound} onClick={() => onAction(run, 'approve')}>{t('gitlabRuns.action.approve')}</Button>
            <Button size="sm" variant="outline" disabled={unbound} onClick={() => onAction(run, 'reject')}>{t('gitlabRuns.action.reject')}</Button>
          </>
        ) : null}
        {blocked ? (
          <>
            {run.blockedReason === 'missing-credential' ? (
              <Button size="sm" disabled={unbound} onClick={() => onAction(run, 'take')}>{t('gitlabRuns.action.takeOver')}</Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={unbound || multiAccounts} onClick={() => onAction(run, 'reset')}>{t('gitlabRuns.action.reset')}</Button>
          </>
        ) : null}
        {!waiting && !blocked && phase !== 'done' ? (
          <Button size="sm" variant="ghost" disabled={unbound || multiAccounts} onClick={() => onAction(run, 'cancel')}>{t('gitlabRuns.action.cancelRun')}</Button>
        ) : null}
        {unbound || multiAccounts ? (
          <Button size="sm" variant="ghost" onClick={() => onOpenSettings(run.projectEntryId ?? null)}>{t('gitlabRuns.action.settings')}</Button>
        ) : null}
      </div>

      <div className="border-b border-edge-muted px-4 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 typography-meta text-muted-foreground">
          {kindKey ? (
            <span className="shrink-0 rounded-full bg-[var(--surface-elevated)] px-1.5 py-0.5 text-[11px]">{t(kindKey)}</span>
          ) : null}
          {run.issueUrl ? (
            <a href={run.issueUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--primary-text)] hover:underline">
              {t('gitlabRuns.action.issue', { iid: run.iid })}
            </a>
          ) : null}
          {run.mrUrl ? (
            <a href={run.mrUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--primary-text)] hover:underline">
              MR !{run.mrIid}
            </a>
          ) : null}
          {recordPath && projectDirectory ? (
            <button
              type="button"
              onClick={() => useUIStore.getState().openContextFile(projectDirectory, recordPath)}
              className="text-[var(--primary-text)] hover:underline"
            >
              {t('gitlabRuns.detail.deliveryRecord')}
            </button>
          ) : null}
          {run.branch ? (
            <span className="ms-auto flex min-w-0 max-w-full items-center gap-1" title={run.branch}>
              <Icon name="git-branch" className="size-3.5 shrink-0" />
              <code className="truncate text-[11px]">{run.branch}</code>
            </span>
          ) : null}
        </div>
        {blocked && run.blockedReason ? (
          <p className="mt-1.5 typography-meta text-[var(--status-error-text)]">{t(guideKey(run.blockedReason))}</p>
        ) : null}
      </div>

      <div className="flex gap-1.5 overflow-x-auto border-b border-edge-muted px-4 py-1.5">
        {nav.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => jump(item.id)}
            className="shrink-0 rounded-md px-2 py-1 typography-meta text-muted-foreground hover:bg-[var(--surface-subtle)] hover:text-foreground"
          >
            {item.label}
          </button>
        ))}
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[
            { label: t('gitlabRuns.detail.summary.verdict'), value: triageLabel },
            { label: t('gitlabRuns.detail.summary.result'), value: evidence ? t('gitlabRuns.detail.summary.done') : t('gitlabRuns.detail.summary.pending') },
            { label: t('gitlabRuns.detail.summary.review'), value: reviewLabel },
            { label: t('gitlabRuns.detail.summary.merge'), value: run.mrUrl ? t('gitlabRuns.detail.summary.ready') : t('gitlabRuns.detail.summary.notReady') },
            { label: t('gitlabRuns.detail.summary.tests'), value: evidence ? String(evidence.verification.length) : t('gitlabRuns.detail.empty') },
          ].map((card) => (
            <div key={card.label} className="rounded-lg bg-[var(--surface-subtle)] px-3 py-2">
              <span className="block typography-meta text-muted-foreground">{card.label}</span>
              <span className="mt-0.5 block typography-ui-label font-medium">{card.value}</span>
            </div>
          ))}
        </div>

        <Section id="triage" title={t('gitlabRuns.detail.triage')} hint={t('gitlabRuns.detail.triage.hint')} sectionRef={sectionRef}>
          {triage || plan ? (
            <dl className="m-0">
              {triage ? <KV label={t('gitlabRuns.detail.triage.summary')}>{triage.summary}</KV> : null}
              {triage?.evidence ? <KV label={t('gitlabRuns.detail.triage.evidence')}>{triage.evidence}</KV> : null}
              {triage?.missing ? <KV label={t('gitlabRuns.detail.triage.missing')}>{triage.missing}</KV> : null}
              {plan ? <KV label={t('gitlabRuns.detail.triage.design')}>{plan.dataFlow}</KV> : null}
            </dl>
          ) : (
            <Empty text={t('gitlabRuns.detail.triage.empty')} />
          )}
        </Section>

        <Section id="plan" title={t('gitlabRuns.detail.plan')} sectionRef={sectionRef}>
          {plan ? (
            <dl className="m-0">
              <KV label={t('gitlabRuns.detail.plan.files')}>
                {plan.files.map((file) => <code key={file} className="me-1.5 text-[11px]">{file}</code>)}
              </KV>
              <KV label={t('gitlabRuns.detail.plan.dataFlow')}>{plan.dataFlow}</KV>
              <KV label={t('gitlabRuns.detail.plan.verification')}>{plan.verification}</KV>
              <KV label={t('gitlabRuns.detail.plan.risks')}>{plan.risks}</KV>
              <KV label={t('gitlabRuns.detail.plan.outOfScope')}>{plan.outOfScope}</KV>
            </dl>
          ) : (
            <Empty text={t('gitlabRuns.detail.plan.empty')} />
          )}
        </Section>

        <Section
          id="files"
          title={t('gitlabRuns.detail.changedFiles')}
          right={<span className="typography-meta text-muted-foreground">{t('gitlabRuns.detail.files.total', { count: files.length, added: totalAdded, removed: totalRemoved })}</span>}
          sectionRef={sectionRef}
        >
          {loading ? (
            <Empty text={t('gitlabRuns.page.loading')} />
          ) : files.length === 0 ? (
            <Empty text={t('gitlabRuns.detail.noFiles')} />
          ) : (
            <div className="overflow-hidden rounded-md bg-[var(--surface-elevated)]">
              {files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => onOpenSession(file.sessionId)}
                  title={t('gitlabRuns.detail.openDiff')}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-start typography-meta hover:bg-[var(--surface-subtle)]"
                >
                  <span className="shrink-0 rounded bg-[var(--surface-subtle)] px-1.5 text-[10px] text-muted-foreground">
                    {t(file.status === 'added' ? 'gitlabRuns.detail.added' : 'gitlabRuns.detail.modified')}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{file.path}</span>
                  {file.added !== null ? <span className="shrink-0 tabular-nums text-[var(--status-success)]">+{file.added}</span> : null}
                  {file.removed !== null ? <span className="shrink-0 tabular-nums text-[var(--status-error-text)]">−{file.removed}</span> : null}
                </button>
              ))}
            </div>
          )}
        </Section>

        <Section
          id="review"
          title={t('gitlabRuns.detail.review')}
          right={run.reviewVerdict ? (
            <span className={cn(
              'rounded-full px-2 py-0.5 typography-meta',
              run.reviewVerdict === 'approve'
                ? 'bg-[var(--status-success-background)] text-[var(--status-success)]'
                : 'bg-[var(--status-warning-background)] text-[var(--status-warning-text)]',
            )}
            >
              {t(run.reviewVerdict === 'approve' ? 'gitlabRuns.review.verdict.approve' : 'gitlabRuns.review.verdict.changes')}
            </span>
          ) : undefined}
          sectionRef={sectionRef}
        >
          {run.reviewVerdict || reviewFindings.length > 0 ? (
            <div>
              {reviewFindings.map((finding, index) => (
                <div key={`${finding.file}-${finding.line ?? 0}-${index}`} className="flex gap-2 py-1.5 typography-meta">
                  <span className={cn(
                    'h-fit shrink-0 rounded px-1.5 text-[10px]',
                    finding.severity === 'blocker'
                      ? 'bg-[var(--status-error-background)] text-[var(--status-error-text)]'
                      : 'bg-[var(--surface-elevated)] text-muted-foreground',
                  )}
                  >
                    {t(finding.severity === 'blocker' ? 'gitlabRuns.detail.review.blocker' : 'gitlabRuns.detail.review.minor')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <code className="text-[11px] text-muted-foreground">
                      {finding.file}{finding.line ? `:${finding.line}` : ''}
                    </code>
                    <p className="m-0 mt-0.5 break-words text-foreground">{finding.note}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty text={t('gitlabRuns.detail.review.empty')} />
          )}
        </Section>

        <Section id="impact" title={t('gitlabRuns.detail.impact')} hint={t('gitlabRuns.detail.impact.hint')} sectionRef={sectionRef}>
          {impact ? (
            <dl className="m-0">
              <KV label={t('gitlabRuns.detail.impact.modules')}>{impact.modules}</KV>
              <KV label={t('gitlabRuns.detail.impact.business')}>{impact.business}</KV>
              <KV label={t('gitlabRuns.detail.impact.compatibility')}>{impact.compatibility}</KV>
              <KV label={t('gitlabRuns.detail.impact.rollback')}>{impact.rollback}</KV>
              <KV label={t('gitlabRuns.detail.impact.testScope')}>{impact.testScope}</KV>
            </dl>
          ) : (
            <Empty text={t('gitlabRuns.detail.impact.empty')} />
          )}
        </Section>

        <Section id="tests" title={t('gitlabRuns.detail.tests')} sectionRef={sectionRef}>
          {evidence ? (
            <div>
              <dl className="m-0 mb-2">
                <KV label={t('gitlabRuns.detail.evidence.rootCause')}>{evidence.rootCause}</KV>
                <KV label={t('gitlabRuns.detail.evidence.changes')}>{evidence.changes}</KV>
                {plan ? <KV label={t('gitlabRuns.detail.plan.verification')}>{plan.verification}</KV> : null}
                <KV label={t('gitlabRuns.detail.evidence.risks')}>{evidence.risks}</KV>
              </dl>
              {evidence.verification.length > 0 ? (
                <div>
                  <div className="mb-1 typography-meta text-muted-foreground">{t('gitlabRuns.detail.tests.commands')}</div>
                  {evidence.verification.map((entry, index) => (
                    <div key={`${entry.command}-${index}`} className="flex items-center gap-2 rounded bg-[var(--surface-elevated)] px-2.5 py-1.5 typography-meta">
                      <code className="min-w-0 flex-1 truncate text-[11px]">{entry.command}</code>
                      <span className="shrink-0 text-[var(--status-success)]">{entry.result}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <Empty text={t('gitlabRuns.detail.tests.empty')} />
          )}
        </Section>
      </div>
    </div>
  );
};
