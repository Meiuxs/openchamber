import { describe, expect, it } from 'vitest';

import { gitlabDescriptor } from './descriptor.js';

const { urls, token } = gitlabDescriptor.presentation;

// Links are built from the first pattern, and GitLab 12.7 — the intranet
// deployment — answers 404 on the `/-/` scope separator: `/group/repo/issues/4`
// is its page, `/group/repo/-/issues/4` is nothing. A newer instance redirects
// the short form onto the `/-/` one, so the short form is the one that works
// everywhere; the `/-/` shapes stay behind it for parsing links GitLab emits.
describe('GitLab link templates', () => {
  it.each(['issue', 'changeRequest', 'commit'])('builds %s links without the /-/ separator', (key) => {
    expect(urls[key][0]).not.toContain('/-/');
    expect(urls[key].some((pattern) => pattern.includes('/-/'))).toBe(true);
  });

  it('recognises a thread address in both shapes', () => {
    const { pattern } = gitlabDescriptor.urls.thread;

    expect(pattern.exec('/group/repo/merge_requests/2')?.[1]).toBe('/group/repo/merge_requests/2');
    expect(pattern.exec('/group/repo/-/merge_requests/2')?.[1]).toBe('/group/repo/-/merge_requests/2');
    expect(pattern.exec('/group/repo/merge_requests/2/diffs')?.[1]).toBe('/group/repo/merge_requests/2');
  });

  it('points a new token at the page 12.7 serves', () => {
    expect(token.createPath).toBe('/profile/personal_access_tokens');
  });
});
