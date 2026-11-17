import React from 'react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { loadMagicPrompts } from '@/lib/magicPrompts';
import { enhancePromptDraft, PromptEnhancementError } from '@/lib/promptEnhancement';
import { getChatDraftIdentityKey } from '@/lib/chatDraftPersistence';
import { useOpenCodeStartupStore } from '@/sync/opencode-startup-gate';
import { parseSlashCommand } from '../../composer/submit/slashCommands';
import { useComposerTextValue } from '../../composer/state/composerText';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerParallelRun } from './useComposerParallelRun';
import type { createComposerSubmitErrorMessage } from './createComposerSubmitErrorMessage';

const REFERENCE_TOKEN = /(?:^|\s)(?:@[^\s]+|\$[A-Za-z_][\w-]*|#[^\s]+)|https?:\/\/[^\s)]+|\[[^\]]+\]/g;

/** A draft made only of references has no request for the model to rewrite. */
const hasEnhanceableText = (text: string): boolean => /\p{L}/u.test(text.replace(REFERENCE_TOKEN, ' '));

type EnhancementContext =
    & Pick<ReturnType<typeof useComposerDraftText>, 'composerText' | 'setMessage' | 'currentChatDraftIdentityRef'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'chatDraftIdentity' | 'isBtwActive' | 'inputMode' | 'attachedFiles' | 'currentDirectory' | 'currentSessionDirectoryForSync'>
    & Pick<ReturnType<typeof useComposerSelection>, 'currentProviderId' | 'currentModelId'>
    & Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>
    & Pick<ReturnType<typeof useComposerPreferences>, 'isMobile'>
    & { parallelRun: ReturnType<typeof useComposerParallelRun>['parallelRun'] }
    & { getSubmitErrorMessage: ReturnType<typeof createComposerSubmitErrorMessage> };

export function useComposerPromptEnhancement({
    composerText, setMessage, currentChatDraftIdentityRef, chatDraftIdentity, isBtwActive,
    inputMode, attachedFiles, currentDirectory, currentSessionDirectoryForSync,
    currentProviderId, currentModelId, composerRef, isMobile, parallelRun, getSubmitErrorMessage,
}: EnhancementContext) {
    const t = useI18n().t;
    const waitingForOpenCode = useOpenCodeStartupStore((state) => state.waitingSends > 0);

    const [isEnhancingPrompt, setIsEnhancingPrompt] = React.useState(false);
    const enhanceAbortRef = React.useRef<AbortController | null>(null);

    const enhanceHasText = useComposerTextValue(composerText, hasEnhanceableText);
    const enhanceHasContent = useComposerTextValue(composerText, (text) => text.trim().length > 0);
    const enhanceIsSlashCommand = useComposerTextValue(
        composerText,
        (text) => text.startsWith('/') && Boolean(parseSlashCommand(text)),
    );

    const canEnhancePrompt = !isMobile
        && !isBtwActive
        && !parallelRun
        && inputMode === 'normal'
        && !waitingForOpenCode
        && !enhanceIsSlashCommand
        && enhanceHasText
        && Boolean(currentProviderId && currentModelId);

    // An empty draft has nothing to rewrite. A draft of only references stays
    // visible but disabled, so its tooltip can say what is missing.
    const showEnhancePrompt = !isMobile
        && !isBtwActive
        && !parallelRun
        && inputMode === 'normal'
        && enhanceHasContent
        && !enhanceIsSlashCommand;

    const enhancePromptDisabledReason = !enhanceHasText
        ? t('chat.chatInput.enhancePrompt.disabledNoText')
        : !currentProviderId || !currentModelId
            ? t('chat.chatInput.toast.noModelSelected')
            : waitingForOpenCode
                ? t('chat.chatInput.waitingForOpenCode')
                : undefined;

    const handleEnhancePrompt = React.useCallback(async () => {
        if (isEnhancingPrompt || !canEnhancePrompt) return;
        const snapshot = composerText.get();
        const identity = chatDraftIdentity;
        const directory = currentSessionDirectoryForSync ?? currentDirectory ?? null;
        const providerID = currentProviderId;
        const modelID = currentModelId;
        if (!providerID || !modelID) {
            toast.error(t('chat.chatInput.toast.noModelSelected'));
            return;
        }

        const controller = new AbortController();
        enhanceAbortRef.current = controller;
        setIsEnhancingPrompt(true);
        try {
            const prompts = await loadMagicPrompts(directory);
            const result = await enhancePromptDraft({
                draft: snapshot,
                prompts,
                directory,
                providerID,
                modelID,
                attachmentFilenames: attachedFiles.map((file) => file.filename),
                signal: controller.signal,
            });
            if (controller.signal.aborted) return;
            const currentIdentity = currentChatDraftIdentityRef.current;
            const identityChanged = !identity
                || !currentIdentity
                || getChatDraftIdentityKey(currentIdentity) !== getChatDraftIdentityKey(identity);
            if (identityChanged || composerText.get() !== snapshot) {
                toast.info(t('chat.chatInput.toast.enhanceDraftChanged'));
                return;
            }
            if (!result.changed) {
                toast.info(t('chat.chatInput.toast.enhanceNoChange'));
                return;
            }
            setMessage(result.text);
            toast.success(t('chat.chatInput.toast.enhanceSuccess'), {
                id: 'prompt-enhance',
                duration: 4000,
                action: {
                    label: t('chat.chatInput.actions.undo'),
                    onClick: () => {
                        if (composerText.get() !== result.text) {
                            toast.info(t('chat.chatInput.toast.enhanceDraftChanged'));
                            return;
                        }
                        setMessage(snapshot);
                        requestAnimationFrame(() => composerRef.current?.focus());
                    },
                },
            });
            requestAnimationFrame(() => composerRef.current?.focus());
        } catch (error) {
            if (controller.signal.aborted) return;
            if (error instanceof PromptEnhancementError && error.code === 'timeout') {
                toast.error(t('chat.chatInput.toast.enhanceTimeout'));
            } else if (error instanceof PromptEnhancementError && error.code === 'references-changed') {
                toast.error(t('chat.chatInput.toast.enhanceReferencesChanged'));
            } else {
                toast.error(getSubmitErrorMessage(error, t('chat.chatInput.toast.enhanceFailed')));
            }
        } finally {
            if (enhanceAbortRef.current === controller) {
                enhanceAbortRef.current = null;
                setIsEnhancingPrompt(false);
            }
        }
    }, [
        attachedFiles, canEnhancePrompt, chatDraftIdentity, composerText, currentChatDraftIdentityRef,
        currentDirectory, currentModelId, currentProviderId, currentSessionDirectoryForSync,
        composerRef, getSubmitErrorMessage, isEnhancingPrompt, setMessage, t,
    ]);

    const enhancePrompt = React.useMemo(() => ({
        state: !showEnhancePrompt
            ? 'hidden' as const
            : isEnhancingPrompt
                ? 'loading' as const
                : canEnhancePrompt
                    ? 'ready' as const
                    : 'disabled' as const,
        disabledReason: enhancePromptDisabledReason,
        onClick: handleEnhancePrompt,
    }), [canEnhancePrompt, enhancePromptDisabledReason, handleEnhancePrompt, isEnhancingPrompt, showEnhancePrompt]);

    React.useEffect(() => () => {
        enhanceAbortRef.current?.abort();
    }, []);

    return enhancePrompt;
}
