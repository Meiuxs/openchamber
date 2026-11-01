import { describe, expect, test } from 'bun:test';

import { referenceLinkHref } from './referenceLink';

const LOCAL = 'https://openchamber.local/tracker/local/LOCAL-2';

describe('referenceLinkHref', () => {
    test('points the page it was built on at the item', () => {
        expect(referenceLinkHref(LOCAL, 'http://localhost:5173/')).toBe(`http://localhost:5173/?reference=${encodeURIComponent(LOCAL)}`);
    });

    test('keeps the page it shares: origin, port and what the instance needs', () => {
        const href = referenceLinkHref(LOCAL, 'https://tunnel.example.dev/?session=ses_1&token=abc');
        const url = new URL(href ?? '');
        expect(url.origin).toBe('https://tunnel.example.dev');
        expect(url.searchParams.get('session')).toBe('ses_1');
        expect(url.searchParams.get('token')).toBe('abc');
        expect(url.searchParams.get('reference')).toBe(LOCAL);
    });

    test('replaces a reference the page already carries', () => {
        const stale = `http://127.0.0.1:8080/?reference=${encodeURIComponent('https://openchamber.local/tracker/local/LOCAL-1')}`;
        const href = referenceLinkHref(LOCAL, stale);
        expect(new URL(href ?? '').searchParams.getAll('reference')).toEqual([LOCAL]);
    });

    test('answers null where a pasted link could not reach the app', () => {
        // A packaged desktop UI's own scheme and a webview's file are not served.
        expect(referenceLinkHref(LOCAL, 'openchamber-ui://index')).toBeNull();
        expect(referenceLinkHref(LOCAL, 'file:///app/index.html')).toBeNull();
        expect(referenceLinkHref(LOCAL, '')).toBeNull();
    });

    test('refuses anything that is not a link to open', () => {
        expect(referenceLinkHref('   ', 'http://localhost:5173/')).toBeNull();
        expect(referenceLinkHref('javascript:alert(1)', 'http://localhost:5173/')).toBeNull();
        expect(referenceLinkHref('not a url', 'http://localhost:5173/')).toBeNull();
    });
});
