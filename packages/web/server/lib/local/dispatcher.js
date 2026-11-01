/**
 * The issue auto-dispatch watcher: a web-server timer that turns assigned,
 * auto-fix-eligible local issues into managed OpenCode sessions. Design and
 * contract: `issue-local-spec/本地Issue自动修复决策方案.md` §9.
 *
 * Dispatch signal: state `todo` + assignee set + `root-cause:found` label +
 * a `## Mechanism` body section. The prompt seeds a single-issue autonomous
 * variant of the issue-work flow (no menu, no confirmation, never commits).
 *
 * The tracker used here must be the shared instance the session-status
 * runtime posts through (the registry caches implementations), so the
 * `started` post registers the session link and later `completed`/`failure`
 * events land on the issue as comments.
 */

import { asNonEmptyString } from '../shared/guards.js';

const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low'];
const ROOT_CAUSE_LABEL = 'root-cause:found';
const DISPATCH_ORIGIN = 'auto-dispatch';
const MARKER_PREFIX = 'Session started';
const MAX_SESSION_LIST_PAGES = 10;

const priorityRank = (priority) => {
  const index = PRIORITY_ORDER.indexOf(priority);
  return index === -1 ? PRIORITY_ORDER.length : index;
};

const hasRootCauseLabel = (summary) => Array.isArray(summary?.labels)
  && summary.labels.some((label) => label?.name === ROOT_CAUSE_LABEL);

const hasMechanismSection = (description) => /(^|\n)##\s+Mechanism\b/.test(asNonEmptyString(description) ?? '');

/**
 * The persisted dedupe marker is the `started` session-status comment ("Session
 * started — auto-dispatch"); its heading carries the short session id the
 * tracker wrote. Returns the newest marker's short id, or null.
 */
const latestMarkerShortId = (item) => {
  const markers = (Array.isArray(item?.comments) ? item.comments : []).filter((comment) => {
    const body = asNonEmptyString(comment?.body) ?? '';
    const source = asNonEmptyString(comment?.author?.name) ?? '';
    return body.startsWith(MARKER_PREFIX) && body.includes(DISPATCH_ORIGIN) && /^session\s+\S+/.test(source);
  });
  const last = markers[markers.length - 1];
  const match = /^session\s+(\S+)/.exec(last?.author?.name ?? '');
  return match ? match[1] : null;
};

/** A single-line session title: the issue identifier, then the issue title. */
const sessionTitle = (identifier, title) => `${identifier}: ${(asNonEmptyString(title) ?? '').replace(/\s+/g, ' ').trim()}`.trim();

