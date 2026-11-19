import React from 'react';
import { ProviderIcon } from '@/components/sourceControl/ProviderIcon';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import type { SourceControlAuthAccount } from '@/lib/api/types';

type SourceControlAccountGroup = {
  key: string;
  account: SourceControlAuthAccount;
};

const groupSourceControlAccounts = (
  accounts: SourceControlAuthAccount[],
): SourceControlAccountGroup[] => {
  const groups = new Map<string, SourceControlAccountGroup>();
  for (const account of accounts) {
    const key = JSON.stringify([
      account.user.provider,
      account.user.instance,
      account.source === 'cli' ? `cli:${account.user.id}` : account.user.id,
    ]);
    const group = groups.get(key);
    if (!group || (account.current && !group.account.current)
      || (account.status === 'valid' && group.account.status !== 'valid' && !group.account.current)) {
      groups.set(key, { key, account });
    }
  }
  return Array.from(groups.values());
};

const ProviderMark: React.FC<{ provider: string }> = ({ provider }) => (
  <ProviderIcon descriptor={useSourceControlProvider(provider)} variant="fill" className="size-4 text-muted-foreground" />
);

type SourceControlAccountListProps = {
  accounts: SourceControlAuthAccount[];
  avatarAlt: (username: string) => string;
  sourceLabel: (account: SourceControlAuthAccount) => string;
  statusLabel: (account: SourceControlAuthAccount) => string | null;
  currentLabel: string;
  renderActions: (account: SourceControlAuthAccount) => React.ReactNode;
};

export const SourceControlAccountList: React.FC<SourceControlAccountListProps> = ({
  accounts,
  avatarAlt,
  sourceLabel,
  statusLabel,
  currentLabel,
  renderActions,
}) => (
  <div className="divide-y divide-[var(--surface-subtle)]">
    {groupSourceControlAccounts(accounts).map((group) => {
      const { account } = group;
      const user = account.user;
      const source = sourceLabel(account);
      const status = statusLabel(account);
      return (
        <div key={group.key} className="py-3 first:pt-0 last:pb-0">
          <div className="flex min-w-0 items-center gap-3">
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={avatarAlt(user.username)}
                className="size-9 shrink-0 oc-tile-inset rounded-full object-cover"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex size-9 shrink-0 items-center justify-center oc-tile-inset rounded-full">
                <ProviderMark provider={user.provider} />
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate typography-ui-label text-foreground">
                {user.name?.trim() || user.username}
              </div>
              <div className="truncate font-mono typography-micro text-muted-foreground">
                {user.username}
              </div>
            </div>
          </div>
          <div className="ms-12 mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="flex flex-wrap items-center gap-1.5 typography-micro text-muted-foreground">
              <span>{source}</span>
              {status ? <>
                <span aria-hidden="true">·</span>
                <span className="text-[var(--status-warning)]">{status}</span>
              </> : null}
              {account.current ? <span className="oc-tile-inset rounded-full px-1.5">{currentLabel}</span> : null}
            </div>
            <div className="ms-auto flex flex-wrap justify-end gap-2">{renderActions(account)}</div>
          </div>
        </div>
      );
    })}
  </div>
);
