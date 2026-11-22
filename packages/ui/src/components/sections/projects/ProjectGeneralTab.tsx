import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { NumberInput } from '@/components/ui/number-input';
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
import { Textarea } from '@/components/ui/textarea';
import {
  builtinIssueTemplateDefaults,
  resolveIssueTemplates,
  toStoredIssueTemplates,
  type BuiltinIssueTemplateNameKey,
  type GitlabIssueTemplateKind,
  type ResolvedIssueTemplate,
} from '@/lib/gitlab-issues/issueTemplates';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getSourceControlAuthKey, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { buildManagedAccountOptions, getManagedCredentialSourceLabelKey } from '@/lib/source-control/identity';
import { useSourceControlDescriptorOf } from '@/lib/source-control/providers/registry';
import { isValidBranchPrefix } from '@/lib/git-ref';
import { selectIsModelMissingFromCatalog, selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { modelVariantNames } from '@/lib/modelVariants';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { updateProjectSetup, updateSharedProjectSetup, type ProjectRef } from '@/lib/openchamberConfig';
import { isVSCodeRuntime } from '@/lib/desktop';
import { ensureSharedSetupTrusted, resetSharedSetupTrust } from '@/lib/sharedTrustConfirmation';
import { useI18n } from '@/lib/i18n';
import { generateUuid } from '@/lib/uuid';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import type { ProjectEntry } from '@/lib/api/types';
import type { useProjectIdentityForm } from './useProjectIdentityForm';
import type { ProjectSetupState } from './useProjectSetup';
import { ProjectSetupUnavailable } from './ProjectSettingsBits';

type ProjectIdentityFormState = ReturnType<typeof useProjectIdentityForm>;

const NO_VARIANT_VALUE = '__default__';

const formatVariantLabel = (variant: string): string => variant.charAt(0).toUpperCase() + variant.slice(1);

const ChatDefaultsSection: React.FC<{ form: ProjectIdentityFormState }> = ({ form }) => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => selectProvidersForDirectory(state, form.project?.path));
  const { parsedDefaultModel, defaultVariant } = form;
  const modelUnavailableNote = useConfigStore((state) => {
    const directory = form.project?.path;
    if (!selectIsModelMissingFromCatalog(state, directory, parsedDefaultModel.providerId, parsedDefaultModel.modelId)) return null;
    const global = parseModelIdentifier(state.settingsDefaultModel);
    const globalRuns = global !== null
      && !selectIsModelMissingFromCatalog(state, directory, global.providerId, global.modelId);
    return globalRuns
      ? 'settings.projects.page.field.projectModelUnavailableUsesGlobal' as const
      : 'settings.projects.page.field.projectModelUnavailable' as const;
  });

  const availableVariants = React.useMemo(() => {
    const { providerId, modelId } = parsedDefaultModel;
    if (!providerId || !modelId) return [];
    const model = providers
      .find((provider) => provider.id === providerId)
      ?.models.find((entry) => entry.id === modelId);
    return modelVariantNames(model);
  }, [parsedDefaultModel, providers]);

  if (!form.project) return null;

  return (
    <SettingsSection
      title={t('settings.projects.page.section.chatDefaults')}
      info={t('settings.projects.page.section.chatDefaultsDescription')}
      contentClassName="space-y-0"
    >
      <SettingsFieldRow settingsItem="projects.default-agent" label={t('settings.projects.page.field.projectAgent')}>
        <AgentSelector
          directory={form.project.path}
          agentName={form.defaultAgent || ''}
          onChange={(agentName) => form.setDefaultAgent(agentName || undefined)}
          filter={(agent) => isPrimaryMode(agent.mode)}
          className={SETTINGS_CUSTOM_TRIGGER_CLASS}
        />
      </SettingsFieldRow>

      <SettingsFieldRow
        settingsItem="projects.default-model"
        label={t('settings.projects.page.field.projectModel')}
        description={modelUnavailableNote
          ? <span className="text-[var(--status-warning)]">{t(modelUnavailableNote)}</span>
          : undefined}
      >
        <ModelSelector
          directory={form.project.path}
          providerId={parsedDefaultModel.providerId}
          modelId={parsedDefaultModel.modelId}
          onChange={form.handleDefaultModelChange}
          className={SETTINGS_CUSTOM_TRIGGER_CLASS}
        />
      </SettingsFieldRow>

      {availableVariants.length > 0 ? (
        <SettingsFieldRow settingsItem="projects.default-thinking" label={t('settings.projects.page.field.projectThinking')}>
          <Select
            value={defaultVariant ?? NO_VARIANT_VALUE}
            onValueChange={(value) => form.handleDefaultVariantChange(value === NO_VARIANT_VALUE ? undefined : value)}
          >
            <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.projects.page.field.projectThinking')}>
              <SelectValue>
                {defaultVariant ? formatVariantLabel(defaultVariant) : t('settings.projects.page.option.thinkingDefault')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_VARIANT_VALUE}>{t('settings.projects.page.option.thinkingDefault')}</SelectItem>
              {availableVariants.map((variant) => (
                <SelectItem key={variant} value={variant}>{formatVariantLabel(variant)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>
      ) : null}
    </SettingsSection>
  );
};

/**
 * The project's local-issue automation: whether the server may start a fix
 * session on its own for an assigned issue whose root cause is documented.
 */
const LocalIssuesSection: React.FC<{ project: ProjectEntry }> = ({ project }) => {
  const { t } = useI18n();
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);

  return (
    <SettingsSection
      title={t('settings.projects.page.section.localIssues')}
      contentClassName="space-y-0"
    >
      <SettingsCheckboxRow
        settingsItem="projects.auto-dispatch"
        checked={project.autoDispatchIssues === true}
        onChange={(checked) => updateProjectMeta(project.id, { autoDispatchIssues: checked })}
        label={t('settings.projects.page.field.autoDispatch')}
        info={t('settings.projects.page.field.autoDispatchInfo')}
      />
    </SettingsSection>
  );
};

/** The "no type" option; a template without a kind leaves the form's type alone. */
const NO_TEMPLATE_KIND_VALUE = '__none__';

const replaceTemplateAt = (
  templates: readonly ResolvedIssueTemplate[],
  index: number,
  patch: Partial<ResolvedIssueTemplate>,
): ResolvedIssueTemplate[] => templates.map((entry, at) => (at === index ? { ...entry, ...patch } : entry));

/**
 * The description templates a project offers when filing a GitLab issue. A
 * built-in template stores nothing while it matches its default, so an
 * untouched project keeps receiving built-in changes; editing one stores the
 * override, and its reset action removes that entry again.
 */
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

  // Store changes and language switches land here; typing does not, so a
  // half-typed name is never written.
  React.useEffect(() => { setDrafts(resolved); }, [resolved]);

  const commit = (next: ResolvedIssueTemplate[]) => {
    setDrafts(next);
    const stored = toStoredIssueTemplates(next, nameOf);
    // A blur that changed nothing must not rewrite the project file.
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

/** The instance as a person names it: `localhost:8929`, `gitlab.com`. */
const instanceLabelOf = (instance: string): string => {
  try {
    return new URL(instance.includes('://') ? instance : `https://${instance}`).host || instance;
  } catch {
    return instance;
  }
};

/**
 * The project's GitLab issue automation: whether the server may pick up
 * `ai-ready` issues, which bot account comments and labels, the branch prefix,
 * and how long an implementing session may run.
 */
const GitlabIssuesSection: React.FC<{ project: ProjectEntry }> = ({ project }) => {
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const identities = useSourceControlAuthStore((state) => state.identities);
  const authEntries = useSourceControlAuthStore((state) => state.entries);
  const refreshAccounts = useSourceControlAuthStore((state) => state.refreshAll);
  const descriptorOf = useSourceControlDescriptorOf();

  React.useEffect(() => {
    void refreshAccounts(sourceControl);
  }, [refreshAccounts, sourceControl]);

  // Choosing a bot answers one question — who comments and labels — so the list
  // says the person. The provider is named by the field itself, the credential
  // source never tells two GitLab accounts apart, and the instance only matters
  // when the list spans more than one of them.
  const accountOptions = React.useMemo(() => {
    const options = identities.flatMap((identity) => {
      if (identity.provider !== 'gitlab') return [];
      const entry = authEntries[getSourceControlAuthKey(identity)];
      if (!entry?.hasChecked || entry.status?.status !== 'connected') return [];
      return buildManagedAccountOptions(
        identity,
        descriptorOf(identity.provider),
        entry.status.accounts,
        (account) => t(getManagedCredentialSourceLabelKey(account.source)),
      ).map((option) => ({
        id: option.reference.accountId,
        username: option.username,
        instance: instanceLabelOf(option.reference.instance),
      }));
    });
    const instances = new Set(options.map((option) => option.instance));
    return options.map((option) => ({
      id: option.id,
      label: instances.size > 1 ? `@${option.username} · ${option.instance}` : `@${option.username}`,
    }));
  }, [authEntries, descriptorOf, identities, t]);

  const storedPrefix = project.gitlabIssueBranchPrefix ?? 'openchamber/';
  const [prefixDraft, setPrefixDraft] = React.useState(storedPrefix);
  const [prefixError, setPrefixError] = React.useState(false);
  React.useEffect(() => {
    const configuredPrefix = project.gitlabIssueBranchPrefix;
    setPrefixDraft(configuredPrefix ?? 'openchamber/');
    // A value that reached the store from outside the form must surface the
    // same error the form shows, so the stopped dispatcher is explained.
    setPrefixError(Boolean(configuredPrefix) && !isValidBranchPrefix(configuredPrefix ?? ''));
  }, [project.id, project.gitlabIssueBranchPrefix]);

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
  const [reviewAgentDraft, setReviewAgentDraft] = React.useState(storedReviewAgent);
  React.useEffect(() => {
    setReviewAgentDraft(project.gitlabIssueReviewAgent ?? '');
  }, [project.id, project.gitlabIssueReviewAgent]);
  const commitReviewAgent = () => {
    const trimmed = reviewAgentDraft.trim();
    if (trimmed === storedReviewAgent) return;
    updateProjectMeta(project.id, { gitlabIssueReviewAgent: trimmed });
  };

  const storedVerifyCommand = project.gitlabIssueVerifyCommand ?? '';
  const [verifyCommandDraft, setVerifyCommandDraft] = React.useState(storedVerifyCommand);
  React.useEffect(() => {
    setVerifyCommandDraft(project.gitlabIssueVerifyCommand ?? '');
  }, [project.id, project.gitlabIssueVerifyCommand]);
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
      contentClassName="space-y-3"
    >
      <SettingsCheckboxRow
        settingsItem="projects.gitlab-auto-dispatch"
        checked={project.autoDispatchGitlabIssues === true}
        onChange={(checked) => updateProjectMeta(project.id, { autoDispatchGitlabIssues: checked })}
        label={t('settings.projects.page.field.gitlabAutoDispatch')}
        info={t('settings.projects.page.field.gitlabAutoDispatchInfo')}
      />
      {project.autoDispatchGitlabIssues === true ? (
        <div>
          <SettingsFieldRow
            settingsItem="projects.gitlab-branch-prefix"
            label={t('settings.projects.page.field.gitlabBranchPrefix')}
            info={t('settings.projects.page.field.gitlabBranchPrefixInfo')}
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
              className="h-8 rounded-md px-3 font-mono text-xs"
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
              className={SETTINGS_NUMBER_INPUT_CLASS}
              aria-label={t('settings.projects.page.field.gitlabTimeout')}
            />
            {timeoutInvalid ? (
              <span className="typography-meta text-[var(--status-error)]">
                {t('settings.projects.page.field.gitlabTimeoutError')}
              </span>
            ) : null}
          </SettingsFieldRow>
          <SettingsFieldRow
            settingsItem="projects.gitlab-review-model"
            label={t('settings.projects.page.field.gitlabReviewModel')}
            info={t('settings.projects.page.field.gitlabReviewModelInfo')}
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
              className={SETTINGS_CUSTOM_TRIGGER_CLASS}
            />
          </SettingsFieldRow>
          {parsedReviewModel.providerId && parsedReviewModel.modelId && reviewVariantOptions.length > 0 ? (
            <SettingsFieldRow
              settingsItem="projects.gitlab-review-variant"
              label={t('settings.projects.page.field.gitlabReviewVariant')}
            >
              <Select
                value={storedReviewVariant || NO_VARIANT_VALUE}
                onValueChange={(value) => updateProjectMeta(project.id, {
                  gitlabIssueReviewVariant: value === NO_VARIANT_VALUE ? '' : value,
                })}
              >
                <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.projects.page.field.gitlabReviewVariant')}>
                  <SelectValue>
                    {storedReviewVariant ? formatVariantLabel(storedReviewVariant) : t('settings.projects.page.option.gitlabReviewVariantDefault')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_VARIANT_VALUE}>{t('settings.projects.page.option.gitlabReviewVariantDefault')}</SelectItem>
                  {reviewVariantOptions.map((variant) => (
                    <SelectItem key={variant} value={variant}>{formatVariantLabel(variant)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsFieldRow>
          ) : null}
          <SettingsFieldRow
            settingsItem="projects.gitlab-review-agent"
            label={t('settings.projects.page.field.gitlabReviewAgent')}
            info={t('settings.projects.page.field.gitlabReviewAgentInfo')}
          >
            <Input
              value={reviewAgentDraft}
              onChange={(event) => setReviewAgentDraft(event.target.value)}
              onBlur={commitReviewAgent}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              placeholder={t('settings.projects.page.field.gitlabReviewAgentUseProject')}
              aria-label={t('settings.projects.page.field.gitlabReviewAgent')}
              className="h-8 rounded-md px-3 font-mono text-xs"
            />
          </SettingsFieldRow>
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
          <SettingsFieldRow
            settingsItem="projects.gitlab-verify-command"
            label={t('settings.projects.page.field.gitlabVerifyCommand')}
            info={t('settings.projects.page.field.gitlabVerifyCommandInfo')}
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
              className="h-8 rounded-md px-3 font-mono text-xs"
            />
          </SettingsFieldRow>
          <SettingsFieldRow
            settingsItem="projects.gitlab-bot-account"
            label={t('settings.projects.page.field.gitlabBotAccount')}
            info={t('settings.projects.page.field.gitlabBotAccountInfo')}
          >
            <Select
              value={project.gitlabIssueBotAccountId ?? ''}
              onValueChange={(value) => updateProjectMeta(project.id, { gitlabIssueBotAccountId: value })}
            >
              <SelectTrigger
                className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
                aria-label={t('settings.projects.page.field.gitlabBotAccount')}
              >
                <SelectValue placeholder={t('settings.projects.page.field.gitlabBotAccountPlaceholder')}>
                  {project.gitlabIssueBotAccountId
                    ? accountOptions.find((option) => option.id === project.gitlabIssueBotAccountId)?.label
                    : undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {accountOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsFieldRow>
        </div>
      ) : null}
      <GitlabIssueTemplatesEditor project={project} />
    </SettingsSection>
  );
};

/**
 * The team's file in the repo: whether it is there and readable, whether
 * its commands may run on this machine, and the plans folder it names.
 * Actions and setup commands are shared from their own tabs.
 */
const TeamFileSection: React.FC<{ projectRef: ProjectRef; setupState: ProjectSetupState }> = ({ projectRef, setupState }) => {
  const { t } = useI18n();
  const { load, reload } = setupState;
  const setup = load.state === 'ready' ? load.setup : null;
  const [plansDirDraft, setPlansDirDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const storedPlansDir = setup?.shared.plansDir ?? '';

  React.useEffect(() => setPlansDirDraft(storedPlansDir), [storedPlansDir]);

  const savePlansDir = async () => {
    const next = plansDirDraft.trim();
    if (next === storedPlansDir) return;
    setBusy(true);
    try {
      if (!(await updateSharedProjectSetup(projectRef, { plansDir: next || null }))) {
        toast.error(t('settings.projects.shared.toast.shareFailed'));
        setPlansDirDraft(storedPlansDir);
        return;
      }
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const reviewTrust = async () => {
    if (!setup) return;
    setBusy(true);
    try {
      await ensureSharedSetupTrusted(projectRef, setup);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const forgetTrust = async () => {
    setBusy(true);
    try {
      if (!(await resetSharedSetupTrust(projectRef))) {
        toast.error(t('settings.projects.shared.toast.shareFailed'));
      }
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title={t('settings.projects.team.title')}
      settingsItem="projects.shared"
      contentClassName="space-y-5"
    >
      {!setup ? (
        <ProjectSetupUnavailable setupState={setupState} />
      ) : (
        <>
          <p className={cn('max-w-[40rem]', setup.shared.status === 'invalid' ? 'typography-meta text-[var(--status-warning)]' : SETTINGS_HELPER_CLASS)}>
            {setup.shared.status === 'invalid'
              ? t('settings.projects.shared.invalid', { path: setup.shared.path, reason: setup.shared.reason ?? '' })
              : setup.shared.status === 'ok'
                ? t('settings.projects.team.description.ok', { path: setup.shared.path })
                : t('settings.projects.team.description.missing', { path: setup.shared.path })}
          </p>

          {setup.trust.hash !== null ? (
            <div
              className={cn(
                'flex max-w-[40rem] items-center gap-3 rounded-lg p-3',
                setup.trust.trusted
                  ? 'oc-tile'
                  : 'bg-[var(--status-warning)]/10',
              )}
            >
              <Icon
                name={setup.trust.trusted ? 'shield-check' : 'error-warning'}
                className={cn('size-4 shrink-0', setup.trust.trusted ? 'text-[var(--status-success)]' : 'text-[var(--status-warning)]')}
              />
              <p className="min-w-0 flex-1 typography-meta text-foreground">
                {setup.trust.trusted ? t('settings.projects.team.trust.allowed') : t('settings.projects.team.trust.waiting')}
              </p>
              {setup.trust.trusted ? (
                <Button type="button" size="xs" variant="ghost" className="shrink-0 !font-normal" disabled={busy} onClick={() => void forgetTrust()}>
                  {t('settings.projects.team.trust.revoke')}
                </Button>
              ) : (
                <Button type="button" size="xs" variant="outline" className="shrink-0" disabled={busy} onClick={() => void reviewTrust()}>
                  {t('settings.projects.team.trust.review')}
                </Button>
              )}
            </div>
          ) : null}

          <SettingsFieldRow
            label={t('settings.projects.shared.plansDir')}
            info={t('settings.projects.shared.plansDirInfo')}
            settingsItem="projects.shared.plansDir"
          >
            <Input
              value={plansDirDraft}
              onChange={(event) => setPlansDirDraft(event.target.value)}
              onBlur={() => void savePlansDir()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              placeholder={t('settings.projects.shared.plansDirPlaceholder')}
              aria-label={t('settings.projects.shared.plansDirAria')}
              disabled={busy || setup.shared.status === 'invalid'}
              className="h-8 rounded-md px-3 font-mono text-xs"
            />
          </SettingsFieldRow>
        </>
      )}
    </SettingsSection>
  );
};

const NotesTodosSection: React.FC<{ projectRef: ProjectRef; setupState: ProjectSetupState }> = ({ projectRef, setupState }) => {
  const { t } = useI18n();
  const { load, reload } = setupState;
  const [busy, setBusy] = React.useState(false);
  if (load.state !== 'ready') return null;

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      if (!(await updateProjectSetup(projectRef, { notesTodosInRepository: next }))) {
        toast.error(t('settings.projects.notesTodos.toast.saveFailed'));
      }
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={t('settings.projects.notesTodos.title')}>
      <SettingsCheckboxRow
        settingsItem="projects.notes-todos.repository"
        checked={load.setup.personal.notesTodosInRepository}
        disabled={busy}
        onChange={(next) => void toggle(next)}
        label={t('settings.projects.notesTodos.inRepository')}
        description={t('settings.projects.notesTodos.inRepositoryDescription')}
      />
    </SettingsSection>
  );
};

export const ProjectGeneralTab: React.FC<{
  form: ProjectIdentityFormState;
  projectRef: ProjectRef;
  setupState: ProjectSetupState;
}> = ({ form, projectRef, setupState }) => (
  <>
    <ChatDefaultsSection form={form} />
    {form.project ? <LocalIssuesSection project={form.project} /> : null}
    {form.project ? <GitlabIssuesSection project={form.project} /> : null}
    {/* VS Code serves no notes and todos, so there is nothing to place. */}
    {isVSCodeRuntime() ? null : <NotesTodosSection projectRef={projectRef} setupState={setupState} />}
    <TeamFileSection projectRef={projectRef} setupState={setupState} />
  </>
);
