import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { NumberInput } from '@/components/ui/number-input';
import { Textarea } from '@/components/ui/textarea';
import {
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsFieldRow,
  SettingsSection,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_NUMBER_INPUT_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import {
  builtinIssueTemplateDefaults,
  resolveIssueTemplates,
  toStoredIssueTemplates,
  type BuiltinIssueTemplateNameKey,
  type GitlabIssueTemplateKind,
  type ResolvedIssueTemplate,
} from '@/lib/gitlab-issues/issueTemplates';
import { useGitlabBotAccounts } from '@/hooks/useGitlabBotAccounts';
import { isValidBranchPrefix } from '@/lib/git-ref';
import { selectIsModelMissingFromCatalog, selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { formatModelVariantLabel, modelVariantNames } from '@/lib/modelVariants';
import { useI18n } from '@/lib/i18n';
import { generateUuid } from '@/lib/uuid';
import { cn } from '@/lib/utils';
import type { ProjectEntry } from '@/lib/api/types';

const NO_VARIANT_VALUE = '__default__';

const GITLAB_CONTROL_COLUMN_CLASS = 'w-full flex-col items-stretch gap-1.5 @xl:w-[20rem] @xl:flex-none';
const GITLAB_TEXT_INPUT_CLASS = 'h-8 w-full rounded-md px-3 font-mono text-xs';
const GITLAB_SELECT_TRIGGER_CLASS = cn(SETTINGS_SELECT_ROW_TRIGGER_CLASS, 'w-full max-w-none');
const GITLAB_MODEL_TRIGGER_CLASS = cn(SETTINGS_CUSTOM_TRIGGER_CLASS, 'w-full max-w-none');

const NO_TEMPLATE_KIND_VALUE = '__none__';

const replaceTemplateAt = (
  templates: readonly ResolvedIssueTemplate[],
  index: number,
  patch: Partial<ResolvedIssueTemplate>,
): ResolvedIssueTemplate[] => templates.map((entry, at) => (at === index ? { ...entry, ...patch } : entry));

const GitlabIssueTemplatesEditor: React.FC<{ project: ProjectEntry }> = ({ project }) => {
  const { t } = useI18n();
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const stored = project.gitlabIssueTemplates;
  const nameOf = React.useCallback((key: BuiltinIssueTemplateNameKey) => t(key), [t]);
  const kindLabelOf = React.useCallback((kind: GitlabIssueTemplateKind | null): string => {
    if (kind === 'bug') return t('gitlabIssue.kind.bug');
    if (kind === 'feature') return t('gitlabIssue.kind.feature');
    return t('settings.projects.page.field.gitlabTemplateKindNone');
  }, [t]);
  const resolved = React.useMemo(() => resolveIssueTemplates(stored, nameOf), [stored, nameOf]);
  const [drafts, setDrafts] = React.useState<ResolvedIssueTemplate[]>(resolved);
  const [syncedFrom, setSyncedFrom] = React.useState(resolved);
  if (syncedFrom !== resolved) {
    setSyncedFrom(resolved);
    setDrafts(resolved);
  }

  const commit = (next: ResolvedIssueTemplate[]) => {
    setDrafts(next);
    const stored = toStoredIssueTemplates(next, nameOf);
    if (JSON.stringify(stored) === JSON.stringify(project.gitlabIssueTemplates ?? [])) return;
    updateProjectMeta(project.id, { gitlabIssueTemplates: stored });
  };

  const addTemplate = () => {
    commit([
      ...drafts,
      {
        id: `custom-${generateUuid()}`,
        name: t('settings.projects.page.field.gitlabTemplateNewName'),
        kind: null,
        body: '',
        builtin: false,
      },
    ]);
  };

  return (
    <SettingsControlGroup
      title={t('settings.projects.page.field.gitlabTemplates')}
      info={t('settings.projects.page.field.gitlabTemplatesInfo')}
      settingsItem="projects.gitlab-templates"
      className="border-t border-edge pt-4"
    >
      <div className="space-y-4">
        {drafts.map((template, index) => (
          <div key={template.id} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={template.name}
                onChange={(event) => setDrafts(replaceTemplateAt(drafts, index, { name: event.target.value }))}
                onBlur={() => commit(drafts)}
                onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                aria-label={t('settings.projects.page.field.gitlabTemplateName')}
                inputSize="compact"
                className="w-full max-w-[16rem] rounded-md px-3"
              />
              <Select
                value={template.kind ?? NO_TEMPLATE_KIND_VALUE}
                onValueChange={(value) => commit(replaceTemplateAt(drafts, index, {
                  // SAFETY: the Select only offers the two kinds and the "none"
                  // value handled beside this cast.
                  kind: value === NO_TEMPLATE_KIND_VALUE ? null : value as GitlabIssueTemplateKind,
                }))}
              >
                <SelectTrigger
                  className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
                  aria-label={t('settings.projects.page.field.gitlabTemplateKind')}
                >
                  <SelectValue>{kindLabelOf(template.kind)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bug">{t('gitlabIssue.kind.bug')}</SelectItem>
                  <SelectItem value="feature">{t('gitlabIssue.kind.feature')}</SelectItem>
                  <SelectItem value={NO_TEMPLATE_KIND_VALUE}>
                    {t('settings.projects.page.field.gitlabTemplateKindNone')}
                  </SelectItem>
                </SelectContent>
              </Select>
              {template.builtin ? (
                <span className="typography-micro text-muted-foreground">
                  {t('settings.projects.page.field.gitlabTemplateBuiltin')}
                </span>
              ) : null}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="ms-auto shrink-0 !font-normal"
                onClick={() => (template.builtin
                  ? commit(replaceTemplateAt(drafts, index, builtinIssueTemplateDefaults(template.id, nameOf) ?? {}))
                  : commit(drafts.filter((_, at) => at !== index)))}
              >
                {template.builtin
                  ? t('settings.projects.page.field.gitlabTemplateReset')
                  : t('settings.projects.page.field.gitlabTemplateRemove')}
              </Button>
            </div>
            <Textarea
              value={template.body}
              onChange={(event) => setDrafts(replaceTemplateAt(drafts, index, { body: event.target.value }))}
              onBlur={() => commit(drafts)}
              rows={Math.min(12, Math.max(3, template.body.split('\n').length + 1))}
              aria-label={t('settings.projects.page.field.gitlabTemplateBody')}
              className="max-w-[40rem] resize-y font-mono text-xs"
            />
          </div>
        ))}
      </div>
      <Button type="button" size="sm" variant="outline" className="mt-3" onClick={addTemplate}>
        {t('settings.projects.page.field.gitlabTemplateAdd')}
      </Button>
    </SettingsControlGroup>
  );
};

export const GitlabIssuesSection: React.FC<{ project: ProjectEntry }> = ({ project }) => {
  const { t } = useI18n();
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const { options: accountOptions, checking: gitlabAccountsChecking } = useGitlabBotAccounts();

  const selectedBotAccount = React.useMemo(
    () => accountOptions.find((option) => option.id === project.gitlabIssueBotAccountId),
    [accountOptions, project.gitlabIssueBotAccountId],
  );

  const storedPrefix = project.gitlabIssueBranchPrefix ?? 'openchamber/';
  const prefixSyncKey = `${project.id}\u0000${storedPrefix}`;
  const [prefixDraft, setPrefixDraft] = React.useState(storedPrefix);
  const [prefixSyncedKey, setPrefixSyncedKey] = React.useState(prefixSyncKey);
  const [prefixError, setPrefixError] = React.useState(
    () => Boolean(project.gitlabIssueBranchPrefix) && !isValidBranchPrefix(storedPrefix),
  );
  if (prefixSyncedKey !== prefixSyncKey) {
    setPrefixSyncedKey(prefixSyncKey);
    setPrefixDraft(storedPrefix);
    setPrefixError(Boolean(project.gitlabIssueBranchPrefix) && !isValidBranchPrefix(storedPrefix));
  }

  const parsedReviewModel = React.useMemo(
    () => parseModelIdentifier(project.gitlabIssueReviewModel) ?? { providerId: '', modelId: '' },
    [project.gitlabIssueReviewModel],
  );
  const reviewProviders = useConfigStore((state) => selectProvidersForDirectory(state, project.path));
  const reviewVariants = React.useMemo(() => {
    const { providerId, modelId } = parsedReviewModel;
    if (!providerId || !modelId) return [];
    const model = reviewProviders
      .find((provider) => provider.id === providerId)
      ?.models.find((entry) => entry.id === modelId);
    return modelVariantNames(model);
  }, [parsedReviewModel, reviewProviders]);
  const storedReviewVariant = project.gitlabIssueReviewVariant ?? '';
  const reviewVariantOptions = storedReviewVariant && !reviewVariants.includes(storedReviewVariant)
    ? [...reviewVariants, storedReviewVariant]
    : reviewVariants;
  const reviewModelMissing = useConfigStore((state) =>
    selectIsModelMissingFromCatalog(state, project.path, parsedReviewModel.providerId, parsedReviewModel.modelId));

  const handleReviewModelChange = (providerId: string, modelId: string) => {
    const next = providerId && modelId ? `${providerId}/${modelId}` : '';
    if (next === (project.gitlabIssueReviewModel ?? '')) return;
    updateProjectMeta(project.id, { gitlabIssueReviewModel: next, gitlabIssueReviewVariant: '' });
  };

  const storedTimeout = project.gitlabIssueTimeoutMinutes;
  const timeoutInvalid = storedTimeout !== undefined
    && !(Number.isInteger(storedTimeout) && storedTimeout >= 1 && storedTimeout <= 1440);

  const storedReviewAgent = project.gitlabIssueReviewAgent ?? '';

  const storedVerifyCommand = project.gitlabIssueVerifyCommand ?? '';
  const verifySyncKey = `${project.id}\u0000${storedVerifyCommand}`;
  const [verifyCommandDraft, setVerifyCommandDraft] = React.useState(storedVerifyCommand);
  const [verifySyncedKey, setVerifySyncedKey] = React.useState(verifySyncKey);
  if (verifySyncedKey !== verifySyncKey) {
    setVerifySyncedKey(verifySyncKey);
    setVerifyCommandDraft(storedVerifyCommand);
  }
  const commitVerifyCommand = () => {
    const trimmed = verifyCommandDraft.trim();
    if (trimmed === storedVerifyCommand) return;
    updateProjectMeta(project.id, { gitlabIssueVerifyCommand: trimmed });
  };

  const commitPrefix = () => {
    const trimmed = prefixDraft.trim();
    if (!isValidBranchPrefix(trimmed)) {
      setPrefixError(true);
      return;
    }
    setPrefixError(false);
    if (trimmed !== storedPrefix) updateProjectMeta(project.id, { gitlabIssueBranchPrefix: trimmed });
  };

  return (
    <SettingsSection
      title={t('settings.projects.page.section.gitlabIssues')}
      contentClassName="space-y-5"
    >
      <SettingsCheckboxRow
        settingsItem="projects.gitlab-auto-dispatch"
        checked={project.autoDispatchGitlabIssues === true}
        onChange={(checked) => updateProjectMeta(project.id, { autoDispatchGitlabIssues: checked })}
        label={t('settings.projects.page.field.gitlabAutoDispatch')}
        info={t('settings.projects.page.field.gitlabAutoDispatchInfo')}
      />
      {project.autoDispatchGitlabIssues === true ? (
        <div className="border-t border-edge pt-5">
          <div className="space-y-2">
            <SettingsFieldRow
              settingsItem="projects.gitlab-branch-prefix"
              label={t('settings.projects.page.field.gitlabBranchPrefix')}
              info={t('settings.projects.page.field.gitlabBranchPrefixInfo')}
              controlClassName={GITLAB_CONTROL_COLUMN_CLASS}
            >
              <Input
                value={prefixDraft}
                onChange={(event) => {
                  setPrefixDraft(event.target.value);
                  if (prefixError) setPrefixError(false);
                }}
                onBlur={commitPrefix}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                placeholder="openchamber/"
                aria-label={t('settings.projects.page.field.gitlabBranchPrefix')}
                className={GITLAB_TEXT_INPUT_CLASS}
              />
              {prefixError ? (
                <span className="typography-meta text-[var(--status-error)]">
                  {t('settings.projects.page.field.gitlabBranchPrefixError')}
                </span>
              ) : null}
            </SettingsFieldRow>
            <SettingsFieldRow
              settingsItem="projects.gitlab-timeout"
              label={t('settings.projects.page.field.gitlabTimeout')}
              info={t('settings.projects.page.field.gitlabTimeoutInfo')}
              controlClassName={GITLAB_CONTROL_COLUMN_CLASS}
            >
              <NumberInput
                value={project.gitlabIssueTimeoutMinutes ?? 30}
                onValueChange={(value) => {
                  if (Number.isInteger(value) && value >= 1 && value <= 1440) {
                    updateProjectMeta(project.id, { gitlabIssueTimeoutMinutes: value });
                  }
                }}
                min={1}
                max={1440}
                step={1}
                containerClassName="w-full"
                className={cn(SETTINGS_NUMBER_INPUT_CLASS, 'w-full')}
                aria-label={t('settings.projects.page.field.gitlabTimeout')}
              />
              {timeoutInvalid ? (
                <span className="typography-meta text-[var(--status-error)]">
                  {t('settings.projects.page.field.gitlabTimeoutError')}
                </span>
              ) : null}
            </SettingsFieldRow>
          </div>
          <div className="space-y-2 border-t border-edge pt-5">
            <SettingsFieldRow
              settingsItem="projects.gitlab-review-model"
              label={t('settings.projects.page.field.gitlabReviewModel')}
              info={t('settings.projects.page.field.gitlabReviewModelInfo')}
              controlClassName={GITLAB_CONTROL_COLUMN_CLASS}
              description={reviewModelMissing
                ? <span className="text-[var(--status-warning)]">{t('settings.projects.page.field.gitlabReviewModelUnavailable')}</span>
                : undefined}
            >
              <ModelSelector
                directory={project.path}
                providerId={parsedReviewModel.providerId}
                modelId={parsedReviewModel.modelId}
                onChange={handleReviewModelChange}
                placeholder={t('settings.projects.page.field.gitlabReviewModelUseProject')}
                className={GITLAB_MODEL_TRIGGER_CLASS}
              />
            </SettingsFieldRow>
            {parsedReviewModel.providerId && parsedReviewModel.modelId && reviewVariantOptions.length > 0 ? (
              <SettingsFieldRow
                settingsItem="projects.gitlab-review-variant"
                label={t('settings.projects.page.field.gitlabReviewVariant')}
                controlClassName={GITLAB_CONTROL_COLUMN_CLASS}
              >
                <Select
                  value={storedReviewVariant || NO_VARIANT_VALUE}
                  onValueChange={(value) => updateProjectMeta(project.id, {
                    gitlabIssueReviewVariant: value === NO_VARIANT_VALUE ? '' : value,
                  })}
                >
                  <SelectTrigger className={GITLAB_SELECT_TRIGGER_CLASS} aria-label={t('settings.projects.page.field.gitlabReviewVariant')}>
                    <SelectValue>
                      {storedReviewVariant ? formatModelVariantLabel(storedReviewVariant) : t('settings.projects.page.option.gitlabReviewVariantDefault')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_VARIANT_VALUE}>{t('settings.projects.page.option.gitlabReviewVariantDefault')}</SelectItem>
                    {reviewVariantOptions.map((variant) => (
                      <SelectItem key={variant} value={variant}>{formatModelVariantLabel(variant)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsFieldRow>
            ) : null}
            <SettingsFieldRow
              settingsItem="projects.gitlab-review-agent"
              label={t('settings.projects.page.field.gitlabReviewAgent')}
              info={t('settings.projects.page.field.gitlabReviewAgentInfo')}
              controlClassName={GITLAB_CONTROL_COLUMN_CLASS}
            >
              <AgentSelector
                directory={project.path}
                agentName={storedReviewAgent}
                onChange={(agentName) => {
                  if (agentName === storedReviewAgent) return;
                  updateProjectMeta(project.id, { gitlabIssueReviewAgent: agentName });
                }}
                placeholder={t('settings.projects.page.field.gitlabReviewAgentUseProject')}
                className={GITLAB_MODEL_TRIGGER_CLASS}
              />
            </SettingsFieldRow>
            <div className="space-y-1.5 pt-1">
              <SettingsCheckboxRow
                settingsItem="projects.gitlab-second-review"
                checked={project.gitlabIssueSecondReview !== false}
                onChange={(checked) => updateProjectMeta(project.id, { gitlabIssueSecondReview: checked })}
                label={t('settings.projects.page.field.gitlabSecondReview')}
                info={t('settings.projects.page.field.gitlabSecondReviewInfo')}
              />
              <SettingsCheckboxRow
                settingsItem="projects.gitlab-auto-close-not-an-issue"
                checked={project.gitlabIssueAutoCloseNotAnIssue !== false}
                onChange={(checked) => updateProjectMeta(project.id, { gitlabIssueAutoCloseNotAnIssue: checked })}
                label={t('settings.projects.page.field.gitlabAutoCloseNotAnIssue')}
                info={t('settings.projects.page.field.gitlabAutoCloseNotAnIssueInfo')}
              />
            </div>
          </div>
          <div className="space-y-2 border-t border-edge pt-5">
            <SettingsFieldRow
              settingsItem="projects.gitlab-verify-command"
              label={t('settings.projects.page.field.gitlabVerifyCommand')}
              info={t('settings.projects.page.field.gitlabVerifyCommandInfo')}
              controlClassName={GITLAB_CONTROL_COLUMN_CLASS}
            >
              <Input
                value={verifyCommandDraft}
                onChange={(event) => setVerifyCommandDraft(event.target.value)}
                onBlur={commitVerifyCommand}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                placeholder="bun run check:changed"
                aria-label={t('settings.projects.page.field.gitlabVerifyCommand')}
                className={GITLAB_TEXT_INPUT_CLASS}
              />
            </SettingsFieldRow>
            <SettingsFieldRow
              settingsItem="projects.gitlab-bot-account"
              label={t('settings.projects.page.field.gitlabBotAccount')}
              info={t('settings.projects.page.field.gitlabBotAccountInfo')}
              controlClassName={GITLAB_CONTROL_COLUMN_CLASS}
            >
              {accountOptions.length === 0 ? (
                <span className={SETTINGS_HELPER_CLASS}>
                  {gitlabAccountsChecking
                    ? t('common.loading')
                    : t('settings.projects.page.field.gitlabBotAccountEmpty')}
                </span>
              ) : (
                <Select
                  value={project.gitlabIssueBotAccountId ?? ''}
                  onValueChange={(value) => updateProjectMeta(project.id, { gitlabIssueBotAccountId: value })}
                >
                  <SelectTrigger
                    className={GITLAB_SELECT_TRIGGER_CLASS}
                    aria-label={t('settings.projects.page.field.gitlabBotAccount')}
                  >
                    <SelectValue placeholder={t('settings.projects.page.field.gitlabBotAccountPlaceholder')}>
                      {selectedBotAccount?.label
                        ?? (project.gitlabIssueBotAccountId ? t('common.unavailable') : undefined)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {accountOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </SettingsFieldRow>
          </div>
        </div>
      ) : null}
      <GitlabIssueTemplatesEditor project={project} />
    </SettingsSection>
  );
};
