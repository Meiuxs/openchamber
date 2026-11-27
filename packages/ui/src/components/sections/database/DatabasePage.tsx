import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import {
  SETTINGS_CARD_GRID_CLASS,
  SettingsAddCard,
  SettingsCard,
  SettingsCardChip,
  SettingsCardIcon,
  SettingsCardPill,
  SettingsCardToolbar,
  type SettingsCardTone,
} from '@/components/sections/shared/SettingsCards';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useUIStore } from '@/stores/useUIStore';
import { useDbBindingStore } from '@/stores/useDbBindingStore';
import { selectMcpServersForDirectory, useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import type { McpServerStatus } from '@/lib/opencode/model';
import {
  DBHUB_NAME_PREFIX,
  DB_ENGINE_PORTS,
  DB_SSL_MODES,
  DEFAULT_DBHUB_VERSION,
  bindingNameOf,
  bindingSlugOf,
  buildDbhubMcpDraft,
  buildDbhubToml,
  isDbhubServer,
  isValidBindingAlias,
  parseDbConnectionUrl,
  readDbBindingSpec,
  suggestBindingAlias,
  summarizeDbhubError,
  type DbBindingSpec,
  type DbEngine,
  type DbSslMode,
} from '@/lib/db-bindings/dsn';

/** Radix selects reject an empty value, so "no sslmode" travels as this sentinel. */
const SSL_DEFAULT = 'default';

const emptySpec = (): DbBindingSpec => ({
  alias: '',
  engine: 'mysql',
  host: '',
  port: DB_ENGINE_PORTS.mysql,
  database: '',
  username: '',
  password: '',
  sslMode: '',
  readonly: true,
  dbhubVersion: DEFAULT_DBHUB_VERSION,
});

const ENGINE_LABELS: Record<DbEngine, string> = { mysql: 'MySQL', postgresql: 'PostgreSQL' };

const StatusPill: React.FC<{
  status: McpServerStatus['status']['status'] | undefined;
  enabled: boolean;
}> = ({ status, enabled }) => {
  const { t } = useI18n();
  if (!enabled) return <SettingsCardPill tone="neutral">{t('settings.mcp.grid.status.disabled')}</SettingsCardPill>;
  const pill: { tone: SettingsCardTone; label: string } | null = status === 'connected'
    ? { tone: 'success', label: t('settings.mcp.page.status.label.connected') }
    : status === 'failed'
      ? { tone: 'error', label: t('settings.mcp.page.status.label.failed') }
      : status === 'pending'
        ? { tone: 'neutral', label: t('settings.mcp.grid.status.pending') }
        : null;
  return pill ? <SettingsCardPill tone={pill.tone}>{pill.label}</SettingsCardPill> : null;
};

type TestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; detail: string }
  | { kind: 'error'; detail: string };

const runTestConnection = async (
  spec: DbBindingSpec,
  directory: string | null,
): Promise<Extract<TestState, { kind: 'ok' | 'error' }>> => {
  try {
    // Send the same TOML the binding will run with: a config dbhub no longer
    // accepts then fails here instead of only after the binding is saved.
    const response = await runtimeFetch('/api/db/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(directory ? { 'x-opencode-directory': directory } : {}),
      },
      body: JSON.stringify({ toml: buildDbhubToml(spec), dbhubVersion: spec.dbhubVersion }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; detail?: string; error?: string }
      | null;
    if (response.ok && payload?.ok) {
      return { kind: 'ok', detail: payload.detail ?? '' };
    }
    return { kind: 'error', detail: summarizeDbhubError(payload?.error ?? `HTTP ${response.status}`) };
  } catch (error) {
    return { kind: 'error', detail: summarizeDbhubError(error instanceof Error ? error.message : String(error)) };
  }
};

/** Persist the binding's dbhub.toml and return its absolute path. */
const writeBindingToml = async (
  spec: DbBindingSpec,
  directory: string | null,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
  const alias = bindingNameOf(spec.alias).slice(DBHUB_NAME_PREFIX.length);
  const response = await runtimeFetch('/api/db/binding', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(directory ? { 'x-opencode-directory': directory } : {}),
    },
    body: JSON.stringify({ alias, toml: buildDbhubToml(spec) }),
  });
  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; path?: string; error?: string }
    | null;
  if (response.ok && payload?.ok && payload.path) return { ok: true, path: payload.path };
  return { ok: false, error: payload?.error ?? `HTTP ${response.status}` };
};

