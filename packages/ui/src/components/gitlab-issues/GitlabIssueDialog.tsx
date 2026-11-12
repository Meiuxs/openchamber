import * as React from 'react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { isValidGitRefName } from '@/lib/git-ref';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { buildManagedAccountOptions, getManagedCredentialSourceLabelKey } from '@/lib/source-control/identity';
import { useSourceControlDescriptorOf } from '@/lib/source-control/providers/registry';
import { openExternalUrl } from '@/lib/url';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getSourceControlAuthKey, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { useUIStore } from '@/stores/useUIStore';

const issueResultSchema = z.object({
  iid: z.number().nullable(),
  webUrl: z.string().nullable(),
});
const issueErrorSchema = z.object({ error: z.string() });

const FAILURE_KEYS = {
  'project-not-found': 'gitlabIssue.error.projectNotFound',
  'not-gitlab-project': 'gitlabIssue.error.notGitlab',
  'bot-account-missing': 'gitlabIssue.bot.missing',
  'bot-account-unusable': 'gitlabIssue.error.botUnusable',
  'gitlab-request-failed': 'gitlabIssue.error.requestFailed',
} as const satisfies Record<string, I18nKey>;

const failureKey = (code: string): I18nKey => (
  // SAFETY: `in` proves the key belongs to the literal map above.
  code in FAILURE_KEYS ? FAILURE_KEYS[code as keyof typeof FAILURE_KEYS] : 'gitlabIssue.error.generic'
);

type IssueKind = 'bug' | 'feature';
type CreatedIssue = z.infer<typeof issueResultSchema>;

/**
 * A confirmation step before the bot files an issue. The dialog creates the
 * issue without `ai-ready`, so the automation still starts only when a person
 * adds the label in GitLab.
 */
