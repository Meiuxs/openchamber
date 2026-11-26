import { describe, expect, test } from 'bun:test';

import type { RepositoryScope } from '@/lib/source-control/repositoryScope';

import { DEFAULT_REPOSITORY_CHOICE, listDirectoriesOf, listDirectoryOf, repositoryChoiceFromPicker, scopesRepositories } from './pickerRepositoryScope';

const scope = (patch: Partial<RepositoryScope>): RepositoryScope => ({
    status: 'ready', directory: '/work/a', repositories: ['/work/a', '/work/b'],
    all: false, allAvailable: true, choosable: true, ...patch,
});

describe('picker repository scope', () => {
    test('only repository sources take a repository scope', () => {
        expect(scopesRepositories('repository', true)).toBe(true);
        expect(scopesRepositories('tracker:linear', true)).toBe(false);
        expect(scopesRepositories('repository', false)).toBe(false);
    });

    test('a single repository lists that directory and no directories', () => {
        expect(listDirectoryOf(scope({}), '/root')).toBe('/work/a');
        expect(listDirectoriesOf(scope({}))).toBeNull();
    });

    test('all repositories lists the root and passes every folder', () => {
        expect(listDirectoryOf(scope({ all: true, directory: '/root' }), '/root')).toBe('/root');
        expect(listDirectoriesOf(scope({ all: true }))).toEqual(['/work/a', '/work/b']);
    });

    test('no scope keeps the caller directory and no across list', () => {
        expect(listDirectoryOf(null, '/root')).toBe('/root');
        expect(listDirectoriesOf(null)).toBeNull();
    });

    test('a chosen repository becomes a single choice; all becomes the all choice', () => {
        expect(repositoryChoiceFromPicker('/work/b')).toEqual({ path: '/work/b', all: false });
        expect(repositoryChoiceFromPicker(null)).toEqual({ path: null, all: true });
        expect(DEFAULT_REPOSITORY_CHOICE).toEqual({ path: null, all: undefined });
    });
});
