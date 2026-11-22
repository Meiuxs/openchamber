import React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { checkIsGitRepository } from '@/lib/gitApiHttp';
import { useI18n } from '@/lib/i18n';
import { getSourceControlAuthKey, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { repositoryBindingOwner, useRepositoryBindings } from '@/lib/source-control/repository-binding';
import { applyIdentityToRepository } from '@/lib/source-control/applyIdentity';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { SourceControlAuthAccount, SourceControlBindingRead, SourceControlIdentity, SourceControlProviderBinding } from '@/lib/api/types';
import {
  bindMutation,
  bindingTargetForRead,
  duplicateGroups,
  normalizeInstance,
  primaryRemoteOf,
  providerMutationOf,
  resetIntent,
  restoreMutation,
  type RepositoryBindingRow,
} from './repositoryBindings';

type AccountOption = { accountId: string; label: string; account: SourceControlAuthAccount };
type BindOption = { key: string; label: string; identity: SourceControlIdentity; account: SourceControlAuthAccount };
type UndoEntry = { directory: string; provider: SourceControlProviderBinding; profileId: string | null };

type DialogState =
  | { kind: 'bind'; directory: string }
  | { kind: 'reset'; directory: string }
  | { kind: 'rebind'; directory: string }
  | { kind: 'duplicate'; key: string }
  | null;

const projectOf = (provider: SourceControlProviderBinding | undefined): string => (
  provider?.repository ? `${provider.repository.owner}/${provider.repository.name}` : '—'
);

export const RepositoryBindingsPage: React.FC<{ checkGit?: (directory: string) => Promise<boolean> }> = ({ checkGit = checkIsGitRepository }) => {
  const { t } = useI18n();
  const api = useRuntimeAPIs();
  const projects = useProjectsStore((state) => state.projects);
  const authEntries = useSourceControlAuthStore((state) => state.entries);
  const identities = useSourceControlAuthStore((state) => state.identities);
  const directories = React.useMemo(
    () => [...new Set(projects.map((project) => project.path).filter((path) => path.length > 0))],
    [projects],
  );
  const [gitDirectories, setGitDirectories] = React.useState<string[]>([]);
  const [scanning, setScanning] = React.useState(true);
  const [query, setQuery] = React.useState('');
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<DialogState>(null);
  const [selectedAccount, setSelectedAccount] = React.useState('');
  const [bindAccountKey, setBindAccountKey] = React.useState('');
  const [bindRemote, setBindRemote] = React.useState('');
  const [keepDirectory, setKeepDirectory] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);
  const [undoEntries, setUndoEntries] = React.useState<UndoEntry[]>([]);

  React.useEffect(() => {
    let active = true;
    setScanning(true);
    void Promise.all(directories.map(async (directory) => {
      try {
        return await checkGit(directory) ? directory : null;
      } catch {
        return null;
      }
    })).then((found) => {
      if (!active) return;
      setGitDirectories(found.filter((directory): directory is string => directory !== null));
      setScanning(false);
    });
    return () => { active = false; };
  }, [checkGit, directories]);

  const bindingStates = useRepositoryBindings(gitDirectories, api.sourceControl);
  const rows: RepositoryBindingRow[] = React.useMemo(() => gitDirectories.map((directory, index) => {
    const state = bindingStates[index];
    return {
      directory,
      read: state?.read ?? null,
      error: state?.status === 'error' ? state.error.message : null,
      loading: state?.status === 'idle' || state?.status === 'loading',
    };
  }), [bindingStates, gitDirectories]);

  React.useEffect(() => {
    void useSourceControlAuthStore.getState().refreshInstances(api.sourceControl)
      .then((instances) => useSourceControlAuthStore.getState().refreshIdentityAccounts(api.sourceControl, instances));
    void useGitIdentitiesStore.getState().loadProfiles();
  }, [api.sourceControl]);

  const gitRows = rows;
  const groups = React.useMemo(() => duplicateGroups(gitRows), [gitRows]);
  const visibleRows = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return gitRows;
    return gitRows.filter((row) => {
      const provider = row.read?.binding?.providers[0];
      return [row.directory, projectOf(provider), provider?.instance ?? '', provider?.accountId ?? '']
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [gitRows, query]);

  const accountsFor = React.useCallback((providerId: SourceControlProviderBinding['provider'], instance: string): AccountOption[] => {
    const identity = { provider: providerId, instance };
    const entry = authEntries[getSourceControlAuthKey(identity)];
    if (entry?.status?.status !== 'connected') return [];
    return (entry.status.accounts ?? [])
      .filter((account) => account.status === 'valid')
      .sort((left, right) => Number(right.current) - Number(left.current))
      .map((account) => ({ accountId: account.id, label: account.user.username || account.id, account }));
  }, [authEntries]);

  const bindOptions = React.useMemo((): BindOption[] => {
    const options: BindOption[] = [];
    for (const identity of identities) {
      const entry = authEntries[getSourceControlAuthKey(identity)];
      if (entry?.status?.status !== 'connected') continue;
      for (const account of entry.status.accounts ?? []) {
        if (account.status !== 'valid') continue;
        options.push({
          key: JSON.stringify([identity.provider, identity.instance, account.id]),
          label: account.user.username || account.id,
          identity: { provider: identity.provider, instance: identity.instance },
          account,
        });
      }
    }
    return options.sort((left, right) => Number(right.account.current) - Number(left.account.current));
  }, [authEntries, identities]);

  const openBindDialog = React.useCallback((row: RepositoryBindingRow) => {
    const target = row.read ? bindingTargetForRead(row.read, identities) : null;
    const matched = target
      ? bindOptions.find((option) => (
        option.identity.provider === target.identity.provider
        && normalizeInstance(option.identity.instance) === normalizeInstance(target.identity.instance)
      ))
      : undefined;
    setBindAccountKey((matched ?? bindOptions[0])?.key ?? '');
    setBindRemote(target?.primaryRemote ?? row.read?.repository.remotes[0]?.name ?? '');
    setDialog({ kind: 'bind', directory: row.directory });
  }, [bindOptions, identities]);

  const refresh = React.useCallback(async (directory: string, previous: SourceControlBindingRead, next: SourceControlBindingRead) => {
    const scope = repositoryBindingOwner.scope(directory);
    const mutation = repositoryBindingOwner.captureMutation(scope, previous);
    if (!repositoryBindingOwner.setMutationResult(mutation, next)) {
      await repositoryBindingOwner.reconcile(scope, api.sourceControl);
    }
    mutation.release();
  }, [api.sourceControl]);

  const captureUndo = React.useCallback((directory: string, provider: SourceControlProviderBinding) => {
    const profile = useGitIdentitiesStore.getState().profiles.find((item) => (
      item.account?.provider === provider.provider
      && normalizeInstance(item.account.instance) === normalizeInstance(provider.instance)
      && item.account.accountId === provider.accountId
    ));
    setUndoEntries((entries) => [...entries, { directory, provider, profileId: profile?.id ?? null }]);
  }, []);

  const resetRow = React.useCallback(async (row: RepositoryBindingRow) => {
    if (!row.read) return;
    const previous = row.read.binding?.providers[0];
    const next = await api.sourceControl.resetRepositoryBinding(resetIntent(row.directory, row.read));
    await refresh(row.directory, row.read, next);
    if (previous) captureUndo(row.directory, previous);
  }, [api.sourceControl, captureUndo, refresh]);

  const rebindRow = React.useCallback(async (row: RepositoryBindingRow, accountId: string) => {
    const binding = row.read?.binding;
    const current = row.read;
    const existing = binding?.providers[0];
    if (!current || !existing) return;
    const next = await api.sourceControl.repositoryProviderBindingMutate({
      directory: row.directory,
      expectedRepositoryId: current.repository.repositoryId,
      expectedRevision: current.revision,
      operation: 'replace',
      target: {
        provider: existing.provider,
        instance: existing.instance,
        accountId: existing.accountId,
        primaryRemote: existing.primaryRemote,
      },
      provider: providerMutationOf({ ...existing, accountId }),
    });
    await refresh(row.directory, current, next);
  }, [api.sourceControl, refresh]);

  const bindRow = React.useCallback(async (
    row: RepositoryBindingRow,
    identity: SourceControlIdentity,
    account: SourceControlAuthAccount,
    primaryRemote: string,
  ) => {
    const current = row.read;
    if (!current || current.binding) return;
    const target = { identity, primaryRemote };
    const profile = useGitIdentitiesStore.getState().profiles.find((item) => (
      item.account?.provider === identity.provider
      && normalizeInstance(item.account.instance) === normalizeInstance(identity.instance)
      && item.account.accountId === account.id
    ));
    if (profile) {
      const outcome = await applyIdentityToRepository(
        { directory: row.directory, identity: profile, remoteName: primaryRemote },
        { git: api.git, sourceControl: api.sourceControl },
      );
      if (outcome.status !== 'applied') throw new Error('Applying this identity failed');
    } else {
      const bound = await api.sourceControl.repositoryProviderBindingMutate(
        bindMutation(row.directory, current, target, account.id),
      );
      const remote = bound.repository.remotes.find((item) => item.name === primaryRemote);
      if (remote && /^https?:\/\//.test(remote.fetch.displayUrl)) {
        await api.git.configureTransportBinding?.({
          directory: row.directory,
          expectedRepositoryId: bound.repository.repositoryId,
          expectedRevision: bound.revision,
          expectedConfigRevision: bound.repository.configRevision,
          expectedFetchFingerprint: remote.fetch.fingerprint,
          expectedPushFingerprint: remote.push.fingerprint,
          remote: primaryRemote,
          transport: 'https',
          credentialAccount: {
            provider: identity.provider,
            instance: identity.instance,
            accountId: account.id,
          },
        });
      }
    }
    const next = await api.sourceControl.repositoryBinding(row.directory);
    await refresh(row.directory, current, next);
  }, [api.git, api.sourceControl, refresh]);

  const bindDialogRow = dialog?.kind === 'bind' ? rows.find((row) => row.directory === dialog.directory) : undefined;
  const bindRemotes = bindDialogRow?.read?.repository.remotes ?? [];
  const selectedBindOption = bindOptions.find((option) => option.key === bindAccountKey) ?? null;

  const runDialog = React.useCallback(async () => {
    if (!dialog) return;
    setBusy(true);
    setResult(null);
    try {
      if (dialog.kind === 'bind') {
        const row = rows.find((entry) => entry.directory === dialog.directory);
        const remote = row?.read?.repository.remotes.find((item) => item.name === bindRemote);
        if (!row || !selectedBindOption || !remote) throw new Error(t('repoBindings.bind.invalid'));
        await bindRow(row, selectedBindOption.identity, selectedBindOption.account, remote.name);
        setResult(t('repoBindings.result.done'));
      } else if (dialog.kind === 'reset') {
        const row = rows.find((entry) => entry.directory === dialog.directory);
        if (row) await resetRow(row);
        setResult(t('repoBindings.result.done'));
      } else if (dialog.kind === 'rebind') {
        const row = rows.find((entry) => entry.directory === dialog.directory);
        if (row && selectedAccount) await rebindRow(row, selectedAccount);
        setResult(t('repoBindings.result.done'));
      } else {
        const members = groups.get(dialog.key)?.members ?? [];
        const kept = members.find((entry) => entry.directory === keepDirectory) ?? members[0];
        let failed = 0;
        for (const row of members) {
          if (row.directory === kept?.directory) continue;
          try {
            await resetRow(row);
          } catch {
            failed += 1;
          }
        }
        setResult(failed > 0
          ? t('repoBindings.result.partial', { failed, total: members.length - 1 })
          : t('repoBindings.result.done'));
      }
      setDialog(null);
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [bindRemote, bindRow, dialog, groups, keepDirectory, rebindRow, resetRow, rows, selectedAccount, selectedBindOption, t]);

  const undo = React.useCallback(async (entry: UndoEntry) => {
    setBusy(true);
    try {
      const previous = await api.sourceControl.repositoryBinding(entry.directory);
      const profile = entry.profileId
        ? useGitIdentitiesStore.getState().getProfileById(entry.profileId)
        : undefined;
      if (profile) {
        const outcome = await applyIdentityToRepository(
          { directory: entry.directory, identity: profile, remoteName: entry.provider.primaryRemote },
          { git: api.git, sourceControl: api.sourceControl },
        );
        const current = await api.sourceControl.repositoryBinding(entry.directory);
        await refresh(entry.directory, previous, current);
        if (outcome.status === 'applied') setUndoEntries((entries) => entries.filter((item) => item !== entry));
        return;
      }
      const next = await api.sourceControl.repositoryProviderBindingMutate(
        restoreMutation(entry.directory, previous, entry.provider),
      );
      await refresh(entry.directory, previous, next);
      setUndoEntries((entries) => entries.filter((item) => item !== entry));
    } finally {
      setBusy(false);
    }
  }, [api.git, api.sourceControl, refresh]);

  const activeDialogRow = dialog && dialog.kind !== 'duplicate'
    ? rows.find((row) => row.directory === dialog.directory) ?? null
    : null;
  const activeDialogProvider = activeDialogRow?.read?.binding?.providers[0];
  const duplicateGroup = dialog?.kind === 'duplicate' ? groups.get(dialog.key) : undefined;
  const duplicateMembers = duplicateGroup?.members ?? [];

  return (
    <SettingsPageLayout title={t('settings.page.repositories.title')} namedBySidebar showSaveStatus>
      <SettingsSection title={t('settings.page.repositories.title')} info={t('repoBindings.subtitle')} settingsItem="repositories.bindings" contentClassName="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('repoBindings.search')}
            aria-label={t('repoBindings.search')}
            className="h-9 max-w-sm"
          />
          <Button type="button" variant="outline" size="sm" disabled={busy || scanning || gitDirectories.length === 0} onClick={() => {
            setResult(null);
            void Promise.all(gitDirectories.map((directory) => (
              repositoryBindingOwner.reconcile(repositoryBindingOwner.scope(directory), api.sourceControl)
            ))).then(() => setResult(t('repoBindings.result.done')))
              .catch((error: unknown) => setResult(error instanceof Error ? error.message : String(error)));
          }}>
            {t('repoBindings.refresh')}
          </Button>
        </div>
        {result ? <p className="text-sm text-muted-foreground">{result}</p> : null}
        {undoEntries.length > 0 ? (
          <div className="space-y-1">
            {undoEntries.map((entry) => (
              <div key={entry.directory} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <span className="truncate">{entry.directory} → {projectOf(entry.provider)}</span>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void undo(entry)}>
                  {t('repoBindings.action.undo')}
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        {duplicateMembers.length > 0 ? null : [...groups.entries()].map(([key, group]) => (
          <div key={key} className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{projectOf(group.provider)} · {group.members.length} {t('repoBindings.status.duplicate')}</span>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => {
                setKeepDirectory(group.members[0]?.directory ?? '');
                setDialog({ kind: 'duplicate', key });
              }}>
                {t('repoBindings.action.resolve')}
              </Button>
            </div>
          </div>
        ))}
        {scanning ? <p className="text-sm text-muted-foreground">{t('repoBindings.loading')}</p> : null}
        {!scanning && visibleRows.length === 0 ? <p className="text-sm text-muted-foreground">{t('repoBindings.empty')}</p> : null}
        <div className="divide-y rounded-md border">
          {visibleRows.map((row) => {
            const provider = row.read?.binding?.providers[0];
            const canBind = Boolean(row.read && !row.read.binding);
            const duplicate = [...groups.values()].some((group) => group.members.some((member) => member.directory === row.directory));
            const statusKey = row.error ? 'repoBindings.status.error'
              : row.loading ? 'repoBindings.loading'
                : provider?.readiness === 'ready' ? 'repoBindings.status.bound'
                  : row.read?.binding ? 'repoBindings.status.needsAttention'
                    : 'repoBindings.status.unbound';
            return (
              <div key={row.directory} className="px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{row.directory}</div>
                    <div className="text-muted-foreground">{projectOf(provider)}{duplicate ? ` · ${t('repoBindings.status.duplicate')}` : ''}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">{t(statusKey)}</span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded(expanded === row.directory ? null : row.directory)}>
                      {t('repoBindings.action.details')}
                    </Button>
                    {canBind ? (
                      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => openBindDialog(row)}>
                        {t('repoBindings.action.bind')}
                      </Button>
                    ) : null}
                    {row.read?.binding ? (
                      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setDialog({ kind: 'reset', directory: row.directory })}>
                        {t('repoBindings.action.reset')}
                      </Button>
                    ) : null}
                    {provider && accountsFor(provider.provider, provider.instance).length > 0 ? (
                      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => {
                        setSelectedAccount(provider.accountId);
                        setDialog({ kind: 'rebind', directory: row.directory });
                      }}>
                        {t('repoBindings.action.rebind')}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {expanded === row.directory ? (
                  <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
                    <div>{t('repoBindings.detail.remote')}: {row.read ? primaryRemoteOf(row.read) : '—'}</div>
                    <div>{t('repoBindings.detail.instance')}: {provider?.instance ?? '—'}</div>
                    <div>{t('repoBindings.detail.project')}: {projectOf(provider)}</div>
                    <div>{t('repoBindings.detail.revision')}: {row.read?.revision ?? '—'}</div>
                    {row.error ? <div className="text-destructive">{row.error}</div> : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </SettingsSection>

      <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === 'bind' ? t('repoBindings.dialog.bind')
                : dialog?.kind === 'reset' ? t('repoBindings.dialog.reset')
                  : dialog?.kind === 'rebind' ? t('repoBindings.dialog.rebind')
                    : t('repoBindings.dialog.duplicate')}
            </DialogTitle>
            <DialogDescription>
              {dialog?.kind === 'bind' ? t('repoBindings.dialog.bind.description')
                : dialog?.kind === 'reset' ? t('repoBindings.dialog.reset.description')
                  : dialog?.kind === 'rebind' ? t('repoBindings.dialog.rebind.description')
                    : t('repoBindings.dialog.duplicate.description')}
            </DialogDescription>
          </DialogHeader>
          {dialog?.kind === 'bind' ? (
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-lg bg-[var(--status-info-background)]/60 px-3 py-2">
                <Icon name="information" className="mt-0.5 size-4 shrink-0 text-[var(--status-info)]" />
                <p className="typography-meta text-[var(--status-info-text)]">{t('repoBindings.bind.hint')}</p>
              </div>
              <SettingsStackedField
                label={t('repoBindings.field.account.label')}
                info={t('repoBindings.field.account.info')}
              >
                {bindOptions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('repoBindings.bind.noAccount')}</p>
                ) : (
                  <Select value={bindAccountKey} onValueChange={setBindAccountKey}>
                    <SelectTrigger className="w-full" aria-label={t('repoBindings.field.account.label')}>
                      <SelectValue>{selectedBindOption?.label ?? ''}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {bindOptions.map((option) => (
                        <SelectItem key={option.key} value={option.key}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </SettingsStackedField>
              <SettingsStackedField
                label={t('repoBindings.field.remote.label')}
                info={t('repoBindings.field.remote.info')}
              >
                {bindRemotes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('repoBindings.bind.noRemote')}</p>
                ) : (
                  <Select value={bindRemote} onValueChange={setBindRemote}>
                    <SelectTrigger className="w-full" aria-label={t('repoBindings.field.remote.label')}>
                      <SelectValue>{bindRemote}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {bindRemotes.map((remote) => (
                        <SelectItem key={remote.name} value={remote.name}>{remote.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </SettingsStackedField>
            </div>
          ) : null}
          {dialog?.kind === 'rebind' && activeDialogProvider ? (
            <SettingsStackedField
              label={t('repoBindings.field.account.label')}
              info={t('repoBindings.field.account.info')}
            >
              <Select value={selectedAccount} onValueChange={setSelectedAccount}>
                <SelectTrigger className="w-full" aria-label={t('repoBindings.field.account.label')}>
                  <SelectValue>
                    {accountsFor(activeDialogProvider.provider, activeDialogProvider.instance)
                      .find((account) => account.accountId === selectedAccount)?.label ?? ''}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {accountsFor(activeDialogProvider.provider, activeDialogProvider.instance).map((account) => (
                    <SelectItem key={account.accountId} value={account.accountId}>{account.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsStackedField>
          ) : null}
          {dialog?.kind === 'duplicate' ? (
            <SettingsStackedField
              label={t('repoBindings.field.directory.label')}
              info={t('repoBindings.field.directory.info')}
            >
              <Select value={keepDirectory} onValueChange={setKeepDirectory}>
                <SelectTrigger className="w-full" aria-label={t('repoBindings.field.directory.label')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {duplicateMembers.map((member) => (
                    <SelectItem key={member.directory} value={member.directory}>{member.directory}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsStackedField>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>{t('settings.common.actions.cancel')}</Button>
            <Button type="button" disabled={busy
              || (dialog?.kind === 'rebind' && !selectedAccount)
              || (dialog?.kind === 'bind' && (!bindAccountKey || !bindRemote))} onClick={() => void runDialog()}>
              {t('repoBindings.action.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPageLayout>
  );
};
