
import * as React from 'react';
import { Popover } from '@base-ui/react/popover';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MobileSheetRow, MobileSheetSearch } from '@/components/ui/MobileSheetList';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { repositoryLabel } from '@/lib/source-control/repositoryScope';
import { cn } from '@/lib/utils';

type PickerSize = 'toolbar' | 'inline';

const TRIGGER_CLASS = {
    toolbar: 'h-7 max-w-[16rem] px-2 typography-ui-label font-medium',
    inline: 'h-7 max-w-[14rem] px-1.5 typography-meta',
} as const satisfies Record<PickerSize, string>;

type RepositoryEntry = { value: string; repository: string | null; label: string };

export const RepositoryPicker: React.FC<{
    repositories: readonly string[];
    selected: string | null;
    root: string;
    allAvailable: boolean;
    onSelect: (repository: string | null) => void;
    sheet?: boolean;
    size?: PickerSize;
}> = ({ repositories, selected, root, allAvailable, onSelect, sheet = false, size = 'toolbar' }) => {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [activeValue, setActiveValue] = React.useState<string | null>(null);
    const searchRef = React.useRef<HTMLInputElement>(null);
    const ariaLabel = t('sourceBoard.repository.label');
    const searchLabel = t('sourceBoard.repository.search');
    const allLabel = t('sourceBoard.repository.all');
    const entries = React.useMemo<RepositoryEntry[]>(() => {
        const found = query
            ? rankByQuery([...repositories], query, (repository) => [repositoryLabel(repository, root)])
            : [...repositories];
        const repositoryEntries = found.map((repository) => ({ value: `repository:${repository}`, repository, label: repositoryLabel(repository, root) }));
        return allAvailable && !query ? [{ value: 'all', repository: null, label: allLabel }, ...repositoryEntries] : repositoryEntries;
    }, [allAvailable, allLabel, query, repositories, root]);
    const selectedValue = selected === null ? 'all' : `repository:${selected}`;
    const effectiveActive = activeValue && entries.some((entry) => entry.value === activeValue) ? activeValue : entries[0]?.value ?? null;
    const choose = (entry: RepositoryEntry) => {
        onSelect(entry.repository);
        setOpen(false);
        setQuery('');
    };
    const triggerClass = cn('min-w-0 w-fit justify-start gap-1 normal-case data-[popup-open]:bg-interactive-hover', TRIGGER_CLASS[size]);
    const triggerContent = (
        <span className="flex min-w-0 items-center gap-1.5">
            <Icon name="folder-3" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{selected === null ? allLabel : repositoryLabel(selected, root)}</span>
            <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-50" />
        </span>
    );

    if (sheet) {
        return (
            <>
                <Button variant="ghost" size="sm" aria-label={ariaLabel} aria-haspopup="dialog" onClick={() => setOpen(true)} className={triggerClass}>
                    {triggerContent}
                </Button>
                <MobileOverlayPanel
                    open={open}
                    title={ariaLabel}
                    onClose={() => { setOpen(false); setQuery(''); }}
                    subheader={<MobileSheetSearch value={query} onChange={setQuery} placeholder={searchLabel} />}
                >
                    {entries.length === 0 ? (
                        <div role="status" className="px-3 py-6 text-center typography-meta text-muted-foreground">{t('sourceBoard.repository.noneFound')}</div>
                    ) : entries.map((entry) => (
                        <MobileSheetRow key={entry.value} selected={entry.value === selectedValue} onClick={() => choose(entry)}>
                            {entry.label}
                        </MobileSheetRow>
                    ))}
                </MobileOverlayPanel>
            </>
        );
    }

    return (
        <Popover.Root
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                setQuery('');
                setActiveValue(next ? selectedValue : null);
            }}
            onOpenChangeComplete={(next) => { if (next) searchRef.current?.focus(); }}
        >
            <Popover.Trigger render={<Button variant="ghost" size="sm" aria-label={ariaLabel} aria-haspopup="dialog" className={triggerClass} />}>
                {triggerContent}
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
                    <Popover.Popup role="dialog" aria-label={ariaLabel} className={cn(dropdownMenuPopupClass, 'flex w-72 max-w-[calc(100vw-2rem)] flex-col p-0')} initialFocus={false}>
                        <Command className="min-h-0 flex-1" shouldFilter={false} value={effectiveActive ?? undefined} onValueChange={setActiveValue}>
                            <CommandInput
                                ref={searchRef}
                                aria-label={searchLabel}
                                placeholder={searchLabel}
                                value={query}
                                onValueChange={setQuery}
                                onKeyDown={(event) => {
                                    if (isIMECompositionEvent(event)) {
                                        event.stopPropagation();
                                        return;
                                    }
                                    handleDropdownNavigationKey(event, (navigationKey) => {
                                        event.currentTarget.dispatchEvent(new KeyboardEvent('keydown', { key: navigationKey, bubbles: true, cancelable: true }));
                                    });
                                }}
                            />
                            <CommandList label={ariaLabel}>
                                {entries.length === 0 ? (
                                    <div role="status" className="px-3 py-6 text-center typography-ui-label text-muted-foreground">{t('sourceBoard.repository.noneFound')}</div>
                                ) : entries.map((entry) => (
                                    <CommandItem key={entry.value} value={entry.value} onSelect={() => choose(entry)} aria-current={entry.value === selectedValue ? true : undefined} className="max-w-full">
                                        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                                        {entry.value === selectedValue ? <Icon name="check" className="size-4 shrink-0 text-muted-foreground" /> : null}
                                    </CommandItem>
                                ))}
                            </CommandList>
                        </Command>
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover.Root>
    );
};
