import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { GitTransportBindingIntent, SourceControlBindingRead, SourceControlProviderBinding, SourceControlProviderBindingMutation } from '@/lib/api/types';

const provider = (): SourceControlProviderBinding => ({
  provider: 'gitlab',
  instance: 'https://gitlab.example.com',
  accountId: 'acct#1',
  primaryRemote: 'origin',
  repository: { owner: 'root', name: 'openchamber' },
});

const read = (directory: string): SourceControlBindingRead => ({
  status: 'bound',
  revision: 4,
  repository: {
    repositoryId: `repo:${directory}`,
    configRevision: 'config-1',
    bare: false,
    remotes: [{ name: 'origin', fetch: { displayUrl: 'url', fingerprint: 'fp' }, push: { displayUrl: 'url', fingerprint: 'fp' } }],
  },
  binding: {
    repositoryId: `repo:${directory}`,
    revision: 4,
    providers: [{ ...provider(), readiness: 'ready', endpoint: null }],
    remotes: [],
    auxiliary: [],
    state: 'bound',
    configRevision: 'config-1',
  },
});

const account = {
  id: 'acct#1',
  credentialId: 'cred#1',
  credentialRevision: 1,
  providerUserId: 'user#1',
  providerUserStatus: 'available' as const,
  user: { provider: 'gitlab' as const, instance: 'https://gitlab.example.com', id: 'user#1', username: 'root' },
  current: true,
  source: 'pat' as const,
  status: 'valid' as const,
};

const checkGit = async (directory: string) => directory !== '/code/not-a-repo';

const mutateCalls: SourceControlProviderBindingMutation[] = [];
const configureCalls: GitTransportBindingIntent[] = [];
const mutate = mock(async (input: SourceControlProviderBindingMutation) => {
  mutateCalls.push(input);
  return missingRead('/code/c');
});
const configureTransport = mock(async (input: GitTransportBindingIntent) => {
  configureCalls.push(input);
});

const missingRead = (directory: string): SourceControlBindingRead => ({
  status: 'missing',
  revision: 4,
  repository: {
    repositoryId: `repo:${directory}`,
    configRevision: 'config-1',
    bare: false,
    remotes: [{ name: 'upstream', fetch: { displayUrl: 'https://selfhosted.example.org/team/app.git', fingerprint: 'fetch-fp' }, push: { displayUrl: 'https://selfhosted.example.org/team/app.git', fingerprint: 'push-fp' } }],
  },
  binding: null,
});

mock.module('@/components/ui/dialog', () => {
  const box = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children);
  return {
    Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) => (open ? box({ children }) : null),
    DialogContent: box,
    DialogHeader: box,
    DialogTitle: box,
    DialogFooter: box,
  };
});

mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({
    git: {
      configureTransportBinding: configureTransport,
      removeTransportBinding: async () => undefined,
      setGitIdentity: async () => undefined,
    },
    sourceControl: {
      repositoryBinding: async () => missingRead('/code/c'),
      repositoryProviderBindingMutate: mutate,
      resetRepositoryBinding: async () => missingRead('/code/c'),
      authInstances: async () => [{ provider: 'gitlab', instance: 'https://gitlab.example.com' }],
      authStatus: async () => ({ status: 'connected', connected: true, provider: 'gitlab', instance: 'https://gitlab.example.com', accounts: [account] }),
    },
  }),
}));
mock.module('@/lib/source-control/repository-binding', () => ({
  useRepositoryBindings: () => [
    { status: 'ready', read: read('/code/a'), error: null, contexts: [] },
    { status: 'ready', read: read('/code/b'), error: null, contexts: [] },
    { status: 'ready', read: missingRead('/code/c'), error: null, contexts: [] },
  ],
  repositoryBindingOwner: {
    scope: (directory: string) => ({ directory }),
    captureMutation: () => ({ release: () => undefined }),
    setMutationResult: () => true,
    reconcile: async () => undefined,
  },
}));
const projectsState = {
  projects: [
    { id: 'a', path: '/code/a' },
    { id: 'b', path: '/code/b' },
    { id: 'c', path: '/code/c' },
    { id: 'd', path: '/code/not-a-repo' },
  ],
  activeProjectId: 'project',
};
mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown) => selector(projectsState),
}));
mock.module('@/stores/useSourceControlAuthStore', () => {
  const key = JSON.stringify(['web', 'gitlab', 'https://gitlab.example.com']);
  return {
    getSourceControlAuthKey: (identity: { provider: string; instance: string }) => JSON.stringify(['web', identity.provider, identity.instance]),
    useSourceControlAuthStore: Object.assign(
      (selector: (state: unknown) => unknown) => selector({
        entries: { [key]: { status: { status: 'connected', connected: true, accounts: [account] } } },
        identities: [{ provider: 'gitlab', instance: 'https://gitlab.example.com' }],
      }),
      { getState: () => ({ refreshInstances: async () => [], refreshIdentityAccounts: async () => undefined }) },
    ),
  };
});
mock.module('@/stores/useGitIdentitiesStore', () => ({
  useGitIdentitiesStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ profiles: [] }),
    { getState: () => ({ loadProfiles: async () => undefined, profiles: [], getProfileById: () => undefined }) },
  ),
}));

const { I18nProvider } = await import('@/lib/i18n');
const { RepositoryBindingsPage } = await import('./RepositoryBindingsPage');

describe('RepositoryBindingsPage', () => {
  let dom: Window;
  let host: HTMLDivElement;
  let root: Root | undefined;
  let saved: Map<string, PropertyDescriptor | undefined>;

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    const values = {
      window: dom, document: dom.document, navigator: dom.navigator,
      HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
      Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
      MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
      getComputedStyle: dom.getComputedStyle.bind(dom),
      requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
      cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
      localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    saved = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.assign(globalThis, values);
    host = document.createElement('div');
    document.body.append(host);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = undefined;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.close();
  });

  test('lists every project, flags duplicates, and binds manually when the remote cannot be inferred', async () => {
    const { createRoot } = await import('react-dom/client');
    root = createRoot(host);
    await act(async () => {
      root?.render(<I18nProvider><RepositoryBindingsPage checkGit={checkGit} /></I18nProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('/code/a');
    expect(host.textContent).toContain('/code/b');
    expect(host.textContent).toContain('/code/c');
    expect(host.textContent).toContain('root/openchamber');
    expect(host.textContent).toContain('Not bound');
    expect(host.textContent).toContain('Duplicate');
    expect(host.textContent).not.toContain('/code/not-a-repo');

    const bindButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Bind');
    expect(bindButton).toBeTruthy();
    await act(async () => { bindButton?.click(); });
    const confirm = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Confirm');
    expect(confirm).toBeTruthy();
    await act(async () => { confirm?.click(); });
    expect(mutateCalls[0]).toMatchObject({
      operation: 'add',
      provider: { provider: 'gitlab', instance: 'https://gitlab.example.com', accountId: 'acct#1', primaryRemote: 'upstream' },
    });
    expect(configureCalls[0]).toMatchObject({
      expectedRevision: 4,
      expectedFetchFingerprint: 'fetch-fp',
      remote: 'upstream',
      transport: 'https',
      credentialAccount: { provider: 'gitlab', instance: 'https://gitlab.example.com', accountId: 'acct#1' },
    });
    expect(Object.keys(configureCalls[0]?.credentialAccount ?? {}).sort()).toEqual(['accountId', 'instance', 'provider']);
  });
});
