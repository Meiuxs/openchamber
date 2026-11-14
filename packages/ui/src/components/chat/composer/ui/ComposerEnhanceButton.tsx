/**
 * The composer's prompt enhancement control.
 *
 * It rewrites the draft in place and never sends it. The button lives beside
 * the send disc on desktop and inside the VS Code footer; mobile does not
 * render it.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type ComposerEnhanceButtonProps = {
    state: 'disabled' | 'ready' | 'loading';
    disabledReason?: string;
    footerIconButtonClass: string;
    iconSizeClass: string;
    onClick: () => void;
};

export const ComposerEnhanceButton = React.memo(function ComposerEnhanceButton(props: ComposerEnhanceButtonProps) {
    const { t } = useI18n();
    const label = t('chat.chatInput.actions.enhancePrompt');
    const loading = props.state === 'loading';
    const disabled = props.state === 'disabled' || loading;
    const tooltip = props.state === 'disabled' && props.disabledReason ? props.disabledReason : label;

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                {/* The span keeps the tooltip reachable while the button is disabled. */}
                <span className="inline-flex">
                    <button
                        type="button"
                        onClick={props.onClick}
                        disabled={disabled}
                        aria-label={label}
                        aria-busy={loading || undefined}
                        className={props.footerIconButtonClass}
                        onMouseDown={(event) => event.preventDefault()}
                    >
                        <Icon
                            name={loading ? 'loader-4' : 'magic'}
                            className={cn(props.iconSizeClass, 'text-current', loading && 'animate-spin')}
                        />
                    </button>
                </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>{tooltip}</TooltipContent>
        </Tooltip>
    );
});
