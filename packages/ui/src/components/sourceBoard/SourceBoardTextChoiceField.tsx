import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { shouldDismissDropdown } from '@/components/ui/dropdown-navigation';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { cn } from '@/lib/utils';
import { textChoices } from './trackerChoices';

// The rows that are not an existing value: any text is a legal one, so these
// read from a range no typed name carries.
const CREATE_ROW = '\u0000create';
const CLEAR_ROW = '\u0000clear';

/**
 * One free-text value, picked from the spellings the tracker already lists or
 * typed as a new one. A plain text field let `auth` and `Auth` become two
 * groupings that filter apart, and one person become two assignees; offering
 * the existing spellings makes the one already in use the easy choice, and a
 * new one still possible.
 *
 * Two triggers share the menu: `field` is the form's full-width control, `icon`
 * is the pencil a preview's meta row puts beside the value it shows.
 */
export const SourceBoardTextChoiceField: React.FC<{
    value: string;
    /** Every spelling in scope, as the list's facets hold them. */
    options: readonly string[];
    onChange: (value: string) => void;
    /** Shown by the `field` trigger while the value is empty. */
    placeholder: string;
    searchPlaceholder: string;
    emptyText: string;
    /** The new-value row, worded by the caller in the interface language. */
    createLabel: (value: string) => string;
    clearLabel: string;
    ariaLabel: string;
    trigger?: 'field' | 'icon';
    /** A write is in flight: the trigger shows it and does not open. */
    busy?: boolean;
}> = ({ value, options, onChange, placeholder, searchPlaceholder, emptyText, createLabel, clearLabel, ariaLabel, trigger = 'field', busy = false }) => {
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const typed = query.trim();
    const { matches, creates } = React.useMemo(() => textChoices(options, typed), [options, typed]);

    const changeOpen = (next: boolean) => {
        if (busy) return;
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
                {trigger === 'icon' ? (
                    <Button
                        variant="ghost"
                        size="xs"
                        aria-label={ariaLabel}
                        title={ariaLabel}
                        disabled={busy}
                        className="size-6 shrink-0 px-0 text-muted-foreground data-[state=open]:bg-interactive-hover"
                    >
                        <Icon name={busy ? 'loader-4' : 'pencil'} className={cn('size-3.5', busy && 'animate-spin')} />
                    </Button>
                ) : (
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
                )}
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
                            <CommandItem key={option} value={`choice:${option}`} onSelect={() => choose(option)}>
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
