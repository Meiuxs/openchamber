import { opencodeClient } from '@/lib/opencode/client';
import { countPatch } from './liveActivitySummary';
import { projectTurnIndexes } from './projectTurnIndexes';
import type { TurnChangedFile, TurnProjectionResult, TurnRecord } from './types';

interface TurnDiffEntry {
    file: string;
    patch?: string;
    additions?: number;
    deletions?: number;
}

type TurnDiffStats = { additions: number; deletions: number };

type TurnDiffBackfillEntry =
    | { state: 'pending' }
    | { state: 'done'; stats: Map<string, TurnDiffStats> }
    | { state: 'failed' };

// One request per turn while a session view is active: pending blocks
// duplicates, done and failed stop refetches. Cleared when the view resets
// (session switch or changed-files toggle), so failed turns retry on
// revisit and the map stays bounded to the active view.
const backfillByTurnId = new Map<string, TurnDiffBackfillEntry>();

export const clearTurnDiffBackfill = (): void => {
    backfillByTurnId.clear();
};

export const getTurnDiffBackfillState = (turnId: string): TurnDiffBackfillEntry | undefined => (
    backfillByTurnId.get(turnId)
);

export const markTurnDiffBackfillPending = (turnId: string): void => {
    backfillByTurnId.set(turnId, { state: 'pending' });
};

export const setTurnDiffBackfillDone = (turnId: string, stats: Map<string, TurnDiffStats>): void => {
    backfillByTurnId.set(turnId, { state: 'done', stats });
};

export const setTurnDiffBackfillFailed = (turnId: string): void => {
    backfillByTurnId.set(turnId, { state: 'failed' });
};

import { diffPathsMatch, normalizeDiffPath } from './diffPaths';

export const parseTurnDiffStats = (entries: readonly TurnDiffEntry[]): Map<string, TurnDiffStats> => {
    const stats = new Map<string, TurnDiffStats>();
    for (const entry of entries) {
        if (typeof entry.file !== 'string' || entry.file === '') continue;
        const counts = typeof entry.additions === 'number' && typeof entry.deletions === 'number'
            ? { additions: entry.additions, deletions: entry.deletions }
            : countPatch(entry.patch);
        // An entry without countable hunks stays out: no stats must not read as
        // an authoritative 0/0 for the file.
        if (!counts) continue;
        stats.set(normalizeDiffPath(entry.file), counts);
    }
    return stats;
};

export const applyTurnDiffStats = (
    files: readonly TurnChangedFile[],
    stats: Map<string, TurnDiffStats>,
): TurnChangedFile[] | undefined => {
    let changed = false;
    const next = files.map((file) => {
        if (file.additions !== undefined || file.deletions !== undefined) return file;
        const counts = Array.from(stats.entries()).find(([path]) => diffPathsMatch(file.file, path))?.[1];
        if (!counts) return file;
        changed = true;
        return { ...file, additions: counts.additions, deletions: counts.deletions };
    });
    return changed ? next : undefined;
};

const backfillTurn = (turn: TurnRecord, stats: Map<string, TurnDiffStats>): TurnRecord | undefined => {
    const files = turn.changedFiles;
    if (!files || !files.some((file) => file.additions === undefined)) return undefined;
    const merged = applyTurnDiffStats(files, stats);
    if (!merged) return undefined;
    // A new record identity lets the row memo comparators see the filled
    // counts; value spread snapshots this rendered turn's lazy details.
    return { ...turn, changedFiles: merged };
};

/**
 * Fills incomplete changed-file counts from session turn diff stats fetched
 * for rendered completed turns. Turns without a settled backfill entry stay
 * untouched so their lazy details keep waiting for a mounted row to read them.
 * Returns the same projection when nothing changed.
 */
export const backfillTurnDiffStats = (projection: TurnProjectionResult): TurnProjectionResult => {
    if (backfillByTurnId.size === 0) return projection;
    let changed = false;
    const turns = projection.turns.map((turn) => {
        const entry = backfillByTurnId.get(turn.turnId);
        if (entry?.state !== 'done') return turn;
        const next = backfillTurn(turn, entry.stats);
        if (!next) return turn;
        changed = true;
        return next;
    });
    if (!changed) return projection;
    return { ...projection, turns, indexes: projectTurnIndexes(turns).indexes };
};

export const fetchTurnDiffStats = async (
    sessionId: string,
    turnId: string,
    directory?: string | null,
): Promise<Map<string, TurnDiffStats>> => {
    const entries = await opencodeClient.getSessionTurnDiff(sessionId, { from: turnId, directory });
    return parseTurnDiffStats(entries);
};
