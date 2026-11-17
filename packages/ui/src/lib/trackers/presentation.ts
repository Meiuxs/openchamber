import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';

type TrackerPresentation = {
  icon: IconName;
  copy: TrackerCopyKeys;
  branchName: (item: { identifier: string }) => string;
  settingsSearch?: TrackerSettingsSearch;
};

type TrackerSettingsSearch = {
  title: I18nKey;
  description: I18nKey;
  keywords: string[];
  addAccount: { title: I18nKey; keywords: string[] };
  mapping: { title: I18nKey; description: I18nKey; keywords: string[] };
};

type TrackerCopyKeys = {
  accountSwitched: I18nKey;
  accountSwitchFailed: I18nKey;
  containerLabel: I18nKey;
  containerAll: I18nKey;
  accountLabel: I18nKey;
  /**
   * Preview meta row naming the item's container: "Team" for Linear, "Project"
   * for a tracker whose container is the folder the items live in. Kept apart
   * from the grouping row so the two never read as the same thing.
   */
  containerMeta: I18nKey;
};

const LINEAR_COPY: TrackerCopyKeys = {
  accountSwitched: 'settings.integrations.linear.toast.workspaceSwitched',
  accountSwitchFailed: 'settings.integrations.linear.toast.workspaceSwitchFailed',
  containerLabel: 'sourceBoard.team.label',
  containerAll: 'sourceBoard.team.all',
  accountLabel: 'sourceBoard.workspace.label',
  containerMeta: 'references.picker.preview.team',
};

const GENERIC_COPY: TrackerCopyKeys = {
  accountSwitched: 'settings.integrations.tracker.toast.accountSwitched',
  accountSwitchFailed: 'settings.integrations.tracker.toast.accountSwitchFailed',
  containerLabel: 'sourceBoard.tracker.container.label',
  containerAll: 'sourceBoard.tracker.container.all',
  accountLabel: 'sourceBoard.tracker.account.label',
  containerMeta: 'references.picker.preview.container',
};

const issueBranchName = (item: { identifier: string }): string => `issue-${item.identifier}`;

const LINEAR_SETTINGS_SEARCH: TrackerSettingsSearch = {
  title: 'settings.integrations.linear.title',
  description: 'settings.integrations.linear.description',
  keywords: ['linear', 'issues', 'oauth', 'connect', 'workspace'],
  addAccount: { title: 'settings.integrations.linear.actions.addWorkspace', keywords: ['linear', 'workspace', 'add', 'connect', 'oauth'] },
  mapping: {
    title: 'settings.integrations.tracker.mapping.defaultProject',
    description: 'settings.integrations.linear.mapping.defaultProject.info',
    keywords: ['linear', 'project', 'team', 'map', 'workspace', 'directory'],
  },
};

// Local issues live on this machine, so nothing to add an account for or map;
// the sub-entries stay the generic ones the type requires and the capabilities
// keep them out of search.
const LOCAL_SETTINGS_SEARCH: TrackerSettingsSearch = {
  title: 'settings.integrations.local.title',
  description: 'settings.integrations.local.description',
  keywords: ['local', 'issues', 'markdown', 'files', 'offline'],
  addAccount: { title: 'settings.integrations.tracker.actions.addAccount', keywords: ['local', 'account', 'add'] },
  mapping: {
    title: 'settings.integrations.tracker.mapping.defaultProject',
    description: 'settings.integrations.tracker.mapping.defaultProject.info',
    keywords: ['local', 'project', 'map', 'directory'],
  },
};

// Local issues are markdown files in the project's folder on this machine, so the folder marks the tracker.
const LOCAL_PRESENTATION: TrackerPresentation = {
  icon: 'folder',
  copy: GENERIC_COPY,
  branchName: issueBranchName,
  settingsSearch: LOCAL_SETTINGS_SEARCH,
};

const PRESENTATIONS = new Map<string, TrackerPresentation>([
  ['linear', { icon: 'linear', copy: LINEAR_COPY, branchName: issueBranchName, settingsSearch: LINEAR_SETTINGS_SEARCH }],
  ['local', LOCAL_PRESENTATION],
]);

const GENERIC_PRESENTATION: TrackerPresentation = { icon: 'record-circle', copy: GENERIC_COPY, branchName: issueBranchName };

export const trackerPresentation = (id: string | null | undefined): TrackerPresentation => (
  (id ? PRESENTATIONS.get(id) : undefined) ?? GENERIC_PRESENTATION
);
