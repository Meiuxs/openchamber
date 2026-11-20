import { asNonEmptyString, isPlainObject } from '../shared/guards.js';
import { parseModelRef } from '../shared/model-ref.js';

import type { SessionCreatedEvent } from '../openchamber-sessions/routes.js';
import type { SessionClient } from '../openchamber-sessions/opencode-client-contract.js';
import type { RegisteredTrackerImplementation } from '../trackers/registry.js';
import type {
  Connected,
  TrackerImplementation,
  TrackerItem,
  TrackerItemSummary,
  TrackerPriority,
  TrackerSessionStatusInput,
  TrackerSessionStatusResult,
} from '../trackers/tracker-contract.js';

const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low'];
const ROOT_CAUSE_LABEL = 'root-cause:found';
const DISPATCH_ORIGIN = 'auto-dispatch';
const MARKER_PREFIX = 'Session started';
const MAX_SESSION_LIST_PAGES = 10;

type DispatchProject = {
  id: string;
  path: string;
  autoDispatchIssues?: boolean;
  defaultModel?: string;
  defaultVariant?: string;
  defaultAgent?: string;
};

type DispatchTracker = Pick<TrackerImplementation, 'list'> & {
  get(id: string, containerId?: string): Promise<Connected<{ item: TrackerItem | null }>>;
  sessionStatus: {
    post(input: TrackerSessionStatusInput & { containerId?: string }): Promise<TrackerSessionStatusResult>;
  };
};

type SessionIdCarrier = { data?: { id?: string } | null; id?: string };
type SessionModelPayload = { providerID: string; id: string; variant?: string };
type SessionPayload = {
  title: string;
  location: { directory: string };
  model?: SessionModelPayload;
  agent?: string;
};

type DispatcherDependencies = {
  listProjects: () => Promise<DispatchProject[] | undefined>;
  getTracker: () => Promise<RegisteredTrackerImplementation | null>;
  createClient: (input: { directory?: string }) => SessionClient;
  waitForOpenCodeReady?: (() => Promise<void>) | null;
  onSessionCreated?: ((event: SessionCreatedEvent) => void) | null;
  logger?: Console;
  tickIntervalMs?: number;
  startupDelayMs?: number;
  maxPerProjectPerTick?: number;
  maxPerTick?: number;
};

const priorityRank = (priority: TrackerPriority | null | undefined): number => {
  const index = PRIORITY_ORDER.findIndex((candidate) => candidate === priority);
  return index === -1 ? PRIORITY_ORDER.length : index;
};

const hasRootCauseLabel = (summary: TrackerItemSummary): boolean => Array.isArray(summary?.labels)
  && summary.labels.some((label) => label?.name === ROOT_CAUSE_LABEL);

const hasMechanismSection = (description: string | null | undefined): boolean => /(^|\n)##\s+Mechanism\b/.test(asNonEmptyString(description) ?? '');

const latestMarkerShortId = (item: TrackerItem): string | null => {
  const markers = (Array.isArray(item?.comments) ? item.comments : []).filter((comment) => {
    const body = asNonEmptyString(comment?.body) ?? '';
    const source = asNonEmptyString(comment?.author?.name) ?? '';
    return body.startsWith(MARKER_PREFIX) && body.includes(DISPATCH_ORIGIN) && /^session\s+\S+/.test(source);
  });
  const last = markers[markers.length - 1];
  const match = /^session\s+(\S+)/.exec(last?.author?.name ?? '');
  return match ? match[1] ?? null : null;
};

const sessionTitle = (identifier: string, title: string | null | undefined): string => `${identifier}: ${(asNonEmptyString(title) ?? '').replace(/\s+/g, ' ').trim()}`.trim();

const splitModel = (value: string | null | undefined): { providerID: string; id: string } | null => {
  const text = asNonEmptyString(value);
  if (!text) return null;
  return parseModelRef(text);
};

const isInteger = (value: unknown): value is number => Number.isInteger(value);

interface ErrorStatusCarrier {
  status?: unknown;
}

const statusOf = (error: Error | ErrorStatusCarrier): number | null => {
  if (!('status' in error)) return null;
  const status = error.status;
  return isInteger(status) ? status : null;
};

