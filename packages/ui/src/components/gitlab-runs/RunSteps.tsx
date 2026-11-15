/**
 * How far one run has come, as the stops it passes through, named.
 *
 * `RunRail` answers the same question in one line, because a board row has no
 * room for names. This is what a card opens into: every stop in order, the time
 * the run entered it, the sessions it opened there, and what else happened — a
 * block belongs to the stop it happened at, not to a step of its own.
 */
import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { SessionDot } from './RunRail';
import { clockOf, guideKey, phaseLabelKey, railOf, railStopOf, sessionTrailOf, type Phase, type Run, type RunEvent } from './runModel';

const eventLine = (
  event: RunEvent,
  t: ReturnType<typeof useI18n>['t'],
): string => {
  if (event.kind === 'session') return t('gitlabRuns.event.session');
  // The reason stays a machine value in the ledger; the step line shows its
  // guide text instead, like the blocked banner does.
  const reason = event.reason ? t(guideKey(String(event.reason))) : '';
  const detail = event.detail ? String(event.detail) : '';
  return [`${t(phaseLabelKey('blocked'))}${reason ? ` · ${reason}` : ''}`, detail].filter(Boolean).join(' — ');
};

export const RunSteps = ({
  run,
  onOpenSession,
}: {
  run: Run;
  onOpenSession: (sessionId: string) => void;
}) => {
  const { t } = useI18n();
  const stops = railOf(run);
  const events = run.events;
  const phase = railStopOf(run.phase === 'blocked' ? run.blockedFrom : run.phase);
  // SAFETY: `phase` came from `run.phase`/`blockedFrom`, which the ledger
  // only fills with a phase name, so it is one of the rail's stops.
  const currentStop = phase && phase !== 'done' ? stops.indexOf(phase as Phase) : -1;
  const currentIndex = phase === 'done' ? stops.length - 1 : currentStop;
  const blockedFrom = run.phase === 'blocked' ? railStopOf(run.blockedFrom) : null;
  const sessions = sessionTrailOf(run);

  return (
    <div className="mt-3">
      <ol className="flex flex-col gap-1.5">
        {stops.map((stop, index) => {
          // A stop can be entered by two events: the move itself and the
          // session start that follows it. A ledger written before every event
          // carried a time has only the second one timed, so the clock comes
          // from whichever event has it.
          const entered = events.find(
            (event) => event.kind === 'phase' && event.to === stop && event.at !== null,
          ) ?? null;
          const stopSessions = sessions.filter((session) => session.stage === stop);
          const here = events
            .filter((event) => (event.kind === 'blocked' ? event.from === stop : event.phase === stop))
            // A stop that lists its sessions does not repeat them as a line.
            .filter((event) => !(event.kind === 'session' && stopSessions.length > 0));
          const reached = run.phase === 'done' || index <= currentIndex;
          const current = run.phase !== 'done' && index === currentIndex;
          const stopped = stop === blockedFrom;
          return (
            <li key={stop} className="flex items-start gap-2">
              <span
                className={cn(
                  'mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded',
                  reached && !current && 'bg-[var(--surface-elevated)] text-muted-foreground',
                  current && 'text-[var(--primary-foreground)]',
                  stopped && 'text-[var(--status-error-text)]',
                  !reached && !current && !stopped && 'text-muted-foreground/40',
                )}
                style={current
                  ? { backgroundColor: 'var(--status-info)' }
                  : stopped
                    ? { backgroundColor: 'var(--status-error-background)' }
                    : undefined}
              >
                {stopped
                  ? <Icon name="error-warning" className="size-2.5" />
                  : reached && !current
                    ? <Icon name="check" className="size-2.5" />
                    : null}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      'typography-meta',
                      reached ? 'text-foreground' : 'text-muted-foreground/60',
                      current && 'font-medium text-foreground',
                    )}
                  >
                    {t(phaseLabelKey(stop))}
                  </span>
                  <span className="ms-auto shrink-0 typography-meta tabular-nums text-muted-foreground">
                    {entered ? clockOf(entered.at) : ''}
                  </span>
                </div>
                {here.map((event, eventIndex) => (
                  <p
                    key={`${event.at ?? ''}-${eventIndex}`}
                    className={cn(
                      'mt-0.5 typography-meta break-words',
                      event.kind === 'blocked' ? 'text-[var(--status-error-text)]' : 'text-muted-foreground',
                    )}
                  >
                    {eventLine(event, t)}
                    {event.at ? (
                      <span className="ms-1.5 tabular-nums text-muted-foreground">{clockOf(event.at)}</span>
                    ) : null}
                  </p>
                ))}
                {stopSessions.map((session) => {
                  const live = session.sessionId === run.sessionId;
                  return (
                    <button
                      key={session.sessionId}
                      type="button"
                      aria-label={t('gitlabRuns.action.openSession')}
                      className={cn(
                        'mt-0.5 flex max-w-full items-center gap-1.5 typography-meta hover:underline',
                        // Only the session the run is polling right now speaks
                        // with a state; the finished ones stay quiet until hover.
                        live ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                      )}
                      onClick={() => onOpenSession(session.sessionId)}
                    >
                      {live ? <SessionDot status={run.sessionStatus} /> : null}
                      <span className="truncate">{t('gitlabRuns.action.openSession')}</span>
                      {session.at ? (
                        <span className={cn(
                          'shrink-0 tabular-nums',
                          live ? 'text-muted-foreground' : undefined,
                        )}
                        >
                          {clockOf(session.at)}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>
      {events.length === 0 && sessions.length === 0 ? (
        <p className="mt-1.5 typography-meta text-muted-foreground/70">{t('gitlabRuns.event.none')}</p>
      ) : null}
    </div>
  );
};
