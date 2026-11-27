import * as React from 'react';

import type { ComposerReference } from '@/components/chat/composer/composerReferences';
import { repositoryUrlOfItemLink } from '@/components/sourceBoard/openTrackerItem';
import { useBoardRepository, useFolderOfRepository, type RepositoryChoice } from '@/components/sourceBoard/boardRepository';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';

import type { SourceControlReadContext } from '@/lib/api/types';
import { repositoryBindingOwner, useRepositoryBindings } from '@/lib/source-control/repository-binding';
import { useSourceControlProviders } from '@/lib/source-control/providers/registry';

import { linkReadContext } from './acrossRepositories';
import type { ReferencePickerConfirmFailure } from './ReferencePickerDialog';
import type { ReferencePickerSelection } from './referencePickerItems';
import { firstByOrder, readTrackerItemDetail, useNestedRepositoryDirectories, useRepositoryFolderReadContexts, useRepositoryReadContext } from './referenceSources';
import { resolveComposerReferences, resolveReferenceLink, type ReferenceLinkTarget, type ReferenceResolveDeps } from './resolveComposerReferences';
import { readTrackerDescriptor } from '@/lib/trackers/registry';

const NO_CHOICE: RepositoryChoice = { path: null, all: undefined };
const NO_FOLDERS: readonly string[] = [];

const readLocationKey = (context: SourceControlReadContext): string => `${context.provider}\n${context.instance}`;

export function useReferenceScope(directory: string | null) {
    const repository = useBoardRepository(directory, NO_CHOICE, { underRepository: false });
    const directories = repository.all ? repository.repositories : null;
    const single = repository.directory;
    const folders = React.useMemo(() => directories ?? (single ? [single] : NO_FOLDERS), [directories, single]);
    return { directory: single, directories, folders };
}

function useReferenceResolveDeps(folders: readonly string[]) {
    const { sourceControl, trackers } = useRuntimeAPIs();
    const descriptors = useSourceControlProviders();
    const primaryRoot = folders[0] ?? null;
    const repositoryContext = useRepositoryReadContext(primaryRoot);
    const primary = repositoryContext && repositoryContext !== 'missing' ? repositoryContext : null;
    // Only a directory without a repository of its own falls back to the
    // repositories under it, so a bound project scans nothing extra.
    const nestedDirectories = useNestedRepositoryDirectories(primaryRoot, repositoryContext === 'missing');
    const nestedBindings = useRepositoryBindings(nestedDirectories, sourceControl);
    const folderContexts = useRepositoryFolderReadContexts(folders);
    // The folders the scope lists, the session's own repository, and the
    // repositories found under it, each one context per read location: the
    // same account and instance reached through two folders reads one place.
    const known = React.useMemo(() => {
        const found: Array<{ directory: string; context: SourceControlReadContext }> = [];
        const seen = new Set<string>();
        const push = (directory: string | null | undefined, context: SourceControlReadContext | 'missing' | null) => {
            if (!context || typeof context !== 'object' || !directory) return;
            const key = `${directory}\n${readLocationKey(context)}`;
            if (seen.has(key)) return;
            seen.add(key);
            found.push({ directory, context });
        };
        for (const entry of folderContexts) push(entry.directory, entry.context);
        push(primaryRoot, primary);
        for (const binding of nestedBindings) {
            for (const context of binding.contexts) push(context.directory, context);
        }
        return found;
    }, [folderContexts, nestedBindings, primary, primaryRoot]);
    const contexts = React.useMemo(() => {
        const found: SourceControlReadContext[] = [];
        const seen = new Set<string>();
        for (const { context } of known) {
            const key = readLocationKey(context);
            if (seen.has(key)) continue;
            seen.add(key);
            found.push(context);
        }
        return found;
    }, [known]);
    // A checked item's own folder may sit outside what the session directory
    // scans (an established root's submodule, or one past the scan cap), so its
    // binding is read on demand, ordered exactly as the list orders contexts.
    const contextFor = React.useCallback(async (target: string) => {
        const held = known.find((entry) => entry.directory === target)?.context;
        if (held) return held;
        const state = await repositoryBindingOwner.read(repositoryBindingOwner.scope(target), sourceControl);
        return firstByOrder(state.contexts, descriptors);
    }, [descriptors, known, sourceControl]);
    const deps = React.useMemo((): ReferenceResolveDeps => ({
        sourceControl,
        context: primary ?? contexts[0] ?? null,
        contexts,
        contextFor,
        contextOf: (directory) => known.find((entry) => entry.directory === directory)?.context ?? null,
        readTrackerDetail: (provider, itemId, containerId) => (trackers
            ? readTrackerItemDetail(trackers, provider, itemId, containerId)
            : Promise.reject(new Error('Trackers are not available here'))),
        trackerName: (provider) => readTrackerDescriptor(provider).name,
    }), [contextFor, contexts, known, primary, sourceControl, trackers]);
    return { deps, contexts, folderContexts: known };
}

export function useAttachReferences(
    folders: readonly string[],
    onAttach: (references: ComposerReference[]) => void,
): (selections: ReferencePickerSelection[]) => Promise<ReferencePickerConfirmFailure | null> {
    const { deps } = useReferenceResolveDeps(folders);
    const { t } = useI18n();
    return React.useCallback(async (selections) => {
        const resolved = await resolveComposerReferences(selections, deps);
        if (resolved.references.length > 0) onAttach(resolved.references);
        if (resolved.failures.length === 0) return null;
        return {
            failedKeys: resolved.failures.map((failure) => failure.key),
            message: t('references.picker.error.attachFailed', {
                items: resolved.failures.map((failure) => failure.label).join(', '),
                error: resolved.failures[0]?.error ?? '',
            }),
        };
    }, [deps, onAttach, t]);
}

export function useReadReferenceLink(folders: readonly string[]): (target: ReferenceLinkTarget, link: string) => Promise<ComposerReference | null> {
    const { deps, folderContexts } = useReferenceResolveDeps(folders);
    const folderOf = useFolderOfRepository(folders);
    const urls = useRepositoryUrlMatcher();
    return React.useCallback((target, link) => {
        if (target.source === 'tracker') return resolveReferenceLink(target, deps);
        const repositoryUrl = repositoryUrlOfItemLink(link, urls);
        const repositoryFolder = repositoryUrl ? folderOf(repositoryUrl) : null;
        const context = linkReadContext(folderContexts, repositoryFolder === 'none' ? null : repositoryFolder, target);
        return resolveReferenceLink(target, { ...deps, context });
    }, [deps, folderContexts, folderOf, urls]);
}
