import React, { memo } from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useRateGateStatus, useRateGateStore } from '@/stores/useRateGateStore';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';

const clock = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export const RateGateWaitingRow = memo(({ sessionId }: { sessionId: string | null }) => {
  const { t } = useI18n();
  const status = useRateGateStatus();
  const until = useRateGateStore(React.useCallback(
    (state) => (sessionId ? state.waitingUntil(sessionId) : null),
    [sessionId],
  ));

  const active = Boolean(status?.enabled) && until !== null;
  const now = useDurationTickerNow(active);

  if (until === null || until <= now) return null;

  return (
    <div
      role="status"
      className="flex oc-composer-row min-w-0 items-center gap-2 border-b border-edge ps-3 pe-3"
      title={t('chat.rateLimit.waiting', { time: clock(until, now) })}
    >
      <Icon name="time" className="size-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {t('chat.rateLimit.waiting', { time: clock(until, now) })}
      </span>
    </div>
  );
});

RateGateWaitingRow.displayName = 'RateGateWaitingRow';
