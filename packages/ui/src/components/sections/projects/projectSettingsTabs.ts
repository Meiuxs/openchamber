import { create } from 'zustand';

export type ProjectSettingsTab = 'general' | 'actions' | 'worktrees' | 'environment';

export const useProjectSettingsTabStore = create<{
  tab: ProjectSettingsTab;
  setTab: (tab: ProjectSettingsTab) => void;
}>((set) => ({
  tab: 'general',
  setTab: (tab) => set({ tab }),
}));

const SEARCH_TARGET_TABS = new Map<string, ProjectSettingsTab>([
  ['projects.default-agent', 'general'],
  ['projects.default-model', 'general'],
  ['projects.default-thinking', 'general'],
  ['projects.auto-dispatch', 'general'],
  ['projects.gitlab-auto-dispatch', 'general'],
  ['projects.gitlab-branch-prefix', 'general'],
  ['projects.gitlab-timeout', 'general'],
  ['projects.gitlab-review-model', 'general'],
  ['projects.gitlab-review-variant', 'general'],
  ['projects.gitlab-templates', 'general'],
  ['projects.gitlab-bot-account', 'general'],
  ['projects.notes-todos.repository', 'general'],
  ['projects.shared', 'general'],
  ['projects.shared.plansDir', 'general'],
  ['projects.actions', 'actions'],
  ['projects.worktree', 'worktrees'],
  ['projects.worktree.create', 'worktrees'],
  ['projects.worktree.setup.wait', 'worktrees'],
  ['projects.worktree.setup.replace', 'worktrees'],
  ['projects.worktree.teardown', 'worktrees'],
  ['projects.environment', 'environment'],
]);

export const projectSettingsTabForSearchTarget = (id: string): ProjectSettingsTab | null => SEARCH_TARGET_TABS.get(id) ?? null;

export const projectSettingsTabAnchors = (tab: ProjectSettingsTab): string[] =>
  [...SEARCH_TARGET_TABS].filter(([, owner]) => owner === tab).map(([id]) => id);
