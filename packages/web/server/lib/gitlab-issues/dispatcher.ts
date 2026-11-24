import fs from 'node:fs/promises';
import path from 'node:path';
import { parseGitLabRemoteUrl } from '../gitlab/repo.js';
import { isRecord, isString } from '../shared/guards.js';
import { parseModelRef } from '../shared/model-ref.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { SettingsProject } from '../settings/settings-normalization-runtime.js';
import type { AuthCredential, createSourceControlAuthStore } from '../source-control/auth-storage.js';
import type { registerSourceControlRoutes } from '../source-control/routes.js';
import type { BindingRead } from '../source-control/binding-service-contracts.js';
import type { createGitCredentialResolver, createHttpsCredentialReference } from '../git/credential-resolver.js';
import type { createOpenCodeClient } from '../openchamber-sessions/opencode-client.js';
import type { BootstrapStore } from '../git/service-contracts.js';
import {
  BLOCKED_REASONS, FEEDBACK_MAX_ROUNDS, FEEDBACK_MIN_ACCESS_LEVEL, PHASES, canTransition, isActivePhase,
} from './machine.js';
import {
  TemplateError, assistantText, buildIssueBranch, findAccountForUser, isBotNoteBody, labelNamesOf,
  matchReusableBranch, parseIssueTemplate, resolveAccount, resolveProjectConfig,
} from './gitlab.js';
import type { GitlabIssueApi } from './gitlab.js';
import { withBotNoteMarker } from './bot-notes.js';
import { createGitlabIssueLedger, ledgerKey } from './ledger.js';
import type {
  GitlabIssueLedger, RunEntry, RunEvent, RunSession, ChangeSummary,
  VerifyResult, ReviewHistoryEntry, FeedbackHistoryEntry,
} from './ledger.js';
import {
  AgentOutputError, buildFeedbackPrompt, buildImplementPrompt, buildPlanPrompt, buildReviewPrompt,
  buildTriagePrompt,
  formatBlockedComment, formatEvidenceComment,
  formatFeedbackPushComment, formatFindingLine, formatMrComment, formatOscillationComment,
  formatPlanComment, formatRecheckComment, formatRecordWriteComment, formatReviewComment, formatTriageComment,
  parseAgentOutput, sessionStageLabel,
} from './prompts.js';
import type { EvidenceResult, Finding, FeedbackLine } from './prompts.js';
import { recordLocationFor, writeRunRecord } from './record.js';
import { createFeedbackFlow } from './feedback-flow.js';
import { buildMrDescription } from './mr-description.js';
import type { IssueCredential } from './workspace.js';

const BUSY_LABELS = ['ai-working', 'ai-plan-review', 'ai-review', 'ai-blocked', 'ai-done'];

const DEFAULT_STARTUP_DELAY_MS = 30_000;
const DEFAULT_TICK_INTERVAL_MS = 10_000;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 2;
const REVIEW_MAX_REVISIONS = 3;
const VERIFY_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const SLOT_PHASES: readonly string[] = Object.freeze([
  PHASES.CLAIMED, PHASES.TRIAGING, PHASES.PLANNING, PHASES.WAITING_APPROVAL,
  PHASES.PREPARING, PHASES.IMPLEMENTING, PHASES.REVIEWING, PHASES.RECHECKING,
  PHASES.VERIFYING, PHASES.ADDRESSING,
]);

const SESSION_FAILED_DETAIL = '会话没有任何输出就结束了（常见原因：模型不可用、额度不足，或会话被中断）。';

const hasLabel = (issue: JsonObject | null | undefined, name: string) => labelNamesOf(issue).includes(name);

interface ErrorFields {
  message?: unknown;
  name?: unknown;
  code?: unknown;
  status?: unknown;
  response?: unknown;
  cause?: unknown;
  data?: unknown;
}

