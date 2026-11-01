import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { shouldDismissDropdown } from '@/components/ui/dropdown-navigation';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { cn } from '@/lib/utils';
import { featureChoices } from './trackerChoices';

// The rows that are not an existing grouping: a grouping is any text, so these
// read from a range no typed name carries.
const CREATE_ROW = '\u0000create';
const CLEAR_ROW = '\u0000clear';

/**
 * One grouping slug, picked from the slugs the tracker already lists or typed
 * as a new one. A plain text field let `auth` and `Auth` become two groupings
 * that filter apart; offering the existing spellings makes the one that is
 * already used the easy choice, and the new one still possible.
 */
export const SourceBoardFeatureField: React.FC<{
    value: string;
    /** Every grouping slug in scope, as the list's facets hold them. */
    options: readonly string[];
    onChange: (value: string) => void;
    placeholder: string;
    searchPlaceholder: string;
    emptyText: string;
    /** The new-value row, worded by the caller in the interface language. */
    createLabel: (value: string) => string;
    clearLabel: string;
    ariaLabel: string;
}> = ({ value, options, onChange, placeholder, searchPlaceholder, emptyText, createLabel, clearLabel, ariaLabel }) => {
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const typed = query.trim();
    const { matches, creates } = React.useMemo(() => featureChoices(options, typed), [options, typed]);

    const changeOpen = (next: boolean) => {
        setOpen(next);
        if (!next) setQuery('');
    };
    const choose = (next: string) => {
        onChange(next);
        changeOpen(false);
    };

    return (
        <DropdownMenu open={open} onOpenChange={changeOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={ariaLabel}
                    className={cn(dropdownTriggerVariants({ size: 'default' }), 'w-full max-w-full')}
                >
                    <span className={cn('truncate', value ? 'text-foreground' : 'text-muted-foreground')}>
                        {value || placeholder}
                    </span>
                    <Icon name="arrow-down-s" className="size-4 shrink-0 text-muted-foreground" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="start"
                sideOffset={6}
                portalToBody
                className="flex max-h-[min(var(--available-height),20rem)] w-[var(--anchor-width)] min-w-[14rem] flex-col overflow-hidden p-0"
            >
                <Command
                    shouldFilter={false}
                    // Let cmdk see the keys it navigates with; the menu only takes
                    // the ones that dismiss it.
                    onKeyDown={(event) => { if (!shouldDismissDropdown(event)) event.stopPropagation(); }}
                >
                    <CommandInput autoFocus placeholder={searchPlaceholder} value={query} onValueChange={setQuery} />
                    <CommandList disableHorizontal>
                        {matches.map((option) => (
                            <CommandItem key={option} value={`grouping:${option}`} onSelect={() => choose(option)}>
                                <span className="flex size-4 shrink-0 items-center justify-center">
                                    {option === value ? <Icon name="check" className="size-4" /> : null}
                                </span>
                                <span className="truncate">{option}</span>
                            </CommandItem>
                        ))}
                        {creates ? (
                            <>
                                {matches.length > 0 ? <CommandSeparator /> : null}
                                <CommandItem value={CREATE_ROW} onSelect={() => choose(typed)}>
                                    <Icon name="add" className="size-4" />
                                    <span className="truncate">{createLabel(typed)}</span>
                                </CommandItem>
                            </>
                        ) : null}
                        {matches.length === 0 && !creates ? <CommandEmpty>{emptyText}</CommandEmpty> : null}
                        {value ? (
                            <>
                                <CommandSeparator />
                                <CommandItem value={CLEAR_ROW} onSelect={() => choose('')}>
                                    <Icon name="close" className="size-4" />
                                    <span className="truncate">{clearLabel}</span>
                                </CommandItem>
                            </>
                        ) : null}
                    </CommandList>
                </Command>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
