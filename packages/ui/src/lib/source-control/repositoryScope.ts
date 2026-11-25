
import * as React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { discoversNestedRepos } from '@/lib/nestedRepositories';
import { useGitStore, useIsGitRepo, useNestedRepos, type NestedRepoDiscovery } from '@/stores/useGitStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

const NO_FOLDERS: string[] = [];

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

export function useFolderRepositories(root: string | null) {
    const { git } = useRuntimeAPIs();
    const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
    const searchesNested = root !== null && discoversNestedRepos(root, homeDirectory);
    const rootIsGitRepo = useIsGitRepo(root);
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

export function useRepositoryScope(root: string | null, choice: RepositoryChoice): RepositoryScope & { retry: () => void; discoveryFailed: boolean; discoveryPending: boolean } {
    const { sourceControl } = useRuntimeAPIs();
    const acrossAvailable = Boolean(sourceControl.referencesAcross);
    const { rootIsGitRepo, nestedRepos, retry } = useFolderRepositories(root);
    const resolution = React.useMemo(
        () => resolveRepositoryScope(root, rootIsGitRepo, nestedRepos, { path: choice.path, all: choice.all }, acrossAvailable),
        [acrossAvailable, choice.all, choice.path, nestedRepos, root, rootIsGitRepo],
    );
    return { ...resolution, retry, discoveryFailed: nestedRepos === null, discoveryPending: nestedRepos === undefined };
}
