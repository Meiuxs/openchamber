import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { type OpenWithMenu } from '../useOpenWithMenu';
import { type useFileTabs } from './useFileTabs';

export function renderFileOpenInApps({ openWith, tabs }: {
  openWith: Pick<OpenWithMenu, 'renderOpenWithItems'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile'>;
}) {
  const { selectedFile } = tabs;
  const openInAppMenuItems = selectedFile?.path
    ? openWith.renderOpenWithItems(selectedFile.path, { Item: DropdownMenuItem, Separator: DropdownMenuSeparator, iconClassName: 'size-4' })
    : null;

  return { openInAppMenuItems };
}
