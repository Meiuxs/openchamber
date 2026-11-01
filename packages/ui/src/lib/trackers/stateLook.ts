import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import type { TrackerStateCategory } from './types';

/**
 * How a work item's state reads, by category. Trackers name their states per
 * team or project; the category is what maps onto the theme's PR colours.
 */

/**
 * The state ids a tracker can generate rather than write, and the board's words
 * for each. Only a tracker that says its names are slugs
 * (`capabilities.translatedStates`) is read through this: Linear's names are
 * what a team typed and stay as typed.
 */
export const TRACKER_STATE_LABEL_KEYS = new Map<string, I18nKey>([
  ['triage', 'references.picker.filter.tracker.state.triage'],
  ['backlog', 'references.picker.filter.tracker.state.backlog'],
  ['todo', 'references.picker.filter.tracker.state.todo'],
  ['in-progress', 'references.picker.filter.tracker.state.inProgress'],
  ['done', 'references.picker.filter.tracker.state.done'],
  ['canceled', 'references.picker.filter.tracker.state.canceled'],
]);

/** What a state is called on screen: the board's words for a generated id, else the tracker's own name. */
export const trackerStateLabel = (
  state: { id?: string | null; name: string; category?: TrackerStateCategory | null },
  t: (key: I18nKey) => string,
  translatedStates: boolean,
): string => {
  if (!translatedStates) return state.name;
  const key = TRACKER_STATE_LABEL_KEYS.get(state.id ?? '') ?? (state.category ? TRACKER_STATE_LABEL_KEYS.get(state.category) : undefined);
  return key ? t(key) : state.name;
};


/** A glyph for a state in a list or a status menu: started is open, done is merged, dropped is closed, the rest is not started. */
type TrackerStateGlyph = { icon: IconName; color: string };

export const trackerStateGlyph = (category: TrackerStateCategory | null | undefined): TrackerStateGlyph => {
  switch (category) {
    case 'in-progress':
      return { icon: 'record-circle', color: 'var(--pr-open)' };
    case 'done':
      return { icon: 'checkbox-circle', color: 'var(--pr-merged)' };
    case 'canceled':
      return { icon: 'close-circle', color: 'var(--pr-closed)' };
    default:
      return { icon: 'checkbox-blank-circle', color: 'var(--surface-muted-foreground)' };
  }
};

/**
 * The repository-issue state a work item reads as on issue badges (sidebar,
 * work status): not done yet is open, done is completed, dropped is not
 * planned.
 */
type TrackerIssueLook = 'open' | 'completed' | 'not_planned';

export const trackerIssueLook = (category: TrackerStateCategory): TrackerIssueLook => {
  switch (category) {
    case 'done':
      return 'completed';
    case 'canceled':
      return 'not_planned';
    default:
      return 'open';
  }
};

/** Whether an item in this state is finished: nothing more moves it, so it is not followed. */
export const isSettledTrackerState = (category: TrackerStateCategory | null | undefined): boolean => (
  category === 'done' || category === 'canceled'
);

const CATEGORY_RANK = {
  triage: 0,
  backlog: 1,
  todo: 2,
  'in-progress': 3,
  done: 4,
  canceled: 5,
} as const satisfies Record<TrackerStateCategory, number>;

/** Where a category sorts in a status menu: the workflow's order, unknown last. */
export const trackerStateCategoryRank = (category: TrackerStateCategory | null | undefined): number => (
  category ? CATEGORY_RANK[category] : Object.keys(CATEGORY_RANK).length
);