const readSessionId = (value: SessionIdCarrier | null | undefined): string | null => value?.data?.id ?? value?.id ?? null;

export const buildAutoDispatchPrompt = ({ identifier, title, projectPath }: { identifier: string; title: string | null | undefined; projectPath: string }): string => {
  const name = sessionTitle(identifier, title).replace(/^[^:]+:\s*/, '') || identifier;
  return [
    `You are working autonomously on one local issue: ${identifier} — ${name}`,
    `Project directory: ${projectPath}`,
    '',
    'A root cause for this issue has already been found and documented. Fix it end to end:',
    '',
    `1. Read the issue file for ${identifier} in this project's local issues directory (\`.issues/\` by default). It holds the full report: Symptom, Reproduce, Environment, Evidence and the documented \`## Mechanism\`.`,
    '2. Verify the documented Mechanism against the current code before fixing — line references may be stale. If it no longer matches the code, correct the Mechanism section in the issue file first, then continue from what the code actually shows.',
    '3. Set the issue\'s `state` to `in-progress` and bump `updatedAt` in the frontmatter as your first edit.',
    '4. Implement the smallest fix that removes the root cause, following the repository\'s own conventions. Run the narrowest check that covers the change (focused test, type-check, or build for the code you touched).',
    '5. Prove it: run the same reproduction the issue describes and confirm it no longer fails. Note what the proof covered and what it did not.',
    `6. Close the loop on the issue file: set \`state\` to \`done\`, bump \`updatedAt\`, and append your own comment entry (\`### <ISO timestamp> · <your role>\`) summarizing the fix and the proof. Write the entry yourself; never edit or copy entries written by others.`,
    '7. Never commit and never push. Finish with a one-paragraph summary of the change and ask the maintainer to review and commit.',
    '',
    'Rules:',
    `- Work only on ${identifier}. Skip any menu or confirmation step — no human is watching this session.`,
    '- If the fix turns out to be a product decision (a behavior someone must choose), stop: append a comment on the issue stating the question, set the state back to `triage`, and end with the question. Do not pick a side yourself.',
    '- Keep every issue-file edit inside the existing frontmatter and comment formats; nothing else in the issue file changes.',
  ].join('\n');
};

