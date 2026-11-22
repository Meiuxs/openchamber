import React from 'react';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import type { ChatMessageEntry, TurnProjectionResult, TurnRecord } from '../lib/turns/types';
import { buildProjectionCacheKey, getCachedProjection, setCachedProjection } from '../lib/turns/turnProjectionCache';
import {
    backfillTurnDiffStats,
    clearTurnDiffBackfill,
    fetchTurnDiffStats,
    getTurnDiffBackfillState,
    markTurnDiffBackfillPending,
    setTurnDiffBackfillDone,
    setTurnDiffBackfillFailed,
} from '../lib/turns/turnDiffBackfill';
import { streamPerfMeasure } from '@/stores/utils/streamDebug';

interface UseTurnRecordsOptions {
    sessionKey?: string;
    showTurnChangedFiles: boolean;
    directory?: string;
}

interface TurnRecordsResult {
    projection: TurnProjectionResult;
    staticTurns: TurnProjectionResult['turns'];
    streamingTurn: TurnProjectionResult['turns'][number] | undefined;
}

export const useTurnRecords = (
    messages: ChatMessageEntry[],
    options: UseTurnRecordsOptions,
): TurnRecordsResult => {
    const previousProjectionRef = React.useRef<TurnProjectionResult | null>(null);
    const staticTurnsRef = React.useRef<TurnRecord[]>([]);
    const streamingTurnRef = React.useRef<TurnRecord | undefined>(undefined);
    const previousSessionKeyRef = React.useRef<string | undefined>(options.sessionKey);
    const previousShowTurnChangedFilesRef = React.useRef(options.showTurnChangedFiles);
    const [backfillVersion, bumpBackfillVersion] = React.useReducer((value: number) => value + 1, 0);

    if (
        previousSessionKeyRef.current !== options.sessionKey
        || previousShowTurnChangedFilesRef.current !== options.showTurnChangedFiles
    ) {
        previousSessionKeyRef.current = options.sessionKey;
        previousShowTurnChangedFilesRef.current = options.showTurnChangedFiles;
        previousProjectionRef.current = null;
        staticTurnsRef.current = [];
        streamingTurnRef.current = undefined;
    }

    React.useEffect(() => {
        previousProjectionRef.current = null;
        staticTurnsRef.current = [];
        streamingTurnRef.current = undefined;
        // The projection cache is discarded below, so the module-level
        // backfill cache must go with it: stale entries would otherwise keep
        // filling counts from another session's diffs forever.
        clearTurnDiffBackfill();
    }, [options.sessionKey, options.showTurnChangedFiles]);

    const projection = React.useMemo(() => {
        const sessionKey = options.sessionKey ?? '';
        const cacheKey = `${buildProjectionCacheKey(
            sessionKey,
            messages,
            options.showTurnChangedFiles,
            'merge',
        )}|bf:${backfillVersion}`;
        const cached = getCachedProjection(cacheKey);
        if (cached) {
            const backfilled = backfillTurnDiffStats(cached);
            previousProjectionRef.current = backfilled;
            return backfilled;
        }

        return streamPerfMeasure('ui.turns.projection_ms', () => {
            const nextProjection = projectTurnRecords(messages, {
                previousProjection: previousProjectionRef.current,
                showTurnChangedFiles: options.showTurnChangedFiles,
                mergeHiddenUserTurns: true,
            });
            const backfilled = backfillTurnDiffStats(nextProjection);
            previousProjectionRef.current = backfilled;

            setCachedProjection(cacheKey, backfilled);

            return backfilled;
        });
    }, [messages, options.showTurnChangedFiles, options.sessionKey, backfillVersion]);

    // Write calls carry no line counts in their metadata, so their changed
    // files render without +N −M. For completed turns only, fetch the
    // snapshot-based session turn diff once per turn and let the projection
    // fill the counts. Failures keep the filename-only presentation. The bump
    // after a fetch must not be guarded by effect cleanup: StrictMode and
    // sibling fetches retire earlier effect runs whose cleanup would otherwise
    // strand the settled data in the module cache with no recompute.
    React.useEffect(() => {
        const sessionId = options.sessionKey;
        if (!options.showTurnChangedFiles || !sessionId) return;
        for (const turn of projection.turns) {
            if (turn.stream.isStreaming) continue;
            // State first: settled turns must not re-read their lazy details.
            if (getTurnDiffBackfillState(turn.turnId)) continue;
            const files = turn.changedFiles;
            if (!files || !files.some((file) => file.additions === undefined)) continue;
            markTurnDiffBackfillPending(turn.turnId);
            void fetchTurnDiffStats(sessionId, turn.turnId, options.directory)
                .then((stats) => {
                    setTurnDiffBackfillDone(turn.turnId, stats);
                    bumpBackfillVersion();
                })
                .catch(() => {
                    setTurnDiffBackfillFailed(turn.turnId);
                });
        }
    }, [projection, options.showTurnChangedFiles, options.sessionKey, options.directory]);

    const lastMessageId = messages[messages.length - 1]?.info.id;
    const tailIsTurn = !lastMessageId || !projection.ungroupedMessageIds.has(lastMessageId);

    const staticTurns = React.useMemo(() => {
        const nextStatic = tailIsTurn
            ? projection.turns.slice(0, -1)
            : projection.turns;
        const previousStatic = staticTurnsRef.current;

        if (previousStatic.length === nextStatic.length) {
            let isSame = true;
            for (let index = 0; index < nextStatic.length; index += 1) {
                if (previousStatic[index] !== nextStatic[index]) {
                    isSame = false;
                    break;
                }
            }
            if (isSame) {
                return previousStatic;
            }
        }

        staticTurnsRef.current = nextStatic;
        return nextStatic;
    }, [projection.turns, tailIsTurn]);

    const streamingTurn = React.useMemo(() => {
        const nextStreamingTurn = projection.turns.length === 0 || !tailIsTurn
            ? undefined
            : projection.turns[projection.turns.length - 1];
        if (streamingTurnRef.current === nextStreamingTurn) {
            return streamingTurnRef.current;
        }
        streamingTurnRef.current = nextStreamingTurn;
        return nextStreamingTurn;
    }, [projection.turns, tailIsTurn]);

    return {
        projection,
        staticTurns,
        streamingTurn,
    };
};
