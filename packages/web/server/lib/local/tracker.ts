import path from 'path';
import { asNonEmptyString, isString } from '../shared/guards.js';
import { appendComment, LocalIssueError, readIssue, splitComments, writeIssue } from './files.js';
import { createLocalScanner, issuesDirOf } from './scanner.js';
import { readLocalPreferences, writeLocalPreferences } from './preferences.js';
import { createLocalSessionStatusRuntime } from './status-runtime.js';

import type { IssueFieldValue } from './files.js';
import type { IssueView, Project } from './scanner.js';
import type {
  TrackerDescriptor,
  TrackerImplementation,
  TrackerItem,
  TrackerItemSummary,
  TrackerPriority,
  TrackerSessionStatusInput,
  TrackerSessionStatusKind,
  TrackerSessionStatusResult,
} from '../trackers/tracker-contract.js';

type SessionLink = { identifier: string; sessionOrigin: string | null };
type ContainerRef = { id: string; name: string };
type LocalSessionStatusInput = TrackerSessionStatusInput & { containerId?: string; projectDirectory?: string };
type ForkItemInput = {
  id: string;
  containerId?: string;
  projectDirectory?: string;
  title?: string;
  description?: string | null;
  priority?: TrackerPriority | null;
  labels?: string[];
  assignee?: string | null;
  feature?: string | null;
  blockedBy?: string[];
};
type ForkCreateInput = Omit<ForkItemInput, 'id'> & { containerId: string };
type ForkUpdateStateInput = { id: string; stateId: string; containerId?: string; projectDirectory?: string };

const LOCAL_TRACKER_ID = 'local';

const SESSION_STATUS_KINDS: readonly TrackerSessionStatusKind[] = ['started', 'completed', 'failure'];
const isSessionStatusKind = (value: string): value is TrackerSessionStatusKind =>
  SESSION_STATUS_KINDS.some((kind) => kind === value);
const MAX_SESSION_STATUS_MEMORY = 500;
const SESSION_ID_SHORT_LENGTH = 12;

const statusWord = (kind: TrackerSessionStatusKind): string => (kind === 'failure' ? 'failed' : kind);

const toSingleLine = (value: string | null | undefined): string | null => (isString(value) ? value.replace(/\s+/g, ' ').trim() : null);

const toSingleLineLabels = (labels: string[] | null | undefined): string[] => (Array.isArray(labels)
  ? labels.filter(isString).map(toSingleLine).filter((label): label is string => label !== null)
  : []);

const normalizePriority = (priority: TrackerPriority | null | undefined): TrackerPriority =>
  (priority === 'none' || !priority ? 'low' : priority);

const toTrackerPerson = (name: string | null): { name: string | null; avatarUrl: string | null } | null =>
  (name ? { name, avatarUrl: null } : null);

const shortSessionId = (sessionId: string): string => (sessionId.length <= SESSION_ID_SHORT_LENGTH ? sessionId : sessionId.slice(0, SESSION_ID_SHORT_LENGTH));

const nowIso = (): string => new Date().toISOString();

const itemUrl = (identifier: string): string => `https://openchamber.local/tracker/local/${identifier}`;

export const LOCAL_TRACKER_DESCRIPTOR: TrackerDescriptor = Object.freeze({
  id: LOCAL_TRACKER_ID,
  name: 'Local',
  authMethods: Object.freeze([]),
  capabilities: Object.freeze({
    multipleAccounts: false,
    stateUpdate: true,
    children: false,
    labels: true,
    priority: true,
    feature: true,
    blockers: true,
    assignee: true,
    filters: Object.freeze({ people: false, priority: true }),
    projectMapping: false,
    sessionComments: true,
    hostAccess: false,
    externalUrl: false,
    translatedStates: true,
    containersAreProjects: true,
    create: true,
    edit: true,
    delete: true,
    itemComments: true,
  }),
  stateFilters: Object.freeze(['open', 'all', 'triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled']),
  urlPatterns: Object.freeze([
    Object.freeze({ host: 'openchamber.local', path: '^/tracker/local/([A-Za-z][A-Za-z0-9]*-\\d+)(?:/|$)' }),
  ]),
  identifierPattern: '^[A-Za-z][A-Za-z0-9]*-\\d+$',
});

const URL_PATTERNS = LOCAL_TRACKER_DESCRIPTOR.urlPatterns.map((pattern) => ({
  host: pattern.host,
  path: new RegExp(pattern.path),
}));

