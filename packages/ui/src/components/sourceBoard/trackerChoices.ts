import type { TrackerItemSummary } from '@/lib/api/types';
import { rankByQuery } from '@/lib/search/fuzzySearch';

/**
 * What the grouping field offers for the text typed so far: the groupings that
 * match, and whether that text is a new one. A new one is offered only for a
 * word no grouping is spelled as — picking an existing spelling is what the
 * list is for, and a near miss (`Auth` beside `auth`) is how one grouping
 * became two.
 */
export const featureChoices = (options: readonly string[], typed: string) => {
    const query = typed.trim();
    return {
        matches: query ? rankByQuery(options, query, (option) => [option]) : options,
        creates: query.length > 0 && !options.some((option) => option.toLowerCase() === query.toLowerCase()),
    };
};

/**
 * The issues that can be offered as one issue's blockers: the project's own
 * open ones, never the issue asking. An issue that blocked itself would wait
 * forever, and the tracker reads the file as saying exactly that.
 */
export const blockerCandidates = (issues: readonly TrackerItemSummary[], self: string): TrackerItemSummary[] => (
    issues.filter((issue) => issue.identifier !== self)
);