export const buildAutoDispatchPrompt = ({ identifier, title, projectPath }) => {
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

/** @typedef {import('../trackers/tracker-contract').TrackerImplementation} TrackerImplementation */

/**
 * @param {object} deps
 * @param {() => Promise<Array<Record<string, unknown>>>} deps.listProjects the settings projects.
 * @param {() => Promise<TrackerImplementation | null>} deps.getTracker the shared local tracker.
 * @param {{ directory?: string }} deps.createClient a directory-scoped OpenCode client factory.
 * @param {() => Promise<void>} [deps.waitForOpenCodeReady]
 * @param {(event: { sessionID: string, directory: string, createdAt: string, promptDispatched: boolean, title: string }) => void} [deps.onSessionCreated]
 * @param {Console} [deps.logger]
 * @param {number} [deps.tickIntervalMs]
 * @param {number} [deps.startupDelayMs]
 * @param {number} [deps.maxPerProjectPerTick]
 * @param {number} [deps.maxPerTick]
 */
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
} = {}) {
  // Issue key → the session the watcher dispatched for it. In-memory: the
  // persisted marker on the issue file covers restarts (see recoverSession).
  const dispatched = new Map();
  let timer = null;
  let startupTimer = null;
  let ticking = false;

  const isKeyOf = (projectId, identifier) => `${projectId}:${identifier}`;

  // Alive → true. Gone (404) → false. Anything else (OpenCode briefly down,
  // auth blip) → null: the tick skips the issue rather than double-dispatching.
  const sessionLiveness = async (client, sessionID) => {
    try {
      const session = await client.session.get({ sessionID });
      return Boolean(session?.data?.id ?? session?.id);
    } catch (error) {
      if (error?.status === 404) return false;
      logger.warn?.('[issue-dispatcher] session liveness unknown:', sessionID, error?.message || error);
      return null;
    }
  };

  // After a server restart the in-memory map is empty and the marker comment
  // only carries the session id's short prefix, so liveness goes through the
  // session list. Bounded: a few pages are plenty for a recent session.
  const recoverSessionByPrefix = async (client, shortId) => {
    let cursor;
    for (let page = 0; page < MAX_SESSION_LIST_PAGES; page += 1) {
      const result = await client.session.list(cursor ? { cursor } : {});
      const sessions = Array.isArray(result?.data) ? result.data : [];
      const found = sessions.find((session) => (asNonEmptyString(session?.id) ?? '').startsWith(shortId));
      if (found) return found.id;
      cursor = sessions.length ? result?.cursor?.next : undefined;
      if (!cursor) return null;
    }
    return null;
  };

  const dispatchOne = async (tracker, project, key, summary) => {
    const detail = await tracker.get(summary.identifier, project.id);
    const item = detail?.connected ? detail.item : null;
    if (!item) return false;
    // Decision 6: only issues a root cause is already documented for; a
    // diagnosis-only issue stays on the board for a human.
    if (!hasMechanismSection(item.description)) return false;

    const markerShortId = latestMarkerShortId(item);
    if (markerShortId) {
      const client = createClient({ directory: project.path });
      const recovered = await recoverSessionByPrefix(client, markerShortId);
      if (recovered) {
        dispatched.set(key, recovered);
        return false;
      }
      // No live session behind the marker: fall through and redispatch.
    }

    const client = createClient({ directory: project.path });
    // Agent and model are session properties in v2, set at create time like
    // scheduled tasks do; a project without defaults leaves OpenCode's own.
    const modelRef = asNonEmptyString(project.defaultModel)?.split('/', 2) ?? null;
    const payload = {
      title: sessionTitle(summary.identifier, summary.title),
      location: { directory: project.path },
    };
    if (modelRef && modelRef.length === 2 && modelRef[0] && modelRef[1]) {
      payload.model = { providerID: modelRef[0], id: modelRef[1] };
      const variant = asNonEmptyString(project.defaultVariant);
      if (variant) payload.model.variant = variant;
    }
    const agent = asNonEmptyString(project.defaultAgent);
    if (agent) payload.agent = agent;
    const session = await client.session.create(payload);
    const sessionID = session?.data?.id ?? session?.id;
    if (!sessionID) throw new Error('failed to create session');

    // The marker and the link land before the prompt: if the prompt fails the
    // session still shows on the issue and the next tick does not duplicate it.
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
      createdAt: new Date().toISOString(),
      promptDispatched: true,
      title: sessionTitle(summary.identifier, summary.title),
    });
    logger.info?.(`[issue-dispatcher] dispatched ${summary.identifier} (${project.id}) to session ${sessionID}`);
    return true;
  };

  // One project: at most `maxPerProjectPerTick` sessions, highest priority
  // first, so a backlog drains one session per tick instead of bursting.
  const dispatchProject = async (tracker, project) => {
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
        const client = createClient({ directory: project.path });
        const alive = await sessionLiveness(client, dispatched.get(key));
        if (alive !== false) continue;
        dispatched.delete(key);
      }
      try {
        if (await dispatchOne(tracker, project, key, summary)) {
          dispatchedCount += 1;
        }
      } catch (error) {
        logger.warn?.(`[issue-dispatcher] dispatch failed for ${summary.identifier} (${project.id}):`, error?.message || error);
      }
    }
    return dispatchedCount;
  };

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const projects = (await listProjects()).filter((project) => project?.autoDispatchIssues === true);
      if (projects.length === 0) return;
      if (waitForOpenCodeReady) await waitForOpenCodeReady();
      const tracker = await getTracker();
      if (!tracker) return;

      let dispatchedCount = 0;
      for (const project of projects) {
        if (dispatchedCount >= maxPerTick) break;
        try {
          dispatchedCount += await dispatchProject(tracker, project);
        } catch (error) {
          logger.warn?.(`[issue-dispatcher] project scan failed (${project.id}):`, error?.message || error);
        }
      }
    } catch (error) {
      logger.warn?.('[issue-dispatcher] tick failed:', error?.message || error);
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
