/**
 * How far one run has come, drawn as the stops it passes through.
 *
 * The rail reads the run alone: a blocked run is drawn at the stop it was
 * blocked from, not at one of its own, because `blocked` is a state of the run
 * rather than a place in the sequence.
 */
import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { phaseLabelKey, railOf, railStopOf, type Phase, type Run } from './runModel';

export const RunRail = ({ run }: { run: Run }) => {
  const { t } = useI18n();
  const stops = railOf(run);
  // SAFETY: the value came from `run.phase`/`blockedFrom`, which the ledger
  // only fills with a phase name, so it is a rail phase or `done`.
  const currentPhase = railStopOf(
    run.phase === 'blocked' ? run.blockedFrom : run.phase,
  ) as Phase | null;
  const currentIndex = currentPhase && currentPhase !== 'done' && currentPhase !== 'blocked'
    ? stops.indexOf(currentPhase)
    : run.phase === 'done' ? stops.length - 1 : -1;
  const blockedIndex = run.phase === 'blocked' ? Math.max(currentIndex, 0) : -1;
  const railColor = run.phase === 'blocked'
    ? 'var(--status-error-text)'
    : run.phase === 'waiting-approval'
      ? 'var(--status-warning-text)'
      : run.phase === 'done'
        ? 'var(--status-success)'
        : 'var(--status-info)';

  return (
    <div className="mt-3 flex items-center" aria-hidden="true">
      {stops.map((stop, index) => {
        const isDone = run.phase === 'done' || (index < currentIndex && run.phase !== 'blocked');
        const isCurrent = index === currentIndex && run.phase !== 'done' && run.phase !== 'blocked';
        const isBlocked = index === blockedIndex;
        return (
          <React.Fragment key={stop}>
            <span
              className={cn(
                'flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-medium tabular-nums',
                isDone && 'bg-[var(--surface-elevated)] text-muted-foreground',
                isCurrent && 'text-[var(--primary-foreground)]',
                isBlocked && 'text-[var(--status-error-text)]',
                !isDone && !isCurrent && !isBlocked && 'text-muted-foreground/60',
              )}
              style={isCurrent ? { backgroundColor: railColor } : isBlocked ? { backgroundColor: 'var(--status-error-background)' } : undefined}
            >
              {isDone ? <Icon name="check" className="size-3" /> : isBlocked ? <Icon name="error-warning" className="size-3" /> : index + 1}
            </span>
            {index < stops.length - 1 ? (
              <span
                className={cn('h-px min-w-2 flex-1', isDone ? 'bg-[var(--surface-elevated)]' : 'bg-border')}
              />
            ) : null}
            <span className="sr-only">{t(phaseLabelKey(stop))}</span>
          </React.Fragment>
        );
      })}
    </div>
  );
};

export const SessionDot = ({ status }: { status: 'busy' | 'idle' | null }) => {
  // A session that is working blinks every other second; a finished one stays still.
  const dim = useWaitingBlink(status === 'busy');
  if (!status) return null;
  return (
    <span
      className={cn(
        'size-1.5 rounded-full',
        status === 'busy' ? 'bg-[var(--status-info)]' : 'bg-[var(--status-success)]',
        dim,
      )}
    />
  );
};
