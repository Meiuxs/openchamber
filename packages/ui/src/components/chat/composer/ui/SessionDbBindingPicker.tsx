import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { listDbBindings, resolveEffectiveBinding } from '@/lib/db-bindings/dsn';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { selectMcpServersForDirectory, useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { useDbBindingStore } from '@/stores/useDbBindingStore';

interface SessionDbBindingPickerProps {
  directory?: string;
  sessionId: string | null;
  footerIconButtonClass: string;
  iconSizeClass: string;
}

/**
 * Which bound database this session is meant to use. It is a preference: the
 * picker only changes what the session prompt points the agent at, and every
 * binding's tools stay available (see the design note in docs/superpowers/specs).
 */
export const SessionDbBindingPicker: React.FC<SessionDbBindingPickerProps> = React.memo(({
  directory,
  sessionId,
  footerIconButtonClass,
  iconSizeClass,
}) => {
  const { t } = useI18n();
  // Select the stable array, then filter outside the selector (a selector that
  // builds a new array re-renders forever under useSyncExternalStore).
  const allServers = useMcpConfigStore((state) => selectMcpServersForDirectory(state, directory ?? null));
  const bindings = React.useMemo(() => listDbBindings(allServers), [allServers]);
  const primaryEntry = useDbBindingStore((state) =>
    directory ? (state.primaryByDirectory[directory] ?? null) : null);
  const selectedEntry = useDbBindingStore((state) =>
    sessionId ? (state.selectionBySession[sessionId] ?? null) : null);
  const setSelection = useDbBindingStore((state) => state.setSelection);

  if (!sessionId || bindings.length === 0) return null;
  const effective = resolveEffectiveBinding(bindings, primaryEntry, selectedEntry);
  if (!effective) return null;

  const label = effective.spec.alias.trim() || effective.entryName;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(footerIconButtonClass, 'gap-1.5 px-2')}
          title={t('settings.db.picker.label')}
          aria-label={t('settings.db.picker.aria')}
        >
          <Icon name="database-2" className={iconSizeClass} />
          <span className="hidden min-w-0 max-w-28 truncate typography-meta sm:inline">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{t('settings.db.picker.label')}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setSelection(sessionId, null)}>
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{t('settings.db.picker.defaultOption')}</span>
            <span className="typography-micro text-muted-foreground">
              {primaryEntry
                ? (bindings.find((binding) => binding.entryName === primaryEntry)?.spec.alias || primaryEntry)
                : (bindings[0]?.spec.alias || bindings[0]?.entryName)}
            </span>
          </span>
        </DropdownMenuItem>
        {bindings.map((binding) => {
          const isSelected = effective.entryName === binding.entryName && selectedEntry === binding.entryName;
          return (
            <DropdownMenuItem key={binding.entryName} onSelect={() => setSelection(sessionId, binding.entryName)}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">
                  {binding.spec.alias || binding.entryName}
                  {isSelected ? ' ✓' : ''}
                </span>
                <span className="truncate typography-micro text-muted-foreground">
                  {binding.spec.host}:{binding.spec.port}/{binding.spec.database}
                  {' · '}
                  {binding.spec.readonly ? t('settings.db.grid.readonly') : t('settings.db.grid.readwrite')}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

SessionDbBindingPicker.displayName = 'SessionDbBindingPicker';
