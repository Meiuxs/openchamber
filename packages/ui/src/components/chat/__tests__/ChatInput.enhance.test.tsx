import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';
import { createProjectIdFromPath } from '@/lib/projectId';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  Window,
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  Node: browser.Node,
  Text: browser.Text,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement,
  HTMLFormElement: browser.HTMLFormElement,
  Range: browser.Range,
  Selection: browser.Selection,
  DocumentFragment: browser.DocumentFragment,
  Event: browser.Event,
  KeyboardEvent: browser.KeyboardEvent,
  MouseEvent: browser.MouseEvent,
  FocusEvent: browser.FocusEvent,
  InputEvent: browser.InputEvent,
  CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: browser.IntersectionObserver,
  matchMedia: browser.matchMedia.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  customElements: browser.customElements,
  HTMLDivElement: browser.HTMLDivElement,
  HTMLSpanElement: browser.HTMLSpanElement,
  SVGElement: browser.SVGElement,
  ShadowRoot: browser.ShadowRoot,
  CSSStyleSheet: browser.CSSStyleSheet,
  DOMParser: browser.DOMParser,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const WORKTREE = '/elsewhere/feature';
const PROJECTS = [WORKTREE, '/repo'].map((path) => ({ id: createProjectIdFromPath(path), path }));

let enhanceResponse: Response | Promise<Response> | null = null;

const responseFor = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/');
  const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
  const directory = decodeURIComponent(headers.get('x-opencode-directory') ?? url.searchParams.get('location[directory]') ?? WORKTREE);
  const location = { directory, project: { id: 'project', directory, canonical: directory } };
  if (url.pathname === '/api/config/settings') return Response.json({ projects: PROJECTS });
  if (url.pathname.endsWith('/fs/home')) return Response.json({ home: '/home/test' });
  if (url.pathname.endsWith('/fs/list')) return Response.json({ entries: [] });
  if (url.pathname.endsWith('/session-warming')) return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
  if (url.pathname.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
  if (url.pathname === '/api/config' || url.pathname === '/api/project') return Response.json([]);
  if (url.pathname.endsWith('/session/active')) return Response.json({ data: {} });
  if (url.pathname.endsWith('/vcs')) return Response.json({ data: { branch: { current: 'main', default: 'main' } } });
  if (url.pathname === '/api/magic-prompts') return Response.json({ version: 1, overrides: {} });
  if (url.pathname === '/api/small-model') {
    return Response.json({ available: true, model: { providerID: 'provider', modelID: 'model' } });
  }
  if (url.pathname === '/api/small-model/generate') {
    return enhanceResponse ?? Response.json({ text: 'Enhanced text' });
  }
  if (url.pathname.endsWith('/location')) return Response.json(location);
  const sessionId = url.pathname.match(/\/session\/(ses_feature)$/)?.[1];
  if (sessionId) return Response.json({ data: {
    id: sessionId, projectID: 'project', location: { directory: WORKTREE }, title: sessionId,
    time: { created: 1, updated: 1 }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    metadata: {},
  } });
  if (url.pathname.endsWith('/session')) return Response.json({ data: [] });
  return Response.json({ location, data: [], cursor: {} });
};
spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => responseFor(input, init));

