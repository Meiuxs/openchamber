import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { FilesAPI, GitAPI } from '@/lib/api/types';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import type { NestedRepoDiscovery } from '@/stores/useGitStore';
import { useDiffViewTurnNavigation } from './useDiffViewTurnNavigation';
import type { TurnSnapshotDiff } from '../turnSnapshotDiff';
import type { DiffScope, FileEntry } from './types';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true,
});

const ROOT = '/repo';
const PANEL_SESSION = 'panel-session';
const PINNED_SESSION = 'pinned-session';
const changed: FileEntry = { path: 'src/a.ts', index: ' ', working_dir: 'M', insertions: 1, deletions: 0, isNew: false };

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

let reactRoot: Root | null = null;
let shown: string[] = [];
let statusRead: Deferred;

type Request = { file: string; sessionId: string | null; turnId?: string; panelSessionId: string | null };
type ProbeProps = { request: Request | null; initialScope?: DiffScope; panelSessionId?: string; turnDiffSettled?: boolean };

const Probe: React.FC<ProbeProps> = ({ request, initialScope = 'turn', panelSessionId = PANEL_SESSION, turnDiffSettled = true }) => {
  const [activeDiffScope, setActiveDiffScope] = React.useState<DiffScope>(initialScope);
  // DiffView follows its diffScope prop one render late, in an effect that runs before the hook's.
  React.useEffect(() => { setActiveDiffScope('turn'); }, []);
  const [pending, setPending] = React.useState(request);
  const [, setDisplayFile] = React.useState<string | null>(null);
  const [, setDisplayFileStaged] = React.useState(false);
  const [, setScrollRequestNonce] = React.useState(0);
  const shouldPinAfterAlignRef = React.useRef(false);
  const pendingScrollTargetRef = React.useRef<string | null>(null);
  useDiffViewTurnNavigation({
    visible: true, activeDiffScope, setActiveDiffScope, setDisplayFile, setDisplayFileStaged,
    shouldPinAfterAlignRef, pendingScrollTargetRef, expandStackedFile: (path) => { shown.push(path); },
    setScrollRequestNonce, pendingTurnDiffFile: pending, setPendingTurnDiffFile: setPending, diffScope: 'turn',
    panelSessionId, turnDiffSettled, rootDirectory: ROOT,
    // Snapshots off: the turn diff lists nothing.
    lastTurnDiffs: [], onDiffScopeChange: undefined, effectiveDirectory: ROOT,
    repositoriesKnown: true, rootIsGitRepo: true, nestedRepos: [], repositoryOptions: [],
    selectNestedRepo: async () => {},
    fetchStatus: async () => { await statusRead.promise; return true; },
    // SAFETY: the fallback hands git only to the fetchStatus stub above.
    git: {} as GitAPI,
    workingFiles: [changed],
    // SAFETY: a file inside a repository never reaches the Files API.
    files: {} as FilesAPI,
  });
  return null;
};

const pinnedChip: Request = { file: 'src/a.ts', sessionId: PINNED_SESSION, turnId: 'older-turn', panelSessionId: PANEL_SESSION };

const render = async (props: ProbeProps) => {
  reactRoot ??= createRoot(document.createElement('div'));
  await act(async () => reactRoot?.render(<Probe {...props} />));
};

beforeEach(() => {
  shown = [];
  statusRead = deferred();
  useSessionUIStore.setState({ currentSessionId: PANEL_SESSION });
});

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  reactRoot = null;
});

let switched: string[] = [];
let scopes: DiffScope[] = [];

type NestedProbeProps = {
  request: Request;
  initialRepository: string;
  rootIsGitRepo: boolean | null;
  nestedRepos: NestedRepoDiscovery | undefined;
  repositoryOptions: string[] | null;
  workingFilesByDirectory: Record<string, FileEntry[]>;
  turnFiles: TurnSnapshotDiff[];
  files: FilesAPI;
  gitApi?: Partial<GitAPI>;
};

