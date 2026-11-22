import { describe, expect, test } from 'bun:test';
import {
    applyTurnDiffStats,
    backfillTurnDiffStats,
    parseTurnDiffStats,
    setTurnDiffBackfillDone,
} from './turnDiffBackfill';
import type { TurnChangedFile, TurnProjectionResult, TurnRecord } from './types';

function turnRecord(turnId: string, changedFiles: TurnChangedFile[] | undefined): TurnRecord {
    const userMessage = {
        info: { id: turnId, sessionID: 'session', role: 'user', time: { created: 1 } },
        parts: [{ type: 'text', id: 'request', messageID: turnId, sessionID: 'session', text: 'Request' }],
    };
    const record = {
        turnId,
        userMessageId: turnId,
        userMessage,
        messages: [],
        assistantMessageIds: ['a1'],
        assistantMessages: [],
        activityParts: [],
        summary: {},
        hasTools: false,
        hasReasoning: false,
        changedFiles,
        stream: { isStreaming: false, isRetrying: false },
    } as TurnRecord;
    return record;
}

function projection(turns: TurnRecord[]): TurnProjectionResult {
    return {
        turns,
        indexes: { turnById: new Map(), messageToTurnId: new Map(), messageMetaById: new Map() },
        lastTurnId: turns[turns.length - 1]?.turnId ?? null,
        lastTurnMessageIds: new Set<string>(),
        ungroupedMessageIds: new Set<string>(),
    };
}

describe('parseTurnDiffStats', () => {
    test('uses the server-computed counts of a write-created file', () => {
        const stats = parseTurnDiffStats([
            { file: 'src/new-file.ts', patch: '', additions: 12, deletions: 0 },
        ]);
        expect(stats.get('src/new-file.ts')).toEqual({ additions: 12, deletions: 0 });
    });

    test('counts patch hunks when the entry carries no counts (overwrite)', () => {
        const stats = parseTurnDiffStats([
            {
                file: 'src/overwritten.ts',
                patch: '@@ -1,1 +1,2 @@\n-before\n+after\n+added',
            },
        ]);
        expect(stats.get('src/overwritten.ts')).toEqual({ additions: 2, deletions: 1 });
    });

    test('drops entries without countable hunks instead of fabricating 0', () => {
        const stats = parseTurnDiffStats([
            { file: 'src/binary.png' },
            { file: '', additions: 3, deletions: 1 },
        ]);
        expect(stats.size).toBe(0);
    });
});

describe('applyTurnDiffStats', () => {
    test('fills a write-created file with the diff counts and keeps inTurnDiff', () => {
        const files: TurnChangedFile[] = [{ file: 'src/new-file.ts', inTurnDiff: true }];
        const stats = parseTurnDiffStats([{ file: 'src/new-file.ts', additions: 12, deletions: 0 }]);
        expect(applyTurnDiffStats(files, stats)).toEqual([
            { file: 'src/new-file.ts', additions: 12, deletions: 0, inTurnDiff: true },
        ]);
    });

    test('leaves files the diff does not contain and already-complete files alone', () => {
        const files: TurnChangedFile[] = [
            { file: 'src/missing.ts', inTurnDiff: true },
            { file: 'src/counted.ts', additions: 1, deletions: 1, inTurnDiff: true },
        ];
        const stats = parseTurnDiffStats([{ file: 'counted.ts', additions: 9, deletions: 9 }]);
        expect(applyTurnDiffStats(files, stats)).toBeUndefined();
        expect(files[1]).toEqual({ file: 'src/counted.ts', additions: 1, deletions: 1, inTurnDiff: true });
    });

    test('returns nothing to change when the fetch failed and stats are empty', () => {
        const files: TurnChangedFile[] = [{ file: 'src/new-file.ts', inTurnDiff: true }];
        expect(applyTurnDiffStats(files, parseTurnDiffStats([]))).toBeUndefined();
        expect(files[0]?.additions).toBeUndefined();
    });
});

describe('backfillTurnDiffStats', () => {
    test('replaces the turn with filled counts and points the indexes at the copy', () => {
        const original = turnRecord('turn-1', [{ file: 'src/new-file.ts', inTurnDiff: true }]);
        setTurnDiffBackfillDone('turn-1', parseTurnDiffStats([{ file: 'src/new-file.ts', additions: 12, deletions: 0 }]));
        const backfilled = backfillTurnDiffStats(projection([original]));

        expect(backfilled.turns[0]).not.toBe(original);
        expect(backfilled.turns[0]?.changedFiles).toEqual([
            { file: 'src/new-file.ts', additions: 12, deletions: 0, inTurnDiff: true },
        ]);
        expect(backfilled.indexes.turnById.get('turn-1')).toBe(backfilled.turns[0]);
        expect(backfilled.indexes.turnById.get('turn-1')).not.toBe(original);
    });

    test('returns the same projection when no turn has settled backfill state', () => {
        const original = turnRecord('turn-2', [{ file: 'src/new-file.ts', inTurnDiff: true }]);
        const input = projection([original]);
        expect(backfillTurnDiffStats(input)).toBe(input);
    });

    test('keeps a failed turn untouched instead of writing 0 counts', () => {
        const original = turnRecord('turn-3', [{ file: 'src/new-file.ts', inTurnDiff: true }]);
        const result = backfillTurnDiffStats(projection([original]));
        expect(result.turns[0]).toBe(original);
        expect(result.turns[0]?.changedFiles?.[0]?.additions).toBeUndefined();
    });
});
