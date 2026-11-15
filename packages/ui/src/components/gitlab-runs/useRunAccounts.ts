/**
 * Which bound account may act on a run, decided per run origin.
 *
 * The ledger stores the instance as a base URL; an identity may spell the same
 * host without the scheme, so the two are compared by host rather than by the
 * string a person typed in either place.
 */
import * as React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { buildManagedAccountOptions, getManagedCredentialSourceLabelKey } from '@/lib/source-control/identity';
import { useSourceControlDescriptorOf } from '@/lib/source-control/providers/registry';
import { getSourceControlAuthKey, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';

type RunAccountOption = ReturnType<typeof buildManagedAccountOptions>[number];

export const useRunAccounts = (): ((origin: string) => RunAccountOption[]) => {
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const identities = useSourceControlAuthStore((state) => state.identities);
  const authEntries = useSourceControlAuthStore((state) => state.entries);
  const refreshAccounts = useSourceControlAuthStore((state) => state.refreshAll);
  const descriptorOf = useSourceControlDescriptorOf();

  React.useEffect(() => {
    void refreshAccounts(sourceControl);
  }, [refreshAccounts, sourceControl]);

  const instanceHost = React.useCallback((value: string): string => {
    try {
      return new URL(value.includes('://') ? value : `https://${value}`).host.toLowerCase();
    } catch {
      return value.toLowerCase();
    }
  }, []);

  return React.useCallback((origin: string) => identities
    .filter((identity) => identity.provider === 'gitlab'
      && instanceHost(identity.instance) === instanceHost(origin))
    .flatMap((identity) => {
      const entry = authEntries[getSourceControlAuthKey(identity)];
      if (!entry?.hasChecked || entry.status?.status !== 'connected') return [];
      return buildManagedAccountOptions(
        identity,
        descriptorOf(identity.provider),
        entry.status.accounts,
        (account) => t(getManagedCredentialSourceLabelKey(account.source)),
      );
    }), [authEntries, descriptorOf, identities, instanceHost, t]);
};
