import React from 'react';
import { ToolbarTooltipButton } from '@/components/ui/action-toolbar';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';

export const ToolOutputCopyButton: React.FC<{ content: string }> = ({ content }) => {
    const { t } = useI18n();
    const [copied, setCopied] = React.useState(false);

    const handleCopy = React.useCallback(async () => {
        const result = await copyTextToClipboard(content);
        if (!result.ok) {
            toast.error(t('filesView.toast.copyFailed'));
            return;
        }
        setCopied(true);
    }, [content, t]);

    return (
        <ToolbarTooltipButton
            label={t('filesView.editor.copyFileContents')}
            icon="file-copy"
            done={copied}
            className="me-8 flex-shrink-0"
            onClick={() => { void handleCopy(); }}
        />
    );
};
