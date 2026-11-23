import React from 'react';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import type { TurnChangedFile } from '../../lib/turns/types';
import { cn } from '@/lib/utils';
import { useChatSessionSelection } from '../../chatColumnSession';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getGitDiff } from '@/lib/gitDiffApi';
import { opencodeClient } from '@/lib/opencode/client';
import { openTurnFileDiffInEditor } from '../openTurnFileDiffInEditor';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { useI18n } from '@/lib/i18n';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { hasTextSelectionInside } from '@/lib/textSelection';
import { isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';
import { DiffCount } from '@/components/ui/diff-count';
import { DEFAULT_CONTEXT_DIFF_LINES, FULL_CONTEXT_DIFF_LINES } from '@/components/views/diffView/diffContextLines';
import { PlainDiffFallback } from '../parts/PlainDiffFallback';
import { dispatchRowExpand } from '../../lib/scroll/timelineScrollIntent';
import { diffPathsMatch as pathsMatch } from '../../lib/turns/diffPaths';

const InlineTurnDiff = React.lazy(() =>
    import('../parts/ToolPartDiffPreview').then((module) => ({ default: module.default })),
);

const CHANGED_FILE_LIMIT = 4;

type TurnFileDiff = { file: string; patch: string };

const getDisplayFileName = (file: string): string => {
    const normalized = file.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    return segments.at(-1) ?? file;
};

type InlineDiffState =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; patch: string }
    | { status: 'error'; message: string };

// The patch is parsed and syntax-highlighted in the transcript, so a huge file
// stays an error rather than locking the row.
const MAX_ADDED_FILE_DIFF_CHARS = 400_000;

