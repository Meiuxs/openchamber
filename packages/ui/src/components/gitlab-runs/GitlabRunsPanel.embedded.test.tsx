import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

const noAccounts = () => [];

// An embedded panel is one tab of the board, so a failed read has no other
// surface to fall back to: the tab itself must say what happened.
mock.module('./useRunAccounts', () => ({ useRunAccounts: () => noAccounts }));
mock.module('./useGitlabRuns', () => ({
  useGitlabRuns: () => ({
    runs: null,
    bot: null,
    error: true,
    loading: false,
    notBound: false,
    refresh: () => undefined,
  }),
}));

const { GitlabRunsPanel } = await import('./GitlabRunsPanel');

const render = () => renderToStaticMarkup(
  <I18nProvider>
    <GitlabRunsPanel embedded directory="/repo" projectId="p1" />
  </I18nProvider>,
);

test('a failed read inside the board names the failure and offers a retry', () => {
  const html = render();

  expect(html).toContain('Runs could not be loaded');
  expect(html).toContain('Retry');
});
