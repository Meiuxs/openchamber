/**
 * The sessions a run has opened, as one compact row: the activity each one
 * belongs to and the time it started, clicking through to the session itself.
 *
 * `RunSteps` answers the same question with the full per-stop trail; this is
 * the one-line version for a card that is folded — the sessions a fix and its
 * reviews opened stay reachable without opening anything.
 */
import * as React from 'react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { SessionDot } from './RunRail';
import { clockOf, phaseLabelKey, sessionTrailOf, type Phase, type Run } from './runModel';

export const SessionTrail = ({
  run,
  onOpenSession,
}: {
  run: Run;
  /** Where a click lands; the default opens the session in this window. */
  onOpenSession?: (sessionId: string) => void;
}) => {
  const { t } = useI18n();
  const trail = sessionTrailOf(run);
  if (trail.length === 0) return null;
  const open = onOpenSession ?? ((sessionId: string) => {
    useSessionUIStore.getState().setCurrentSession(sessionId, run.origin);
  });
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 typography-meta text-muted-foreground">
      {trail.map((session) => {
        const live = session.sessionId === run.sessionId;
        // SAFETY: `stage` is the phase the session served, which the ledger
        // only fills with a phase name.
        const stageKey = phaseLabelKey(session.stage as Phase);
        return (
          <button
            key={session.sessionId}
            type="button"
            className={cn(
              'inline-flex items-center gap-1 hover:text-foreground hover:underline',
              // The session the run is polling right now stands out; the
              // finished ones stay quiet until hover.
              live && 'text-foreground',
            )}
            onClick={() => open(session.sessionId)}
          >
            {live ? <SessionDot status={run.sessionStatus} /> : null}
            <span>{t(stageKey)}</span>
            {session.at ? <span className="tabular-nums">{clockOf(session.at)}</span> : null}
          </button>
        );
      })}
    </div>
  );
};
