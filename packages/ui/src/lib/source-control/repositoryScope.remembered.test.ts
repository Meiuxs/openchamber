import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://localhost/remembered.html' });
Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    localStorage: dom.localStorage,
    sessionStorage: dom.sessionStorage,
});

const { rememberedChoiceOf } = await import('./repositoryScope');

const remembered = {
    repositoryByProject: { 'project-1': '/work/a' },
    allRepositoriesByProject: { 'project-2': true },
};

test('the project\'s remembered repository is the picker\'s choice', () => {
    expect(rememberedChoiceOf(remembered, 'project-1')).toEqual({ path: '/work/a', all: undefined });
});

test('a project that remembered "all" keeps it', () => {
    expect(rememberedChoiceOf(remembered, 'project-2')).toEqual({ path: null, all: true });
});

test('a project the board never chose falls back to the default', () => {
    expect(rememberedChoiceOf(remembered, 'project-3')).toEqual({ path: null, all: undefined });
});

test('a directory outside every project falls back to the default', () => {
    expect(rememberedChoiceOf(remembered, null)).toEqual({ path: null, all: undefined });
});