const NestedProbe: React.FC<NestedProbeProps> = ({
  request, initialRepository, rootIsGitRepo, nestedRepos, repositoryOptions,
  workingFilesByDirectory, turnFiles, files, gitApi = {},
}) => {
  const [activeDiffScope, setActiveDiffScope] = React.useState<DiffScope>('turn');
  const [pending, setPending] = React.useState<Request | null>(request);
  const [effectiveDirectory, setEffectiveDirectory] = React.useState(initialRepository);
  const [, setDisplayFile] = React.useState<string | null>(null);
  const [, setDisplayFileStaged] = React.useState(false);
  const [, setScrollRequestNonce] = React.useState(0);
  const shouldPinAfterAlignRef = React.useRef(false);
  const pendingScrollTargetRef = React.useRef<string | null>(null);
  useDiffViewTurnNavigation({
    visible: true, activeDiffScope, setActiveDiffScope, setDisplayFile, setDisplayFileStaged,
    shouldPinAfterAlignRef, pendingScrollTargetRef, expandStackedFile: (path) => { shown.push(path); },
    setScrollRequestNonce, pendingTurnDiffFile: pending, setPendingTurnDiffFile: setPending, diffScope: 'turn',
    panelSessionId: PANEL_SESSION, turnDiffSettled: true, rootDirectory: ROOT,
    lastTurnDiffs: turnFiles, onDiffScopeChange: (scope) => { scopes.push(scope); }, effectiveDirectory,
    repositoriesKnown: true, rootIsGitRepo, nestedRepos, repositoryOptions,
    selectNestedRepo: (root, repository) => {
      switched.push(`${root}|${repository}`);
      setEffectiveDirectory(repository);
    },
    fetchStatus: async () => true,
    // SAFETY: the probe only reaches the optional methods its tests stub.
    git: gitApi as GitAPI,
    workingFiles: workingFilesByDirectory[effectiveDirectory] ?? [],
    files,
  });
  return null;
};

const filesWithContent = (content: string): FilesAPI => ({
  listDirectory: async () => ({ directory: ROOT, entries: [] }),
  search: async () => [],
  createDirectory: async (path) => ({ success: true, path }),
  statFile: async (path) => ({ path, isFile: true, size: content.length }),
  readFile: async (path) => ({ content, path }),
});

const renderNode = async (node: React.ReactElement) => {
  reactRoot ??= createRoot(document.createElement('div'));
  await act(async () => reactRoot?.render(node));
};

const flush = async () => {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
};

const changedEntry = (path: string): FileEntry => ({ path, index: ' ', working_dir: 'M', insertions: 1, deletions: 0, isNew: false });

// SAFETY: the hook only reads these two optional methods from this stub.
const committedGit = {
  getGitLog: async () => ({
    all: [{
      hash: 'abc1234', date: '2026-01-01T00:00:00.000Z', message: 'change x', refs: '', body: '',
      author_name: 'A', author_email: 'a@example.com', filesChanged: 1, insertions: 1, deletions: 1, parents: [],
    }],
    latest: null,
    total: 1,
  }),
  getCommitFiles: async () => ({
    files: [{ path: 'src/x.ts', insertions: 1, deletions: 1, isBinary: false, changeType: 'M' }],
  }),
} satisfies Partial<GitAPI>;

const nestedRequest = (file: string): Request => ({
  file, sessionId: PANEL_SESSION, panelSessionId: PANEL_SESSION,
});

