import { describe, expect, it, vi } from 'vitest';
import { buildAutoDispatchPrompt, createIssueDispatcher } from './dispatcher.js';

const summary = (identifier, { priority = 'medium', assignee = 'assistant', labels = ['root-cause:found'], title = `Issue ${identifier}` } = {}) => ({
  identifier,
  title,
  priority,
  labels: labels.map((name) => ({ name })),
  assignee: assignee ? { name: assignee, avatarUrl: null } : null,
});

const detail = (item, { mechanism = true, comments = [] } = {}) => ({
  ...item,
  description: mechanism ? '## Symptom\nbroken\n\n## Mechanism\nx calls y' : '## Symptom\nbroken',
  comments,
});

/** A marker comment as the session-status post writes it. */
const marker = (shortSessionId, iso = '2026-11-01T09:00:00.000Z') => ({
  id: 'comment-0',
  body: `Session started — auto-dispatch`,
  createdAt: iso,
  author: { name: `session ${shortSessionId}`, avatarUrl: null },
});

const openCodeClient = ({ sessions = [], failCreate = null } = {}) => {
  const created = [];
  const prompted = [];
  return {
    created,
    prompted,
    sessions,
    client: {
      session: {
        get: async ({ sessionID }) => {
          if (sessions.some((id) => id === sessionID)) return { data: { id: sessionID } };
          const error = new Error('not found');
          error.status = 404;
          throw error;
        },
        list: async () => ({ data: sessions.map((id) => ({ id })), cursor: null }),
        create: async (input) => {
          if (failCreate) throw failCreate;
          const id = `ses-${created.length + 1}`;
          created.push(input);
          return { data: { id } };
        },
        prompt: async ({ sessionID, text }) => {
          prompted.push({ sessionID, text });
        },
      },
    },
  };
};

/** A tracker fake: issues by project id, sessions listed for liveness. */
const trackerWith = (issuesByProject) => ({
  list: async ({ containerId }) => ({ connected: true, items: issuesByProject[containerId] ?? [], cursor: null, hasMore: false }),
  get: async (identifier, containerId) => {
    const entry = (issuesByProject[containerId] ?? []).find((candidate) => candidate.identifier === identifier);
    return entry ? { connected: true, item: entry.detail } : { connected: true, item: null };
  },
  sessionStatus: {
    post: vi.fn(async () => ({ connected: true, posted: true })),
  },
});

const dispatcherWith = async ({
  projects = [{ id: 'proj-1', path: '/repo', autoDispatchIssues: true }],
  issuesByProject,
  tracker = trackerWith(issuesByProject ?? {}),
  openCode = openCodeClient(),
  onSessionCreated = null,
  maxPerTick = 3,
  maxPerProjectPerTick = 1,
} = {}) => {
  const dispatcher = createIssueDispatcher({
    listProjects: async () => projects,
    getTracker: async () => tracker,
    createClient: () => openCode.client,
    onSessionCreated,
    maxPerTick,
    maxPerProjectPerTick,
  });
  await dispatcher.tick();
  return { dispatcher, openCode, tracker };
};

