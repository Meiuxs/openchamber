/**
 * The picker follows the board: a folder that is not a repository offers the
 * repositories under it, and whatever is picked carries the folder it was
 * listed in. Tracker sources keep the old single list.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { RepositoryReference } from '@/lib/api/types';
import type { RepositoryChoice, RepositoryScope } from '@/lib/source-control/repositoryScope';
import { acmeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';

import type { ReferencePickerItem, ReferencePickerSelection } from './referencePickerItems';

type Scope = RepositoryScope & { retry: () => void; discoveryFailed: boolean; discoveryPending: boolean };

const READY_SCOPE: Scope = {
    status: 'ready', directory: '/work/a', repositories: ['/work/a', '/work/b'],
    all: false, allAvailable: true, choosable: true, retry: () => {},
    discoveryFailed: false, discoveryPending: false,
};
const ALL_SCOPE: Scope = {
    ...READY_SCOPE, directory: '/root', repositories: ['/work/a', '/work/b'], all: true,
};
const EMPTY_SCOPE: Scope = {
    status: 'ready', directory: null, repositories: [], all: false, allAvailable: false, choosable: false,
    retry: () => {}, discoveryFailed: false, discoveryPending: false,
};

const descriptor = acmeDescriptor({ label: 'GitHub' });
const issue: RepositoryReference = {
    kind: 'issue', state: 'open', number: 7, title: 'Seven',
    url: 'https://github.com/acme/app/issues/7', body: '', bodyTruncated: false,
    createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
    sourceRepo: { owner: 'acme', repo: 'app', source: '/work/a' }, provider: 'github',
};
const listed: ReferencePickerItem = { source: 'repository', reference: issue };

let scopeNow: Scope = READY_SCOPE;
let remembered: RepositoryChoice = { path: null, all: undefined };
let scopeArgs: Array<{ root: string | null; choice: RepositoryChoice }> = [];
let browserOptions: { directory: string | null; directories: readonly string[] | null } | null = null;
let retried = 0;

mock.module('@/lib/source-control/repositoryScope', () => ({
    repositoryLabel: (repository: string) => repository,
    useRememberedRepositoryChoice: () => remembered,
    useRepositoryScope: (root: string | null, choice: RepositoryChoice) => {
        scopeArgs.push({ root, choice });
        // The dialog asks with a null root when it does not scope the source.
        return root ? scopeNow : EMPTY_SCOPE;
    },
}));

mock.module('@/components/references/usePreviewReturnScroll', () => ({
    usePreviewReturnScroll: () => ({ current: null }),
}));

mock.module('@/components/references/useReferenceBrowser', () => ({
    IDLE_PULL_STATUS: { status: 'idle' },
    useReferenceBrowser: (options: { directory: string | null; directories: readonly string[] | null }) => {
        browserOptions = options;
        return {
            source: 'repository', directory: '/work/a', across: false, acrossProvider: null, leftOut: [],
            tracker: null, trackerDescriptor: { name: 'Tracker' }, descriptor,
            previewItem: listed, previewKey: 'github:acme/app#7', highlightedItem: listed,
            mobilePreviewKey: null, trackerDetail: { status: 'idle' }, repositoryDetail: { status: 'idle' },
            pullStatusOf: () => ({ status: 'idle' }), now: 0,
            handleNavigationKey: () => false, closeMobilePreview: () => {}, openItem: () => {}, openTrackerIdentifier: () => {},
        };
    },
}));

mock.module('@/components/references/ReferenceBrowser', () => ({
    ReferenceBrowserTabs: () => null,
    ReferenceBrowserSearch: () => null,
    ReferenceBrowserList: ({ onActivate }: { onActivate: (item: ReferencePickerItem) => void }) => (
        <button type="button" data-testid="activate" onClick={() => onActivate(listed)}>activate</button>
    ),
}));

mock.module('@/components/references/ReferencePreview', () => ({
    ReferencePreview: () => null,
}));

mock.module('@/components/sourceControl/RepositoryPicker', () => ({
    RepositoryPicker: ({ repositories, selected, onSelect }: {
        repositories: readonly string[];
        selected: string | null;
        onSelect: (repository: string | null) => void;
    }) => (
        <button
            type="button"
            data-testid="repository-picker"
            data-selected={selected ?? 'all'}
            onClick={() => onSelect(repositories[1] ?? null)}
        >
            {repositories.join('|')}
        </button>
    ),
}));

mock.module('@/components/sourceControl/RepositoryAcrossNote', () => ({
    RepositoryAcrossNote: () => null,
}));

const dom = new Window({ url: 'http://localhost/picker.html' });
Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    CustomEvent: dom.CustomEvent,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    Element: dom.Element,
    Node: dom.Node,
    Event: dom.Event,
    KeyboardEvent: dom.KeyboardEvent,
    ResizeObserver: dom.ResizeObserver,
    MutationObserver: dom.MutationObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    localStorage: dom.localStorage,
    sessionStorage: dom.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
});
dom.HTMLElement.prototype.scrollIntoView = () => {};

const { ReferencePickerDialog } = await import('./ReferencePickerDialog');
const { I18nProvider } = await import('@/lib/i18n');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
    scopeNow = READY_SCOPE;
    remembered = { path: null, all: undefined };
    scopeArgs = [];
    browserOptions = null;
    retried = 0;
    scopeNow = { ...READY_SCOPE, retry: () => { retried += 1; } };
});

afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
});

async function renderPicker(props: Partial<React.ComponentProps<typeof ReferencePickerDialog>> = {}) {
    const confirmations: ReferencePickerSelection[][] = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
        root?.render(
            <I18nProvider>
                <ReferencePickerDialog
                    open
                    onOpenChange={() => {}}
                    source="repository"
                    purpose="attach"
                    selection="single"
                    directory="/root"
                    nestedRepositories
                    onConfirm={async (selections) => {
                        confirmations.push(selections);
                        return null;
                    }}
                    {...props}
                />
            </I18nProvider>,
        );
    });
    return confirmations;
}

const button = (testId: string) => document.body.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);

describe('nested repositories in the reference picker', () => {
    test('a folder read across its repositories passes them to the browser', async () => {
        scopeNow = { ...ALL_SCOPE, retry: () => { retried += 1; } };
        await renderPicker();

        expect(browserOptions?.directories).toEqual(['/work/a', '/work/b']);
        expect(browserOptions?.directory).toBe('/root');
        expect(button('repository-picker')?.dataset.selected).toBe('all');
    });

    test('starts on the repository the board remembers for the project', async () => {
        remembered = { path: '/work/b', all: false };
        await renderPicker();

        expect(scopeArgs[0]?.choice).toEqual({ path: '/work/b', all: false });
        expect(browserOptions?.directories).toBeNull();
    });

    test('a repository inside the folder is read alone, and switching it is a choice', async () => {
        await renderPicker();

        expect(browserOptions?.directories).toBeNull();
        expect(browserOptions?.directory).toBe('/work/a');
        expect(button('repository-picker')?.dataset.selected).toBe('/work/a');

        await act(async () => button('repository-picker')?.click());
        expect(scopeArgs.at(-1)?.choice).toEqual({ path: '/work/b', all: false });
    });

    test('a selection carries the folder it was listed in', async () => {
        const confirmations = await renderPicker();

        await act(async () => button('activate')?.click());

        expect(confirmations[0]?.[0]).toEqual({
            source: 'repository', reference: issue, includeDiff: false, directory: '/work/a',
        });
    });

    test('a tracker source keeps a single list and no repository picker', async () => {
        await renderPicker({ source: 'tracker:linear' });

        expect(browserOptions?.directories).toBeNull();
        expect(button('repository-picker')).toBeNull();
        expect(scopeArgs.at(-1)?.root).toBeNull();
    });

    test('discovery in progress says so instead of reading as "no repository"', async () => {
        scopeNow = { ...EMPTY_SCOPE, status: 'pending', discoveryPending: true, retry: () => { retried += 1; } };
        await renderPicker();

        expect(document.body.textContent).toContain('Looking for Git repositories...');
        expect(button('activate')).toBeNull();
        expect(document.body.textContent).not.toContain('Retry');
    });

    test('failed discovery offers a retry', async () => {
        scopeNow = { ...EMPTY_SCOPE, status: 'failed', discoveryFailed: true, retry: () => { retried += 1; } };
        await renderPicker();

        expect(document.body.textContent).toContain('Could not scan for Git repositories');
        expect(button('activate')).toBeNull();
        const retry = [...document.body.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Retry');
        expect(retry).toBeDefined();
        await act(async () => retry?.click());
        expect(retried).toBe(1);
    });
});
