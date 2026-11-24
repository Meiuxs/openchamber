import { describe, expect, test } from 'bun:test';
import { chooseTurnFilePatch } from './turnFilePatch';
import type { TurnChangedFile } from './types';

const toolPatch = '@@ -3,1 +3,0 @@\n-removed line';

// What a Git snapshot shows for a file it does not track: every line as new.
const wholeFileAdd = [
    '--- /dev/null',
    '+++ b/notes/x.md',
    '@@ -0,0 +1,2 @@',
    '+# notes',
    '+body',
].join('\n');

const file = (extra: Partial<TurnChangedFile> = {}): TurnChangedFile => ({
    file: 'notes/x.md', additions: 0, deletions: 1, inTurnDiff: true, patch: toolPatch, ...extra,
});

describe('chooseTurnFilePatch', () => {
    test('prefers the tool patch when the snapshot cannot account for the row counts', () => {
        expect(chooseTurnFilePatch(file(), wholeFileAdd)).toBe(toolPatch);
    });

    test('keeps the snapshot patch when it agrees with the row counts', () => {
        const snapshot = '@@ -3,1 +3,1 @@\n-removed line\n+kept line';
        expect(chooseTurnFilePatch(file({ additions: 1, deletions: 1 }), snapshot)).toBe(snapshot);
    });

    test('falls back to the tool patch when the snapshot has no entry for the file', () => {
        expect(chooseTurnFilePatch(file(), undefined)).toBe(toolPatch);
    });

    test('falls back to the snapshot when the tool reported no patch', () => {
        expect(chooseTurnFilePatch(file({ patch: undefined }), wholeFileAdd)).toBe(wholeFileAdd);
        expect(chooseTurnFilePatch(file({ patch: undefined }), undefined)).toBeUndefined();
    });

    test('treats an unreadable snapshot patch as unusable', () => {
        expect(chooseTurnFilePatch(file(), 'not a diff')).toBe(toolPatch);
    });
});
