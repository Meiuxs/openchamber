import type {
  GitRemote,
  SourceControlAuthAccount,
  SourceControlBindingRead,
  SourceControlIdentity,
  SourceControlProviderBinding,
  SourceControlProviderBindingMutation,
  SourceControlRepositoryBindingResetIntent,
} from '@/lib/api/types';
import { resolveSourceControlIdentity } from '@/lib/source-control/identity';

export type RepositoryBindingRow = {
  directory: string;
  read: SourceControlBindingRead | null;
  error: string | null;
  loading: boolean;
};

type DuplicateGroup = {
  provider: SourceControlProviderBinding;
  members: RepositoryBindingRow[];
};

export const normalizeInstance = (value: string): string => value.trim().toLowerCase()
  .replace(/^https?:\/\//, '')
  .replace(/\/+$/, '');

export const providerMutationOf = (provider: SourceControlProviderBinding): SourceControlProviderBinding => ({
  provider: provider.provider,
  instance: provider.instance,
  accountId: provider.accountId,
  primaryRemote: provider.primaryRemote,
  ...(provider.repository ? { repository: provider.repository } : {}),
});

const projectKey = (provider: SourceControlProviderBinding): string | null => {
  if (!provider.repository) return null;
  return JSON.stringify([
    provider.provider,
    normalizeInstance(provider.instance),
    provider.accountId,
    provider.repository.owner.toLowerCase(),
    provider.repository.name.toLowerCase(),
  ]);
};

export const duplicateGroups = (rows: readonly RepositoryBindingRow[]): Map<string, DuplicateGroup> => {
  const grouped = new Map<string, DuplicateGroup>();
  for (const row of rows) {
    for (const provider of row.read?.binding?.providers ?? []) {
      const key = projectKey(provider);
      if (!key) continue;
      const group = grouped.get(key) ?? { provider, members: [] };
      group.members.push(row);
      grouped.set(key, group);
    }
  }
  return new Map([...grouped].filter(([, group]) => group.members.length > 1));
};

export const primaryRemoteOf = (read: SourceControlBindingRead): string => (
  read.binding?.providers[0]?.primaryRemote ?? read.repository.remotes[0]?.name ?? 'origin'
);

type BindingTarget = { identity: SourceControlIdentity; primaryRemote: string };

export const bindingTargetForRead = (
  read: SourceControlBindingRead,
  identities: readonly SourceControlIdentity[],
): BindingTarget | null => {
  const remotes = [...read.repository.remotes].sort((left, right) => (
    left.name === 'origin' ? -1 : right.name === 'origin' ? 1 : 0
  ));
  for (const remote of remotes) {
    const identity = resolveSourceControlIdentity(toGitRemote(remote), identities);
    if (identity) return { identity, primaryRemote: remote.name };
  }
  return null;
};

const toGitRemote = (remote: SourceControlBindingRead['repository']['remotes'][number]): GitRemote => ({
  name: remote.name,
  fetchUrl: remote.fetch.displayUrl,
  pushUrl: remote.push.displayUrl,
});

export const bindMutation = (
  directory: string,
  read: SourceControlBindingRead,
  target: BindingTarget,
  accountId: string,
): SourceControlProviderBindingMutation => ({
  directory,
  expectedRepositoryId: read.repository.repositoryId,
  expectedRevision: read.revision,
  operation: 'add',
  provider: {
    provider: target.identity.provider,
    instance: target.identity.instance,
    accountId,
    primaryRemote: target.primaryRemote,
  },
});

export const resetIntent = (
  directory: string,
  read: SourceControlBindingRead,
): SourceControlRepositoryBindingResetIntent => ({
  directory,
  expectedRepositoryId: read.repository.repositoryId,
  expectedRevision: read.revision,
  expectedConfigRevision: read.repository.configRevision,
  confirmed: true,
});

type RebindAllPlanEntry = {
  row: RepositoryBindingRow;
  target: BindingTarget;
  account: SourceControlAuthAccount;
};

export const rebindAllPlanFor = (
  rows: readonly RepositoryBindingRow[],
  identities: readonly SourceControlIdentity[],
  accounts: ReadonlyArray<{ identity: SourceControlIdentity; account: SourceControlAuthAccount }>,
): RebindAllPlanEntry[] => {
  const plan: RebindAllPlanEntry[] = [];
  for (const row of rows) {
    const read = row.read;
    if (!read) continue;
    const existing = read.binding?.providers[0];
    const target = existing
      ? { identity: { provider: existing.provider, instance: existing.instance }, primaryRemote: existing.primaryRemote }
      : bindingTargetForRead(read, identities);
    if (!target || target.identity.provider !== 'gitlab') continue;
    const existingAccountId = existing?.accountId;
    const candidates = accounts.filter((option) => (
      option.identity.provider === 'gitlab'
      && normalizeInstance(option.identity.instance) === normalizeInstance(target.identity.instance)
    ));
    const option = candidates.find((item) => item.account.current)
      ?? candidates.find((item) => item.account.id === existingAccountId)
      ?? candidates[0];
    if (option) plan.push({ row, target, account: option.account });
  }
  return plan;
};

export const restoreMutation = (
  directory: string,
  current: SourceControlBindingRead,
  provider: SourceControlProviderBinding,
): SourceControlProviderBindingMutation => ({
  directory,
  expectedRepositoryId: current.repository.repositoryId,
  expectedRevision: current.revision,
  operation: 'add',
  provider: providerMutationOf(provider),
});
