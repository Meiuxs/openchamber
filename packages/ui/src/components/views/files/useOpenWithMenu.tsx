import React from 'react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { isDesktopLocalOriginActive, openDesktopFileInApp, openDesktopPath } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { getBrowserOpenInApps } from '@/lib/openInApps';
import { useOpenInAppsStore, type OpenInAppOption } from '@/stores/useOpenInAppsStore';

type OpenWithMenuComponents = {
  Item: React.ElementType;
  Separator: React.ElementType;
  /** Tree menus space the icon away from the label; menu-bar items rely on their own gap. */
  iconClassName?: string;
};

const parentDirectoryOf = (value: string): string => {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized) return '';
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  const trimmed = normalized.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash < 0) return trimmed;
  if (lastSlash === 0) return '/';
  const parent = trimmed.slice(0, lastSlash);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
};

/**
 * "Open with" submenu shared by the file tree menus and the editor toolbar.
 * Browser clients run the open on the server machine through `/api/fs/open`;
 * the desktop app keeps its scanned-app launchers.
 */
export const useOpenWithMenu = (root: string) => {
  const { files } = useRuntimeAPIs();
  const { t } = useI18n();
  const desktopLocal = isDesktopLocalOriginActive();
  const canOpenPath = Boolean(files.openPath);
  const canOpenWith = desktopLocal || canOpenPath;
  const canUseCustomOpenApp = !desktopLocal && canOpenPath;
  const openInApps = useOpenInAppsStore((state) => state.availableApps);
  const openInCacheStale = useOpenInAppsStore((state) => state.isCacheStale);
  const initializeOpenInApps = useOpenInAppsStore((state) => state.initialize);
  const loadOpenInApps = useOpenInAppsStore((state) => state.loadInstalledApps);
  const browserOpenInApps = React.useMemo(() => getBrowserOpenInApps(), []);
  const openWithApps = desktopLocal ? openInApps : browserOpenInApps;

  React.useEffect(() => {
    initializeOpenInApps();
  }, [initializeOpenInApps]);

  // The OS opens it with whatever app owns the type: Word for a .docx, Typora for a .md.
  const handleOpenDefaultPath = React.useCallback((targetPath: string) => {
    if (desktopLocal) {
      void openDesktopPath(targetPath).then((opened) => {
        if (!opened) toast.error(t('sidebarFilesTree.toast.operationFailed'));
      });
      return;
    }
    if (!files.openPath) return;
    void files.openPath(targetPath).catch(() => {
      toast.error(t('sidebarFilesTree.toast.operationFailed'));
    });
  }, [desktopLocal, files, t]);

  const handleOpenPathInApp = React.useCallback(async (targetPath: string, app: OpenInAppOption) => {
    if (desktopLocal) {
      if (await openDesktopFileInApp(targetPath, app.id, app.appName)) return;
      if (await openDesktopPath(targetPath, app.appName)) return;
      const parentDirectory = parentDirectoryOf(targetPath) || root;
      if (parentDirectory && await openDesktopPath(parentDirectory, app.appName)) return;
      toast.error(t('filesView.toast.openInAppFailed', { app: app.appName }));
      return;
    }
    if (!files.openPath) return;
    try {
      await files.openPath(targetPath, app.command || app.appName);
    } catch {
      toast.error(t('filesView.toast.openInAppFailed', { app: app.label }));
    }
  }, [desktopLocal, files, root, t]);

  const [customAppDialogPath, setCustomAppDialogPath] = React.useState<string | null>(null);
  const [customAppName, setCustomAppName] = React.useState('');
  const [isCustomAppSubmitting, setIsCustomAppSubmitting] = React.useState(false);
  const customAppInputRef = React.useRef<HTMLInputElement | null>(null);

  const openCustomAppDialog = React.useCallback((targetPath: string) => {
    setCustomAppDialogPath(targetPath);
    setCustomAppName('');
    setIsCustomAppSubmitting(false);
  }, []);

  const handleCustomAppSubmit = React.useCallback(async () => {
    const appName = customAppName.trim();
    if (!appName || !customAppDialogPath || !files.openPath || isCustomAppSubmitting) return;
    setIsCustomAppSubmitting(true);
    try {
      await files.openPath(customAppDialogPath, appName);
      setCustomAppDialogPath(null);
    } catch {
      toast.error(t('filesView.toast.openInAppFailed', { app: appName }));
    } finally {
      setIsCustomAppSubmitting(false);
    }
  }, [customAppName, customAppDialogPath, files, isCustomAppSubmitting, t]);

  const renderOpenWithItems = React.useCallback((
    targetPath: string,
    { Item, Separator, iconClassName = 'me-2 size-4' }: OpenWithMenuComponents,
  ) => (
    <>
      <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleOpenDefaultPath(targetPath); }}>
        <Icon name="external-link" className={iconClassName} /> {t('sidebarFilesTree.menu.openInDefaultApp')}
      </Item>
      {openWithApps.length > 0 && <Separator />}
      {openWithApps.map((app) => (
        <Item key={app.id} onClick={(e: React.MouseEvent) => { e.stopPropagation(); void handleOpenPathInApp(targetPath, app); }}>
          <Icon name={app.icon} className={iconClassName} /> {app.label}
        </Item>
      ))}
      {canUseCustomOpenApp && (
        <>
          <Separator />
          <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); openCustomAppDialog(targetPath); }}>
            <Icon name="edit" className={iconClassName} /> {t('filesView.menu.customApp')}
          </Item>
        </>
      )}
      {desktopLocal && openInCacheStale && (
        <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); void loadOpenInApps(true); }}>
          <Icon name="refresh" className={iconClassName} /> {t('filesView.editor.refreshApps')}
        </Item>
      )}
    </>
  ), [canUseCustomOpenApp, desktopLocal, handleOpenDefaultPath, handleOpenPathInApp, loadOpenInApps, openCustomAppDialog, openInCacheStale, openWithApps, t]);

  const openWithDialog = (
    <Dialog open={customAppDialogPath !== null} onOpenChange={(open) => !open && setCustomAppDialogPath(null)}>
      <DialogContent initialFocus={customAppInputRef}>
        <DialogHeader>
          <DialogTitle>{t('filesView.dialog.customApp.title')}</DialogTitle>
          <DialogDescription>{t('filesView.dialog.customApp.description')}</DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <Input
            value={customAppName}
            onChange={(e) => setCustomAppName(e.target.value)}
            placeholder={t('filesView.dialog.customApp.placeholder')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void handleCustomAppSubmit();
              }
            }}
            ref={customAppInputRef}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCustomAppDialogPath(null)} disabled={isCustomAppSubmitting}>
            {t('filesView.dialog.cancel')}
          </Button>
          <Button
            onClick={() => void handleCustomAppSubmit()}
            disabled={isCustomAppSubmitting || !customAppName.trim()}
          >
            {isCustomAppSubmitting ? <Icon name="loader-4" className="size-4 animate-spin" /> : t('filesView.dialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { canOpenWith, renderOpenWithItems, openWithDialog };
};