const isErrorFields = (error: unknown): error is ErrorFields => isRecord(error);
const errorFields = <Value>(error: Value): ErrorFields | null => (isErrorFields(error) ? error : null);
const responseStatus = <Value>(error: Value) => {
  const fields = errorFields(error);
  if (!fields) return undefined;
  const response = errorFields(fields.response);
  if (response?.status !== undefined) return response.status;
  const cause = errorFields(fields.cause);
  return errorFields(cause?.response)?.status;
};
const unauthorized = <Value>(error: Value) => responseStatus(error) === 401 || errorFields(error)?.status === 401;
const errorName = <Value>(error: Value): string | undefined => {
  const name = errorFields(error)?.name;
  return isString(name) ? name : undefined;
};
const errorCode = <Value>(error: Value) => errorFields(error)?.code;
const errorMessage = <Value>(error: Value) => {
  const message = errorFields(error)?.message;
  return isString(message) ? message : String(error);
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const isLoopbackHost = (hostname: string) => LOOPBACK_HOSTS.has(hostname) || hostname.startsWith('127.');

const endpointForRemote = (rawUrl: string | null | undefined) => {
  let url: URL;
  try {
    url = new URL(String(rawUrl ?? ''));
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const plainHttpAllowed = url.protocol === 'http:' && isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !plainHttpAllowed) return null;
  const secure = url.protocol === 'https:';
  return {
    protocol: secure ? 'https' : 'http',
    host: url.hostname,
    port: Number(url.port) || (secure ? 443 : 80),
    path: url.pathname,
  };
};

type Endpoint = NonNullable<ReturnType<typeof endpointForRemote>>;
type ProjectConfig = ReturnType<typeof resolveProjectConfig>;
type AuthStore = ReturnType<typeof createSourceControlAuthStore>;
type BindingService = ReturnType<typeof registerSourceControlRoutes>;
type CredentialResolver = ReturnType<typeof createGitCredentialResolver>;
type OpencodeClient = ReturnType<typeof createOpenCodeClient>;

interface ClientLike {
  session: {
    active(): Promise<JsonValue>;
    create(payload: JsonObject): Promise<JsonValue>;
    prompt(input: { sessionID: string; text: string }): Promise<JsonValue>;
    interrupt(input: { sessionID: string }): Promise<JsonValue>;
    get(input: { sessionID: string }): Promise<JsonValue>;
  };
  message: {
    list(input: { sessionID: string; limit: number; order: string }): Promise<JsonValue>;
  };
}

interface SessionCreatedLike {
  sessionID?: string | undefined;
  directory?: string | undefined;
  createdAt?: string | number | undefined;
  promptDispatched?: boolean | undefined;
  title?: string | undefined;
}

export interface DispatcherDependencies {
  listProjects: () => Promise<SettingsProject[]>;
  authStore: AuthStore;
  bindingService: BindingService;
  apiFactory: (input: { origin: string; account: AuthCredential }) => GitlabIssueApi;
  workspace: CreateGitlabIssueWorkspaceLike;
  clientFactory: (input: { directory: string }) => OpencodeClient;
  credentialResolver: CredentialResolver;
  createHttpsCredentialReference: typeof createHttpsCredentialReference;
  worktreeBootstrapStore?: BootstrapStore | null | undefined;
  resolveWorktreeSetup?: ((project: SettingsProject) => Promise<{ startCommand: string }>) | null | undefined;
  worktreeSetupState?: ((input: { directory: string; bootstrapStore: BootstrapStore | null }) => Promise<'ready' | 'pending' | 'failed'>) | null | undefined;
  waitForOpenCodeReady?: ((...args: never[]) => Promise<void>) | null | undefined;
  onSessionCreated?(event: SessionCreatedLike): void;
  logger?: Pick<Console, 'warn'> | undefined;
  now?: (() => number) | undefined;
  tickIntervalMs?: number | undefined;
  startupDelayMs?: number | undefined;
  issueScanEveryTicks?: number | undefined;
  maxPerProjectPerTick?: number | undefined;
  maxPerTick?: number | undefined;
  maxActivePerProject?: number | undefined;
  maxActiveGlobal?: number | undefined;
  leaseMs?: number | undefined;
  contextTtlMs?: number | undefined;
  ledger?: GitlabIssueLedger | undefined;
  ledgerPath?: string | undefined;
  writeRecord?: ((input: {
    run: RunEntry; checkoutPath: string; excludePath: string | null;
  }) => Promise<{ path: string; written: boolean }>) | undefined;
}

interface CredentialRequestLike {
  mode: string;
  credentialId: string;
  endpoint: Endpoint | undefined;
  operationId: string;
  deadline: string | number;
}

interface WorkspaceCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface CreateGitlabIssueWorkspaceLike {
  fetchBranch(input: { cwd: string; remote: string; branch: string; credential: IssueCredential }): Promise<WorkspaceCommandResult>;
  localBranchExists(input: { cwd: string; branch: string }): Promise<boolean>;
  createWorktreeFor(input: {
    repoPath: string; branch: string; worktreeName: string; startRef?: string | undefined;
    mode?: string | undefined; bootstrapStore?: BootstrapStore | null | undefined; startCommand?: string | null | undefined;
  }): Promise<{ path: string }>;
  configureIdentity(input: { cwd: string; name: string; email: string }): Promise<void>;
  commitCountSince(input: { cwd: string; baseRef: string }): Promise<number>;
  hasDiffSince(input: { cwd: string; baseRef: string }): Promise<boolean>;
  pushBranch(input: { cwd: string; remote: string; branch: string; credential: IssueCredential }): Promise<{ branch: string; sha: string }>;
  removeWorktreeSafely(input: { repoPath: string; worktreePath: string | null | undefined }): Promise<{ removed: boolean; dirty: boolean }>;
  run(args: string[], options?: { cwd?: string | undefined }): Promise<WorkspaceCommandResult>;
  runVerifyCommand(input: { cwd: string; command: string; timeoutMs: number }): Promise<WorkspaceCommandResult>;
  describeChanges(input: { cwd: string; baseRef: string }): Promise<ChangeSummary | null>;
}

export interface DispatchContext {
  project: SettingsProject;
  config: ProjectConfig;
  instance: string;
  primaryRemote: string;
  remoteUrl: string;
  endpoint: Endpoint | null;
  projectPath: string;
  projectId: string | number;
  defaultBranch: string | null;
  botAccount: AuthCredential;
  botUsername: string;
  api: GitlabIssueApi;
}

type SessionResult =
  | { status: 'busy' }
  | { status: 'failed' }
  | { status: 'idle'; text: string; completedAt: number };

const isJsonRecord = (value: unknown): value is JsonObject => isRecord(value);
const isInteger = (value: unknown): value is number => Number.isInteger(value);
const asId = (value: JsonValue | undefined): string | number => (isString(value) || isInteger(value) ? value : 0);
const asIid = (value: JsonValue | undefined): number => (isInteger(value) ? value : 0);
const asText = (value: JsonValue | null | undefined) => (isString(value) ? value : '');

const MAX_TRIAGE_COMMENTS = 20;
const readIssueComments = (notes: JsonObject[]): FeedbackLine[] => (Array.isArray(notes) ? notes : [])
  .filter((note) => isJsonRecord(note) && isInteger(note.id) && note.system !== true
    && !isBotNoteBody(asText(note.body)))
  .slice(-MAX_TRIAGE_COMMENTS)
  .map((note) => {
    const author = isJsonRecord(note.author) ? note.author : null;
    return {
      author: isString(author?.username) ? author.username : 'unknown',
      text: asText(note.body),
    };
  })
  .filter((item) => item.text.trim().length > 0);

export function createGitlabIssueDispatcher(dependencies: DispatcherDependencies) {
  const {
    listProjects,
    authStore,
    bindingService,
    apiFactory,
    workspace,
    clientFactory,
    credentialResolver,
    createHttpsCredentialReference,
    worktreeBootstrapStore = null,
    resolveWorktreeSetup = null,
    worktreeSetupState = null,
    waitForOpenCodeReady = null,
    onSessionCreated,
    logger = console,
    now = Date.now,
    tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
    startupDelayMs = DEFAULT_STARTUP_DELAY_MS,
    issueScanEveryTicks = 3,
    maxPerProjectPerTick = 1,
    maxPerTick = 3,
    maxActivePerProject = 1,
    maxActiveGlobal = 3,
    leaseMs = DEFAULT_LEASE_MS,
    contextTtlMs = 60_000,
    ledger = createGitlabIssueLedger({ filePath: dependencies.ledgerPath, now }),
    writeRecord = writeRunRecord,
  } = dependencies;

  let timer: ReturnType<typeof setInterval> | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let ticking = false;
  let stopped = false;
  let tickCount = 0;
  let recovered = false;
  const contextCache = new Map<string, { at: number; signature: string; context: DispatchContext }>();

  const isoNow = () => new Date(now()).toISOString();
  const keyOf = (run: RunEntry) => ledgerKey(run.origin, run.projectId, run.iid);
  const slotRuns = (runs: RunEntry[]) => runs.filter((run) => SLOT_PHASES.includes(run.phase));
  const warn = <Value>(message: string, error?: Value) => logger.warn?.(message, errorFields(error)?.message || error);

  const touch = (run: RunEntry) => ledger.update(keyOf(run), {
    leaseUntil: new Date(now() + leaseMs).toISOString(),
  });

  const MAX_RUN_EVENTS = 20;
  const withEvents = (run: RunEntry, events: RunEvent[]): RunEvent[] => [
    ...(Array.isArray(run.events) ? run.events : []),
    ...events,
  ].slice(-MAX_RUN_EVENTS);
  const withEvent = (run: RunEntry, event: RunEvent) => withEvents(run, [event]);

  const MAX_RUN_SESSIONS = 20;
  const withSession = (run: RunEntry, session: RunSession): RunSession[] => [
    ...(Array.isArray(run.sessions) ? run.sessions : []),
    session,
  ].slice(-MAX_RUN_SESSIONS);

  const REVIEW_HISTORY_MAX = 10;
  const FEEDBACK_HISTORY_MAX = 5;
  const FEEDBACK_ITEM_COUNT_MAX = 50;
  const FEEDBACK_ITEM_MAX = 2000;
  const VERIFY_OUTPUT_TAIL = 4000;

  const appendReviewHistory = (run: RunEntry, entry: Omit<ReviewHistoryEntry, 'seq'>): ReviewHistoryEntry[] => {
    const history: ReviewHistoryEntry[] = Array.isArray(run.reviewHistory) ? run.reviewHistory : [];
    const lastSeq = history.reduce((max, item) => Math.max(max, item.seq), 0);
    return [...history, { ...entry, seq: lastSeq + 1 }].slice(-REVIEW_HISTORY_MAX);
  };

  const appendFeedbackHistory = (run: RunEntry, entry: FeedbackHistoryEntry): FeedbackHistoryEntry[] => {
    const history: FeedbackHistoryEntry[] = Array.isArray(run.feedbackHistory) ? run.feedbackHistory : [];
    const items = entry.items.slice(0, FEEDBACK_ITEM_COUNT_MAX).map((item) => ({
      author: item.author,
      text: item.text.slice(0, FEEDBACK_ITEM_MAX),
    }));
    return [...history, { ...entry, items }].slice(-FEEDBACK_HISTORY_MAX);
  };

  const captureChanges = async (run: RunEntry, context: DispatchContext): Promise<Partial<Pick<RunEntry, 'changeSummary'>>> => {
    if (!run.worktreePath) return {};
    const baseRef = `${context.primaryRemote}/${run.targetBranch ?? ''}`;
    const summary = await workspace.describeChanges({ cwd: run.worktreePath, baseRef })
      .catch(() => null);
    return summary ? { changeSummary: summary } : {};
  };

  const excludePathFor = async (checkoutPath: string): Promise<string | null> => {
    try {
      const result = await workspace.run(['rev-parse', '--git-path', 'info/exclude'], { cwd: checkoutPath });
      if (result.code !== 0) return null;
      const answer = String(result.stdout ?? '').trim();
      if (!answer) return null;
      return path.isAbsolute(answer) ? answer : path.join(checkoutPath, answer);
    } catch {
      return null;
    }
  };

  const writeRecordFor = async (run: RunEntry, checkoutPath: string) => {
    const excludePath = await excludePathFor(checkoutPath);
    return writeRecord({ run, checkoutPath, excludePath });
  };

  const writeRecordBestEffort = async (run: RunEntry, checkoutPath: string) => {
    try {
      await writeRecordFor(run, checkoutPath);
    } catch (error) {
      warn(`[gitlab-issues] delivery record write failed for #${run.iid}:`, error);
    }
  };

  const transition = async (run: RunEntry, to: string, patch: Partial<RunEntry> = {}) => {
    if (!canTransition(run.phase, to)) throw new Error(`Illegal transition ${run.phase} -> ${to}`);
    return ledger.update(keyOf(run), {
      phase: to,
      since: isoNow(),
      lastError: null,
      leaseUntil: new Date(now() + leaseMs).toISOString(),
      events: withEvent(run, { at: isoNow(), kind: 'phase', from: run.phase, to }),
      ...patch,
    });
  };

  const block = async (run: RunEntry, reason: string, detail = '', patch: Partial<RunEntry> = {}) => ledger.update(keyOf(run), {
    phase: PHASES.BLOCKED,
    blockedReason: reason,
    events: withEvent(run, {
      kind: 'blocked',
      from: run.phase === PHASES.BLOCKED ? (run.blockedFrom ?? null) : run.phase,
      reason,
      detail: isString(detail) && detail.trim() ? detail.trim().slice(0, 240) : null,
    }),
    blockedFrom: run.phase === PHASES.BLOCKED ? (run.blockedFrom ?? null) : run.phase,
    lastError: detail || null,
    since: isoNow(),
    leaseUntil: null,
    ...patch,
  });

  const cleanupWorktree = async (run: RunEntry, context: DispatchContext, note: string | null = null) => {
    if (!run.worktreePath) return null;
    let cleanup;
    try {
      cleanup = await workspace.removeWorktreeSafely({
        repoPath: context.project.path,
        worktreePath: run.worktreePath,
      });
    } catch (error) {
      warn(`[gitlab-issues] worktree cleanup failed for #${run.iid}:`, error);
      return run.worktreePath;
    }
    if (cleanup.dirty) {
      if (note) {
        await context.api.postNote(run.projectId, run.iid, note)
          .catch((error) => warn(`[gitlab-issues] cleanup note failed for #${run.iid}:`, error));
      }
      return run.worktreePath;
    }
    if (!cleanup.removed) {
      warn(`[gitlab-issues] worktree still on disk for #${run.iid}: ${run.worktreePath}`);
      return run.worktreePath;
    }
    return null;
  };

  const blockWithComment = async (run: RunEntry, context: DispatchContext, reason: string, detail: string, patch: Partial<RunEntry> = {}) => {
    const changes = await captureChanges(run, context);
    const retained = await cleanupWorktree(
      run,
      context,
      `工作区有未提交改动，已保留：\`${run.worktreePath}\``,
    );
    const next = await block(run, reason, detail, { ...changes, ...patch, worktreePath: retained });
    await context.api.addLabels(run.projectId, run.iid, ['ai-blocked'])
      .catch((error) => warn(`[gitlab-issues] ai-blocked label failed for #${run.iid}:`, error));
    await context.api
      .removeLabels(run.projectId, run.iid, ['ai-working', 'ai-plan-review', 'ai-review'])
      .catch((error) => warn(`[gitlab-issues] working label clear failed for #${run.iid}:`, error));
    await context.api.postNote(run.projectId, run.iid, formatBlockedComment(reason, detail))
      .catch((error) => warn(`[gitlab-issues] blocked note failed for #${run.iid}:`, error));
    return next;
  };

  const feedbackFlow = createFeedbackFlow({
    ledger,
    keyOf,
    appendFeedbackHistory,
    transition,
    blockWithComment,
    errorName,
    warn,
    isoNow,
  });

  const failRun = async (
    run: RunEntry,
    context: DispatchContext,
    reason: string,
    detail: string,
    patch: Partial<RunEntry> = {},
  ) => {
    const repeated = Boolean(run.lastError) && run.lastError === detail;
    const exhausted = (run.attempts ?? 0) >= MAX_ATTEMPTS;
    const nextReason = repeated || exhausted ? BLOCKED_REASONS.REPEATED_ERROR : reason;
    return blockWithComment(run, context, nextReason, detail, { attempts: run.attempts ?? 0, ...patch });
  };

  const markBotUnauthorized = async (context: DispatchContext) => {
    contextCache.delete(context.project.id);
    try {
      await authStore.markAccountInvalid(context.instance, context.botAccount.credentialId);
      logger.warn?.(`[gitlab-issues] bot account refused for project ${context.project.id}; marked invalid and dispatch paused`);
    } catch (error) {
      warn(`[gitlab-issues] bot account refused for project ${context.project.id}; could not mark it invalid:`, error);
    }
  };

  const resolveContext = async (project: SettingsProject, config: ProjectConfig): Promise<DispatchContext | null> => {
    const bindingRead: BindingRead | null = await bindingService.get(project.path);
    const binding = bindingRead?.binding;
    if (!binding) return null;
    const provider = (binding.providers ?? []).find((entry) => entry?.provider === 'gitlab'
      && entry.readiness === 'ready');
    if (!provider?.instance) return null;
    const primaryRemote = provider.primaryRemote;
    const remote = (bindingRead.repository?.remotes ?? []).find((entry) => entry?.name === primaryRemote);
    const remoteUrl = asText(remote?.fetch?.displayUrl ?? provider.endpoint?.displayUrl ?? '');
    const parsed = parseGitLabRemoteUrl(remoteUrl, provider.instance);
    if (!parsed) return null;
    const botAccount = await resolveAccount(authStore, provider.instance, config.botAccountId);
    if (!botAccount) {
      logger.warn?.(`[gitlab-issues] bot account unusable for project ${project.id}`);
      return null;
    }
    const api = withBotNoteMarker(apiFactory({ origin: provider.instance, account: botAccount }));
    let botUser: JsonObject | null;
    let projectInfo: JsonObject;
    try {
      botUser = await api.currentUser();
      projectInfo = await api.getProject(parsed.projectPath);
    } catch (error) {
      if (unauthorized(error)) {
        // SAFETY: this partial context is only read by markBotUnauthorized for account invalidation.
        await markBotUnauthorized({ project, instance: provider.instance, botAccount } as DispatchContext);
      }
      throw error;
    }
    return {
      project,
      config,
      instance: provider.instance,
      primaryRemote,
      remoteUrl,
      endpoint: endpointForRemote(remoteUrl),
      projectPath: parsed.projectPath,
      projectId: asId(projectInfo.id),
      defaultBranch: isString(projectInfo.default_branch) ? projectInfo.default_branch : null,
      botAccount,
      botUsername: asText(botUser?.username),
      api,
    };
  };

  const resolveActor = async (run: RunEntry) => {
    const account = await resolveAccount(authStore, run.origin, run.actorAccountId);
    if (!account) return null;
    return { account, api: apiFactory({ origin: run.origin, account }) };
  };

  const credentialFor = async (context: DispatchContext, account: AuthCredential): Promise<IssueCredential> => {
    const deadline: string | number = new Date(now() + 60_000).toISOString();
    const request: CredentialRequestLike = {
      mode: 'managed',
      credentialId: createHttpsCredentialReference({
        provider: 'gitlab',
        instance: context.instance,
        credentialId: account.credentialId,
        credentialRevision: account.credentialRevision,
        providerUserId: account.providerUserId,
      }),
      endpoint: context.endpoint ?? undefined,
      operationId: `gitlab-issue-${context.projectId}`,
      deadline,
    };
    // SAFETY: the fork passes an ISO deadline; managed HTTPS resolution does not read it.
    const resolved = await credentialResolver.resolve(request as Parameters<CredentialResolver['resolve']>[0]);
    // SAFETY: the managed reference above always resolves to an HTTPS credential.
    return resolved as IssueCredential;
  };

  const sessionClient = (run: RunEntry): ClientLike => {
    // SAFETY: OpenCode client replies are JSON-shaped; only ids and text records are read here.
    return clientFactory({ directory: run.worktreePath ?? '' }) as ClientLike;
  };

  const readSessionResult = async (client: ClientLike, sessionID: string): Promise<SessionResult> => {
    const response = await client.session.active();
    const active = isJsonRecord(response) && isJsonRecord(response.data) ? response.data : response;
    if (isJsonRecord(active) && Object.hasOwn(active, sessionID)) return { status: 'busy' };
    const listed = await client.message.list({ sessionID, limit: 50, order: 'desc' });
    const records = (isJsonRecord(listed) && Array.isArray(listed.data) ? listed.data : [])
      .map((item) => (isJsonRecord(item) ? item : {}));
    const latestAssistant = records.find((record) => record?.type === 'assistant');
    if (!latestAssistant) {
      return { status: records.some((record) => record?.type === 'idle') ? 'failed' : 'busy' };
    }
    const time = isJsonRecord(latestAssistant?.time) ? latestAssistant.time : null;
    const finishedAt = isInteger(time?.completed) ? time.completed : null;
    if (!finishedAt) return { status: 'busy' };
    const assistant = records.find((record) => record?.type === 'assistant' && assistantText(record).length > 0);
    return {
      status: 'idle',
      text: assistantText(assistant),
      completedAt: finishedAt,
    };
  };

  const sessionFinished = (run: RunEntry, result: SessionResult) => result.status === 'idle'
    && Number.isFinite(result.completedAt)
    && result.completedAt >= Date.parse(run.since ?? '');

  const sessionFailed = (run: RunEntry, result: SessionResult) => result.status === 'failed'
    || (sessionFinished(run, result) && !String(result.status === 'idle' ? result.text : '').trim());

  const worktreeSetupCommand = async (project: SettingsProject) => {
    if (!resolveWorktreeSetup) return '';
    try {
      const setup = await resolveWorktreeSetup(project);
      return String(setup?.startCommand ?? '').trim();
    } catch (error) {
      warn(`[gitlab-issues] worktree setup could not be resolved for ${project.path}:`, error);
      return '';
    }
  };

  const ensureWorktree = async (run: RunEntry, context: DispatchContext): Promise<RunEntry> => {
    if (run.worktreePath) return run;
    if (!context.endpoint) {
      return blockWithComment(
        run, context, BLOCKED_REASONS.MISSING_CREDENTIAL,
        '主远端不是 HTTPS 地址，无法使用一次性凭据租约推送。',
      );
    }
    const actor = await resolveAccount(authStore, run.origin, run.actorAccountId);
    if (!actor) {
      return blockWithComment(run, context, BLOCKED_REASONS.MISSING_CREDENTIAL, '触发者账号不可用。');
    }
    const actorApi = apiFactory({ origin: run.origin, account: actor });
    let actorUser: JsonObject | null;
    try {
      actorUser = await actorApi.currentUser();
    } catch (error) {
      if (unauthorized(error)) {
        return blockWithComment(run, context, BLOCKED_REASONS.MISSING_CREDENTIAL, '触发者账号已失效。');
      }
      throw error;
    }
    const email = isString(actorUser?.email) ? actorUser.email.trim() : '';
    if (!email) {
      return blockWithComment(
        run, context, BLOCKED_REASONS.MISSING_CREDENTIAL,
        '触发者账号没有可见邮箱，无法写入提交身份。',
      );
    }

    let recorded: RunEntry | null = null;
    try {
      const existing = matchReusableBranch(
        await context.api.listBranches(run.projectId, `issue-${run.iid}`),
        context.config.prefix,
        run.iid,
      );
      const base = existing ?? run.targetBranch;
      if (base !== run.targetBranch) {
        const botCredential = await credentialFor(context, context.botAccount);
        await workspace.fetchBranch({
          cwd: context.project.path, remote: context.primaryRemote, branch: base ?? '', credential: botCredential,
        });
      }
      const botCredential = await credentialFor(context, context.botAccount);
      await workspace.fetchBranch({
        cwd: context.project.path, remote: context.primaryRemote, branch: run.targetBranch ?? '', credential: botCredential,
      });

      const branchExists = await workspace.localBranchExists({
        cwd: context.project.path, branch: run.branch ?? '',
      });
      const worktree = await workspace.createWorktreeFor({
        repoPath: context.project.path,
        branch: run.branch ?? '',
        worktreeName: `gitlab-issue-${run.iid}`,
        startRef: `${context.primaryRemote}/${base}`,
        mode: branchExists ? 'existing' : 'new',
        bootstrapStore: worktreeBootstrapStore,
        startCommand: await worktreeSetupCommand(context.project),
      });
      recorded = await ledger.update(keyOf(run), {
        worktreePath: worktree.path,
        since: isoNow(),
        leaseUntil: new Date(now() + leaseMs).toISOString(),
      });
      await workspace.configureIdentity({
        cwd: worktree.path,
        name: asText(actorUser?.name ?? actorUser?.username),
        email,
      });
      return recorded;
    } catch (error) {
      if (errorName(error) !== 'WorkspaceError') throw error;
      const current = recorded ?? run;
      if (errorCode(error) === 'signing-required') {
        return blockWithComment(
          current, context, BLOCKED_REASONS.MISSING_CREDENTIAL,
          '目标仓库要求签名提交，但服务端没有触发者的签名密钥。',
        );
      }
      return failRun(current, context, BLOCKED_REASONS.VERIFICATION_FAILED, errorMessage(error));
    }
  };

  const startSession = async (run: RunEntry, context: DispatchContext, stage: string): Promise<RunEntry> => {
    if (stage !== 'review' && stage !== 'recheck' && (run.attempts ?? 0) >= MAX_ATTEMPTS) {
      return failRun(run, context, BLOCKED_REASONS.REPEATED_ERROR, 'Attempt limit reached');
    }
    let setupState: 'ready' | 'pending' | 'failed' = 'ready';
    if (worktreeSetupState) {
      try {
        setupState = (await worktreeSetupState({
          directory: run.worktreePath ?? '',
          bootstrapStore: worktreeBootstrapStore,
        })) ?? 'ready';
      } catch (error) {
        warn(`[gitlab-issues] worktree setup state unreadable for #${run.iid}:`, error);
      }
    }
    if (setupState === 'pending') return run;
    if (setupState === 'failed') {
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, '工作树 setup 失败，依赖没有装好。');
    }
    const client = sessionClient(run);
    const issue = await context.api.getIssue(run.projectId, run.iid);
    const triageComments = stage === 'triage'
      ? await context.api.listNotes(run.projectId, run.iid ?? 0)
        .then(readIssueComments)
        .catch((error) => {
          warn(`[gitlab-issues] comment read failed for #${run.iid}:`, error);
          return null;
        })
      : null;
    const actor = await resolveAccount(authStore, run.origin, run.actorAccountId);
    if (!actor) {
      return blockWithComment(run, context, BLOCKED_REASONS.MISSING_CREDENTIAL, '触发者账号不可用。');
    }
    const title = `#${run.iid}: ${String(issue?.title ?? '').replace(/\s+/g, ' ').trim()} · ${sessionStageLabel(stage, run.feedbackRounds)}`;
    const payload: JsonObject = {
      title,
      location: { directory: run.worktreePath },
      metadata: {
        hidden: true,
        openchamber: {
          kind: 'gitlab-automation',
          origin: run.origin,
          projectEntryId: run.projectEntryId ?? null,
          iid: run.iid,
        },
      },
    };
    const usesReviewModel = (stage === 'review' || stage === 'recheck') && Boolean(context.config.reviewModel);
    const modelValue = isString(usesReviewModel ? context.config.reviewModel : context.project.defaultModel)
      ? String(usesReviewModel ? context.config.reviewModel : context.project.defaultModel).trim()
      : '';
    const modelRef = parseModelRef(modelValue);
    if (modelRef) {
      payload.model = { providerID: modelRef.providerID, id: modelRef.id };
      const variant = usesReviewModel
        ? (context.config.reviewVariant || context.project.defaultVariant)
        : context.project.defaultVariant;
      if (variant) {
        const model = isJsonRecord(payload.model) ? payload.model : {};
        model.variant = variant;
      }
    }
    const stageAgent = (stage === 'review' || stage === 'recheck') && context.config.reviewAgent
      ? context.config.reviewAgent
      : context.project.defaultAgent ?? '';
    if (stageAgent) payload.agent = stageAgent;
    const session = await client.session.create(payload);
    const sessionData = isJsonRecord(session) ? session : null;
    const sessionID = asText(isJsonRecord(sessionData?.data) ? sessionData.data.id : sessionData?.id);
    if (!sessionID) throw new Error('failed to create session');
    const nextPhase = stage === 'triage' ? PHASES.TRIAGING
      : stage === 'plan' ? PHASES.PLANNING
        : stage === 'review' ? PHASES.REVIEWING
          : stage === 'recheck' ? PHASES.RECHECKING
            : stage === 'feedback' ? PHASES.ADDRESSING : PHASES.IMPLEMENTING;
    await ledger.update(keyOf(run), {
      sessionId: sessionID,
      sessions: withSession(run, { sessionId: sessionID, stage: nextPhase, at: isoNow() }),
      phase: nextPhase,
      since: isoNow(),
      attempts: stage === 'triage' || stage === 'review' || stage === 'recheck' || stage === 'feedback'
        ? (run.attempts ?? 0) : (run.attempts ?? 0) + 1,
      leaseUntil: new Date(now() + leaseMs).toISOString(),
      events: withEvents(run, [
        { at: isoNow(), kind: 'phase', from: run.phase, to: nextPhase },
        { at: isoNow(), kind: 'session', phase: nextPhase },
      ]),
    });
    const text = stage === 'triage'
      ? buildTriagePrompt({
        issue: {
          title: isString(issue?.title) ? issue.title : null,
          description: isString(issue?.description) ? issue.description : null,
          comments: triageComments,
        },
        iid: run.iid,
        projectPath: run.worktreePath ?? '',
        actorLogin: asText(actor.user.login),
        kind: run.kind,
      })
      : stage === 'plan'
        ? buildPlanPrompt({
          issue, iid: run.iid, projectPath: run.worktreePath ?? '', actorLogin: asText(actor.user.login),
        })
        : stage === 'review'
        ? buildReviewPrompt({
          issue,
          iid: run.iid,
          projectPath: run.worktreePath ?? '',
          actorLogin: asText(actor.user.login),
          baseRef: `${context.primaryRemote}/${run.targetBranch}`,
          evidence: run.evidence,
          feedbackItems: run.feedbackItems,
        })
        : stage === 'recheck'
        ? buildReviewPrompt({
          issue,
          iid: run.iid,
          projectPath: run.worktreePath ?? '',
          actorLogin: asText(actor.user.login),
          baseRef: `${context.primaryRemote}/${run.targetBranch}`,
          evidence: null,
          feedbackItems: null,
          secondOpinion: true,
        })
        : stage === 'feedback'
          ? buildFeedbackPrompt({
            issue,
            iid: run.iid,
            projectPath: run.worktreePath ?? '',
            actorLogin: asText(actor.user.login),
            branch: run.branch ?? '',
            targetBranch: run.targetBranch ?? '',
            baseRef: `${context.primaryRemote}/${run.targetBranch}`,
            feedbackItems: run.feedbackItems ?? [],
            round: run.feedbackRounds ?? 1,
            maxRounds: FEEDBACK_MAX_ROUNDS,
          })
          : buildImplementPrompt({
          issue,
          iid: run.iid,
          projectPath: run.worktreePath ?? '',
          actorLogin: asText(actor.user.login),
          branch: run.branch ?? '',
          targetBranch: run.targetBranch ?? '',
          reviewFindings: run.reviewFindings,
        });
    try {
      await client.session.prompt({ sessionID, text });
    } catch (error) {
      await client.session.interrupt({ sessionID }).catch(() => {});
      await ledger.update(keyOf(run), { sessionId: null }).catch(() => {});
      throw error;
    }
    onSessionCreated?.({
      sessionID,
      directory: run.worktreePath ?? '',
      createdAt: isoNow(),
      promptDispatched: true,
      title,
    });
    // SAFETY: the run was just persisted under this key, so the ledger lookup yields a RunEntry.
    return ledger.get(keyOf(run)) as Promise<RunEntry>;
  };

  const claim = async (context: DispatchContext, issue: JsonObject): Promise<boolean> => {
    const fresh = await context.api.getIssue(context.projectId, asIid(issue?.iid));
    const labels = labelNamesOf(fresh);
    if (fresh.state !== 'opened' || !labels.includes('ai-ready')
      || labels.some((label) => BUSY_LABELS.includes(label))) return false;
    const key = ledgerKey(context.instance, context.projectId, asIid(fresh.iid));
    if (await ledger.get(key)) return false;

    const baseEntry: RunEntry = {
      origin: context.instance,
      projectEntryId: context.project.id,
      projectId: context.projectId,
      projectPath: context.projectPath,
      title: isString(fresh.title) ? fresh.title : null,
      iid: asIid(fresh.iid),
      kind: null,
      phase: PHASES.BLOCKED,
      targetBranch: '',
      branch: '',
      actorUserId: null,
      actorAccountId: null,
      sessionId: null,
      sessions: [],
      worktreePath: null,
      mrIid: null,
      attempts: 0,
      leaseUntil: null,
      since: isoNow(),
      updatedAt: isoNow(),
      lastError: null,
      blockedReason: null,
      blockedFrom: null,
      triageVerdict: null,
      triageNoteId: null,
      triage: null,
      outcome: null,
      approvalNoteId: null,
      planNoteId: null,
      plan: null,
      evidenceNoteId: null,
      evidence: null,
      reviewRounds: 0,
      reviewNoteId: null,
      reviewVerdict: null,
      reviewFindings: null,
      reviewImpact: null,
      recheckVerdict: null,
      recheckNoteId: null,
      rechecked: false,
      feedbackRounds: 0,
      lastFeedbackActor: null,
      feedbackItems: null,
      noteWatermarks: null,
    };

    let template: ReturnType<typeof parseIssueTemplate>;
    try {
      template = parseIssueTemplate(fresh);
    } catch (error) {
      if (!(error instanceof TemplateError)) throw error;
      await context.api.addLabels(context.projectId, asIid(fresh.iid), ['ai-blocked']).catch(() => {});
      await context.api.postNote(
        context.projectId,
        asIid(fresh.iid),
        `自动化已暂停，原因：\`${error.reason}\`。请按模板补充 \`类型:\` 和 \`目标分支:\` 行后重新添加 \`ai-ready\`。`,
      ).catch(() => {});
      await ledger.put({
        ...baseEntry,
        blockedReason: error.reason,
        lastError: error.message,
      });
      return false;
    }

    const targetBranch = template.targetBranch || asText(context.defaultBranch);
    try {
      await context.api.showBranch(context.projectId, targetBranch);
    } catch {
      await context.api.addLabels(context.projectId, asIid(fresh.iid), ['ai-blocked']).catch(() => {});
      await context.api.postNote(
        context.projectId,
        asIid(fresh.iid),
        `自动化已暂停，原因：\`branch-missing\`。目标分支 \`${targetBranch}\` 不存在。`,
      ).catch(() => {});
      await ledger.put({
        ...baseEntry,
        kind: template.kind,
        targetBranch,
        blockedReason: BLOCKED_REASONS.BRANCH_MISSING,
        lastError: `Target branch does not exist: ${targetBranch}`,
      });
      return false;
    }

    let triggerer: { userId: number } | null;
    try {
      triggerer = await context.api.latestTriggerer(context.projectId, asIid(fresh.iid));
    } catch (error) {
      if (unauthorized(error)) throw error;
      await context.api.addLabels(context.projectId, asIid(fresh.iid), ['ai-blocked']).catch(() => {});
      await context.api.postNote(
        context.projectId,
        asIid(fresh.iid),
        '自动化已暂停，原因：`label-events-unavailable`。该实例读不到 `ai-ready` 的标签事件，无法确认触发者。',
      ).catch(() => {});
      await ledger.put({
        ...baseEntry,
        kind: template.kind,
        targetBranch,
        phase: PHASES.BLOCKED,
        blockedFrom: PHASES.CLAIMED,
        blockedReason: BLOCKED_REASONS.LABEL_EVENTS_UNAVAILABLE,
        since: isoNow(),
        lastError: isString(errorFields(error)?.message) ? String(errorFields(error)?.message) : 'Label events are unavailable',
      });
      return false;
    }
    const actor = triggerer
      ? await findAccountForUser(authStore, context.instance, triggerer.userId)
      : null;
    const accessLevel = triggerer ? await context.api.accessLevelOf(context.projectId, triggerer.userId) : 0;
    if (!triggerer || !actor || accessLevel < 30) {
      await context.api.addLabels(context.projectId, asIid(fresh.iid), ['ai-blocked']).catch(() => {});
      await context.api.postNote(
        context.projectId,
        asIid(fresh.iid),
        '自动化已暂停，原因：`missing-credential`。触发者在 OpenChamber 中没有可用的同实例账号，或权限低于 Developer。',
      ).catch(() => {});
      await ledger.put({
        ...baseEntry,
        kind: template.kind,
        targetBranch,
        actorUserId: triggerer?.userId ?? null,
        blockedReason: BLOCKED_REASONS.MISSING_CREDENTIAL,
        lastError: 'Triggerer account is missing or lacks Developer access',
      });
      return false;
    }

    const reused = matchReusableBranch(
      await context.api.listBranches(context.projectId, `issue-${fresh.iid}`),
      context.config.prefix,
      asIid(fresh.iid),
    );
    const entry: RunEntry = {
      ...baseEntry,
      kind: template.kind,
      phase: PHASES.CLAIMED,
      targetBranch,
      branch: reused ?? buildIssueBranch(context.config.prefix, asIid(fresh.iid), fresh.title),
      actorUserId: triggerer.userId,
      actorAccountId: actor.credentialId,
      leaseUntil: new Date(now() + leaseMs).toISOString(),
      events: [{ at: isoNow(), kind: 'phase', from: null, to: PHASES.CLAIMED }],
    };
    await ledger.put(entry);
    try {
      await context.api.addLabels(context.projectId, asIid(fresh.iid), ['ai-working']);
      await context.api.postNote(
        context.projectId,
        asIid(fresh.iid),
        `已认领。分支：\`${entry.branch}\`，目标分支：\`${targetBranch}\`。`,
      );
    } catch (error) {
      await ledger.remove(key);
      throw error;
    }
    return true;
  };

  const scanProject = async (context: DispatchContext) => {
    const issues = await context.api.listOpenIssues(context.projectId);
    let claimed = 0;
    for (const issue of issues) {
      if (claimed >= maxPerProjectPerTick) break;
      if (await claim(context, issue)) claimed += 1;
    }
    return claimed;
  };

  const handleClaimed = async (run: RunEntry, context: DispatchContext) => {
    const prepared = await ensureWorktree(run, context);
    if (prepared.phase === PHASES.BLOCKED) return prepared;
    return transition(prepared, PHASES.PREPARING);
  };

  const handlePreparing = async (run: RunEntry, context: DispatchContext) => startSession(run, context, 'triage');

  const closeAsNotAnIssue = async (run: RunEntry, context: DispatchContext, triage: { verdict: string }, noteId: number) => {
    if (context.config.autoCloseNotAnIssue === false) {
      return blockWithComment(
        run,
        context,
        BLOCKED_REASONS.NOT_AN_ISSUE,
        '判定为非问题（依据见上一条评论）。按项目配置已暂停，等待人工确认后关闭；如认同请直接关闭 issue，如不认同请回复说明。',
        { triageVerdict: triage.verdict, triageNoteId: noteId },
      );
    }
    try {
      await context.api.closeIssue(run.projectId, run.iid ?? 0);
    } catch (error) {
      warn(`[gitlab-issues] issue close failed for #${run.iid}:`, error);
      return blockWithComment(
        run,
        context,
        BLOCKED_REASONS.NOT_AN_ISSUE,
        '判定为非问题，但 bot 无权关闭 issue，请人工关闭。',
        { triageVerdict: triage.verdict, triageNoteId: noteId },
      );
    }
    await context.api.removeLabels(run.projectId, run.iid ?? 0, ['ai-working', 'ai-plan-review', 'ai-review'])
      .catch((error) => warn(`[gitlab-issues] working label clear failed for #${run.iid}:`, error));
    await context.api.addLabels(run.projectId, run.iid ?? 0, ['ai-done'])
      .catch((error) => warn(`[gitlab-issues] ai-done label failed for #${run.iid}:`, error));
    const retained = await cleanupWorktree(run, context, `issue 已关闭，工作区有未提交改动，已保留：\`${run.worktreePath}\``);
    return transition(run, PHASES.DONE, {
      outcome: 'not-an-issue',
      triageVerdict: triage.verdict,
      triageNoteId: noteId,
      sessionId: null,
      worktreePath: retained,
      leaseUntil: null,
    });
  };

  const handleTriaging = async (run: RunEntry, context: DispatchContext): Promise<RunEntry | void> => {
    if (!run.sessionId) {
      const prepared = run.worktreePath ? run : await ensureWorktree(run, context);
      if (prepared.phase === PHASES.BLOCKED) return prepared;
      return startSession(prepared, context, 'triage');
    }
    const result = await readSessionResult(sessionClient(run), run.sessionId);
    if (sessionFailed(run, result)) {
      return failRun(run, context, BLOCKED_REASONS.SESSION_FAILED, SESSION_FAILED_DETAIL);
    }
    if (!sessionFinished(run, result)) return;
    let triage;
    try {
      triage = parseAgentOutput(result.status === 'idle' ? result.text : '', 'triage');
    } catch (error) {
      if (!(error instanceof AgentOutputError)) throw error;
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, error.message);
    }
    if (triage.verdict === 'insufficient-info') {
      return blockWithComment(
        run,
        context,
        BLOCKED_REASONS.INSUFFICIENT_INFO,
        `报告缺少可核验的信息：${triage.missing}`,
      );
    }
    const noteId = await context.api.postNote(run.projectId, run.iid ?? 0, formatTriageComment(triage));
    if (triage.verdict === 'not-an-issue') {
      return closeAsNotAnIssue(run, context, triage, noteId);
    }
    return transition(run, run.kind === 'feature' ? PHASES.PLANNING : PHASES.IMPLEMENTING, {
      triageVerdict: triage.verdict,
      triageNoteId: noteId,
      triage,
      sessionId: null,
      attempts: 0,
    });
  };

  const handlePlanning = async (run: RunEntry, context: DispatchContext): Promise<RunEntry | void> => {
    if (!run.sessionId) {
      const prepared = run.worktreePath ? run : await ensureWorktree(run, context);
      if (prepared.phase === PHASES.BLOCKED) return prepared;
      return startSession(prepared, context, 'plan');
    }
    const result = await readSessionResult(sessionClient(run), run.sessionId);
    if (sessionFailed(run, result)) {
      return failRun(run, context, BLOCKED_REASONS.SESSION_FAILED, SESSION_FAILED_DETAIL);
    }
    if (!sessionFinished(run, result)) return;
    let plan;
    try {
      plan = parseAgentOutput(result.status === 'idle' ? result.text : '', 'plan');
    } catch (error) {
      if (!(error instanceof AgentOutputError)) throw error;
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, error.message);
    }
    const noteId = await context.api.postNote(run.projectId, run.iid ?? 0, formatPlanComment(plan));
    const next = await transition(run, PHASES.WAITING_APPROVAL, { planNoteId: noteId, plan, sessionId: null });
    await context.api.addLabels(run.projectId, run.iid ?? 0, ['ai-plan-review'])
      .catch((error) => warn(`[gitlab-issues] ai-plan-review label failed for #${run.iid}:`, error));
    await context.api.removeLabels(run.projectId, run.iid ?? 0, ['ai-working'])
      .catch((error) => warn(`[gitlab-issues] ai-working label failed for #${run.iid}:`, error));
    return next;
  };

  const handleWaitingApproval = async (run: RunEntry, context: DispatchContext): Promise<RunEntry | void> => {
    const command = await context.api.latestCommand(run.projectId, run.iid ?? 0, {
      sinceIso: run.since,
      commands: ['/ai-approve', '/ai-reject'],
      minAccessLevel: 30,
    });
    if (!command) return;
    if (command.command === '/ai-reject') {
      return blockWithComment(
        run,
        context,
        BLOCKED_REASONS.REJECTED,
        '方案已被拒绝。移除 `ai-blocked` 并重新添加 `ai-ready` 可开始新一轮。',
      );
    }
    const approver = await findAccountForUser(authStore, run.origin, command.userId);
    if (!approver) {
      return blockWithComment(
        run, context, BLOCKED_REASONS.MISSING_CREDENTIAL,
        '审批者在 OpenChamber 中没有绑定的同实例账号，请由其绑定账号或回复 `/ai-take` 指定。',
      );
    }
    let approverUser: JsonObject | null;
    try {
      approverUser = await apiFactory({ origin: run.origin, account: approver }).currentUser();
    } catch (error) {
      if (unauthorized(error)) {
        return blockWithComment(run, context, BLOCKED_REASONS.MISSING_CREDENTIAL, '审批者账号已失效。');
      }
      throw error;
    }
    const email = isString(approverUser?.email) ? approverUser.email.trim() : '';
    if (!email) {
      return blockWithComment(
        run, context, BLOCKED_REASONS.MISSING_CREDENTIAL,
        '审批者账号没有可见邮箱，无法写入提交身份。',
      );
    }
    if (run.worktreePath) {
      await workspace.configureIdentity({
        cwd: run.worktreePath,
        name: asText(approverUser?.name ?? approverUser?.username),
        email,
      });
    }
    const next = await transition(run, PHASES.IMPLEMENTING, {
      approvalNoteId: command.noteId,
      actorUserId: command.userId,
      actorAccountId: approver.credentialId,
      approvedBy: {
        login: asText(approver.user.login),
        userId: command.userId,
        accountId: approver.credentialId,
        at: isoNow(),
      },
    });
    await context.api.removeLabels(run.projectId, run.iid ?? 0, ['ai-plan-review'])
      .catch((error) => warn(`[gitlab-issues] ai-plan-review label failed for #${run.iid}:`, error));
    await context.api.addLabels(run.projectId, run.iid ?? 0, ['ai-working'])
      .catch((error) => warn(`[gitlab-issues] ai-working label failed for #${run.iid}:`, error));
    return next;
  };

  const resumeOnNewInfo = async (run: RunEntry, context: DispatchContext): Promise<RunEntry | null> => {
    let notes: JsonObject[];
    let members: Map<number, number>;
    try {
      notes = await context.api.listNotes(run.projectId, run.iid ?? 0);
      members = new Map((await context.api.listMembers(run.projectId))
        .map((member): [number, number] => [Number(member?.id), Number(member?.access_level)]));
    } catch {
      return null;
    }
    const watermark = run.triageNoteId ?? 0;
    const answered = notes.some((note) => {
      const author = isJsonRecord(note?.author) ? note.author : null;
      const authorId = Number(author?.id ?? 0);
      return isInteger(note?.id) && note.id > watermark
        && note.system !== true && !isBotNoteBody(asText(note.body))
        && (authorId === (run.actorUserId ?? 0) || (members.get(authorId) ?? 0) >= FEEDBACK_MIN_ACCESS_LEVEL);
    });
    if (!answered) return null;
    const next = await transition(run, PHASES.CLAIMED, {
      blockedReason: null,
      triageVerdict: null,
      triageNoteId: null,
      triage: null,
      sessionId: null,
      attempts: 0,
    });
    await context.api.removeLabels(run.projectId, run.iid ?? 0, ['ai-blocked'])
      .catch((error) => warn(`[gitlab-issues] ai-blocked label failed for #${run.iid}:`, error));
    await context.api.addLabels(run.projectId, run.iid ?? 0, ['ai-working'])
      .catch((error) => warn(`[gitlab-issues] ai-working label failed for #${run.iid}:`, error));
    await context.api.postNote(run.projectId, run.iid ?? 0, '收到补充信息，重新开始判定。')
      .catch((error) => warn(`[gitlab-issues] resume note failed for #${run.iid}:`, error));
    return next;
  };

  const handleBlocked = async (run: RunEntry, context: DispatchContext): Promise<RunEntry | void> => {
    if (run.blockedReason === BLOCKED_REASONS.RECORD_WRITE_FAILED) {
      try {
        await writeRecordFor(run, context.project.path);
      } catch {
        return;
      }
      const next = await transition(run, PHASES.VERIFYING, { blockedReason: null });
      await context.api.removeLabels(run.projectId, run.iid ?? 0, ['ai-blocked'])
        .catch((error) => warn(`[gitlab-issues] ai-blocked label failed for #${run.iid}:`, error));
      await context.api.addLabels(run.projectId, run.iid ?? 0, ['ai-working'])
        .catch((error) => warn(`[gitlab-issues] ai-working label failed for #${run.iid}:`, error));
      await context.api.postNote(run.projectId, run.iid ?? 0, '交付说明已写入，继续验证与推送。')
        .catch((error) => warn(`[gitlab-issues] record retry note failed for #${run.iid}:`, error));
      return next;
    }
    if (run.blockedReason === BLOCKED_REASONS.MISSING_CREDENTIAL) {
      const command = await context.api.latestCommand(run.projectId, run.iid ?? 0, {
        sinceIso: run.since,
        commands: ['/ai-take'],
        minAccessLevel: 30,
      });
      if (command) {
        const taker = await findAccountForUser(authStore, run.origin, command.userId);
        if (taker) {
          const next = await transition(run, PHASES.CLAIMED, {
            actorUserId: command.userId,
            actorAccountId: taker.credentialId,
            blockedReason: null,
          });
          await context.api.removeLabels(run.projectId, run.iid ?? 0, ['ai-blocked'])
            .catch((error) => warn(`[gitlab-issues] ai-blocked label failed for #${run.iid}:`, error));
          await context.api.addLabels(run.projectId, run.iid ?? 0, ['ai-working'])
            .catch((error) => warn(`[gitlab-issues] ai-working label failed for #${run.iid}:`, error));
          await context.api.postNote(run.projectId, run.iid ?? 0, `已由 @${taker.user.login} 接管。`)
            .catch((error) => warn(`[gitlab-issues] takeover note failed for #${run.iid}:`, error));
          return next;
        }
      }
    }
    if (run.blockedReason === BLOCKED_REASONS.INSUFFICIENT_INFO) {
      const resumed = await resumeOnNewInfo(run, context);
      if (resumed) return resumed;
    }
    const issue = await context.api.getIssue(run.projectId, run.iid ?? 0);
    if (issue.state === 'opened' && hasLabel(issue, 'ai-ready') && !hasLabel(issue, 'ai-blocked')) {
      await ledger.remove(keyOf(run));
    }
  };

  const handleImplementing = async (run: RunEntry, context: DispatchContext): Promise<RunEntry | void> => {
    if (!run.sessionId) {
      const prepared = run.worktreePath ? run : await ensureWorktree(run, context);
      if (prepared.phase === PHASES.BLOCKED) return prepared;
      return startSession(prepared, context, 'implement');
    }
    const result = await readSessionResult(sessionClient(run), run.sessionId);
    if (sessionFailed(run, result)) {
      return failRun(run, context, BLOCKED_REASONS.SESSION_FAILED, SESSION_FAILED_DETAIL);
    }
    if (!sessionFinished(run, result)) return;
    let evidence: EvidenceResult;
    try {
      evidence = parseAgentOutput(result.status === 'idle' ? result.text : '', 'implement');
    } catch (error) {
      if (!(error instanceof AgentOutputError)) throw error;
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, error.message);
    }
    const noteId = await context.api.postNote(run.projectId, run.iid ?? 0, formatEvidenceComment(evidence));
    const changes = await captureChanges(run, context);
    return transition(run, PHASES.REVIEWING, {
      evidenceNoteId: noteId, evidence, sessionId: null, attempts: 0, reviewFindings: null, ...changes,
    });
  };

  const recurringFindings = (run: RunEntry, current: Finding[]) => {
    const previous = Array.isArray(run.reviewFindings) ? run.reviewFindings : [];
    return current.filter((finding) => previous.some((entry) => entry.file === finding.file));
  };

  const postOscillationNote = async (
    run: RunEntry,
    context: DispatchContext,
    rounds: number,
    current: Finding[],
  ) => {
    if (rounds < 2) return;
    const recurring = recurringFindings(run, current);
    if (!recurring.length) return;
    await context.api.postNote(
      run.projectId,
      run.iid ?? 0,
      formatOscillationComment(recurring, rounds, REVIEW_MAX_REVISIONS),
    ).catch((error) => warn(`[gitlab-issues] oscillation note failed for #${run.iid}:`, error));
  };

  const handleReviewing = async (run: RunEntry, context: DispatchContext): Promise<RunEntry | void> => {
    if (!run.sessionId) {
      const prepared = run.worktreePath ? run : await ensureWorktree(run, context);
      if (prepared.phase === PHASES.BLOCKED) return prepared;
      return startSession(prepared, context, 'review');
    }
    const result = await readSessionResult(sessionClient(run), run.sessionId);
    if (sessionFailed(run, result)) {
      return failRun(run, context, BLOCKED_REASONS.SESSION_FAILED, SESSION_FAILED_DETAIL);
    }
    if (!sessionFinished(run, result)) return;
    let review;
    try {
      review = parseAgentOutput(result.status === 'idle' ? result.text : '', 'review');
    } catch (error) {
      if (!(error instanceof AgentOutputError)) throw error;
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, error.message);
    }
    const rounds = (run.reviewRounds ?? 0) + (review.verdict === 'request-changes' ? 1 : 0);
    const findings: Finding[] = [
      ...(Array.isArray(run.reviewFindings) ? run.reviewFindings : []),
      ...(review.verdict === 'request-changes' ? review.findings : []),
    ];
    const reviewHistory = appendReviewHistory(run, {
      kind: 'review',
      round: rounds,
      verdict: review.verdict,
      summary: review.summary,
      findings: review.findings,
      at: isoNow(),
    });
    const recheckNext = context.config.secondReview && !run.rechecked;
    const noteId = await context.api.postNote(
      run.projectId,
      run.iid ?? 0,
      formatReviewComment(review, rounds, REVIEW_MAX_REVISIONS, recheckNext),
    );
    if (review.verdict === 'approve') {
      if (recheckNext) {
        return transition(run, PHASES.RECHECKING, {
          reviewNoteId: noteId,
          reviewVerdict: 'approve',
          reviewImpact: review.impact ?? null,
          sessionId: null,
          feedbackItems: null,
          reviewHistory,
        });
      }
      return transition(run, PHASES.VERIFYING, {
        reviewNoteId: noteId,
        reviewVerdict: 'approve',
        reviewImpact: review.impact ?? null,
        sessionId: null,
        feedbackItems: null,
        reviewHistory,
      });
    }
    await postOscillationNote(run, context, rounds, review.findings);
    if (rounds > REVIEW_MAX_REVISIONS) {
      return blockWithComment(
        run,
        context,
        BLOCKED_REASONS.REVIEW_REJECTED,
        [`审核连续 ${REVIEW_MAX_REVISIONS} 轮要求修改，仍未通过。累计审核发现：`, ...findings.map(formatFindingLine)].join('\n'),
        {
          reviewNoteId: noteId,
          reviewVerdict: 'request-changes',
          reviewRounds: rounds,
          reviewFindings: findings,
          reviewImpact: null,
          sessionId: null,
          reviewHistory,
        },
      );
    }
    return transition(run, PHASES.IMPLEMENTING, {
      reviewNoteId: noteId,
      reviewVerdict: 'request-changes',
      reviewRounds: rounds,
      reviewFindings: findings,
      reviewImpact: null,
      sessionId: null,
      attempts: 0,
      reviewHistory,
    });
  };

  const handleRechecking = async (run: RunEntry, context: DispatchContext): Promise<RunEntry | void> => {
    if (!run.sessionId) {
      const prepared = run.worktreePath ? run : await ensureWorktree(run, context);
      if (prepared.phase === PHASES.BLOCKED) return prepared;
      return startSession(prepared, context, 'recheck');
    }
    const result = await readSessionResult(sessionClient(run), run.sessionId);
    if (sessionFailed(run, result)) {
      return failRun(run, context, BLOCKED_REASONS.SESSION_FAILED, SESSION_FAILED_DETAIL);
    }
    if (!sessionFinished(run, result)) return;
    let recheck;
    try {
      recheck = parseAgentOutput(result.status === 'idle' ? result.text : '', 'recheck');
    } catch (error) {
      if (!(error instanceof AgentOutputError)) throw error;
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, error.message);
    }
    const noteId = await context.api.postNote(run.projectId, run.iid ?? 0, formatRecheckComment(recheck));
    if (recheck.verdict === 'approve') {
      return transition(run, PHASES.VERIFYING, {
        recheckVerdict: 'approve',
        recheckNoteId: noteId,
        rechecked: true,
        sessionId: null,
        reviewHistory: appendReviewHistory(run, {
          kind: 'recheck',
          round: run.reviewRounds ?? 0,
          verdict: 'approve',
          summary: recheck.summary,
          findings: recheck.findings,
          at: isoNow(),
        }),
      });
    }
    const rounds = (run.reviewRounds ?? 0) + 1;
    const findings: Finding[] = [
      ...(Array.isArray(run.reviewFindings) ? run.reviewFindings : []),
      ...recheck.findings,
    ];
    const reviewHistory = appendReviewHistory(run, {
      kind: 'recheck',
      round: rounds,
      verdict: 'request-changes',
      summary: recheck.summary,
      findings: recheck.findings,
      at: isoNow(),
    });
    await postOscillationNote(run, context, rounds, recheck.findings);
    if (rounds > REVIEW_MAX_REVISIONS) {
      return blockWithComment(
        run,
        context,
        BLOCKED_REASONS.REVIEW_REJECTED,
        ['独立复核要求修改，且修改轮数已达上限。累计审核发现：', ...findings.map(formatFindingLine)].join('\n'),
        {
          recheckVerdict: 'request-changes',
          recheckNoteId: noteId,
          rechecked: true,
          reviewNoteId: noteId,
          reviewVerdict: 'request-changes',
          reviewRounds: rounds,
          reviewFindings: findings,
          reviewImpact: null,
          sessionId: null,
          reviewHistory,
        },
      );
    }
    return transition(run, PHASES.IMPLEMENTING, {
      recheckVerdict: 'request-changes',
      recheckNoteId: noteId,
      rechecked: true,
      reviewNoteId: noteId,
      reviewVerdict: 'request-changes',
      reviewRounds: rounds,
      reviewFindings: findings,
      reviewImpact: null,
      sessionId: null,
      attempts: 0,
      reviewHistory,
    });
  };

  const handleAddressing = async (run: RunEntry, context: DispatchContext): Promise<RunEntry | false> => {
    if (!run.sessionId) {
      if (!run.worktreePath) {
        return blockWithComment(
          run, context, BLOCKED_REASONS.WORKTREE_MISSING,
          '反馈修复需要的工作区已不存在，无法从已推送的分支重建评审状态。',
        );
      }
      try {
        await fs.stat(run.worktreePath);
      } catch {
        return blockWithComment(
          run, context, BLOCKED_REASONS.WORKTREE_MISSING,
          `反馈修复需要的工作区目录已丢失：\`${run.worktreePath}\`。`,
        );
      }
      return startSession(run, context, 'feedback');
    }
    const result = await readSessionResult(sessionClient(run), run.sessionId);
    if (sessionFailed(run, result)) {
      return failRun(run, context, BLOCKED_REASONS.SESSION_FAILED, SESSION_FAILED_DETAIL);
    }
    if (!sessionFinished(run, result)) return false;
    let evidence: EvidenceResult;
    try {
      evidence = parseAgentOutput(result.status === 'idle' ? result.text : '', 'implement');
    } catch (error) {
      if (!(error instanceof AgentOutputError)) throw error;
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, error.message);
    }
    const noteId = await context.api.postNote(run.projectId, run.iid ?? 0, formatEvidenceComment(evidence));
    const changes = await captureChanges(run, context);
    return transition(run, PHASES.REVIEWING, {
      evidenceNoteId: noteId, evidence, sessionId: null, attempts: 0, reviewFindings: null, ...changes,
    });
  };

  const handleVerifying = async (run: RunEntry, context: DispatchContext): Promise<RunEntry> => {
    if (run.reviewVerdict !== 'approve') {
      return blockWithComment(run, context, BLOCKED_REASONS.REVIEW_REJECTED,
        '推送前缺少通过的审核结论（可能是审核门加入前的旧运行记录）。');
    }
    if (!run.branch?.startsWith(context.config.prefix)) {
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, 'Branch does not start with the configured prefix');
    }
    if (!context.endpoint) {
      return blockWithComment(run, context, BLOCKED_REASONS.MISSING_CREDENTIAL, '主远端不是 HTTPS 地址。');
    }
    const actor = await resolveActor(run);
    if (!actor) {
      return blockWithComment(run, context, BLOCKED_REASONS.MISSING_CREDENTIAL, '触发者账号不可用。');
    }
    let changes: boolean;
    try {
      changes = await workspace.hasDiffSince({
        cwd: run.worktreePath ?? '',
        baseRef: `${context.primaryRemote}/${run.targetBranch}`,
      });
    } catch (error) {
      if (errorName(error) === 'WorkspaceError') {
        return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, errorMessage(error));
      }
      throw error;
    }
    if (!changes) {
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, 'The branch has no diff against the target');
    }
    if (!run.evidenceNoteId) {
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, 'Evidence note is missing');
    }
    let recordRun: RunEntry = run;
    if (context.config.verifyCommand) {
      const verifyCommand = context.config.verifyCommand;
      let verified: WorkspaceCommandResult;
      try {
        verified = await workspace.runVerifyCommand({
          cwd: run.worktreePath ?? '',
          command: verifyCommand,
          timeoutMs: VERIFY_COMMAND_TIMEOUT_MS,
        });
      } catch (error) {
        if (errorName(error) === 'WorkspaceError') {
          return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, `服务端验证命令执行失败：${errorMessage(error)}`);
        }
        throw error;
      }
      const outputTail = `${verified.stdout}\n${verified.stderr}`.trim().slice(-VERIFY_OUTPUT_TAIL);
      const verifyResult: VerifyResult = {
        command: verifyCommand,
        code: verified.code ?? null,
        outputTail,
        at: isoNow(),
      };
      if (verified.code !== 0) {
        return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED,
          `服务端验证命令 \`${verifyCommand}\` 未通过（退出码 ${verified.code ?? 'null'}）：\n\`\`\`\n${outputTail.slice(-2000) || '(无输出)'}\n\`\`\``,
          { verifyResult });
      }
      recordRun = await ledger.update(keyOf(run), { verifyResult });
    }

    const changePatch = await captureChanges(recordRun, context);
    if (changePatch.changeSummary) {
      recordRun = await ledger.update(keyOf(run), changePatch);
    }
    try {
      await writeRecordFor(recordRun, context.project.path);
    } catch (error) {
      warn(`[gitlab-issues] delivery record gate failed for #${run.iid}:`, error);
      const location = recordLocationFor({
        checkoutPath: context.project.path,
        projectPath: recordRun.projectPath ?? '',
        iid: recordRun.iid,
      });
      await context.api.postNote(run.projectId, run.iid ?? 0, formatRecordWriteComment(location.primary))
        .catch((noteError) => warn(`[gitlab-issues] record failure note failed for #${run.iid}:`, noteError));
      const blocked = await block(run, BLOCKED_REASONS.RECORD_WRITE_FAILED, `交付说明写入失败：${location.primary}`, changePatch);
      await context.api.addLabels(run.projectId, run.iid ?? 0, ['ai-blocked'])
        .catch((labelError) => warn(`[gitlab-issues] ai-blocked label failed for #${run.iid}:`, labelError));
      await context.api.removeLabels(run.projectId, run.iid ?? 0, ['ai-working', 'ai-plan-review', 'ai-review'])
        .catch((labelError) => warn(`[gitlab-issues] working label clear failed for #${run.iid}:`, labelError));
      return blocked;
    }

    const pushCredential = await credentialFor(context, actor.account);
    let pushed: { branch: string; sha: string };
    try {
      pushed = await workspace.pushBranch({
        cwd: run.worktreePath ?? '',
        remote: context.primaryRemote,
        branch: run.branch ?? '',
        credential: pushCredential,
      });
    } catch (error) {
      if (errorName(error) === 'WorkspaceError') {
        return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, errorMessage(error));
      }
      throw error;
    }

    let issue: JsonObject;
    let mr: JsonObject;
    try {
      issue = await context.api.getIssue(run.projectId, run.iid ?? 0);
      const existing = await actor.api.listOpenMergeRequests(run.projectId, run.branch ?? '');
      mr = existing[0] ?? {};
      if (!existing[0]) {
        mr = await actor.api.createMergeRequest(
          run.projectId,
          run.branch ?? '',
          run.targetBranch ?? '',
          `${asText(issue.title)} (#${run.iid})`,
          buildMrDescription(run),
        );
      }
    } catch (error) {
      const status = responseStatus(error);
      if (unauthorized(error) || status === 403) {
        return blockWithComment(
          run, context, BLOCKED_REASONS.MISSING_CREDENTIAL,
          '触发者账号无权创建合并请求，请确认其 Developer 及以上权限和 token scope。',
        );
      }
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED,
        `无法创建合并请求：${errorMessage(error)}`);
    }
    await context.api.postNote(run.projectId, run.iid ?? 0, formatMrComment(mr))
      .catch((error) => warn(`[gitlab-issues] MR note failed for #${run.iid}:`, error));
    if ((run.feedbackRounds ?? 0) > 0 && pushed.sha) {
      await context.api.postMergeRequestNote(
        run.projectId,
        asIid(mr.iid),
        formatFeedbackPushComment({ round: run.feedbackRounds ?? 0, sha: pushed.sha }),
      ).catch((error) => warn(`[gitlab-issues] push note failed for #${run.iid}:`, error));
    }
    const next = await transition(run, PHASES.MR_OPEN, { mrIid: asIid(mr.iid) });
    await context.api.addLabels(run.projectId, run.iid ?? 0, ['ai-review'])
      .catch((error) => warn(`[gitlab-issues] ai-review label failed for #${run.iid}:`, error));
    return next;
  };

  const finishMerged = async (run: RunEntry, context: DispatchContext) => {
    if (run.targetBranch !== context.defaultBranch) {
      await context.api.closeIssue(run.projectId, run.iid ?? 0)
        .catch((error) => warn(`[gitlab-issues] issue close failed for #${run.iid}:`, error));
    }
    await context.api.addLabels(run.projectId, run.iid ?? 0, ['ai-done'])
      .catch((error) => warn(`[gitlab-issues] ai-done label failed for #${run.iid}:`, error));
    const retained = await cleanupWorktree(run, context, `MR 已合并，但工作区有未提交改动，已保留：\`${run.worktreePath}\``);
    return ledger.update(keyOf(run), {
      phase: PHASES.DONE,
      worktreePath: retained,
      leaseUntil: null,
      since: isoNow(),
    });
  };

  const handleMrOpen = async (run: RunEntry, context: DispatchContext): Promise<RunEntry | false> => {
    const actor = await resolveActor(run);
    if (!actor) {
      return blockWithComment(run, context, BLOCKED_REASONS.MISSING_CREDENTIAL, '触发者账号不可用。');
    }
    let mr: JsonObject;
    try {
      mr = await actor.api.getMergeRequest(run.projectId, run.mrIid ?? 0);
    } catch (error) {
      if (unauthorized(error)) {
        return blockWithComment(run, context, BLOCKED_REASONS.MISSING_CREDENTIAL, '触发者账号已失效。');
      }
      const status = responseStatus(error);
      if (status === 404) {
        return blockWithComment(run, context, BLOCKED_REASONS.MR_CLOSED, '合并请求不存在或已被删除。');
      }
      throw error;
    }
    if (mr.state === 'merged') return finishMerged(run, context);
    if (mr.state === 'closed') {
      return blockWithComment(
        run,
        context,
        BLOCKED_REASONS.MR_CLOSED,
        '合并请求被关闭但未合并。移除 `ai-blocked` 并重新添加 `ai-ready` 可开始新一轮。',
      );
    }
    const issue = await context.api.getIssue(run.projectId, run.iid ?? 0);
    if (issue.state !== 'opened') {
      await context.api.addLabels(run.projectId, run.iid ?? 0, ['ai-done'])
        .catch((error) => warn(`[gitlab-issues] ai-done label failed for #${run.iid}:`, error));
      const retained = await cleanupWorktree(run, context, `issue 已关闭，工作区有未提交改动，已保留：\`${run.worktreePath}\``);
      return ledger.update(keyOf(run), {
        phase: PHASES.DONE,
        worktreePath: retained,
        leaseUntil: null,
        since: isoNow(),
      });
    }
    return feedbackFlow.handleFeedbackScan(run, context);
  };

  const cancelledByHuman = (run: RunEntry, issue: JsonObject) => {
    if (issue.state !== 'opened') return true;
    if (isActivePhase(run.phase) && hasLabel(issue, 'ai-blocked')) return true;
    const watchers: string[] = [
      PHASES.TRIAGING, PHASES.PLANNING, PHASES.PREPARING, PHASES.IMPLEMENTING,
      PHASES.REVIEWING, PHASES.RECHECKING, PHASES.VERIFYING, PHASES.MR_OPEN, PHASES.ADDRESSING,
    ];
    return watchers.includes(run.phase) && !hasLabel(issue, 'ai-working');
  };

  const handleCancellation = async (run: RunEntry, context: DispatchContext) => {
    const issue = await context.api.getIssue(run.projectId, run.iid ?? 0);
    if (!cancelledByHuman(run, issue)) return false;
    if (run.sessionId) {
      await sessionClient(run).session.interrupt({ sessionID: run.sessionId }).catch(() => {});
    }
    await blockWithComment(
      run,
      context,
      BLOCKED_REASONS.CANCELLED,
      '人工修改了标签或关闭了 issue，本次运行已取消。',
      { sessionId: null },
    );
    return true;
  };

  const TIMED_PHASES: string[] = [
    PHASES.PREPARING, PHASES.TRIAGING, PHASES.PLANNING, PHASES.IMPLEMENTING,
    PHASES.REVIEWING, PHASES.RECHECKING, PHASES.ADDRESSING,
  ];

  const handleTimeout = async (run: RunEntry, context: DispatchContext) => {
    if (!TIMED_PHASES.includes(run.phase)) return false;
    const elapsed = now() - Date.parse(run.since ?? '');
    if (!Number.isFinite(elapsed) || elapsed <= context.config.timeoutMinutes * 60_000) return false;
    if (run.sessionId) {
      await sessionClient(run).session.interrupt({ sessionID: run.sessionId }).catch(() => {});
    }
    await blockWithComment(
      run,
      context,
      BLOCKED_REASONS.TIMEOUT,
      `当前阶段超过 ${context.config.timeoutMinutes} 分钟，已中止${run.sessionId ? '会话' : '该阶段的等待'}。`,
      { sessionId: null },
    );
    return true;
  };

  const processRun = async (run: RunEntry, context: DispatchContext) => {
    if (run.phase === PHASES.DONE) return;
    if (run.phase === PHASES.BLOCKED) return handleBlocked(run, context);
    if (run.phase === PHASES.MR_OPEN && await handleMrOpen(run, context) !== false) return;
    if (await handleCancellation(run, context)) return;
    if (await handleTimeout(run, context)) return;
    await touch(run);
    if (run.phase === PHASES.CLAIMED) return handleClaimed(run, context);
    if (run.phase === PHASES.PREPARING) return handlePreparing(run, context);
    if (run.phase === PHASES.TRIAGING) return handleTriaging(run, context);
    if (run.phase === PHASES.PLANNING) return handlePlanning(run, context);
    if (run.phase === PHASES.WAITING_APPROVAL) return handleWaitingApproval(run, context);
    if (run.phase === PHASES.IMPLEMENTING) return handleImplementing(run, context);
    if (run.phase === PHASES.REVIEWING) return handleReviewing(run, context);
    if (run.phase === PHASES.RECHECKING) return handleRechecking(run, context);
    if (run.phase === PHASES.VERIFYING) return handleVerifying(run, context);
    if (run.phase === PHASES.ADDRESSING) return handleAddressing(run, context);
  };

  const recoverRuns = async (runs: RunEntry[], contextFor: (run: RunEntry) => DispatchContext | undefined) => {
    const sessionPhases: string[] = [PHASES.PLANNING, PHASES.PREPARING, PHASES.IMPLEMENTING];
    for (const run of runs) {
      if (!isActivePhase(run.phase) || run.phase === PHASES.MR_OPEN) continue;
      if (!run.sessionId) continue;
      const context = contextFor(run);
      if (!context) continue;
      const alive = await sessionClient(run).session.get({ sessionID: run.sessionId })
        .then(() => true)
        .catch((error) => {
          if (errorFields(error)?.status === 404) return false;
          return null;
        });
      if (alive === null) continue;
      if (alive) {
        await touch(run);
        continue;
      }
      if (run.phase === PHASES.TRIAGING || run.phase === PHASES.REVIEWING
        || run.phase === PHASES.RECHECKING || run.phase === PHASES.ADDRESSING) {
        await ledger.update(keyOf(run), { sessionId: null, since: isoNow(), leaseUntil: null });
        continue;
      }
      if (!sessionPhases.includes(run.phase)) continue;
      let hasCommits = false;
      if (run.worktreePath) {
        hasCommits = await workspace.commitCountSince({
          cwd: run.worktreePath,
          baseRef: `${context.primaryRemote}/${run.targetBranch}`,
        }).catch(() => 0) > 0;
      } else {
        const remote = await context.api.showBranch(run.projectId, run.branch ?? '')
          .then(() => true)
          .catch((error) => {
            const status = responseStatus(error);
            return status === 404 ? false : null;
          });
        if (remote === null) continue;
        hasCommits = remote;
      }
      await ledger.update(keyOf(run), {
        phase: hasCommits ? PHASES.IMPLEMENTING : PHASES.CLAIMED,
        sessionId: null,
        leaseUntil: null,
        since: isoNow(),
      });
    }
  };

  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    tickCount += 1;
    try {
      const projects: { project: SettingsProject; config: ProjectConfig }[] = [];
      for (const project of await listProjects()) {
        const config = resolveProjectConfig(project);
        if (config.enabled) projects.push({ project, config });
      }
      if (!projects.length) return;
      if (waitForOpenCodeReady) await waitForOpenCodeReady();

      const projectContexts: DispatchContext[] = [];
      const contexts = new Map<string, DispatchContext>();
      const byEntryId = new Map<string, DispatchContext>();
      for (const { project, config } of projects) {
        const signature = JSON.stringify({ path: project.path, config });
        const cached = contextCache.get(project.id);
        let context = cached && cached.signature === signature && now() - cached.at < contextTtlMs
          ? cached.context
          : null;
        if (!context) {
          try {
            context = await resolveContext(project, config);
            if (context) contextCache.set(project.id, { at: now(), signature, context });
            else contextCache.delete(project.id);
          } catch (error) {
            contextCache.delete(project.id);
            if (!unauthorized(error)) {
              logger.warn?.(`[gitlab-issues] context failed (${project.id}):`, errorFields(error)?.message || error);
            }
          }
        }
        if (context) {
          projectContexts.push(context);
          contexts.set(`${context.instance}|${context.projectId}`, context);
          byEntryId.set(String(context.project.id), context);
        }
      }
      const contextFor = (run: RunEntry) => (run.projectEntryId === undefined
        ? undefined
        : byEntryId.get(String(run.projectEntryId)))
        ?? contexts.get(`${run.origin}|${run.projectId}`);

      const checkoutPaths = new Map<string, string>();
      for (const { project } of projects) checkoutPaths.set(String(project.id), project.path);
      const writeRecords = async () => {
        for (const run of await ledger.list()) {
          if (stopped) return;
          if (run.projectEntryId === null || run.projectEntryId === undefined) continue;
          const checkoutPath = checkoutPaths.get(String(run.projectEntryId));
          if (!checkoutPath) continue;
          await writeRecordBestEffort(run, checkoutPath);
        }
      };

      let runs = await ledger.list();
      if (!recovered) {
        recovered = true;
        await recoverRuns(runs, contextFor);
        runs = await ledger.list();
      }

      for (const run of runs) {
        if (stopped) return;
        const context = contextFor(run);
        if (!context) continue;
        await processRun(run, context)
          .catch((error) => {
            if (unauthorized(error)) return markBotUnauthorized(context);
            return warn(`[gitlab-issues] run ${run.iid} failed:`, error);
          });
      }
      await writeRecords();

      if (tickCount % issueScanEveryTicks !== 0) return;
      let dispatched = 0;
      const current = await ledger.list();
      let active = slotRuns(current);
      for (const context of projectContexts) {
        if (stopped || dispatched >= maxPerTick || active.length >= maxActiveGlobal) break;
        if (active.filter((run) => run.projectId === context.projectId).length >= maxActivePerProject) continue;
        try {
          const claimedCount = await scanProject(context);
          if (claimedCount) {
            dispatched += claimedCount;
            active = slotRuns(await ledger.list());
          }
        } catch (error) {
          if (unauthorized(error)) {
            await markBotUnauthorized(context);
          } else {
            warn(`[gitlab-issues] project scan failed (${context.project.id}):`, error);
          }
        }
      }
      await writeRecords();
    } catch (error) {
      warn('[gitlab-issues] tick failed:', error);
    } finally {
      ticking = false;
    }
  };

  const stop = () => {
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    if (timer) { clearInterval(timer); timer = null; }
  };

  const sessionStatusOf = async (run: RunEntry) => {
    if (!run.sessionId || !run.worktreePath) return null;
    const result = await readSessionResult(sessionClient(run), run.sessionId)
      .catch(() => null);
    return result?.status === 'busy' || result?.status === 'idle' ? result.status : null;
  };

  return {
    tick,
    ledger,
    sessionStatus: sessionStatusOf,
    start() {
      if (stopped || timer || startupTimer) return;
      startupTimer = setTimeout(() => {
        startupTimer = null;
        if (stopped) return;
        timer = setInterval(() => { void tick(); }, tickIntervalMs);
        timer.unref?.();
        void tick();
      }, startupDelayMs);
      startupTimer.unref?.();
    },
    stop,
    async close() {
      stopped = true;
      stop();
      await ledger.close();
    },
  };
}
