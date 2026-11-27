
import * as React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { discoversNestedRepos } from '@/lib/nestedRepositories';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useSpaceProjectDirectory } from '@/lib/spaces/spaces-store';
import { useGitStore, useIsGitRepo, useNestedRepos, type NestedRepoDiscovery } from '@/stores/useGitStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSourceBoardChoice } from '@/stores/useSourceBoardStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const NO_FOLDERS: string[] = [];
const NO_REPOSITORY_CHOICE: RepositoryChoice = { path: null, all: undefined };

export type RepositoryScope = {
    status: 'pending' | 'failed' | 'ready';
    directory: string | null;
    repositories: readonly string[];
    all: boolean;
    allAvailable: boolean;
    choosable: boolean;
};

export type RepositoryChoice = {
    path: string | null;
    all: boolean | undefined;
};

export function resolveRepositoryScope(
    root: string | null,
    rootIsGitRepo: boolean | null,
    nestedRepos: NestedRepoDiscovery | undefined,
    choice: RepositoryChoice,
    acrossAvailable: boolean,
): RepositoryScope {
    if (!root) return { status: 'ready', directory: null, repositories: [], all: false, allAvailable: false, choosable: false };
    const atRoot = (status: RepositoryScope['status']): RepositoryScope => ({ status, directory: root, repositories: [], all: false, allAvailable: false, choosable: false });
    if (rootIsGitRepo === true) {
        const repositories = Array.isArray(nestedRepos) ? [root, ...nestedRepos] : [root];
        const directory = choice.path && repositories.includes(choice.path) ? choice.path : root;
        return { status: 'ready', directory, repositories, all: false, allAvailable: false, choosable: repositories.length > 1 };
    }
    if (rootIsGitRepo === null || nestedRepos === undefined) return atRoot('pending');
    if (nestedRepos === null) return atRoot('failed');
    if (nestedRepos === 'unsupported') return atRoot('ready');
    const first = nestedRepos[0];
    if (first === undefined) return atRoot('ready');
    if (acrossAvailable && (choice.all ?? choice.path === null)) {
        return { status: 'ready', directory: root, repositories: nestedRepos, all: true, allAvailable: true, choosable: true };
    }
    const directory = choice.path && nestedRepos.includes(choice.path) ? choice.path : first;
    return { status: 'ready', directory, repositories: nestedRepos, all: false, allAvailable: acrossAvailable, choosable: true };
}

export const repositoryLabel = (repository: string, root: string): string => {
    if (repository === root) return root.split('/').filter(Boolean).pop() ?? root;
    const prefix = `${root}/`;
    return repository.startsWith(prefix) ? repository.slice(prefix.length) : repository;
};

/** Which folders a scope searches: `underRepository: false` scans only a folder that is not itself a repository. */
export type FolderSearch = {
    underRepository?: boolean;
};

export function useFolderRepositories(root: string | null, { underRepository = true }: FolderSearch = {}) {
    const { git } = useRuntimeAPIs();
    const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
    const rootIsGitRepo = useIsGitRepo(root);
    const searchesNested = root !== null && discoversNestedRepos(root, homeDirectory) && (underRepository || rootIsGitRepo === false);
    const nestedRepos = useNestedRepos(root);
    const ensureStatus = useGitStore((state) => state.ensureStatus);
    const ensureNestedRepos = useGitStore((state) => state.ensureNestedRepos);

    React.useEffect(() => {
        if (root && rootIsGitRepo === null) void ensureStatus(root, git);
    }, [ensureStatus, git, root, rootIsGitRepo]);
    React.useEffect(() => {
        // Discovery answers for both answers of "is the root a repository",
        // so it starts immediately instead of waiting for the status read;
        // the in-flight map keeps the two reads to one request either way.
        if (root && searchesNested) void ensureNestedRepos(root);
    }, [ensureNestedRepos, root, searchesNested]);

    const retry = React.useCallback(() => {
        if (root && searchesNested) void ensureNestedRepos(root, { force: true });
    }, [ensureNestedRepos, root, searchesNested]);
    return { rootIsGitRepo, nestedRepos: searchesNested ? nestedRepos : NO_FOLDERS, retry };
}

export function useRepositoryScope(
    root: string | null,
    choice: RepositoryChoice,
    search: FolderSearch = {},
): RepositoryScope & { retry: () => void; discoveryFailed: boolean; discoveryPending: boolean } {
    const { sourceControl } = useRuntimeAPIs();
    const acrossAvailable = Boolean(sourceControl.referencesAcross);
    const { rootIsGitRepo, nestedRepos, retry } = useFolderRepositories(root, search);
    const resolution = React.useMemo(
        () => resolveRepositoryScope(root, rootIsGitRepo, nestedRepos, { path: choice.path, all: choice.all }, acrossAvailable),
        [acrossAvailable, choice.all, choice.path, nestedRepos, root, rootIsGitRepo],
    );
    return { ...resolution, retry, discoveryFailed: nestedRepos === null, discoveryPending: nestedRepos === undefined };
}

/** The board's remembered repository for a project, shaped for the shared resolution. */
export const rememberedChoiceOf = (
    remembered: { repositoryByProject: Record<string, string>; allRepositoriesByProject: Record<string, boolean> },
    projectId: string | null,
): RepositoryChoice => (
    projectId
        ? { path: remembered.repositoryByProject[projectId] ?? null, all: remembered.allRepositoriesByProject[projectId] }
        : NO_REPOSITORY_CHOICE
);

/**
 * The repository the board would list for the project this directory belongs
 * to, so a picker opened elsewhere starts on the same one instead of reading
 * every repository under the folder again.
 */
export function useRememberedRepositoryChoice(directory: string | null): RepositoryChoice {
    const projects = useProjectsStore((state) => state.projects);
    const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
    const spaceProjectDirectory = useSpaceProjectDirectory(directory);
    const choice = useSourceBoardChoice();
    return React.useMemo(() => {
        if (!directory) return NO_REPOSITORY_CHOICE;
        const project = resolveProjectForSessionDirectory(projects, worktreesByProject, directory, spaceProjectDirectory);
        return rememberedChoiceOf(choice, project?.id ?? null);
    }, [choice, directory, projects, spaceProjectDirectory, worktreesByProject]);
}
