import { countPatch } from './liveActivitySummary';
import type { TurnChangedFile } from './types';

const patchContradictsTurnCounts = (patch: string, file: TurnChangedFile): boolean => {
    const counts = countPatch(patch);
    if (!counts) return true;
    return counts.additions < (file.additions ?? 0) || counts.deletions < (file.deletions ?? 0);
};

export const chooseTurnFilePatch = (
    file: TurnChangedFile,
    snapshotPatch: string | undefined,
): string | undefined => {
    if (!file.patch) return snapshotPatch;
    if (!snapshotPatch) return file.patch;
    return patchContradictsTurnCounts(snapshotPatch, file) ? file.patch : snapshotPatch;
};
