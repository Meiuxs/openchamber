import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { useRateGateStatus, useRateGateStore } from '@/stores/useRateGateStore';
import type { RateGateAccount } from '@/lib/rate-gate/status';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';

const clock = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

type RateGateTone = 'default' | 'warning' | 'error';

const toneOf = (account: RateGateAccount, now: number): RateGateTone => {
  if (account.limitedUntil !== null && account.limitedUntil > now) return 'error';
  if (account.remaining <= 0) return 'warning';
  return 'default';
};

export const WorkStatusRateLimitSection: React.FC<{ visible?: boolean }> = ({ visible = true }) => {
  const { t } = useI18n();
  const status = useRateGateStatus();
  const fetchStatus = useRateGateStore((state) => state.fetchStatus);

  const accounts = React.useMemo(
    () => [...(status?.accounts ?? [])].sort((left, right) => left.remaining - right.remaining),
    [status],
  );

  useReportWorkStatusPresence('rateLimit', accounts.length > 0);
  const counting = Boolean(status?.enabled) && accounts.length > 0;
  const now = useDurationTickerNow(counting && visible);

  if (!status || !status.enabled || accounts.length === 0) return null;

  const tightest = accounts[0];
  const summary = (
    <span className="inline-flex items-center gap-1.5">
      <WorkStatusValue tone={toneOf(tightest, now)}>
        {`${tightest.used}/${tightest.limit}`}
      </WorkStatusValue>
      {accounts.some((account) => account.waiting.length > 0) ? (
        <span className="text-muted-foreground">
          {t('chat.workStatus.rateLimit.queued', { count: accounts.reduce((total, account) => total + account.waiting.length, 0) })}
        </span>
      ) : null}
    </span>
  );

  return (
    <WorkStatusCollapsibleSection
      id="rateLimit"
      title={t('chat.workStatus.section.rateLimit')}
      icon="speed-up"
      summary={summary}
      action={(
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0">
              <Button
                size="icon"
                variant="ghost"
                className="size-6 shrink-0 text-muted-foreground"
                onClick={() => void fetchStatus()}
                aria-label={t('chat.workStatus.rateLimit.refresh')}
              >
                <Icon name="refresh" className="size-3.5" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{t('chat.workStatus.rateLimit.refresh')}</TooltipContent>
        </Tooltip>
      )}
    >
      {accounts.map((account) => {
        const limited = account.limitedUntil !== null && account.limitedUntil > now;
        const until = account.limitedUntil;
        const detail = limited && until !== null
          ? t('chat.workStatus.rateLimit.limitedUntil', { time: clock(until, now) })
          : t('chat.workStatus.rateLimit.resetIn', { time: clock(account.resetAt, now) });
        return (
          <WorkStatusRow
            key={account.key}
            label={account.label ?? account.providerIds[0] ?? account.key}
            value={<WorkStatusValue tone={limited ? 'error' : 'default'}>{`${account.used}/${account.limit}`}</WorkStatusValue>}
            detail={(
              <span className="inline-flex items-center gap-1.5">
                <span>{detail}</span>
                {account.waiting.length > 0 ? (
                  <span className="text-muted-foreground">
                    {t('chat.workStatus.rateLimit.queued', { count: account.waiting.length })}
                  </span>
                ) : null}
              </span>
            )}
          />
        );
      })}
    </WorkStatusCollapsibleSection>
  );
};