describe('createIssueDispatcher', () => {
  it('dispatches an eligible issue: creates a session, posts the started marker, seeds the prompt', async () => {
    const onSessionCreated = vi.fn();
    const item = { ...summary('LOCAL-1', { priority: 'high' }), detail: null };
    item.detail = detail(item);
    const { openCode, tracker } = await dispatcherWith({
      issuesByProject: { 'proj-1': [item] },
      onSessionCreated,
    });

    expect(openCode.created).toHaveLength(1);
    expect(openCode.created[0]).toMatchObject({
      title: 'LOCAL-1: Issue LOCAL-1',
      location: { directory: '/repo' },
    });
    expect(openCode.prompted).toHaveLength(1);
    expect(openCode.prompted[0].text).toContain('LOCAL-1');
    expect(openCode.prompted[0].text).toContain('in-progress');
    expect(openCode.prompted[0].text).toContain('Never commit');
    expect(tracker.sessionStatus.post).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'started',
      identifier: 'LOCAL-1',
      containerId: 'proj-1',
      sessionOrigin: 'auto-dispatch',
    }));
    expect(onSessionCreated).toHaveBeenCalledWith(expect.objectContaining({ directory: '/repo', promptDispatched: true }));
  });

  it('skips issues without the dispatch signal: unassigned, not root-caused, no Mechanism section', async () => {
    const make = (identifier, item, itemDetail) => ({ ...item, detail: itemDetail });
    const base = summary('LOCAL-1');
    const { openCode } = await dispatcherWith({
      issuesByProject: {
        'proj-1': [
          make('LOCAL-1', summary('LOCAL-1', { assignee: null }), detail(base)),
          make('LOCAL-2', summary('LOCAL-2', { labels: [] }), detail(base)),
          make('LOCAL-3', summary('LOCAL-3'), detail(base, { mechanism: false })),
        ],
      },
    });
    expect(openCode.created).toHaveLength(0);
    expect(openCode.prompted).toHaveLength(0);
  });

  it('dispatches the highest-priority issue first and caps per project per tick', async () => {
    const items = [
      summary('LOCAL-1', { priority: 'low' }),
      summary('LOCAL-2', { priority: 'urgent' }),
      summary('LOCAL-3', { priority: 'high' }),
    ].map((item) => ({ ...item, detail: detail(item) }));
    const { openCode } = await dispatcherWith({
      issuesByProject: { 'proj-1': items },
      maxPerProjectPerTick: 2,
    });
    expect(openCode.created.map((created) => created.title)).toEqual([
      'LOCAL-2: Issue LOCAL-2',
      'LOCAL-3: Issue LOCAL-3',
    ]);
  });

  it('caps the dispatches across projects per tick', async () => {
    const projectItems = (id) => [summary(`LOCAL-${id}`)].map((item) => ({ ...item, detail: detail(item) }));
    const { openCode } = await dispatcherWith({
      projects: [1, 2, 3, 4].map((n) => ({ id: `proj-${n}`, path: `/repo-${n}`, autoDispatchIssues: true })),
      issuesByProject: {
        'proj-1': projectItems(1),
        'proj-2': projectItems(2),
        'proj-3': projectItems(3),
        'proj-4': projectItems(4),
      },
      maxPerTick: 2,
    });
    expect(openCode.created).toHaveLength(2);
  });

  it('ignores projects without the autoDispatchIssues switch', async () => {
    const items = [summary('LOCAL-1')].map((item) => ({ ...item, detail: detail(item) }));
    const { openCode } = await dispatcherWith({
      projects: [{ id: 'proj-1', path: '/repo' }],
      issuesByProject: { 'proj-1': items },
    });
    expect(openCode.created).toHaveLength(0);
  });

  it('does not redispatch while the dispatched session is alive, and does after it is gone', async () => {
    const items = [summary('LOCAL-1')].map((item) => ({ ...item, detail: detail(item) }));
    const openCode = openCodeClient({ sessions: [] });
    const { dispatcher } = await dispatcherWith({
      issuesByProject: { 'proj-1': items },
      openCode,
    });
    expect(openCode.created).toHaveLength(1);
    const dispatchedId = 'ses-1';
    openCode.sessions.push(dispatchedId);

    await dispatcher.tick();
    expect(openCode.created).toHaveLength(1);

    openCode.sessions.length = 0;
    await dispatcher.tick();
    expect(openCode.created).toHaveLength(2);
    expect(openCode.created[1].title).toBe('LOCAL-1: Issue LOCAL-1');
  });

  it('recovers the dispatched session from the issue marker after a restart and skips a live one', async () => {
    const liveSessionId = 'ses_0123456789abcdef';
    const items = [summary('LOCAL-1')].map((item) => ({
      ...item,
      detail: detail(item, { comments: [marker(liveSessionId.slice(0, 12))] }),
    }));
    const openCode = openCodeClient({ sessions: [liveSessionId] });
    await dispatcherWith({ issuesByProject: { 'proj-1': items }, openCode });
    expect(openCode.created).toHaveLength(0);

    const dead = openCodeClient({ sessions: [] });
    const { openCode: deadCode } = await dispatcherWith({ issuesByProject: { 'proj-1': items }, openCode: dead });
    expect(deadCode.created).toHaveLength(1);
  });

  it('keeps other projects going when one project scan or dispatch fails', async () => {
    const failingTracker = {
      ...trackerWith({ 'proj-2': [summary('LOCAL-2')].map((item) => ({ ...item, detail: detail(item) })) }),
      list: async ({ containerId }) => {
        if (containerId === 'proj-1') throw new Error('scan blew up');
        return { connected: true, items: containerId === 'proj-2' ? [summary('LOCAL-2')].map((item) => ({ ...item, detail: detail(item) })) : [], cursor: null, hasMore: false };
      },
    };
    const openCode = openCodeClient();
    await dispatcherWith({
      projects: [
        { id: 'proj-1', path: '/repo-1', autoDispatchIssues: true },
        { id: 'proj-2', path: '/repo-2', autoDispatchIssues: true },
      ],
      tracker: failingTracker,
      openCode,
    });
    expect(openCode.created.map((created) => created.location.directory)).toEqual(['/repo-2']);
  });

  it('marks the session started before the prompt, so a failed prompt still dedupes', async () => {
    const items = [summary('LOCAL-1')].map((item) => ({ ...item, detail: detail(item) }));
    const tracker = trackerWith({ 'proj-1': items });
    const order = [];
    tracker.sessionStatus.post.mockImplementation(async () => {
      order.push('post');
      return { connected: true, posted: true };
    });
    const openCode = openCodeClient();
    const originalPrompt = openCode.client.session.prompt;
    openCode.client.session.prompt = async (input) => {
      order.push('prompt');
      return originalPrompt(input);
    };
    await dispatcherWith({ issuesByProject: { 'proj-1': items }, tracker, openCode });
    expect(order).toEqual(['post', 'prompt']);
  });
});

describe('buildAutoDispatchPrompt', () => {
  it('names the issue, the directory, and the never-commit rule', () => {
    const prompt = buildAutoDispatchPrompt({ identifier: 'LOCAL-7', title: 'Board drops assignee', projectPath: 'D:/work/app' });
    expect(prompt).toContain('LOCAL-7');
    expect(prompt).toContain('Board drops assignee');
    expect(prompt).toContain('D:/work/app');
    expect(prompt).toContain('Never commit');
    expect(prompt).toContain('triage');
  });
});