const addedFilePatch = (path: string, content: string): string | null => {
    if (content.length > MAX_ADDED_FILE_DIFF_CHARS || content.includes('\0')) return null;
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return [
        '--- /dev/null',
        `+++ b/${path.replace(/\\/g, '/')}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
        '',
    ].join('\n');
};

const ChangedFileRow = React.memo(({
    file,
    canExpand,
    loadPatch,
    onOpen,
}: {
    file: TurnChangedFile;
    canExpand: boolean;
    loadPatch?: () => Promise<string>;
    onOpen?: (file: string) => void;
}) => {
    const { t } = useI18n();
    const [expanded, setExpanded] = React.useState(false);
    const [diff, setDiff] = React.useState<InlineDiffState>({ status: 'idle' });
    const expandLabel = expanded
        ? t('chat.changedFiles.actions.collapse', { path: file.file })
        : t('chat.changedFiles.actions.expand', { path: file.file });

    const toggle = () => {
        const next = !expanded;
        setExpanded(next);
        if (!next || !loadPatch || diff.status === 'ready' || diff.status === 'loading') return;
        setDiff({ status: 'loading' });
        void loadPatch()
            .then((patch) => setDiff({ status: 'ready', patch }))
            .catch(() => setDiff({ status: 'error', message: t('diffView.state.failedToLoadDiff') }));
    };

    return (
        <div className="flex flex-col">
            <div className="flex min-h-11 items-center gap-2 md:min-h-7">
                {canExpand ? (
                    <button
                        type="button"
                        data-changed-file-expand=""
                        className="flex size-9 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground md:size-6"
                        aria-label={expandLabel}
                        aria-expanded={expanded}
                        title={expandLabel}
                        onClick={(event) => {
                            event.stopPropagation();
                            if (!expanded) dispatchRowExpand(event.currentTarget);
                            toggle();
                        }}
                    >
                        <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
                    </button>
                ) : (
                    <span className="size-9 shrink-0 md:size-6" aria-hidden />
                )}
                <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                    {onOpen ? (
                        <button
                            type="button"
                            className="min-w-0 shrink-0 font-medium text-foreground/80 hover:text-foreground"
                            aria-label={t('chat.changedFiles.actions.openFileTitle', { path: file.file })}
                            title={file.file}
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (hasTextSelectionInside(event.currentTarget)) return;
                                onOpen(file.file);
                            }}
                        >
                            {getDisplayFileName(file.file)}
                        </button>
                    ) : (
                        <span className="min-w-0 shrink-0 font-medium text-foreground/80" title={file.file}>
                            {getDisplayFileName(file.file)}
                        </span>
                    )}
                    <span className="min-w-0 flex-1 truncate typography-meta text-muted-foreground" title={file.file}>
                        {file.file}
                    </span>
                </div>
                {file.additions !== undefined && file.deletions !== undefined ? (
                    <DiffCount added={file.additions} removed={file.deletions} className="typography-meta font-medium" />
                ) : null}
            </div>
            {expanded && diff.status !== 'idle' ? (
                <div data-turn-inline-diff={diff.status} className={cn('oc-tile-inset mt-1 rounded-md', diff.status === 'ready' && 'p-1')}>
                    {diff.status === 'loading' ? (
                        <div className="flex items-center gap-2 px-3 py-2 typography-meta text-muted-foreground">
                            <Icon name="loader-4" className="size-3.5 animate-spin" />
                            {t('diffView.state.loadingDiff')}
                        </div>
                    ) : null}
                    {diff.status === 'error' ? (
                        <div className="px-3 py-2 typography-meta text-[var(--status-error-text)]">{diff.message}</div>
                    ) : null}
                    {diff.status === 'ready' ? (
                        <React.Suspense fallback={<PlainDiffFallback diff={diff.patch} />}>
                            <InlineTurnDiff diff={diff.patch} diffViewMode="unified" />
                        </React.Suspense>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
});

const ChangedFileCard = React.memo(({
    files,
    children,
}: {
    files: TurnChangedFile[];
    children: React.ReactNode;
}) => {
    const { t } = useI18n();
    const hasTotals = files.some((file) => file.additions !== undefined || file.deletions !== undefined);
    const totalAdded = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
    const totalRemoved = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
    return (
        <div className="oc-tile mt-1 w-full rounded-lg px-3 py-2">
            <div className="flex items-baseline justify-between gap-3 pb-2">
                <span className="typography-ui-label font-normal text-foreground">
                    {files.length === 1
                        ? t('chat.changedFiles.headerSingle', { count: 1 })
                        : t('chat.changedFiles.headerPlural', { count: files.length })}
                </span>
                {hasTotals ? (
                    <DiffCount added={totalAdded} removed={totalRemoved} hideZero className="typography-meta font-medium" />
                ) : null}
            </div>
            <div className="flex flex-col gap-1">{children}</div>
        </div>
    );
});

const InteractiveFileRows = React.memo(({ files, turnId }: { files: TurnChangedFile[]; turnId?: string }) => {
    const { t } = useI18n();
    const effectiveDirectory = useEffectiveDirectory();
    const { sessionId } = useChatSessionSelection();
    const isMobile = useUIStore((state) => state.isMobile);
    const navigateToDiff = useUIStore((state) => state.navigateToDiff);
    const openContextDiff = useUIStore((state) => state.openContextDiff);
    const setPendingTurnDiffFile = useUIStore((state) => state.setPendingTurnDiffFile);
    const mobileActions = useMobileAppActions();
    const runtime = useRuntimeAPIs();
    const turnDiffRequest = React.useRef<{ key: string; promise: Promise<TurnFileDiff[]> } | null>(null);

    const openTurnDiff = React.useCallback((file: string) => {
        const editor = runtime.editor;
        if (runtime.runtime.isVSCode && editor && effectiveDirectory) {
            if (!sessionId) return;
            void opencodeClient.getSessionTurnDiff(sessionId, { directory: effectiveDirectory, from: turnId, context: FULL_CONTEXT_DIFF_LINES })
                .then((turnDiff) => openTurnFileDiffInEditor({ directory: effectiveDirectory, editor, file, turnDiff }))
                .catch(() => toast.error(t('diffView.state.failedToLoadDiff')));
            return;
        }

        if (mobileActions) {
            mobileActions.openChanges({ diffPath: file, scope: 'turn', turnId, sessionId, directory: effectiveDirectory });
            return;
        }

        setPendingTurnDiffFile({ file, sessionId, turnId, panelSessionId: useSessionUIStore.getState().currentSessionId });
        if (!isMobile && effectiveDirectory) {
            openContextDiff(effectiveDirectory, file, false, 'turn');
            return;
        }

        navigateToDiff(file, false, 'turn');
    }, [effectiveDirectory, isMobile, mobileActions, navigateToDiff, openContextDiff, runtime, sessionId, setPendingTurnDiffFile, t, turnId]);

    const openFile = React.useCallback((file: string) => {
        if (!effectiveDirectory) return;
        const absolutePath = toAbsoluteFilePath(effectiveDirectory, file);
        if (runtime.runtime.isVSCode && runtime.editor) {
            void runtime.editor.openFile(absolutePath);
            return;
        }
        useUIStore.getState().openContextFile(effectiveDirectory, absolutePath);
        mobileActions?.openFiles();
    }, [effectiveDirectory, mobileActions, runtime]);

    // The turn diff is a snapshot of the session directory, so a file a tool
    // wrote outside it can never appear there: no expand arrow, and the name
    // opens the file instead of an empty diff.
    const canOpenDiff = React.useCallback((file: TurnChangedFile): boolean => (
        file.inTurnDiff !== false
        && (!effectiveDirectory || isFilePathWithinDirectory(toAbsoluteFilePath(effectiveDirectory, file.file), effectiveDirectory))
    ), [effectiveDirectory]);

    const loadPatch = React.useCallback(async (path: string): Promise<string> => {
        if (!sessionId) throw new Error(t('diffView.state.failedToLoadDiff'));
        const key = JSON.stringify([sessionId, effectiveDirectory, turnId]);
        if (!turnDiffRequest.current || turnDiffRequest.current.key !== key) {
            turnDiffRequest.current = {
                key,
                // Hunk context, not the whole file: the row shows the changed
                // fragments the way a tool diff does.
                promise: opencodeClient.getSessionTurnDiff(sessionId, { directory: effectiveDirectory, from: turnId, context: DEFAULT_CONTEXT_DIFF_LINES }),
            };
        }
        let diffs: TurnFileDiff[];
        try {
            diffs = await turnDiffRequest.current.promise;
        } catch (error) {
            if (turnDiffRequest.current?.key === key) turnDiffRequest.current = null;
            throw error;
        }
        const entry = diffs.find((candidate) => pathsMatch(candidate.file, path));
        if (entry) return entry.patch;
        if (effectiveDirectory) {
            const workingTree = await getGitDiff(effectiveDirectory, { path, contextLines: DEFAULT_CONTEXT_DIFF_LINES }).catch(() => null);
            if (workingTree?.diff.trim()) return workingTree.diff;
        }
        // A session can sit outside any Git repository (its location is a plain
        // directory of projects): snapshots record no diff and no working-tree
        // diff exists. Read the file itself and show what the tool wrote as an
        // added-file diff, which beats failing the row.
        try {
            if (runtime.files?.readFile) {
                const absolute = effectiveDirectory ? toAbsoluteFilePath(effectiveDirectory, path) : path;
                const file = await runtime.files.readFile(absolute, { directory: effectiveDirectory ?? undefined });
                const patch = addedFilePatch(path, file.content);
                if (patch) return patch;
            }
        } catch {
            // Unreadable or unsupported: the row keeps its error state.
        }
        throw new Error(t('diffView.state.failedToLoadDiff'));
    }, [effectiveDirectory, runtime, sessionId, t, turnId]);

    return (
        <>
            {files.map((file) => {
                const opensDiff = canOpenDiff(file);
                return (
                    <ChangedFileRow
                        key={file.file}
                        file={file}
                        canExpand={opensDiff}
                        loadPatch={opensDiff ? () => loadPatch(file.file) : undefined}
                        onOpen={file.inTurnDiff === false ? undefined : opensDiff ? openTurnDiff : openFile}
                    />
                );
            })}
        </>
    );
});

export const TurnChangedFilePills = React.memo(({ files, turnId, isLatestTurn }: { files?: TurnChangedFile[]; turnId?: string; isLatestTurn: boolean }) => {
    const { t } = useI18n();
    const [expanded, setExpanded] = React.useState(false);
    const toggleRef = React.useRef<HTMLButtonElement>(null);
    React.useLayoutEffect(() => {
        const toggle = toggleRef.current;
        if (!expanded && toggle && toggle.ownerDocument.activeElement === toggle) {
            toggle.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }, [expanded]);
    if (!files || files.length === 0) return null;

    const hiddenCount = files.length - CHANGED_FILE_LIMIT;
    const visibleFiles = expanded ? files : files.slice(0, CHANGED_FILE_LIMIT);
    const interactive = isLatestTurn || Boolean(turnId);
    const label = expanded
        ? t('chat.changedFiles.actions.showFewer')
        : t('chat.changedFiles.actions.otherFiles', { count: hiddenCount });

    return (
        <ChangedFileCard files={files}>
            {interactive ? (
                <InteractiveFileRows files={visibleFiles} turnId={isLatestTurn ? undefined : turnId} />
            ) : (
                visibleFiles.map((file) => <ChangedFileRow key={file.file} file={file} canExpand={false} />)
            )}
            {hiddenCount > 0 ? (
                <HoverTooltip label={label}>
                    <button
                        ref={toggleRef}
                        type="button"
                        data-changed-files-more=""
                        className="flex min-h-7 items-center gap-2 rounded text-muted-foreground hover:text-foreground"
                        aria-expanded={expanded}
                        aria-label={label}
                        onClick={(event) => {
                            event.stopPropagation();
                            if (!expanded) dispatchRowExpand(event.currentTarget);
                            setExpanded((value) => !value);
                        }}
                    >
                        <span className="flex size-9 shrink-0 items-center justify-center md:size-6">
                            {expanded ? <Icon name="arrow-up-s" className="size-3.5" /> : null}
                        </span>
                        <span className="typography-meta font-medium">{expanded ? label : `+${hiddenCount}`}</span>
                    </button>
                </HoverTooltip>
            ) : null}
        </ChangedFileCard>
    );
});