export const GitlabIssueDialog: React.FC = () => {
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const projectId = useUIStore((state) => state.gitlabIssueDialogProjectId);
  const close = React.useCallback(() => {
    useUIStore.getState().setGitlabIssueDialogProjectId(null);
  }, []);
  const project = useProjectsStore((state) => (
    state.projects.find((entry) => entry.id === projectId) ?? null
  ));

  const identities = useSourceControlAuthStore((state) => state.identities);
  const authEntries = useSourceControlAuthStore((state) => state.entries);
  const refreshAccounts = useSourceControlAuthStore((state) => state.refreshAll);
  const descriptorOf = useSourceControlDescriptorOf();

  React.useEffect(() => {
    if (!projectId) return;
    void refreshAccounts(sourceControl);
  }, [projectId, refreshAccounts, sourceControl]);

  const botAccountId = project?.gitlabIssueBotAccountId ?? '';
  const botAccountLabel = React.useMemo(() => {
    if (!botAccountId) return null;
    const options = identities.flatMap((identity) => {
      if (identity.provider !== 'gitlab') return [];
      const entry = authEntries[getSourceControlAuthKey(identity)];
      if (!entry?.hasChecked || entry.status?.status !== 'connected') return [];
      return buildManagedAccountOptions(
        identity,
        descriptorOf(identity.provider),
        entry.status.accounts,
        (account) => t(getManagedCredentialSourceLabelKey(account.source)),
      );
    });
    return options.find((option) => option.reference.accountId === botAccountId)?.label ?? botAccountId;
  }, [authEntries, botAccountId, descriptorOf, identities, t]);

  const [kind, setKind] = React.useState<IssueKind>('bug');
  const [title, setTitle] = React.useState('');
  const [branch, setBranch] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<CreatedIssue | null>(null);

  React.useEffect(() => {
    setKind('bug');
    setTitle('');
    setBranch('');
    setDescription('');
    setSubmitting(false);
    setError(null);
    setCreated(null);
  }, [projectId]);

  const trimmedTitle = title.trim();
  const trimmedBranch = branch.trim();
  // A backtick would end the `目标分支:` value the dispatcher reads.
  const branchInvalid = trimmedBranch.length > 0
    && (!isValidGitRefName(trimmedBranch) || trimmedBranch.includes('`'));
  const canSubmit = Boolean(project) && Boolean(botAccountId) && trimmedTitle.length > 0
    && !branchInvalid && !submitting;
  const createdUrl = created?.webUrl ?? null;

  const openProjectSettings = React.useCallback(() => {
    if (!project) return;
    const ui = useUIStore.getState();
    ui.setGitlabIssueDialogProjectId(null);
    ui.setSettingsProjectsSelectedId(project.id);
    ui.setSettingsPage('projects');
    ui.setSettingsDialogOpen(true);
  }, [project]);

  const submit = React.useCallback(async () => {
    if (!project || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await runtimeFetch('/api/gitlab-issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The dialog cannot be dismissed while submitting; a hung request must end.
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          directory: project.path,
          kind,
          title: trimmedTitle,
          targetBranch: trimmedBranch,
          description,
        }),
      });
      if (!response.ok) {
        const failure = issueErrorSchema.safeParse(await response.json().catch(() => null));
        setError(t(failure.success ? failureKey(failure.data.error) : 'gitlabIssue.error.generic'));
        return;
      }
      const parsed = issueResultSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        setError(t('gitlabIssue.error.generic'));
        return;
      }
      setCreated(parsed.data);
      toast.success(t('gitlabIssue.created', { iid: parsed.data.iid ?? '?' }));
    } catch {
      setError(t('gitlabIssue.error.requestFailed'));
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, description, kind, project, t, trimmedBranch, trimmedTitle]);

  return (
    <Dialog open={Boolean(projectId)} onOpenChange={(open) => { if (!open && !submitting) close(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('gitlabIssue.dialog.title')}</DialogTitle>
          <DialogDescription>{t('gitlabIssue.dialog.description')}</DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3">
            <p className="typography-ui-label text-foreground">
              {t('gitlabIssue.created', { iid: created.iid ?? '?' })}
            </p>
            {createdUrl ? (
              <Button variant="outline" onClick={() => { void openExternalUrl(createdUrl); }}>
                {t('gitlabIssue.actions.open')}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <span className="typography-ui-label font-medium text-foreground">{t('gitlabIssue.field.kind')}</span>
              <div className="flex gap-2" role="group" aria-label={t('gitlabIssue.field.kind')}>
                {([['bug', 'gitlabIssue.kind.bug'], ['feature', 'gitlabIssue.kind.feature']] as const).map(([value, key]) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant="chip"
                    aria-pressed={kind === value}
                    onClick={() => setKind(value)}
                  >
                    {t(key)}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="gitlab-issue-title" className="typography-ui-label font-medium text-foreground">
                {t('gitlabIssue.field.title')}
              </label>
              <Input
                id="gitlab-issue-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t('gitlabIssue.field.titlePlaceholder')}
                maxLength={255}
                autoFocus
                disabled={submitting}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="gitlab-issue-branch" className="typography-ui-label font-medium text-foreground">
                {t('gitlabIssue.field.branch')}
              </label>
              <Input
                id="gitlab-issue-branch"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder={t('gitlabIssue.field.branchPlaceholder')}
                disabled={submitting}
              />
              {branchInvalid ? (
                <p className="typography-meta text-status-error">{t('gitlabIssue.field.branchInvalid')}</p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="gitlab-issue-description" className="typography-ui-label font-medium text-foreground">
                {t('gitlabIssue.field.description')}
              </label>
              <Textarea
                id="gitlab-issue-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t('gitlabIssue.field.descriptionPlaceholder')}
                rows={5}
                maxLength={65_000}
                disabled={submitting}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-edge bg-[var(--surface-subtle)] px-3 py-2">
              <span className="typography-meta text-muted-foreground">
                {botAccountId
                  ? `${t('settings.projects.page.field.gitlabBotAccount')}: ${botAccountLabel ?? botAccountId}`
                  : t('gitlabIssue.bot.missing')}
              </span>
              {botAccountId ? null : (
                <Button type="button" size="sm" variant="outline" onClick={openProjectSettings}>
                  {t('gitlabIssue.bot.openSettings')}
                </Button>
              )}
            </div>

            {error ? <p className="typography-meta text-status-error">{error}</p> : null}
          </div>
        )}

        <DialogFooter>
          {created ? null : (
            <>
              <Button variant="outline" onClick={close} disabled={submitting}>
                {t('gitlabIssue.actions.cancel')}
              </Button>
              <Button onClick={() => void submit()} disabled={!canSubmit}>
                {submitting ? t('common.loading') : t('gitlabIssue.actions.submit')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
