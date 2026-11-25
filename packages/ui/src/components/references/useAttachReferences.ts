import * as React from 'react';

import type { ComposerReference } from '@/components/chat/composer/composerReferences';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';

import type { SourceControlReadContext } from '@/lib/api/types';
import { useRepositoryBindings } from '@/lib/source-control/repository-binding';

import type { ReferencePickerConfirmFailure } from './ReferencePickerDialog';
import type { ReferencePickerSelection } from './referencePickerItems';
import { readTrackerItemDetail, useNestedRepositoryDirectories, useRepositoryReadContext } from './referenceSources';
import { resolveComposerReferences, resolveReferenceLink, type ReferenceLinkTarget, type ReferenceResolveDeps } from './resolveComposerReferences';
import { readTrackerDescriptor } from '@/lib/trackers/registry';

const readLocationKey = (context: SourceControlReadContext): string => `${context.provider}\n${context.instance}`;

function useReferenceResolveDeps(directory: string | null): ReferenceResolveDeps {
    const { sourceControl, trackers } = useRuntimeAPIs();
    const repositoryContext = useRepositoryReadContext(directory);
    const primary = repositoryContext && repositoryContext !== 'missing' ? repositoryContext : null;
    // Only a directory without a repository of its own falls back to the
    // repositories under it, so a bound project scans nothing.
    const nestedDirectories = useNestedRepositoryDirectories(directory, repositoryContext === 'missing');
    const nestedBindings = useRepositoryBindings(nestedDirectories, sourceControl);
    const contexts = React.useMemo(() => {
        const found: SourceControlReadContext[] = primary ? [primary] : [];
        const seen = new Set(found.map(readLocationKey));
        for (const binding of nestedBindings) {
            for (const context of binding.contexts) {
                const key = readLocationKey(context);
                if (seen.has(key)) continue;
                seen.add(key);
                found.push(context);
            }
        }
        return found;
    }, [nestedBindings, primary]);
    return React.useMemo(() => ({
        sourceControl,
        context: primary,
        contexts,
        readTrackerDetail: (provider, itemId, containerId) => (trackers
            ? readTrackerItemDetail(trackers, provider, itemId, containerId)
            : Promise.reject(new Error('Trackers are not available here'))),
        trackerName: (provider) => readTrackerDescriptor(provider).name,
    }), [contexts, primary, sourceControl, trackers]);
}

export function useAttachReferences(
    directory: string | null,
    onAttach: (references: ComposerReference[]) => void,
): (selections: ReferencePickerSelection[]) => Promise<ReferencePickerConfirmFailure | null> {
    const deps = useReferenceResolveDeps(directory);
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

export function useReadReferenceLink(directory: string | null): (target: ReferenceLinkTarget) => Promise<ComposerReference | null> {
    const deps = useReferenceResolveDeps(directory);
    return React.useCallback((target) => resolveReferenceLink(target, deps), [deps]);
}