describe('useDiffViewTurnNavigation', () => {
  beforeEach(() => {
    switched = [];
    scopes = [];
  });

  test('a pinned chat chip whose file misses the turn list reveals it in Changed', async () => {
    await render({ request: pinnedChip });
    await act(async () => statusRead.resolve());
    expect(shown).toEqual(['src/a.ts']);
  });

  test('switches to the file repository before revealing it in Changed', async () => {
    await renderNode(
      <NestedProbe
        request={nestedRequest('b/src/x.ts')}
        initialRepository={`${ROOT}/a`}
        rootIsGitRepo={false}
        nestedRepos={[`${ROOT}/a`, `${ROOT}/b`]}
        repositoryOptions={[`${ROOT}/a`, `${ROOT}/b`]}
        workingFilesByDirectory={{ [`${ROOT}/b`]: [changedEntry('src/x.ts')] }}
        turnFiles={[]}
        files={filesWithContent('export {};\n')}
      />,
    );
    await flush();
    expect(switched).toEqual([`${ROOT}|${ROOT}/b`]);
    expect(shown).toEqual(['src/x.ts']);
  });

  test('switches to the file repository even when the turn snapshot lists the file', async () => {
    await renderNode(
      <NestedProbe
        request={nestedRequest('b/src/x.ts')}
        initialRepository={`${ROOT}/a`}
        rootIsGitRepo={false}
        nestedRepos={[`${ROOT}/a`, `${ROOT}/b`]}
        repositoryOptions={[`${ROOT}/a`, `${ROOT}/b`]}
        workingFilesByDirectory={{}}
        turnFiles={[{ file: 'b/src/x.ts', patch: '@@ -1 +1 @@\n-a\n+b\n' }]}
        files={filesWithContent('export {};\n')}
      />,
    );
    await flush();
    expect(switched).toEqual([`${ROOT}|${ROOT}/b`]);
    expect(shown).toEqual(['b/src/x.ts']);
  });

  test('opens the file instead of dropping the click when no diff can be shown', async () => {
    await renderNode(
      <NestedProbe
        request={nestedRequest('notes/x.md')}
        initialRepository={ROOT}
        rootIsGitRepo={false}
        // SAFETY: this is the exact unsupported variant the component receives.
        nestedRepos={'unsupported' as NestedRepoDiscovery}
        repositoryOptions={null}
        workingFilesByDirectory={{ [ROOT]: [] }}
        turnFiles={[]}
        files={filesWithContent('# notes\n')}
      />,
    );
    await flush();
    const openFiles = (useUIStore.getState().contextPanelByDirectory[ROOT]?.tabs ?? [])
      .filter((tab) => tab.mode === 'file')
      .map((tab) => tab.targetPath);
    expect(openFiles).toContain(`${ROOT}/notes/x.md`);
    // The file belongs to no repository, so the panel must not detour through
    // the Git Changes scope before opening it.
    expect(scopes).not.toContain('working');
  });

  test('a committed change opens the commit that last touched the file', async () => {
    await renderNode(
      <NestedProbe
        request={nestedRequest('b/src/x.ts')}
        initialRepository={`${ROOT}/b`}
        rootIsGitRepo={false}
        nestedRepos={[`${ROOT}/b`]}
        repositoryOptions={[`${ROOT}/b`]}
        workingFilesByDirectory={{ [`${ROOT}/b`]: [] }}
        turnFiles={[]}
        files={filesWithContent('export {};\n')}
        gitApi={committedGit}
      />,
    );
    await flush();
    expect(scopes).toContain('commit');
    expect(shown).toEqual(['src/x.ts']);
  });

  test('a pinned chat chip survives the panel catching up from Working to turn scope', async () => {
    await render({ request: pinnedChip, initialScope: 'working' });
    await act(async () => statusRead.resolve());
    expect(shown).toEqual(['src/a.ts']);
  });

  test('a panel that moves to another session before the snapshot settles drops the request', async () => {
    await render({ request: pinnedChip, turnDiffSettled: false });
    await act(async () => useSessionUIStore.setState({ currentSessionId: 'another-session' }));
    await render({ request: pinnedChip, turnDiffSettled: false, panelSessionId: 'another-session' });
    await render({ request: pinnedChip, panelSessionId: 'another-session' });
    await act(async () => statusRead.resolve());
    expect(shown).toEqual([]);
  });

  test('leaving the panel session drops the pending reveal', async () => {
    await render({ request: pinnedChip });
    await act(async () => useSessionUIStore.setState({ currentSessionId: 'another-session' }));
    await act(async () => statusRead.resolve());
    expect(shown).toEqual([]);
  });
});
