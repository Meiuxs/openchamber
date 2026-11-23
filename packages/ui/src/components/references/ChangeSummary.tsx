import { Icon } from '@/components/icon/Icon';
import { DiffCount } from '@/components/ui/diff-count';
import type { RepositoryReferenceDetail } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

type Pull = NonNullable<RepositoryReferenceDetail['pull']>;

export function ChangeSummary({ pull, unavailable }: { pull: Pull; unavailable: boolean }) {
    const { t } = useI18n();
    if (unavailable) return <span className="text-[var(--status-error-text)]">{t('gitView.change.comparison.partial')}</span>;
    return (
        <span className="inline-flex items-center gap-2">
            <DiffCount added={pull.additions} removed={pull.deletions} />
            <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                <Icon name="file-list-2" className="size-3.5" />
                {pull.changedFiles}
            </span>
        </span>
    );
}
