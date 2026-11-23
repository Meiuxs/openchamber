import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { buildManagedAccountOptions, getManagedCredentialSourceLabelKey } from '@/lib/source-control/identity';
import { useSourceControlDescriptorOf } from '@/lib/source-control/providers/registry';
import { getSourceControlAuthKey, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';

interface GitlabBotAccountOption {
  id: string;
  label: string;
}

interface GitlabBotAccounts {
  options: GitlabBotAccountOption[];
  checking: boolean;
}

const instanceLabelOf = (instance: string): string => {
  try {
    return new URL(instance.includes('://') ? instance : `https://${instance}`).host || instance;
  } catch {
    return instance;
  }
};

export const useGitlabBotAccounts = (): GitlabBotAccounts => {
  const { sourceControl } = useRuntimeAPIs();
  const { t } = useI18n();
  const identities = useSourceControlAuthStore((state) => state.identities);
  const authEntries = useSourceControlAuthStore((state) => state.entries);
  const refreshAccounts = useSourceControlAuthStore((state) => state.refreshAll);
  const descriptorOf = useSourceControlDescriptorOf();

  React.useEffect(() => {
    if (sourceControl) void refreshAccounts(sourceControl);
  }, [refreshAccounts, sourceControl]);

  const options = React.useMemo(() => {
    const found = identities.flatMap((identity) => {
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
    const instances = new Set(found.map((option) => option.instance));
    return found.map((option) => ({
      id: option.id,
      label: instances.size > 1 ? `@${option.username} · ${option.instance}` : `@${option.username}`,
    }));
  }, [authEntries, descriptorOf, identities, t]);

  const checking = React.useMemo(
    () => identities.some((identity) => identity.provider === 'gitlab'
      && !authEntries[getSourceControlAuthKey(identity)]?.hasChecked),
    [authEntries, identities],
  );

  return { options, checking };
};
