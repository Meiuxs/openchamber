/**
 * Diff-path matching shared by the changed-file rows and the turn-diff
 * backfill: entries are project-root relative while displayed paths may
 * carry a leading "./" or separators of either kind. A suffix match keeps
 * delegated edits under a nested prefix comparable.
 */
export const normalizeDiffPath = (path: string): string =>
    path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

export const diffPathsMatch = (left: string, right: string): boolean => {
    const a = normalizeDiffPath(left);
    const b = normalizeDiffPath(right);
    // Empty paths match nothing: an empty diff entry must not read as a
    // wildcard against every normalized path.
    return a !== '' && b !== '' && (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`));
};
