import React from 'react';
import { findRepoFile, getRelativeFilePath, isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';
import { findFileRepository } from '@/lib/nestedRepositories';
import { isVSCodeRuntime } from '@/lib/desktop';
import type { FilesAPI, GitAPI } from '@/lib/api/types';
import type { useUIStore } from '@/stores/useUIStore';
import { useGitStore, type NestedRepoDiscovery } from '@/stores/useGitStore';
import { commitSelectionKey, useCommitSelectionStore } from '@/stores/useCommitSelectionStore';
import {
    beginChangedFileOpen, createLatestRequestGate, isProjectFileOutsideRepositories, openChangedFileWithoutRepository,
} from '../files/openChangedFileWithoutRepository';
import type { TurnSnapshotDiff } from '../turnSnapshotDiff';
import type { DiffScope, DiffViewProps, FileEntry } from './types';

interface DiffViewTurnNavigationOptions {
    visible: boolean;
    activeDiffScope: DiffScope;
    setActiveDiffScope: React.Dispatch<React.SetStateAction<DiffScope>>;
    setDisplayFile: React.Dispatch<React.SetStateAction<string | null>>;
    setDisplayFileStaged: React.Dispatch<React.SetStateAction<boolean>>;
    shouldPinAfterAlignRef: React.RefObject<boolean>;
    pendingScrollTargetRef: React.RefObject<string | null>;
    expandStackedFile: (path: string) => void;
    setScrollRequestNonce: React.Dispatch<React.SetStateAction<number>>;
    pendingTurnDiffFile: ReturnType<typeof useUIStore.getState>['pendingTurnDiffFile'];
    setPendingTurnDiffFile: ReturnType<typeof useUIStore.getState>['setPendingTurnDiffFile'];
    diffScope: DiffScope | null;
    panelSessionId: string | null;
    turnDiffSettled: boolean;
    rootDirectory: string | undefined;
    lastTurnDiffs: TurnSnapshotDiff[];
    onDiffScopeChange: DiffViewProps['onDiffScopeChange'];
    effectiveDirectory: string | undefined;
    repositoriesKnown: boolean;
    rootIsGitRepo: boolean | null;
    nestedRepos: NestedRepoDiscovery | undefined;
    repositoryOptions: string[] | null;
    selectNestedRepo: ReturnType<typeof useGitStore.getState>['selectNestedRepo'];
    fetchStatus: ReturnType<typeof useGitStore.getState>['fetchStatus'];
    git: GitAPI;
    changedFiles: FileEntry[];
    files: FilesAPI;
}

export function useDiffViewTurnNavigation({
    visible, activeDiffScope, setActiveDiffScope, setDisplayFile, setDisplayFileStaged, shouldPinAfterAlignRef,
    pendingScrollTargetRef, expandStackedFile, setScrollRequestNonce, pendingTurnDiffFile, diffScope,
    panelSessionId, setPendingTurnDiffFile, turnDiffSettled, rootDirectory, lastTurnDiffs, onDiffScopeChange, effectiveDirectory,
    repositoriesKnown, rootIsGitRepo, nestedRepos, repositoryOptions, selectNestedRepo, fetchStatus, git, changedFiles,
    files,
}: DiffViewTurnNavigationOptions) {
    const [changedFallback, setChangedFallback] = React.useState<{
        file: string; picked: boolean; statusReadFor: string | null; isCurrent: () => boolean;
    } | null>(null);
    const fallbackStatusRequestRef = React.useRef<string | null>(null);
    const [editorOpenGate] = React.useState(createLatestRequestGate);
    const gateSessionRef = React.useRef(panelSessionId);
    const revealListedFile = React.useCallback((path: string) => {
        setDisplayFile(path);
        setDisplayFileStaged(false);
        shouldPinAfterAlignRef.current = true;
        pendingScrollTargetRef.current = path;
        expandStackedFile(path);
        setScrollRequestNonce((value) => value + 1);
    }, [expandStackedFile]);

    const revealCommittedFile = React.useCallback(async (
        repository: string, file: string, isCurrent: () => boolean,
    ): Promise<boolean> => {
        if (isVSCodeRuntime() || !git.getGitLog || !git.getCommitFiles) return false;
        const filePath = getRelativeFilePath(file, repository);
        if (!filePath) return false;
        try {
            const log = await git.getGitLog(repository, { file: filePath, maxCount: 1 });
            const entry = log?.all?.[0];
            if (!entry?.hash || !isCurrent()) return false;
            const listing = await git.getCommitFiles(repository, entry.hash);
            const target = listing.files.find((candidate) => candidate.path === filePath || candidate.previousPath === filePath);
            if (!target || target.isBinary || !isCurrent()) return false;
            const branch = useGitStore.getState().directories.get(repository)?.status?.current ?? null;
            useCommitSelectionStore.getState().select(commitSelectionKey(repository, branch), entry);
            setActiveDiffScope('commit');
            onDiffScopeChange?.('commit');
            revealListedFile(target.path);
            return true;
        } catch {
            return false;
        }
    }, [git, onDiffScopeChange, revealListedFile, setActiveDiffScope]);

    React.useEffect(() => {
        if (!pendingTurnDiffFile) return;
        editorOpenGate.cancel();
        if (!visible) return;
        if (diffScope !== 'turn' || pendingTurnDiffFile.panelSessionId !== panelSessionId) {
            setPendingTurnDiffFile(null);
            return;
        }
        if (!turnDiffSettled || activeDiffScope !== 'turn') return;
        setPendingTurnDiffFile(null);
        const file = toAbsoluteFilePath(rootDirectory, pendingTurnDiffFile.file);
        const listed = findRepoFile(file, rootDirectory, lastTurnDiffs.flatMap((diff) => diff.file ?? []));
        if (listed) {
            const repository = findFileRepository(file, [
                ...(rootIsGitRepo && rootDirectory ? [rootDirectory] : []),
                ...(repositoryOptions ?? []),
            ]);
            if (rootDirectory && repository && repository !== effectiveDirectory) {
                selectNestedRepo(rootDirectory, repository);
            }
            revealListedFile(listed);
            return;
        }
        fallbackStatusRequestRef.current = null;
        setChangedFallback({
            file, picked: false, statusReadFor: null, isCurrent: beginChangedFileOpen(editorOpenGate, panelSessionId),
        });
        setActiveDiffScope('working');
        onDiffScopeChange?.('working');
    }, [activeDiffScope, diffScope, editorOpenGate, effectiveDirectory, lastTurnDiffs, onDiffScopeChange, panelSessionId, pendingTurnDiffFile, repositoryOptions, revealListedFile, rootDirectory, rootIsGitRepo, selectNestedRepo, setPendingTurnDiffFile, turnDiffSettled, visible]);

    React.useEffect(() => {
        if (gateSessionRef.current !== panelSessionId) {
            gateSessionRef.current = panelSessionId;
            editorOpenGate.cancel();
        }
        if (!changedFallback || !visible || !effectiveDirectory) return;
        if (activeDiffScope !== 'working' || !changedFallback.isCurrent()) {
            setChangedFallback(null);
            return;
        }
        if (!repositoriesKnown) return;
        if (rootDirectory && isProjectFileOutsideRepositories(changedFallback.file, {
            rootDirectory, rootIsGitRepo, nestedRepos, repositories: repositoryOptions ?? [],
        })) {
            setChangedFallback(null);
            void openChangedFileWithoutRepository(changedFallback.file, rootDirectory, files, changedFallback.isCurrent);
            return;
        }
        const repository = findFileRepository(changedFallback.file, [
            ...(rootIsGitRepo && rootDirectory ? [rootDirectory] : []),
            ...(repositoryOptions ?? []),
        ]);
        if (repository && repository !== effectiveDirectory && rootDirectory) {
            if (changedFallback.picked) {
                setChangedFallback(null);
                return;
            }
            setChangedFallback({ ...changedFallback, picked: true });
            selectNestedRepo(rootDirectory, repository);
            return;
        }
        if (changedFallback.statusReadFor !== effectiveDirectory) {
            if (fallbackStatusRequestRef.current === effectiveDirectory) return;
            fallbackStatusRequestRef.current = effectiveDirectory;
            void fetchStatus(effectiveDirectory, git, { silent: true }).finally(() => {
                setChangedFallback((current) => current && { ...current, statusReadFor: effectiveDirectory });
            });
            return;
        }
        setChangedFallback(null);
        const listed = findRepoFile(changedFallback.file, effectiveDirectory, changedFiles.map((file) => file.path));
        if (listed) {
            revealListedFile(listed);
            return;
        }
        const isCurrent = changedFallback.isCurrent;
        const openFile = () => {
            if (rootDirectory && isFilePathWithinDirectory(changedFallback.file, rootDirectory) && isCurrent()) {
                void openChangedFileWithoutRepository(changedFallback.file, rootDirectory, files, isCurrent);
            }
        };
        if (repository && isCurrent()) {
            void revealCommittedFile(repository, changedFallback.file, isCurrent).then((revealed) => {
                if (!revealed) openFile();
            });
            return;
        }
        openFile();
    }, [activeDiffScope, changedFallback, changedFiles, editorOpenGate, effectiveDirectory, fetchStatus, files, git, nestedRepos, repositoriesKnown, repositoryOptions, revealCommittedFile, revealListedFile, rootDirectory, rootIsGitRepo, panelSessionId, selectNestedRepo, visible]);
}
