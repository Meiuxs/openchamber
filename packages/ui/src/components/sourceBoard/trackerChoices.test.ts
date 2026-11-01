import { describe, expect, test } from 'bun:test';

import type { TrackerItemSummary } from '@/lib/api/types';
import { blockerCandidates, featureChoices } from './trackerChoices';

const issue = (identifier: string, title: string): TrackerItemSummary => ({
    provider: 'local',
    id: identifier,
    identifier,
    title,
    url: '',
    state: null,
});

describe('featureChoices', () => {
    test('offers every grouping in scope while nothing is typed, and no new one', () => {
        expect(featureChoices(['auth', 'billing'], '')).toEqual({ matches: ['auth', 'billing'], creates: false });
        expect(featureChoices(['auth', 'billing'], '   ')).toEqual({ matches: ['auth', 'billing'], creates: false });
    });

    test('narrows to the groupings that match what was typed, and still offers the typed word itself', () => {
        // `bill` matches `billing`, but is not `billing`: both stay on offer.
        expect(featureChoices(['auth', 'billing'], 'bill')).toEqual({ matches: ['billing'], creates: true });
    });

    test('offers no new grouping once a grouping is spelled out in full', () => {
        const { matches, creates } = featureChoices(['auth', 'billing'], 'billing');
        expect(matches).toContain('billing');
        expect(creates).toBe(false);
    });

    test('offers a new grouping only for a word no grouping is spelled as', () => {
        expect(featureChoices(['auth'], 'search').creates).toBe(true);
    });

    test('treats a different case and padding as the same grouping, not a new one', () => {
        expect(featureChoices(['auth'], 'AUTH').creates).toBe(false);
        expect(featureChoices(['auth'], '  AUTH  ').creates).toBe(false);
    });

    test('offers nothing but a new one when no grouping is in scope', () => {
        expect(featureChoices([], 'auth')).toEqual({ matches: [], creates: true });
    });
});

describe('blockerCandidates', () => {
    test('leaves out the issue asking, which cannot wait on itself', () => {
        const listed = [issue('LOCAL-1', 'First'), issue('LOCAL-2', 'Second')];
        expect(blockerCandidates(listed, 'LOCAL-2').map((item) => item.identifier)).toEqual(['LOCAL-1']);
    });

    test('keeps every other issue, in the order the list gave them', () => {
        const listed = [issue('LOCAL-3', 'Third'), issue('LOCAL-1', 'First'), issue('LOCAL-2', 'Second')];
        expect(blockerCandidates(listed, 'LOCAL-9').map((item) => item.identifier)).toEqual(['LOCAL-3', 'LOCAL-1', 'LOCAL-2']);
    });
});