export function createIssueDispatcher({
  listProjects,
  getTracker,
  createClient,
  waitForOpenCodeReady = null,
  onSessionCreated = null,
  logger = console,
  tickIntervalMs = 10_000,
  startupDelayMs = 30_000,
  maxPerProjectPerTick = 1,
  maxPerTick = 3,
}: DispatcherDependencies) {
  const dispatched = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let ticking = false;

  const isKeyOf = (projectId: string, identifier: string): string => `${projectId}:${identifier}`;

  const sessionLiveness = async (client: SessionClient, sessionID: string): Promise<boolean | null> => {
    try {
      const session = await client.session.get({ sessionID });
      return Boolean(readSessionId(session));
    } catch (error) {
      if ((error instanceof Error || isPlainObject(error)) && statusOf(error) === 404) return false;
      logger.warn?.('[issue-dispatcher] session liveness unknown:', sessionID, error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  const recoverSessionByPrefix = async (client: SessionClient, shortId: string): Promise<string | null> => {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_SESSION_LIST_PAGES; page += 1) {
      const result = await client.session.list(cursor ? { cursor } : {});
      const sessions = Array.isArray(result?.data) ? result.data : [];
      const found = sessions.find((session) => (asNonEmptyString(session?.id) ?? '').startsWith(shortId));
      if (found) return found.id;
      cursor = sessions.length ? result?.cursor?.next ?? undefined : undefined;
      if (!cursor) return null;
    }
    return null;
  };

  const dispatchOne = async (tracker: DispatchTracker, project: DispatchProject, key: string, summary: TrackerItemSummary): Promise<boolean> => {
    const detail = await tracker.get(summary.identifier, project.id);
    const item = detail?.connected ? detail.item : null;
    if (!item) return false;
    if (!hasMechanismSection(item.description)) return false;

    const markerShortId = latestMarkerShortId(item);
    if (markerShortId) {
      const client = createClient({ directory: project.path });
      const recovered = await recoverSessionByPrefix(client, markerShortId);
      if (recovered) {
        dispatched.set(key, recovered);
        return false;
      }
    }

    const client = createClient({ directory: project.path });
    const model = splitModel(project.defaultModel);
    const payload: SessionPayload = {
      title: sessionTitle(summary.identifier, summary.title),
      location: { directory: project.path },
    };
    if (model) {
      const modelPayload: SessionModelPayload = { providerID: model.providerID, id: model.id };
      const variant = asNonEmptyString(project.defaultVariant);
      if (variant) modelPayload.variant = variant;
      payload.model = modelPayload;
    }
    const agent = asNonEmptyString(project.defaultAgent);
    if (agent) payload.agent = agent;
    const session = await client.session.create(payload);
    const sessionID = readSessionId(session);
    if (!sessionID) throw new Error('failed to create session');

    await tracker.sessionStatus.post({
      sessionId: sessionID,
      kind: 'started',
      identifier: summary.identifier,
      containerId: project.id,
      sessionOrigin: DISPATCH_ORIGIN,
    });
    dispatched.set(key, sessionID);

    await client.session.prompt({
      sessionID,
      text: buildAutoDispatchPrompt({
        identifier: summary.identifier,
        title: summary.title,
        projectPath: project.path,
      }),
    });

    onSessionCreated?.({
      sessionID,
      directory: project.path,
      createdAt: Date.now(),
      promptDispatched: true,
      dispatchedAsCommand: false,
      title: sessionTitle(summary.identifier, summary.title),
    });
    logger.info?.(`[issue-dispatcher] dispatched ${summary.identifier} (${project.id}) to session ${sessionID}`);
    return true;
  };

  const dispatchProject = async (tracker: DispatchTracker, project: DispatchProject): Promise<number> => {
    const list = await tracker.list({ state: 'todo', containerId: project.id });
    if (!list?.connected || !Array.isArray(list.items)) return 0;

    const summaries = list.items
      .filter((summary) => summary?.assignee?.name && hasRootCauseLabel(summary))
      .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority));

    let dispatchedCount = 0;
    for (const summary of summaries) {
      if (dispatchedCount >= maxPerProjectPerTick) break;
      const key = isKeyOf(project.id, summary.identifier);
      if (dispatched.has(key)) {
        const existing = dispatched.get(key);
        if (existing) {
          const client = createClient({ directory: project.path });
          const alive = await sessionLiveness(client, existing);
          if (alive !== false) continue;
        }
        dispatched.delete(key);
      }
      try {
        if (await dispatchOne(tracker, project, key, summary)) {
          dispatchedCount += 1;
        }
      } catch (error) {
        logger.warn?.(`[issue-dispatcher] dispatch failed for ${summary.identifier} (${project.id}):`, error instanceof Error ? error.message : String(error));
      }
    }
    return dispatchedCount;
  };

  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      const projects = (await listProjects() ?? []).filter((project) => project.autoDispatchIssues === true);
      if (projects.length === 0) return;
      if (waitForOpenCodeReady) await waitForOpenCodeReady();
      const tracker = await getTracker();
      if (!tracker) return;
      // SAFETY: the registry's local tracker implements container-scoped get and sessionStatus.post.
      const dispatchTracker = tracker as DispatchTracker;

      let dispatchedCount = 0;
      for (const project of projects) {
        if (dispatchedCount >= maxPerTick) break;
        try {
          dispatchedCount += await dispatchProject(dispatchTracker, project);
        } catch (error) {
          logger.warn?.(`[issue-dispatcher] project scan failed (${project.id}):`, error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      logger.warn?.('[issue-dispatcher] tick failed:', error instanceof Error ? error.message : String(error));
    } finally {
      ticking = false;
    }
  };

  return {
    tick,
    start() {
      if (timer || startupTimer) return;
      startupTimer = setTimeout(() => {
        startupTimer = null;
        timer = setInterval(() => { void tick(); }, tickIntervalMs);
        timer.unref?.();
        void tick();
      }, startupDelayMs);
      startupTimer.unref?.();
    },
    stop() {
      if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}
