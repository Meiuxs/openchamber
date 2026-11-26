import { describe, expect, test } from 'bun:test';

import type { RepositoryIssueReference } from '@/lib/api/types';

import { itemWithDirectory, repositorySelection } from './referencePickerItems';

const issue = (number: number, owner = 'acme', repo = 'app'): RepositoryIssueReference => ({
    kind: 'issue', provider: 'github', number, title: `#${number}`,
    url: `https://github.com/${owner}/${repo}/issues/${number}`, state: 'open',
    body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null,
    labels: [], commentCount: 0, sourceRepo: { owner, repo, source: 'origin' },
});
const item = { source: 'repository' as const, reference: issue(7) };

describe('reference selection directory', () => {
    test('stamps the folder the item was listed in', () => {
        expect(itemWithDirectory(item, '/work/a')).toMatchObject({ directory: '/work/a' });
    });

    test('keeps a directory already carried by the item', () => {
        const listed = { ...item, directory: '/work/a' };
        expect(itemWithDirectory(listed, '/work/b')).toBe(listed);
        expect(repositorySelection(listed, false, '/work/b')).toMatchObject({ directory: '/work/a' });
    });

    test('selection falls back to the given directory', () => {
        expect(repositorySelection(item, true, '/work/a')).toMatchObject({ directory: '/work/a', includeDiff: true });
    });

    test('no directory stays undefined', () => {
        const selection = repositorySelection(item, false, null);
        expect(selection.source === 'repository' ? selection.directory : 'tracker').toBeUndefined();
    });
});