/**
 * Accepts either the alias or the full entry name: the rename path passes the
 * entry name, and re-prefixing it silently removed nothing.
 */
const removeBindingToml = async (aliasOrName: string, directory: string | null): Promise<void> => {
  const slug = bindingSlugOf(aliasOrName);
  await runtimeFetch(`/api/db/binding?alias=${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    headers: directory ? { 'x-opencode-directory': directory } : {},
  }).catch(() => undefined);
};

interface BindingDialogProps {
  open: boolean;
  spec: DbBindingSpec;
  existingName: string | null;
  existingAliases: readonly string[];
  directory: string | null;
  npmRegistry: string;
  onClose: () => void;
}

const BindingDialog: React.FC<BindingDialogProps> = ({
  open,
  spec,
  existingName,
  existingAliases,
  directory,
  npmRegistry,
  onClose,
}) => {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState<DbBindingSpec>(spec);
  const [test, setTest] = React.useState<TestState>({ kind: 'idle' });
  const [parseNote, setParseNote] = React.useState<string | null>(null);
  const [dsnInvalid, setDsnInvalid] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [dsnText, setDsnText] = React.useState('');
  const aliasTouched = React.useRef(false);
  const { createMcp, updateMcp, deleteMcp, loadMcpConfigs } = useMcpConfigStore(useShallow((s) => ({
    createMcp: s.createMcp,
    updateMcp: s.updateMcp,
    deleteMcp: s.deleteMcp,
    loadMcpConfigs: s.loadMcpConfigs,
  })));

  React.useEffect(() => {
    if (open) {
      setDraft(spec);
      setTest({ kind: 'idle' });
      setDsnText('');
      setParseNote(null);
      setDsnInvalid(false);
      aliasTouched.current = false;
    }
  }, [open, spec]);

  // Any edit invalidates a previous test result — showing "connected" for a
  // host the user just changed is worse than showing nothing.
  const patch = (changes: Partial<DbBindingSpec>) => {
    setDraft((prev) => ({ ...prev, ...changes }));
    setTest({ kind: 'idle' });
  };

  const applyDsn = (raw: string) => {
    // Keep what was pasted: clearing the box made a successful parse look like
    // nothing happened, and it hides the string the fields were derived from.
    setDsnText(raw);
    const parsed = parseDbConnectionUrl(raw);
    if (!parsed) {
      setParseNote(null);
      setDsnInvalid(raw.trim() !== '');
      return;
    }
    setDsnInvalid(false);
    setDraft((prev) => ({
      ...prev,
      ...parsed,
      alias:
        prev.alias.trim() === '' && !aliasTouched.current
          ? suggestBindingAlias(parsed.database || parsed.host, existingAliases)
          : prev.alias,
    }));
    setParseNote(
      t('settings.db.dialog.dsnParsed', {
        engine: ENGINE_LABELS[parsed.engine],
        host: parsed.host,
        port: parsed.port || DB_ENGINE_PORTS[parsed.engine],
        database: parsed.database,
      }),
    );
    setTest({ kind: 'idle' });
  };

  /**
   * Each SSL option is one localized string "名称 — 说明"; the dropdown splits it
   * so the list still reads as short names, and the selected one shows the full
   * sentence underneath.
   */
  const sslOptionText = (value: string): string => {
    switch (value) {
      case 'disable': return t('settings.db.dialog.sslOption.disable');
      case 'prefer': return t('settings.db.dialog.sslOption.prefer');
      case 'require': return t('settings.db.dialog.sslOption.require');
      case 'verify-ca': return t('settings.db.dialog.sslOption.verify-ca');
      case 'verify-full': return t('settings.db.dialog.sslOption.verify-full');
      default: return t('settings.db.dialog.sslOption.default');
    }
  };
  const splitSslOption = (text: string): { name: string; description: string } => {
    const at = text.indexOf('—');
    return at < 0
      ? { name: text.trim(), description: '' }
      : { name: text.slice(0, at).trim(), description: text.slice(at + 1).trim() };
  };
  const sslValues = [SSL_DEFAULT, ...DB_SSL_MODES.filter((mode) => mode !== '')];
  const selectedSsl = draft.sslMode === '' ? SSL_DEFAULT : draft.sslMode;

  const aliasError = draft.alias.trim() !== '' && !isValidBindingAlias(draft.alias);

  const missingFields = (): string[] => {
    const missing: string[] = [];
    if (!isValidBindingAlias(draft.alias)) missing.push(t('settings.db.dialog.aliasLabel'));
    if (draft.host.trim() === '') missing.push(t('settings.db.dialog.hostLabel'));
    if (draft.database.trim() === '') missing.push(t('settings.db.dialog.databaseLabel'));
    return missing;
  };

  // Keep the buttons live and say what is missing, instead of greying them out
  // with no explanation.
  const ensureComplete = (): boolean => {
    const missing = missingFields();
    if (missing.length === 0) return true;
    toast.error(t('settings.db.dialog.missingFields', { fields: missing.join(' / ') }));
    return false;
  };

  const handleTest = async () => {
    if (!ensureComplete()) return;
    setTest({ kind: 'running' });
    setTest(await runTestConnection(draft, directory));
  };

  const handleSave = async () => {
    if (saving) return;
    if (!ensureComplete()) return;
    const targetName = bindingNameOf(draft.alias);
    const taken = existingAliases.some((alias) => bindingNameOf(alias) === targetName);
    if (taken && existingName !== targetName) {
      toast.error(t('settings.db.dialog.nameTaken'));
      return;
    }
    setSaving(true);
    try {
      const written = await writeBindingToml(draft, directory);
      if (!written.ok) throw new Error(written.error);
      const nextDraft = buildDbhubMcpDraft(draft, npmRegistry || null, written.path);
      if (existingName !== null && existingName === nextDraft.name) {
        const updated = await updateMcp(existingName, nextDraft, directory);
        if (!updated.ok) throw new Error(updated.message || 'update failed');
      } else {
        // Create before deleting: the old order could lose the binding entirely
        // when the new entry was rejected.
        const created = await createMcp(nextDraft, directory);
        if (!created.ok) throw new Error(created.message || 'create failed');
        if (existingName !== null) {
          const removed = await deleteMcp(existingName, directory);
          if (removed.ok) await removeBindingToml(existingName, directory);
        }
        if (created.requiresManualRestart) {
          toast.warning(created.message ?? t('settings.db.toast.savedManualRestart'));
        }
      }
      await loadMcpConfigs({ force: true, directory });
      toast.success(t('settings.db.toast.saved', { name: nextDraft.name }));
      onClose();
    } catch (error) {
      toast.error(t('settings.db.toast.saveFailed'), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{existingName === null ? t('settings.db.dialog.addTitle') : t('settings.db.dialog.editTitle', { name: existingName })}</DialogTitle>
          <DialogDescription>{t('settings.db.dialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Textarea
            value={dsnText}
            onChange={(e) => applyDsn(e.target.value)}
            placeholder={t('settings.db.dialog.dsnPastePlaceholder')}
            rows={2}
            className="font-mono typography-meta"
            spellCheck={false}
            aria-label={t('settings.db.dialog.dsnPasteLabel')}
          />
          {parseNote ? (
            <p className="typography-micro text-emerald-600 dark:text-emerald-400">{parseNote}</p>
          ) : dsnInvalid ? (
            <p className="typography-micro text-destructive">{t('settings.db.dialog.dsnUnrecognized')}</p>
          ) : null}

          <div className="flex gap-2" role="group" aria-label={t('settings.db.dialog.engineLabel')}>
            {(Object.keys(ENGINE_LABELS) as DbEngine[]).map((engine) => (
              <Button
                key={engine}
                type="button"
                size="sm"
                variant={draft.engine === engine ? 'default' : 'outline'}
                onClick={() => patch({ engine, port: DB_ENGINE_PORTS[engine] })}
              >
                {ENGINE_LABELS[engine]}
              </Button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2 space-y-1">
              <span className="typography-meta text-muted-foreground">{t('settings.db.dialog.aliasLabel')}</span>
              <Input
                value={draft.alias}
                onChange={(e) => {
                  aliasTouched.current = true;
                  patch({ alias: e.target.value });
                }}
                placeholder="orders-db"
                aria-invalid={aliasError}
              />
              {aliasError ? (
                <span className="typography-micro text-destructive">{t('settings.db.dialog.aliasInvalid')}</span>
              ) : draft.alias.trim() !== '' ? (
                <span className="typography-micro font-mono text-muted-foreground">
                  {bindingNameOf(draft.alias)}
                </span>
              ) : null}
            </label>
            <label className="space-y-1">
              <span className="typography-meta text-muted-foreground">{t('settings.db.dialog.hostLabel')}</span>
              <Input value={draft.host} onChange={(e) => patch({ host: e.target.value })} placeholder="db-internal.local" spellCheck={false} />
            </label>
            <label className="space-y-1">
              <span className="typography-meta text-muted-foreground">{t('settings.db.dialog.portLabel')}</span>
              <Input value={draft.port} onChange={(e) => patch({ port: e.target.value })} placeholder={DB_ENGINE_PORTS[draft.engine]} spellCheck={false} />
            </label>
            <label className="space-y-1">
              <span className="typography-meta text-muted-foreground">{t('settings.db.dialog.databaseLabel')}</span>
              <Input value={draft.database} onChange={(e) => patch({ database: e.target.value })} placeholder="orders" spellCheck={false} />
            </label>
            <label className="space-y-1">
              <span className="typography-meta text-muted-foreground">{t('settings.db.dialog.userLabel')}</span>
              <Input value={draft.username} onChange={(e) => patch({ username: e.target.value })} placeholder="svc_agent" spellCheck={false} autoComplete="off" />
            </label>
            <label className="space-y-1">
              <span className="typography-meta text-muted-foreground">{t('settings.db.dialog.passwordLabel')}</span>
              <Input
                type="password"
                value={draft.password}
                onChange={(e) => patch({ password: e.target.value })}
                autoComplete="new-password"
              />
            </label>
            <label className="space-y-1">
              <span className="typography-meta text-muted-foreground">{t('settings.db.dialog.sslLabel')}</span>
              <Select
                value={selectedSsl}
                onValueChange={(value) => patch({ sslMode: value === SSL_DEFAULT ? '' : (value as DbSslMode) })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{splitSslOption(sslOptionText(selectedSsl)).name}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {sslValues.map((value) => {
                    const option = splitSslOption(sslOptionText(value));
                    return (
                      <SelectItem key={value} value={value}>
                        <span className="flex flex-col">
                          <span>{option.name}</span>
                          <span className="typography-micro text-muted-foreground">{option.description}</span>
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <span className="block typography-micro text-muted-foreground">
                {splitSslOption(sslOptionText(selectedSsl)).description || t('settings.db.dialog.sslHint')}
              </span>
            </label>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t('settings.db.dialog.readonlyLabel')}</div>
              <div className="typography-micro text-muted-foreground">{t('settings.db.dialog.readonlyHint')}</div>
            </div>
            <Switch checked={draft.readonly} onCheckedChange={(checked) => patch({ readonly: checked })} />
          </div>

          <details className="group">
            <summary className="typography-micro text-muted-foreground cursor-pointer select-none hover:text-foreground">
              {t('settings.db.dialog.advancedSummary')}
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="typography-meta text-muted-foreground">{t('settings.db.dialog.versionLabel')}</span>
                <Input
                  value={draft.dbhubVersion}
                  onChange={(e) => patch({ dbhubVersion: e.target.value })}
                  placeholder={DEFAULT_DBHUB_VERSION}
                  spellCheck={false}
                />
                <span className="block typography-micro text-muted-foreground">
                  {t('settings.db.dialog.versionHint')}
                </span>
              </label>
            </div>
            {npmRegistry.trim() ? (
              <div className="mt-2 typography-micro text-muted-foreground">
                {t('settings.db.dialog.registryNote', { registry: npmRegistry.trim() })}
              </div>
            ) : null}
          </details>

          {test.kind === 'ok' ? (
            <div className="rounded-lg bg-green-500/10 px-3 py-2 text-sm text-green-600 dark:text-green-400">
              {t('settings.db.dialog.testOk', { detail: test.detail })}
            </div>
          ) : test.kind === 'error' ? (
            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {t('settings.db.dialog.testFailed', { detail: test.detail })}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => void handleTest()} disabled={test.kind === 'running'}>
            {test.kind === 'running' ? t('settings.db.dialog.testing') : t('settings.db.dialog.test')}
          </Button>
          <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? t('settings.db.dialog.saving') : t('settings.db.dialog.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const DatabasePage: React.FC = () => {
  const { t } = useI18n();
  const settingsDirectory = useSettingsDirectory();
  const npmRegistry = useUIStore((state) => state.npmRegistry);
  const { loadMcpConfigs, deleteMcp } = useMcpConfigStore(useShallow((s) => ({
    loadMcpConfigs: s.loadMcpConfigs,
    deleteMcp: s.deleteMcp,
  })));
  // Select the store's stable array; filtering inside a selector would return a
  // fresh array on every snapshot and spin React's useSyncExternalStore forever.
  const allServers = useMcpConfigStore((state) =>
    selectMcpServersForDirectory(state, settingsDirectory));
  const servers = React.useMemo(() => allServers.filter(isDbhubServer), [allServers]);
  const existingAliases = React.useMemo(
    () => servers.map((server) => (server.name.startsWith(DBHUB_NAME_PREFIX) ? server.name.slice(DBHUB_NAME_PREFIX.length) : server.name)),
    [servers],
  );
  const mcpStatus = useMcpStore((state) => state.getStatusForDirectory(settingsDirectory));
  const refreshStatus = useMcpStore((state) => state.refresh);
  const primaryEntry = useDbBindingStore((state) =>
    settingsDirectory ? (state.primaryByDirectory[settingsDirectory] ?? null) : null);
  const loadPrimary = useDbBindingStore((state) => state.loadPrimary);
  const setPrimary = useDbBindingStore((state) => state.setPrimary);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [dialogSpec, setDialogSpec] = React.useState<DbBindingSpec | null>(null);
  const [dialogExistingName, setDialogExistingName] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<string | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);

  React.useEffect(() => {
    void loadMcpConfigs({ directory: settingsDirectory });
  }, [loadMcpConfigs, settingsDirectory]);

  React.useEffect(() => {
    void loadPrimary(settingsDirectory);
  }, [loadPrimary, settingsDirectory]);

  // With a single binding there is nothing to choose from, so it is the primary
  // without anything being written to disk.
  const effectivePrimary = React.useMemo(() => {
    if (servers.length === 1) return servers[0]?.name ?? null;
    if (!primaryEntry) return null;
    return servers.some((server) => server.name === primaryEntry) ? primaryEntry : null;
  }, [servers, primaryEntry]);

  const handleSetPrimary = async (name: string | null) => {
    const result = await setPrimary(settingsDirectory, name);
    if (!result.ok) toast.error(t('settings.db.grid.primaryFailed'));
  };

  const handleRefresh = () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    const minSpin = new Promise((resolve) => setTimeout(resolve, 500));
    void Promise.all([refreshStatus({ directory: settingsDirectory, silent: true }), minSpin])
      .finally(() => setIsRefreshing(false));
  };

  const handleAdd = () => {
    setDialogExistingName(null);
    setDialogSpec(emptySpec());
  };

  const handleEdit = (name: string) => {
    const server = servers.find((entry) => entry.name === name);
    const spec = server ? readDbBindingSpec(server) : null;
    setDialogExistingName(name);
    setDialogSpec(spec ?? emptySpec());
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    const result = await deleteMcp(deleteTarget, settingsDirectory);
    if (result.ok) {
      // The entry is gone; drop the dbhub.toml it pointed at as well.
      const alias = deleteTarget.startsWith(DBHUB_NAME_PREFIX)
        ? deleteTarget.slice(DBHUB_NAME_PREFIX.length)
        : deleteTarget;
      await removeBindingToml(alias, settingsDirectory);
      toast.success(result.message || t('settings.db.toast.deleted', { name: deleteTarget }));
      setDeleteTarget(null);
    } else {
      toast.error(t('settings.db.toast.deleteFailed'));
    }
    setIsDeleting(false);
  };

  return (
    <SettingsPageLayout
      title={t('settings.page.databases.title')}
      namedBySidebar
    >
      <SettingsCardToolbar
        search={null}
        actions={(
          <>
            <Button
              variant="ghost"
              size="sm"
              className="w-7 shrink-0 px-0 text-muted-foreground"
              disabled={isRefreshing}
              onClick={handleRefresh}
              aria-label={t('settings.mcp.sidebar.actions.refreshStatusAria')}
              title={t('settings.mcp.sidebar.actions.refreshStatusTitle')}
            >
              <Icon name="refresh" className={cn('size-4', isRefreshing && 'animate-spin')} />
            </Button>
            <SettingsProjectSelector className="min-w-0 w-56" />
          </>
        )}
      />

      {servers.length === 0 ? (
        <p className="py-6 typography-meta text-muted-foreground">{t('settings.db.grid.empty')}</p>
      ) : null}

      <div className={SETTINGS_CARD_GRID_CLASS}>
        <SettingsAddCard
          label={t('settings.db.grid.addTitle')}
          hint={t('settings.db.grid.addHint')}
          onClick={handleAdd}
          settingsItem="db.create"
        />
        {servers.map((server) => {
          const spec = readDbBindingSpec(server);
          const enabled = server.disabled !== true;
          const isPrimary = effectivePrimary === server.name;
          return (
            <SettingsCard
              key={server.name}
              icon={<SettingsCardIcon name="database-2" />}
              title={spec?.alias || server.name}
              subtitle={spec ? `${spec.host}:${spec.port}/${spec.database}` : undefined}
              badges={(
                <>
                  <SettingsCardChip>{ENGINE_LABELS[spec?.engine ?? 'mysql']}</SettingsCardChip>
                  {isPrimary ? <SettingsCardPill tone="info">{t('settings.db.grid.primaryBadge')}</SettingsCardPill> : null}
                  <StatusPill status={mcpStatus[server.name]?.status.status} enabled={enabled} />
                </>
              )}
              muted={!enabled}
              footer={(
                <>
                  <span>{spec?.readonly ? t('settings.db.grid.readonly') : t('settings.db.grid.readwrite')}</span>
                  <SettingsCardChip>{t('settings.mcp.grid.scope.project')}</SettingsCardChip>
                </>
              )}
              onOpen={() => handleEdit(server.name)}
              actionsLabel={t('settings.mcp.grid.actionsAria', { name: server.name })}
              actions={[
                { label: t('settings.db.grid.action.edit'), icon: 'edit', onSelect: () => handleEdit(server.name) },
                ...(servers.length > 1
                  ? [isPrimary
                    ? { label: t('settings.db.grid.action.clearPrimary'), icon: 'star-fill' as const, onSelect: () => void handleSetPrimary(null) }
                    : { label: t('settings.db.grid.action.makePrimary'), icon: 'star' as const, onSelect: () => void handleSetPrimary(server.name) }]
                  : []),
                { label: t('settings.common.actions.delete'), icon: 'delete-bin', destructive: true, onSelect: () => setDeleteTarget(server.name) },
              ]}
            />
          );
        })}
      </div>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !isDeleting) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.db.deleteDialog.title', { name: deleteTarget ?? '' })}</DialogTitle>
            <DialogDescription>{t('settings.db.deleteDialog.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)} disabled={isDeleting}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void handleDelete()} disabled={isDeleting}>
              {t('settings.common.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {dialogSpec !== null ? (
        <BindingDialog
          open
          spec={dialogSpec}
          existingName={dialogExistingName}
          existingAliases={existingAliases}
          directory={settingsDirectory}
          npmRegistry={npmRegistry}
          onClose={() => setDialogSpec(null)}
        />
      ) : null}
    </SettingsPageLayout>
  );
};
