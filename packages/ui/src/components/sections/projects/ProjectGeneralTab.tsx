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
  // New sessions skip a model the project's live catalog no longer lists; say
  // so, and where they go instead.
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
                className="h-8 w-full max-w-[16rem] rounded-md px-3 text-xs"
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
                  className="h-8 w-fit text-xs"
                  aria-label={t('settings.projects.page.field.gitlabTemplateKind')}
                >
                  <SelectValue />
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
              rows={6}
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

  const [reviewModelDraft, setReviewModelDraft] = React.useState(project.gitlabIssueReviewModel ?? '');
  const [reviewVariantDraft, setReviewVariantDraft] = React.useState(project.gitlabIssueReviewVariant ?? '');
  React.useEffect(() => {
    setReviewModelDraft(project.gitlabIssueReviewModel ?? '');
    setReviewVariantDraft(project.gitlabIssueReviewVariant ?? '');
  }, [project.id, project.gitlabIssueReviewModel, project.gitlabIssueReviewVariant]);

  const commitReviewModel = () => {
    const trimmed = reviewModelDraft.trim();
    if (trimmed === (project.gitlabIssueReviewModel ?? '')) return;
    updateProjectMeta(project.id, { gitlabIssueReviewModel: trimmed });
  };

  const commitReviewVariant = () => {
    const trimmed = reviewVariantDraft.trim();
    if (trimmed === (project.gitlabIssueReviewVariant ?? '')) return;
    updateProjectMeta(project.id, { gitlabIssueReviewVariant: trimmed });
  };

  const storedTimeout = project.gitlabIssueTimeoutMinutes;
  const timeoutInvalid = storedTimeout !== undefined
    && !(Number.isInteger(storedTimeout) && storedTimeout >= 1 && storedTimeout <= 1440);

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
      contentClassName="space-y-0"
    >
      <SettingsCheckboxRow
        settingsItem="projects.gitlab-auto-dispatch"
        checked={project.autoDispatchGitlabIssues === true}
        onChange={(checked) => updateProjectMeta(project.id, { autoDispatchGitlabIssues: checked })}
        label={t('settings.projects.page.field.gitlabAutoDispatch')}
        info={t('settings.projects.page.field.gitlabAutoDispatchInfo')}
      />
      {project.autoDispatchGitlabIssues === true ? (
        <>
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
          >
            <div className="flex flex-col gap-2">
              <Input
                value={reviewModelDraft}
                onChange={(event) => setReviewModelDraft(event.target.value)}
                onBlur={commitReviewModel}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                placeholder={t('settings.projects.page.field.gitlabReviewModelPlaceholder')}
                aria-label={t('settings.projects.page.field.gitlabReviewModel')}
              />
              <Input
                value={reviewVariantDraft}
                onChange={(event) => setReviewVariantDraft(event.target.value)}
                onBlur={commitReviewVariant}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                placeholder={t('settings.projects.page.field.gitlabReviewVariantPlaceholder')}
                aria-label={t('settings.projects.page.field.gitlabReviewVariant')}
              />
            </div>
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
        </>
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
          {/* What the file is and what it holds, said once in a sentence. */}
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

/**
 * Where this machine keeps the project's notes and todos: OpenChamber's own
 * data, or a file in the repository that Git carries to other machines.
 * The server moves the entries with the switch, so neither side comes up empty.
 */
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