function matchLocalUrl(value: string): string | null {
  const raw = isString(value) ? value.trim() : '';
  if (!raw || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  for (const pattern of URL_PATTERNS) {
    if (pattern.host !== host) continue;
    const match = pattern.path.exec(url.pathname);
    if (match) return match[1] ? decodeURIComponent(match[1]) : null;
  }
  return null;
}

const toContainer = (container: ContainerRef | null | undefined): { id: string; key: string | null; name: string } | null =>
  (container ? { id: container.id, key: null, name: container.name } : null);

function toTrackerItemSummary(issue: IssueView, container: ContainerRef | null | undefined): TrackerItemSummary {
  return {
    provider: LOCAL_TRACKER_ID,
    id: issue.identifier,
    identifier: issue.identifier,
    title: issue.title,
    url: itemUrl(issue.identifier),
    state: { id: issue.state, name: issue.state, category: issue.state },
    priority: issue.priority ?? 'low',
    labels: issue.labels.map((name, index) => ({ id: `label-${index}`, name, color: null })),
    assignee: toTrackerPerson(issue.assignee),
    container: toContainer(container),
    feature: issue.feature ?? null,
    blockedBy: issue.blockedBy,
    blocked: issue.blocked === true,
    updatedAt: issue.updatedAt ?? null,
  };
}

function toTrackerItem(issue: IssueView, container: ContainerRef | null | undefined): TrackerItem {
  const { head, comments } = splitComments(issue.body);
  return {
    ...toTrackerItemSummary(issue, container),
    description: head.trim() || null,
    comments: comments.map((comment, index) => ({
      id: `comment-${index}`,
      body: comment.text,
      createdAt: comment.iso,
      author: toTrackerPerson(comment.source),
    })),
  };
}

export function createLocalTracker({ listProjects }: { listProjects: () => Promise<Project[]> }) {
  const scanner = createLocalScanner({ listProjects });

  const containerOfIssue = async (issue: IssueView) => {
    const found = (await scanner.containers()).find((candidate) => candidate.id === issue.containerId);
    return found ? { id: found.id, key: null, name: found.name } : null;
  };

  const sessionLinks = new Map<string, SessionLink>();
  const postedStatuses = new Set<string>();
  const inflightPosts = new Map<string, Promise<TrackerSessionStatusResult>>();

  const rememberSessionLink = (sessionId: string, link: SessionLink): void => {
    sessionLinks.delete(sessionId);
    sessionLinks.set(sessionId, link);
    if (sessionLinks.size > MAX_SESSION_STATUS_MEMORY) {
      const oldest = sessionLinks.keys().next().value;
      if (oldest !== undefined) sessionLinks.delete(oldest);
    }
  };

  const rememberPostedStatus = (dedupeKey: string): void => {
    postedStatuses.delete(dedupeKey);
    postedStatuses.add(dedupeKey);
    if (postedStatuses.size > MAX_SESSION_STATUS_MEMORY) {
      const oldest = postedStatuses.keys().next().value;
      if (oldest !== undefined) postedStatuses.delete(oldest);
    }
  };

  const postSessionStatusOnce = async (input: LocalSessionStatusInput): Promise<TrackerSessionStatusResult> => {
    const sessionId = asNonEmptyString(input?.sessionId);
    const kind = asNonEmptyString(input?.kind);
    if (!sessionId || !kind || !isSessionStatusKind(kind)) {
      return { connected: true as const, posted: false, skipped: 'no-identifier' };
    }

    const link = sessionLinks.get(sessionId) ?? null;
    const identifier = asNonEmptyString(input.identifier) ?? link?.identifier ?? null;
    if (!identifier) {
      return { connected: true as const, posted: false, skipped: 'no-identifier' };
    }

    const sessionOrigin = asNonEmptyString(input.sessionOrigin) ?? link?.sessionOrigin ?? null;
    if (asNonEmptyString(input.identifier)) {
      rememberSessionLink(sessionId, { identifier, sessionOrigin });
    }

    if (!readLocalPreferences().sessionComments) {
      return { connected: true as const, posted: false, skipped: 'no-identifier' };
    }
    const dedupeKey = `${sessionId}:${kind}`;
    if (postedStatuses.has(dedupeKey)) {
      return { connected: true as const, posted: false, skipped: 'already-posted' };
    }

    const projectHint = asNonEmptyString(input?.containerId) ?? asNonEmptyString(input?.projectDirectory) ?? null;
    const found = await scanner.get(identifier, projectHint);
    if (!found) {
      return { connected: true as const, posted: false, skipped: 'no-identifier' };
    }

    const project = (await listProjects()).find((candidate) => candidate.id === found.issue.containerId);
    if (!project) {
      return { connected: true as const, posted: false, skipped: 'no-identifier' };
    }
    const dirPath = path.join(project.path, issuesDirOf(project));
    const parsed = readIssue(dirPath, found.issue.fileName);
    if (!parsed) {
      return { connected: true as const, posted: false, skipped: 'no-identifier' };
    }

    writeIssue(dirPath, appendComment(parsed, {
      iso: nowIso(),
      source: `session ${shortSessionId(sessionId)}`,
      text: sessionOrigin
        ? `Session ${statusWord(kind)} — ${sessionOrigin}`
        : `Session ${statusWord(kind)}`,
    }));
    rememberPostedStatus(dedupeKey);
    return { connected: true as const, posted: true };
  };

  const postSessionStatus = (input: LocalSessionStatusInput): Promise<TrackerSessionStatusResult> => {
    const dedupeKey = `${input?.sessionId}:${input?.kind}`;
    const pending = inflightPosts.get(dedupeKey);
    if (pending) {
      return pending;
    }
    const promise = postSessionStatusOnce(input).finally(() => {
      inflightPosts.delete(dedupeKey);
    });
    inflightPosts.set(dedupeKey, promise);
    return promise;
  };

  return {
    auth: {
      status: async () => ({ connected: true as const, account: { id: 'local', name: 'Local', user: null, current: true } }),
      start: async () => {
        throw new LocalIssueError('Not supported');
      },
      disconnect: async () => {
        throw new LocalIssueError('Not supported');
      },
      activate: async () => {
        throw new LocalIssueError('Not supported');
      },
    },

    list: async (options: Parameters<TrackerImplementation['list']>[0]) => {
      const result = await scanner.list(options);
      return {
        connected: true as const,
        items: result.issues.map((issue) => toTrackerItemSummary(issue, result.containerByIssue.get(issue.containerId))),
        cursor: result.cursor,
        hasMore: result.hasMore,
        facets: { feature: result.features, assignee: result.assignees },
      };
    },

    get: async (id: string, containerId?: string | null) => {
      const found = await scanner.get(id, containerId);
      return { connected: true as const, item: found ? toTrackerItem(found.issue, found.container) : null };
    },

    states: async () => ({ connected: true as const, states: await scanner.states() }),

    comment: async ({ id, body, containerId, projectDirectory }: { id: string; body: string; containerId?: string; projectDirectory?: string }) => {
      const issue = await scanner.comment(id, body, containerId || projectDirectory);
      return { connected: true as const, item: toTrackerItem(issue, await containerOfIssue(issue)) };
    },

    updateState: async ({ id, stateId, containerId, projectDirectory }: ForkUpdateStateInput) => {
      const issue = await scanner.updateState(id, stateId, containerId || projectDirectory);
      return { connected: true as const, item: toTrackerItemSummary(issue, await containerOfIssue(issue)) };
    },

    create: async ({ containerId, title, description, priority, labels, assignee, feature, blockedBy }: ForkCreateInput) => {
      const issue = await scanner.create(containerId, {
        title: toSingleLine(title) ?? '',
        description: description ?? null,
        priority: normalizePriority(priority),
        labels: toSingleLineLabels(labels),
        assignee: toSingleLine(assignee),
        feature: toSingleLine(feature),
        blockedBy: toSingleLineLabels(blockedBy),
      });
      return { connected: true as const, item: toTrackerItemSummary(issue, await containerOfIssue(issue)) };
    },

    edit: async ({ id, title, description, priority, labels, assignee, feature, blockedBy, containerId, projectDirectory }: ForkItemInput) => {
      const patch: Record<string, IssueFieldValue> = {};
      if (title !== undefined) patch.title = toSingleLine(title);
      if (description !== undefined) patch.description = description ?? null;
      if (priority !== undefined) patch.priority = normalizePriority(priority);
      if (labels !== undefined) patch.labels = toSingleLineLabels(labels);
      if (assignee !== undefined) patch.assignee = toSingleLine(assignee);
      if (feature !== undefined) patch.feature = toSingleLine(feature);
      if (blockedBy !== undefined) patch.blockedBy = toSingleLineLabels(blockedBy);
      const issue = await scanner.edit(id, patch, containerId || projectDirectory);
      return { connected: true as const, item: toTrackerItemSummary(issue, await containerOfIssue(issue)) };
    },

    remove: async ({ id, containerId, projectDirectory }: { id: string; containerId?: string; projectDirectory?: string }) => {
      const issue = await scanner.remove(id, containerId || projectDirectory);
      return { connected: true as const, removed: true as const, identifier: issue.identifier };
    },

    liveSummaries: async (identifiers: string[]) => ({ connected: true as const, items: await scanner.liveSummaries(identifiers) }),

    matchUrl: matchLocalUrl,

    preferences: {
      get: async () => readLocalPreferences(),
      set: async (input: { sessionComments: boolean }) => writeLocalPreferences(input),
    },

    sessionStatus: {
      post: postSessionStatus,
      createRuntime: () => createLocalSessionStatusRuntime({ post: postSessionStatus }),
    },
  };
}