plugin({
  name: 'composer-enhance-vite-modules',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const directory = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [
        `../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href,
      ]));
      return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
    });
  },
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EditorView } = await import('@codemirror/view');
const { undo } = await import('@codemirror/commands');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { ChatInput } = await import('../ChatInput');
const { SyncProvider } = await import('@/sync/sync-context');
const { useDirectoryStore, ensureHomeDirectoryResolved } = await import('@/stores/useDirectoryStore');
const { updateDesktopSettings } = await import('@/lib/persistence');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { OpenCode } = await import('@opencode/client');
const { opencodeClient } = await import('@/lib/opencode/client');

const sdk = OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request, init) => responseFor(request, init),
});

// SAFETY: The composer reads only the runtime descriptor and the source-control
// object's identity here; no runtime API method is invoked.
const runtimeAPIs = { runtime: { platform: 'web', isDesktop: false, isVSCode: false }, sourceControl: {} } as RuntimeAPIs;

let sent: string[] = [];

beforeEach(() => {
  useProjectsStore.setState({ projects: PROJECTS });
  sent = [];
  enhanceResponse = null;
  useDirectoryStore.setState({ currentDirectory: WORKTREE });
  useSessionUIStore.setState({
    currentSessionId: 'ses_feature',
    currentSessionDirectory: WORKTREE,
    sendMessage: async (content) => { sent.push(content); },
  });
  useConfigStore.setState({
    currentProviderId: 'provider',
    currentModelId: 'model',
    isConnected: true,
    hasEverConnected: true,
  });
});

afterAll(() => {
  browser.close();
});

const mountComposer = async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <RuntimeAPIContext.Provider value={runtimeAPIs}>
        <ThemeSystemProvider>
          <I18nProvider>
            <SyncProvider sdk={sdk} directory={WORKTREE}>
              <ChatInput />
            </SyncProvider>
          </I18nProvider>
        </ThemeSystemProvider>
      </RuntimeAPIContext.Provider>,
    );
  });
  await act(async () => {
    await ensureHomeDirectoryResolved();
    await updateDesktopSettings({});
  });
  await act(async () => {
    // Project activation can apply defaults after mount; catalog discovery is
    // outside this test, so pin the fixture's model before enhancing.
    useConfigStore.setState({ currentProviderId: 'provider', currentModelId: 'model' });
  });
  const content = container.querySelector<HTMLElement>('.cm-content');
  const view = content ? EditorView.findFromDOM(content) : null;
  if (!view) throw new Error('The composer did not mount');
  return { container, root, view };
};

const typeDraft = async (view: InstanceType<typeof EditorView>, text: string) => {
  await act(async () => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.type' });
  });
};

const clickEnhance = async (container: HTMLElement, waitMs = 300) => {
  await act(async () => {
    // Project activation can apply defaults after typing; pin the fixture's model.
    useConfigStore.setState({ currentProviderId: 'provider', currentModelId: 'model' });
    await new Promise((done) => setTimeout(done, 300));
  });
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Enhance prompt"]');
  if (!button) throw new Error('The enhance button did not mount');
  await act(async () => {
    button.click();
    await new Promise((done) => setTimeout(done, waitMs));
  });
};

test('enhances the draft in place and never sends it', async () => {
  const { container, root, view } = await mountComposer();
  try {
    await typeDraft(view, 'make this better');
    await clickEnhance(container);

    expect(view.state.doc.toString()).toBe('Enhanced text');
    expect(sent).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('undo restores the draft', async () => {
  const { container, root, view } = await mountComposer();
  try {
    await typeDraft(view, 'make this better');
    await clickEnhance(container);
    expect(view.state.doc.toString()).toBe('Enhanced text');

    await act(async () => { undo(view); });

    expect(view.state.doc.toString()).toBe('make this better');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('a draft changed during the request is not overwritten', async () => {
  const { container, root, view } = await mountComposer();
  let release = () => {};
  enhanceResponse = new Promise<Response>((resolve) => {
    release = () => resolve(Response.json({ text: 'Enhanced text' }));
  });
  try {
    await typeDraft(view, 'make this better');
    await clickEnhance(container, 50);
    await typeDraft(view, 'make this better now');
    await act(async () => {
      release();
      await new Promise((done) => setTimeout(done, 300));
    });

    expect(view.state.doc.toString()).toBe('make this better now');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('a rewrite that drops a reference keeps the original', async () => {
  const { container, root, view } = await mountComposer();
  enhanceResponse = Response.json({ text: 'Please fix the bug.' });
  // The Small Model reply drops the mention; the OpenCode fallback does too.
  const generate = spyOn(opencodeClient, 'generateText').mockResolvedValue('OPENCODE TEXT');
  try {
    await typeDraft(view, '@src/foo.ts please fix');
    await clickEnhance(container);

    expect(view.state.doc.toString()).toBe('@src/foo.ts please fix');
  } finally {
    generate.mockRestore();
    await act(async () => root.unmount());
    container.remove();
  }
});
