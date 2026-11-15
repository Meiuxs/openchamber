import fs from 'node:fs/promises';
import { parseGitLabRemoteUrl } from '../gitlab/repo.js';
import { isRecord, isString } from '../shared/guards.js';
import { parseModelRef } from '../shared/model-ref.js';
import {
  BLOCKED_REASONS, PHASES, canTransition, isActivePhase,
} from './machine.js';
import {
  TemplateError, assistantText, buildIssueBranch, findAccountForUser, isBareBotMention, labelNamesOf, matchReusableBranch,
  parseFeedbackCommand, parseIssueTemplate, resolveAccount, resolveProjectConfig,
} from './gitlab.js';
import { createGitlabIssueLedger, ledgerKey } from './ledger.js';
import {
  AgentOutputError, buildFeedbackPrompt, buildImplementPrompt, buildPlanPrompt, buildReviewPrompt,
  buildTriagePrompt,
  formatBareMentionComment, formatBlockedComment, formatEvidenceComment, formatFeedbackAckComment,
  formatFeedbackPushComment, formatFindingLine, formatMrComment, formatPlanComment,
  formatReviewComment, formatTriageComment, parseAgentOutput, sessionStageLabel,
} from './prompts.js';

const BUSY_LABELS = ['ai-working', 'ai-plan-review', 'ai-review', 'ai-blocked', 'ai-done'];
const DEFAULT_STARTUP_DELAY_MS = 30_000;
const DEFAULT_TICK_INTERVAL_MS = 10_000;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 2;
// The review-revision loop is bounded on its own: request-changes sends the
// findings back to a fresh implement session at most this many times.
const REVIEW_MAX_REVISIONS = 3;
// A reviewer can send an open run back to fix things at most this many times;
// past that the branch waits for a human.
const FEEDBACK_MAX_ROUNDS = 5;
// The lowest GitLab access level that may trigger a feedback round: the same
// Developer bar the approval commands use.
const FEEDBACK_MIN_ACCESS_LEVEL = 30;
// A run occupies a dispatch slot while it holds a session or waits for a
// human. An open MR belongs to its reviewers, so it does not keep the
// project from picking up the next issue — while it is being fixed it holds
// a session again.
const SLOT_PHASES = Object.freeze([
  PHASES.CLAIMED, PHASES.TRIAGING, PHASES.PLANNING, PHASES.WAITING_APPROVAL,
  PHASES.PREPARING, PHASES.IMPLEMENTING, PHASES.REVIEWING, PHASES.VERIFYING,
  PHASES.ADDRESSING,
]);

// Reported when a session ends with nothing the phase can read, so the blocked
// comment names the likely cause instead of repeating the json parser's own
// complaint about a model that never answered.
const SESSION_FAILED_DETAIL = '会话没有任何输出就结束了（常见原因：模型不可用、额度不足，或会话被中断）。';

const hasLabel = (issue, name) => labelNamesOf(issue).includes(name);
const unauthorized = (error) => error?.cause?.response?.status === 401
  || error?.response?.status === 401 || error?.status === 401;

// Loopback keeps the local development instance reachable over plain HTTP. The
// provider accepts that origin (`allowLoopbackHttp`), so the push credential
// lease has to work there as well; every other remote still needs TLS.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const isLoopbackHost = (hostname) => LOOPBACK_HOSTS.has(hostname) || hostname.startsWith('127.');

const endpointForRemote = (rawUrl) => {
  let url;
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

export function createGitlabIssueDispatcher(dependencies) {
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
    /** `(project) => Promise<{ startCommand: string }>`: the project's worktree setup commands. */
    resolveWorktreeSetup = null,
    /** `({ directory, bootstrapStore }) => Promise<'ready' | 'pending' | 'failed'>`. */
    worktreeSetupState = null,
    waitForOpenCodeReady = null,
    onSessionCreated = null,
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
  } = dependencies;

  let timer = null;
  let startupTimer = null;
  let ticking = false;
  let stopped = false;
  let tickCount = 0;
  let recovered = false;
  const contextCache = new Map();

  const isoNow = () => new Date(now()).toISOString();
  const keyOf = (run) => ledgerKey(run.origin, run.projectId, run.iid);
  const slotRuns = (runs) => runs.filter((run) => SLOT_PHASES.includes(run.phase));
  const warn = (message, error) => logger.warn?.(message, error?.message || error);

  const touch = (run) => ledger.update(keyOf(run), {
    leaseUntil: new Date(now() + leaseMs).toISOString(),
  });

  // The run's own history, kept on the ledger so the panel can say how it got
  // here instead of only where it is now. Phase entries move the step line;
  // the others explain a stop or a slow stage. Oldest entries fall off, so a
  // long-lived run does not grow the ledger file without bound.
  const MAX_RUN_EVENTS = 20;
  const withEvents = (run, events) => [
    ...(Array.isArray(run.events) ? run.events : []),
    ...events,
  ].slice(-MAX_RUN_EVENTS);
  const withEvent = (run, event) => withEvents(run, [event]);

  // Every session a run opened, oldest first, bounded like the trail above: a
  // phase clears `sessionId` when it moves on, so the ledger is the only place
  // that still knows the sessions behind the fix and each review round.
  const MAX_RUN_SESSIONS = 20;
  const withSession = (run, session) => [
    ...(Array.isArray(run.sessions) ? run.sessions : []),
    session,
  ].slice(-MAX_RUN_SESSIONS);

  const transition = async (run, to, patch = {}) => {
    if (!canTransition(run.phase, to)) throw new Error(`Illegal transition ${run.phase} -> ${to}`);
    return ledger.update(keyOf(run), {
      phase: to,
      since: isoNow(),
      lastError: null,
      leaseUntil: new Date(now() + leaseMs).toISOString(),
      // Every event carries the time it happened: the panel draws it, and an
      // event without one used to be enough to fail the whole runs answer.
      events: withEvent(run, { at: isoNow(), kind: 'phase', from: run.phase, to }),
      ...patch,
    });
  };

  const block = async (run, reason, detail = '', patch = {}) => ledger.update(keyOf(run), {
    phase: PHASES.BLOCKED,
    blockedReason: reason,
    events: withEvent(run, {
      kind: 'blocked',
      from: run.phase === PHASES.BLOCKED ? (run.blockedFrom ?? null) : run.phase,
      reason,
      detail: isString(detail) && detail.trim() ? detail.trim().slice(0, 240) : null,
    }),
    // The panel draws the rail up to the stage that blocked.
    blockedFrom: run.phase === PHASES.BLOCKED ? (run.blockedFrom ?? null) : run.phase,
    lastError: detail || null,
    since: isoNow(),
    leaseUntil: null,
    ...patch,
  });

  const cleanupWorktree = async (run, context, note = null) => {
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

  const blockWithComment = async (run, context, reason, detail, patch = {}) => {
    const retained = await cleanupWorktree(
      run,
      context,
      `工作区有未提交改动，已保留：\`${run.worktreePath}\``,
    );
    const next = await block(run, reason, detail, { ...patch, worktreePath: retained });
    await context.api.addLabels(run.projectId, run.iid, ['ai-blocked'])
      .catch((error) => warn(`[gitlab-issues] ai-blocked label failed for #${run.iid}:`, error));
    await context.api
      .removeLabels(run.projectId, run.iid, ['ai-working', 'ai-plan-review', 'ai-review'])
      .catch((error) => warn(`[gitlab-issues] working label clear failed for #${run.iid}:`, error));
    await context.api.postNote(run.projectId, run.iid, formatBlockedComment(reason, detail))
      .catch((error) => warn(`[gitlab-issues] blocked note failed for #${run.iid}:`, error));
    return next;
  };

  const failRun = async (run, context, reason, detail) => {
    const repeated = Boolean(run.lastError) && run.lastError === detail;
    const exhausted = (run.attempts ?? 0) >= MAX_ATTEMPTS;
    const nextReason = repeated || exhausted ? BLOCKED_REASONS.REPEATED_ERROR : reason;
    return blockWithComment(run, context, nextReason, detail, { attempts: run.attempts ?? 0 });
  };

  const markBotUnauthorized = async (context) => {
    contextCache.delete(context.project.id);
    try {
      await authStore.markAccountInvalid(context.instance, context.botAccount.credentialId);
      logger.warn?.(`[gitlab-issues] bot account refused for project ${context.project.id}; marked invalid and dispatch paused`);
    } catch (error) {
      warn(`[gitlab-issues] bot account refused for project ${context.project.id}; could not mark it invalid:`, error);
    }
  };

  const resolveContext = async (project, config) => {
    const bindingRead = await bindingService.get(project.path);
    const binding = bindingRead?.binding;
    if (!binding) return null;
    const provider = (binding.providers ?? []).find((entry) => entry?.provider === 'gitlab'
      && entry.readiness === 'ready');
    if (!provider?.instance) return null;
    const primaryRemote = provider.primaryRemote;
    const remote = (bindingRead.repository?.remotes ?? []).find((entry) => entry?.name === primaryRemote);
    const remoteUrl = remote?.fetch?.displayUrl ?? provider.endpoint?.displayUrl ?? '';
    const parsed = parseGitLabRemoteUrl(remoteUrl, provider.instance);
    if (!parsed) return null;
    const botAccount = await resolveAccount(authStore, provider.instance, config.botAccountId);
    if (!botAccount) {
      logger.warn?.(`[gitlab-issues] bot account unusable for project ${project.id}`);
      return null;
    }
    const api = apiFactory({ origin: provider.instance, account: botAccount });
    let botUser;
    let projectInfo;
    try {
      botUser = await api.currentUser();
      projectInfo = await api.getProject(parsed.projectPath);
    } catch (error) {
      if (unauthorized(error)) await markBotUnauthorized({ project, instance: provider.instance, botAccount });
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
      projectId: projectInfo.id,
      defaultBranch: projectInfo.default_branch,
      botAccount,
      botUserId: botUser.id,
      // Mention commands are written against the bot's real username, never a
      // hard-coded one: the same flow works on any instance.
      botUsername: botUser.username,
      api,
    };
  };

  const resolveActor = async (run) => {
    const account = await resolveAccount(authStore, run.origin, run.actorAccountId);
    if (!account) return null;
    return { account, api: apiFactory({ origin: run.origin, account }) };
  };

  const credentialFor = async (context, account) => credentialResolver.resolve({
    mode: 'managed',
    credentialId: createHttpsCredentialReference({
      provider: 'gitlab',
      instance: context.instance,
      credentialId: account.credentialId,
      credentialRevision: account.credentialRevision,
      providerUserId: account.providerUserId,
    }),
    endpoint: context.endpoint,
    operationId: `gitlab-issue-${context.projectId}`,
    deadline: new Date(now() + 60_000).toISOString(),
  });

  const sessionClient = (run) => clientFactory({ directory: run.worktreePath });

  const readSessionResult = async (client, sessionID) => {
    const response = await client.session.active();
    const active = isRecord(response) && isRecord(response.data) ? response.data : response;
    if (isRecord(active) && Object.hasOwn(active, sessionID)) return { status: 'busy' };
    const listed = await client.message.list({ sessionID, limit: 10, order: 'desc' });
    const records = Array.isArray(listed?.data) ? listed.data : [];
    const latestAssistant = records.find((record) => record?.type === 'assistant');
    // An idle session that never answered has already failed: a provider that
    // refuses the model, a spent quota, a turn that died before its first
    // token. The phase it opened cannot continue on its own, so it is reported
    // now — waiting for a message that will never arrive only spends the
    // timeout and then says "timeout" about something else entirely.
    //
    // The proof is the `idle` record OpenCode appends when a run ends, not the
    // empty record page: a prompt that has not reached the server yet lists no
    // records either, and failing on that would block a session that is only
    // starting. Without an `idle` record the turn is still expected.
    if (!latestAssistant) {
      return { status: records.some((record) => record?.type === 'idle') ? 'failed' : 'busy' };
    }
    const finishedAt = Number.isFinite(latestAssistant?.time?.completed) ? latestAssistant.time.completed : null;
    if (!finishedAt) return { status: 'busy' };
    const assistant = records.find((record) => record?.type === 'assistant' && assistantText(record).length > 0);
    return {
      status: 'idle',
      text: assistantText(assistant),
      completedAt: finishedAt,
    };
  };

  const sessionFinished = (run, result) => result.status === 'idle'
    && Number.isFinite(result.completedAt)
    && result.completedAt >= Date.parse(run.since);

  // A phase whose session ended without an answer cannot continue on its own:
  // the provider refused the model, the quota is spent, or the turn was
  // interrupted before its first token. `parseAgentOutput` only knows its own
  // missing json, so the phase reports the session instead, with a reason a
  // person can act on.
  const sessionFailed = (run, result) => result.status === 'failed'
    || (sessionFinished(run, result) && !String(result.text ?? '').trim());

  // Setup commands belong to the project, not to the run: they are read once
  // per creation, and a settings read that fails leaves the worktree bare
  // rather than stopping the automation.
  const worktreeSetupCommand = async (project) => {
    if (!resolveWorktreeSetup) return '';
    try {
      const setup = await resolveWorktreeSetup(project);
      return String(setup?.startCommand ?? '').trim();
    } catch (error) {
      warn(`[gitlab-issues] worktree setup could not be resolved for ${project.path}:`, error);
      return '';
    }
  };

  const ensureWorktree = async (run, context) => {
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
    let actorUser;
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

    let recorded = null;
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
          cwd: context.project.path, remote: context.primaryRemote, branch: base, credential: botCredential,
        });
      }
      const botCredential = await credentialFor(context, context.botAccount);
      await workspace.fetchBranch({
        cwd: context.project.path, remote: context.primaryRemote, branch: run.targetBranch, credential: botCredential,
      });

      const branchExists = await workspace.localBranchExists({
        cwd: context.project.path, branch: run.branch,
      });
      const worktree = await workspace.createWorktreeFor({
        repoPath: context.project.path,
        branch: run.branch,
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
        name: actorUser.name || actorUser.username,
        email,
      });
      return recorded;
    } catch (error) {
      if (error?.name !== 'WorkspaceError') throw error;
      const current = recorded ?? run;
      if (error.code === 'signing-required') {
        return blockWithComment(
          current, context, BLOCKED_REASONS.MISSING_CREDENTIAL,
          '目标仓库要求签名提交，但服务端没有触发者的签名密钥。',
        );
      }
      return failRun(current, context, BLOCKED_REASONS.VERIFICATION_FAILED, error.message);
    }
  };

  const startSession = async (run, context, stage) => {
    // A review is bounded by REVIEW_MAX_REVISIONS, not by the retry budget, and
    // a revision round starts from a clean attempt count.
    if (stage !== 'review' && (run.attempts ?? 0) >= MAX_ATTEMPTS) {
      return failRun(run, context, BLOCKED_REASONS.REPEATED_ERROR, 'Attempt limit reached');
    }
    // A worktree runs its project's setup commands after git is ready, and a
    // session opened before that finishes races the install with the agent's
    // first command. Waiting is per tick, never a deadline: a slow install is
    // slow, not a failure, so the run stays where it is and the next tick asks
    // again.
    let setupState = 'ready';
    if (worktreeSetupState) {
      try {
        setupState = (await worktreeSetupState({
          directory: run.worktreePath,
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
    const actor = await resolveAccount(authStore, run.origin, run.actorAccountId);
    if (!actor) {
      return blockWithComment(run, context, BLOCKED_REASONS.MISSING_CREDENTIAL, '触发者账号不可用。');
    }
    const title = `#${run.iid}: ${String(issue?.title ?? '').replace(/\s+/g, ' ').trim()} · ${sessionStageLabel(stage, run.feedbackRounds)}`;
    const payload = { title, location: { directory: run.worktreePath } };
    const usesReviewModel = stage === 'review' && Boolean(context.config.reviewModel);
    const modelValue = isString(usesReviewModel ? context.config.reviewModel : context.project.defaultModel)
      ? String(usesReviewModel ? context.config.reviewModel : context.project.defaultModel).trim()
      : '';
    const modelRef = parseModelRef(modelValue);
    if (modelRef) {
      payload.model = { providerID: modelRef.providerID, id: modelRef.id };
      const variant = usesReviewModel
        ? (context.config.reviewVariant || context.project.defaultVariant)
        : context.project.defaultVariant;
      if (variant) payload.model.variant = variant;
    }
    if (context.project.defaultAgent) payload.agent = context.project.defaultAgent;
    const session = await client.session.create(payload);
    const sessionID = session?.data?.id ?? session?.id;
    if (!sessionID) throw new Error('failed to create session');
    const nextPhase = stage === 'triage' ? PHASES.TRIAGING
      : stage === 'plan' ? PHASES.PLANNING
        : stage === 'review' ? PHASES.REVIEWING
          : stage === 'feedback' ? PHASES.ADDRESSING : PHASES.IMPLEMENTING;
    await ledger.update(keyOf(run), {
      sessionId: sessionID,
      sessions: withSession(run, { sessionId: sessionID, stage: nextPhase, at: isoNow() }),
      phase: nextPhase,
      since: isoNow(),
      // Review, triage and feedback rounds are bounded by their own outcome,
      // not by the retry budget, and start from a clean attempt count.
      attempts: stage === 'triage' || stage === 'review' || stage === 'feedback'
        ? (run.attempts ?? 0) : (run.attempts ?? 0) + 1,
      leaseUntil: new Date(now() + leaseMs).toISOString(),
      // A session start moves the step line too: it sets the phase itself,
      // without going through `transition`.
      events: withEvents(run, [
        { at: isoNow(), kind: 'phase', from: run.phase, to: nextPhase },
        { at: isoNow(), kind: 'session', phase: nextPhase },
      ]),
    });
    const text = stage === 'triage'
      ? buildTriagePrompt({
        issue,
        iid: run.iid,
        projectPath: run.worktreePath,
        actorLogin: actor.user.login,
        kind: run.kind,
      })
      : stage === 'plan'
        ? buildPlanPrompt({
          issue, iid: run.iid, projectPath: run.worktreePath, actorLogin: actor.user.login,
        })
        : stage === 'review'
        ? buildReviewPrompt({
          issue,
          iid: run.iid,
          projectPath: run.worktreePath,
          actorLogin: actor.user.login,
          baseRef: `${context.primaryRemote}/${run.targetBranch}`,
          evidence: run.evidence,
          feedbackItems: run.feedbackItems,
        })
        : stage === 'feedback'
          ? buildFeedbackPrompt({
            issue,
            iid: run.iid,
            projectPath: run.worktreePath,
            actorLogin: actor.user.login,
            branch: run.branch,
            targetBranch: run.targetBranch,
            baseRef: `${context.primaryRemote}/${run.targetBranch}`,
            feedbackItems: run.feedbackItems ?? [],
            round: run.feedbackRounds ?? 1,
            maxRounds: FEEDBACK_MAX_ROUNDS,
          })
          : buildImplementPrompt({
          issue,
          iid: run.iid,
          projectPath: run.worktreePath,
          actorLogin: actor.user.login,
          branch: run.branch,
          targetBranch: run.targetBranch,
          reviewFindings: run.reviewFindings,
        });
    try {
      await client.session.prompt({ sessionID, text });
    } catch (error) {
      // The session exists but never received the work; clear the id so the
      // next tick starts a fresh one instead of polling an empty session.
      await client.session.interrupt({ sessionID }).catch(() => {});
      await ledger.update(keyOf(run), { sessionId: null }).catch(() => {});
      throw error;
    }
    onSessionCreated?.({
      sessionID,
      directory: run.worktreePath,
      createdAt: isoNow(),
      promptDispatched: true,
      title,
    });
    return ledger.get(keyOf(run));
  };

  const claim = async (context, issue) => {
    const fresh = await context.api.getIssue(context.projectId, issue.iid);
    const labels = labelNamesOf(fresh);
    if (fresh.state !== 'opened' || !labels.includes('ai-ready')
      || labels.some((label) => BUSY_LABELS.includes(label))) return false;
    const key = ledgerKey(context.instance, context.projectId, fresh.iid);
    if (await ledger.get(key)) return false;

    const baseEntry = {
      origin: context.instance,
      projectEntryId: context.project.id,
      projectId: context.projectId,
      // Kept so the panel can build issue and MR links without another API read.
      projectPath: context.projectPath,
      title: fresh.title ?? null,
      iid: fresh.iid,
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
      // Set only when a run ends without a merge request. `done` alone cannot
      // tell a merged fix from an issue closed as not describing a problem.
      outcome: null,
      approvalNoteId: null,
      planNoteId: null,
      evidenceNoteId: null,
      evidence: null,
      reviewRounds: 0,
      reviewNoteId: null,
      reviewVerdict: null,
      reviewFindings: null,
      // Comment-driven feedback rounds after the MR opens. The watermarks start
      // null: the first mr-open poll sets them to the newest note ids without
      // triggering, so comments made while the run was still building cannot
      // retroactively start a round.
      feedbackRounds: 0,
      lastFeedbackActor: null,
      feedbackItems: null,
      noteWatermarks: null,
    };

    let template;
    try {
      template = parseIssueTemplate(fresh);
    } catch (error) {
      if (!(error instanceof TemplateError)) throw error;
      await context.api.addLabels(context.projectId, fresh.iid, ['ai-blocked']).catch(() => {});
      await context.api.postNote(
        context.projectId,
        fresh.iid,
        `自动化已暂停，原因：\`${error.reason}\`。请按模板补充 \`类型:\` 和 \`目标分支:\` 行后重新添加 \`ai-ready\`。`,
      ).catch(() => {});
      await ledger.put({
        ...baseEntry,
        blockedReason: error.reason,
        lastError: error.message,
      });
      return false;
    }

    const targetBranch = template.targetBranch || context.defaultBranch;
    try {
      await context.api.showBranch(context.projectId, targetBranch);
    } catch {
      await context.api.addLabels(context.projectId, fresh.iid, ['ai-blocked']).catch(() => {});
      await context.api.postNote(
        context.projectId,
        fresh.iid,
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

    let triggerer;
    try {
      triggerer = await context.api.latestTriggerer(context.projectId, fresh.iid, context.botUserId);
    } catch (error) {
      if (unauthorized(error)) throw error;
      // Older GitLab versions have no resource label events endpoint. Leaving
      // the issue `ai-ready` would retry it every scan with nothing on the
      // GitLab side explaining why nothing happens, so it blocks once.
      await context.api.addLabels(context.projectId, fresh.iid, ['ai-blocked']).catch(() => {});
      await context.api.postNote(
        context.projectId,
        fresh.iid,
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
        lastError: error?.message || 'Label events are unavailable',
      });
      return false;
    }
    const actor = triggerer
      ? await findAccountForUser(authStore, context.instance, triggerer.userId)
      : null;
    const accessLevel = triggerer ? await context.api.accessLevelOf(context.projectId, triggerer.userId) : 0;
    if (!triggerer || !actor || accessLevel < 30) {
      await context.api.addLabels(context.projectId, fresh.iid, ['ai-blocked']).catch(() => {});
      await context.api.postNote(
        context.projectId,
        fresh.iid,
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
      fresh.iid,
    );
    const entry = {
      ...baseEntry,
      kind: template.kind,
      phase: PHASES.CLAIMED,
      targetBranch,
      branch: reused ?? buildIssueBranch(context.config.prefix, fresh.iid, fresh.title),
      actorUserId: triggerer.userId,
      actorAccountId: actor.credentialId,
      leaseUntil: new Date(now() + leaseMs).toISOString(),
      events: [{ at: isoNow(), kind: 'phase', from: null, to: PHASES.CLAIMED }],
    };
    await ledger.put(entry);
    try {
      await context.api.addLabels(context.projectId, fresh.iid, ['ai-working']);
      await context.api.postNote(
        context.projectId,
        fresh.iid,
        `已认领。分支：\`${entry.branch}\`，目标分支：\`${targetBranch}\`。`,
      );
    } catch (error) {
      await ledger.remove(key);
      throw error;
    }
    return true;
  };

  const scanProject = async (context) => {
    const issues = await context.api.listOpenIssues(context.projectId);
    let claimed = 0;
    for (const issue of issues) {
      if (claimed >= maxPerProjectPerTick) break;
      if (await claim(context, issue)) claimed += 1;
    }
    return claimed;
  };

  const handleClaimed = async (run, context) => {
    const prepared = await ensureWorktree(run, context);
    if (prepared.phase === PHASES.BLOCKED) return prepared;
    // Both kinds build the worktree before triage: triage reads the code, and
    // a feature plan needs the same checkout right after it.
    return transition(prepared, PHASES.PREPARING);
  };

  // Preparing is the setup gate: the triage session starts here, and stays
  // here while the worktree still runs its install.
  const handlePreparing = async (run, context) => startSession(run, context, 'triage');

  // A verdict that closes the issue ends the run, so the comment carries the
  // reasoning and the evidence a reader needs even when the bot could not
  // close it. Everything else the run does is refused by the state machine
  // after `done`, so the ledger write is the last step.
  const closeAsNotAnIssue = async (run, context, triage, noteId) => {
    try {
      await context.api.closeIssue(run.projectId, run.iid);
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
    await context.api.removeLabels(run.projectId, run.iid, ['ai-working', 'ai-plan-review', 'ai-review'])
      .catch((error) => warn(`[gitlab-issues] working label clear failed for #${run.iid}:`, error));
    await context.api.addLabels(run.projectId, run.iid, ['ai-done'])
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

  const handleTriaging = async (run, context) => {
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
      triage = parseAgentOutput(result.text, 'triage');
    } catch (error) {
      if (!(error instanceof AgentOutputError)) throw error;
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, error.message);
    }
    // A report nobody can check keeps its issue open and waits for the
    // reporter; only a report the code contradicts closes it.
    if (triage.verdict === 'insufficient-info') {
      return blockWithComment(
        run,
        context,
        BLOCKED_REASONS.INSUFFICIENT_INFO,
        `报告缺少可核验的信息：${triage.missing}`,
      );
    }
    const noteId = await context.api.postNote(run.projectId, run.iid, formatTriageComment(triage));
    if (triage.verdict === 'not-an-issue') {
      return closeAsNotAnIssue(run, context, triage, noteId);
    }
    return transition(run, run.kind === 'feature' ? PHASES.PLANNING : PHASES.IMPLEMENTING, {
      triageVerdict: triage.verdict,
      triageNoteId: noteId,
      sessionId: null,
      attempts: 0,
    });
  };

  const handlePlanning = async (run, context) => {
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
      plan = parseAgentOutput(result.text, 'plan');
    } catch (error) {
      if (!(error instanceof AgentOutputError)) throw error;
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, error.message);
    }
    const noteId = await context.api.postNote(run.projectId, run.iid, formatPlanComment(plan));
    const next = await transition(run, PHASES.WAITING_APPROVAL, { planNoteId: noteId, sessionId: null });
    await context.api.addLabels(run.projectId, run.iid, ['ai-plan-review'])
      .catch((error) => warn(`[gitlab-issues] ai-plan-review label failed for #${run.iid}:`, error));
    await context.api.removeLabels(run.projectId, run.iid, ['ai-working'])
      .catch((error) => warn(`[gitlab-issues] ai-working label failed for #${run.iid}:`, error));
    return next;
  };

  const handleWaitingApproval = async (run, context) => {
    const command = await context.api.latestCommand(run.projectId, run.iid, {
      sinceIso: run.since,
      botUserId: context.botUserId,
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
    // For a feature the triggerer is the approver, so the actor is rebound
    // here and the worktree identity follows the new actor.
    const approver = await findAccountForUser(authStore, run.origin, command.userId);
    if (!approver) {
      return blockWithComment(
        run, context, BLOCKED_REASONS.MISSING_CREDENTIAL,
        '审批者在 OpenChamber 中没有绑定的同实例账号，请由其绑定账号或回复 `/ai-take` 指定。',
      );
    }
    let approverUser;
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
        name: approverUser.name || approverUser.username,
        email,
      });
    }
    const next = await transition(run, PHASES.IMPLEMENTING, {
      approvalNoteId: command.noteId,
      actorUserId: command.userId,
      actorAccountId: approver.credentialId,
    });
    await context.api.removeLabels(run.projectId, run.iid, ['ai-plan-review'])
      .catch((error) => warn(`[gitlab-issues] ai-plan-review label failed for #${run.iid}:`, error));
    await context.api.addLabels(run.projectId, run.iid, ['ai-working'])
      .catch((error) => warn(`[gitlab-issues] ai-working label failed for #${run.iid}:`, error));
    return next;
  };

  const handleBlocked = async (run, context) => {
    if (run.blockedReason === BLOCKED_REASONS.MISSING_CREDENTIAL) {
      const command = await context.api.latestCommand(run.projectId, run.iid, {
        sinceIso: run.since,
        botUserId: context.botUserId,
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
          await context.api.removeLabels(run.projectId, run.iid, ['ai-blocked'])
            .catch((error) => warn(`[gitlab-issues] ai-blocked label failed for #${run.iid}:`, error));
          await context.api.addLabels(run.projectId, run.iid, ['ai-working'])
            .catch((error) => warn(`[gitlab-issues] ai-working label failed for #${run.iid}:`, error));
          await context.api.postNote(run.projectId, run.iid, `已由 @${taker.user.login} 接管。`)
            .catch((error) => warn(`[gitlab-issues] takeover note failed for #${run.iid}:`, error));
          return next;
        }
      }
    }
    // A human removed `ai-blocked` and left `ai-ready`; start over so the
    // template and title are parsed again instead of reusing stale fields.
    const issue = await context.api.getIssue(run.projectId, run.iid);
    if (issue.state === 'opened' && hasLabel(issue, 'ai-ready') && !hasLabel(issue, 'ai-blocked')) {
      await ledger.remove(keyOf(run));
    }
  };

  const handleImplementing = async (run, context) => {
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
    let evidence;
    try {
      evidence = parseAgentOutput(result.text, 'implement');
    } catch (error) {
      if (!(error instanceof AgentOutputError)) throw error;
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, error.message);
    }
    const noteId = await context.api.postNote(run.projectId, run.iid, formatEvidenceComment(evidence));
    // The review gets its own session; the evidence turn keeps its note.
    return transition(run, PHASES.REVIEWING, {
      evidenceNoteId: noteId, evidence, sessionId: null, attempts: 0, reviewFindings: null,
    });
  };

  const handleReviewing = async (run, context) => {
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
      review = parseAgentOutput(result.text, 'review');
    } catch (error) {
      if (!(error instanceof AgentOutputError)) throw error;
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, error.message);
    }
    const rounds = (run.reviewRounds ?? 0) + (review.verdict === 'request-changes' ? 1 : 0);
    // Findings accumulate across revision rounds: the implement session that
    // answers the next round and the human reading a blocked run both need the
    // full list, not only what the latest review said.
    const findings = [
      ...(Array.isArray(run.reviewFindings) ? run.reviewFindings : []),
      ...(review.verdict === 'request-changes' ? review.findings : []),
    ];
    const noteId = await context.api.postNote(
      run.projectId,
      run.iid,
      formatReviewComment(review, rounds, REVIEW_MAX_REVISIONS),
    );
    if (review.verdict === 'approve') {
      // The round is settled: the checklist stops riding along with the run.
      return transition(run, PHASES.VERIFYING, {
        reviewNoteId: noteId, reviewVerdict: 'approve', sessionId: null, feedbackItems: null,
      });
    }
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
          sessionId: null,
        },
      );
    }
    return transition(run, PHASES.IMPLEMENTING, {
      reviewNoteId: noteId,
      reviewVerdict: 'request-changes',
      reviewRounds: rounds,
      reviewFindings: findings,
      sessionId: null,
      attempts: 0,
    });
  };

  // One poll over both feedback channels (the issue's notes and the MR's
  // notes). Each channel carries its own watermark, stored as a note id: a
  // channel only hands out notes newer than it, so a comment that arrived
  // mid-round is either part of the next batch or waits for it, never lost.
  //
  // The first poll of an mr-open run only sets the watermarks to the newest
  // note ids and triggers nothing: comments written while the run was still
  // building predate the MR, and a trigger that only fires from then on is
  // what a person reading the issue expects.
  const scanFeedback = async (run, context) => {
    const [issueNotes, mrNotes] = await Promise.all([
      context.api.listNotes(run.projectId, run.iid),
      context.api.listMergeRequestNotes(run.projectId, run.mrIid),
    ]);
    const newestId = (notes) => notes.reduce((max, note) => (
      Number.isInteger(note?.id) ? Math.max(max, note.id) : max), 0);
    const marks = run.noteWatermarks ?? null;
    if (!marks) {
      return {
        items: [], mentions: [],
        watermarks: { issue: newestId(issueNotes), mergeRequest: newestId(mrNotes) },
        changed: false,
      };
    }
    const channels = [
      { name: 'issue', iid: run.iid, notes: issueNotes },
      { name: 'mergeRequest', iid: run.mrIid, notes: mrNotes },
    ];
    const accessLevels = new Map((await context.api.listMembers(run.projectId))
      .map((member) => [Number(member?.id), Number(member?.access_level)]));
    const items = [];
    const mentions = [];
    const nextWatermarks = { ...marks };
    for (const channel of channels) {
      const since = Number(marks[channel.name] ?? 0);
      const fresh = channel.notes.filter((note) => Number.isInteger(note?.id) && note.id > since);
      if (!fresh.length) continue;
      for (const note of fresh) {
        if (note.system || note.author?.id === context.botUserId) continue;
        if ((accessLevels.get(Number(note.author?.id)) ?? 0) < FEEDBACK_MIN_ACCESS_LEVEL) continue;
        const command = parseFeedbackCommand(note.body, context.botUsername);
        if (command) {
          items.push({
            channel: channel.name,
            noteId: note.id,
            userId: note.author.id,
            author: isString(note.author.username) ? note.author.username : String(note.author?.username ?? ''),
            text: command.text ?? '',
          });
        } else if (isBareBotMention(note.body, context.botUsername)) {
          mentions.push({ channel: channel.name, iid: channel.iid });
        }
      }
      nextWatermarks[channel.name] = newestId(fresh);
    }
    return {
      items,
      mentions,
      watermarks: nextWatermarks,
      changed: nextWatermarks.issue !== marks.issue || nextWatermarks.mergeRequest !== marks.mergeRequest,
    };
  };

  const postFeedbackReply = (context, run, channel, iid, body) => (channel === 'issue'
    ? context.api.postNote(run.projectId, iid, body)
    : context.api.postMergeRequestNote(run.projectId, iid, body)
  ).catch((error) => warn(`[gitlab-issues] feedback reply failed for #${run.iid}:`, error));

  const handleFeedbackScan = async (run, context) => {
    let scan;
    try {
      scan = await scanFeedback(run, context);
    } catch (error) {
      if (error?.name !== 'GitlabListOverflowError') throw error;
      // A comment history beyond what the automation reads cannot be parsed
      // for triggers, and stalling on the same exception every tick would
      // look like silence to everyone watching the MR.
      return blockWithComment(run, context, BLOCKED_REASONS.NOTES_LIMIT,
        '评论数量超出自动化单次读取上限，反馈无法继续解析，请人工处理后续修改。');
    }
    for (const mention of scan.mentions) {
      await postFeedbackReply(
        context, run, mention.channel, mention.iid,
        formatBareMentionComment(context.botUsername),
      );
    }
    if (scan.items.length) {
      const nextRounds = (run.feedbackRounds ?? 0) + 1;
      if (nextRounds > FEEDBACK_MAX_ROUNDS) {
        return blockWithComment(
          run,
          context,
          BLOCKED_REASONS.FEEDBACK_LIMIT,
          `反馈修复已达上限（${FEEDBACK_MAX_ROUNDS} 轮）。`,
          { noteWatermarks: scan.watermarks },
        );
      }
      const byChannel = [];
      for (const item of scan.items) {
        const last = byChannel[byChannel.length - 1];
        if (last && last.channel === item.channel) last.items.push(item);
        else byChannel.push({ channel: item.channel, iid: item.channel === 'issue' ? run.iid : run.mrIid, items: [item] });
      }
      for (const group of byChannel) {
        await postFeedbackReply(
          context, run, group.channel, group.iid,
          formatFeedbackAckComment({ items: group.items, round: nextRounds, maxRounds: FEEDBACK_MAX_ROUNDS }),
        );
      }
      const last = scan.items[scan.items.length - 1];
      const next = await transition(run, PHASES.ADDRESSING, {
        feedbackRounds: nextRounds,
        lastFeedbackActor: last.userId,
        feedbackItems: scan.items.map(({ author, text }) => ({ author, text })),
        noteWatermarks: scan.watermarks,
        sessionId: null,
        attempts: 0,
      });
      // The run holds a session again; `ai-review` stays until the round is
      // back in mr-open, where the verifying step re-asserts it.
      await context.api.addLabels(run.projectId, run.iid, ['ai-working'])
        .catch((error) => warn(`[gitlab-issues] ai-working label failed for #${run.iid}:`, error));
      return next;
    }
    // Mentions alone only advance the watermarks, and the first poll of an
    // mr-open run persists the initial ones, so neither the usage reply nor
    // the silent init happens twice.
    if (scan.changed || !run.noteWatermarks) {
      await ledger.update(keyOf(run), { noteWatermarks: scan.watermarks });
    }
    return false;
  };

  const handleAddressing = async (run, context) => {
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
    let evidence;
    try {
      evidence = parseAgentOutput(result.text, 'implement');
    } catch (error) {
      if (!(error instanceof AgentOutputError)) throw error;
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, error.message);
    }
    const noteId = await context.api.postNote(run.projectId, run.iid, formatEvidenceComment(evidence));
    // The feedback list stays on the run until the review approves: the
    // review checks the round item by item, and a request-changes round
    // still owes those items.
    return transition(run, PHASES.REVIEWING, {
      evidenceNoteId: noteId, evidence, sessionId: null, attempts: 0, reviewFindings: null,
    });
  };

  const buildMrDescription = (run) => [
    '## 关联 issue',
    '',
    `Closes #${run.iid}`,
    '',
    '## 根因',
    '',
    run.evidence?.rootCause ?? '',
    '',
    '## 改动',
    '',
    run.evidence?.changes ?? '',
    '',
    '## 验证命令与结果',
    '',
    ...(run.evidence?.verification ?? []).map((entry) => `- \`${entry.command}\`：${entry.result}`),
    '',
    '## 风险与回滚',
    '',
    run.evidence?.risks ?? '',
    '',
    '## 生成阶段',
    '',
    `${run.kind} 自动化`,
  ].join('\n');

  const handleVerifying = async (run, context) => {
    // The review verdict is what stands between the session and the push. A
    // run recorded before the review gate existed carries no verdict at all,
    // and pushing those would bypass the review, so they stop for a human
    // reset instead.
    if (run.reviewVerdict !== 'approve') {
      return blockWithComment(run, context, BLOCKED_REASONS.REVIEW_REJECTED,
        '推送前缺少通过的审核结论（可能是审核门加入前的旧运行记录）。');
    }
    if (!run.branch.startsWith(context.config.prefix)) {
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, 'Branch does not start with the configured prefix');
    }
    if (!context.endpoint) {
      return blockWithComment(run, context, BLOCKED_REASONS.MISSING_CREDENTIAL, '主远端不是 HTTPS 地址。');
    }
    const actor = await resolveActor(run);
    if (!actor) {
      return blockWithComment(run, context, BLOCKED_REASONS.MISSING_CREDENTIAL, '触发者账号不可用。');
    }
    let changes;
    try {
      changes = await workspace.hasDiffSince({
        cwd: run.worktreePath,
        baseRef: `${context.primaryRemote}/${run.targetBranch}`,
      });
    } catch (error) {
      if (error?.name === 'WorkspaceError') {
        return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, error.message);
      }
      throw error;
    }
    if (!changes) {
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, 'The branch has no diff against the target');
    }
    if (!run.evidenceNoteId) {
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, 'Evidence note is missing');
    }

    const pushCredential = await credentialFor(context, actor.account);
    let pushed;
    try {
      pushed = await workspace.pushBranch({
        cwd: run.worktreePath,
        remote: context.primaryRemote,
        branch: run.branch,
        credential: pushCredential,
      });
    } catch (error) {
      if (error?.name === 'WorkspaceError') {
        return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, error.message);
      }
      throw error;
    }

    let issue;
    let mr;
    try {
      issue = await context.api.getIssue(run.projectId, run.iid);
      const existing = await actor.api.listOpenMergeRequests(run.projectId, run.branch);
      mr = existing[0];
      if (!mr) {
        mr = await actor.api.createMergeRequest(
          run.projectId,
          run.branch,
          run.targetBranch,
          `${issue.title} (#${run.iid})`,
          buildMrDescription(run),
        );
      }
    } catch (error) {
      const status = error?.cause?.response?.status ?? error?.response?.status;
      if (unauthorized(error) || status === 403) {
        return blockWithComment(
          run, context, BLOCKED_REASONS.MISSING_CREDENTIAL,
          '触发者账号无权创建合并请求，请确认其 Developer 及以上权限和 token scope。',
        );
      }
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED,
        `无法创建合并请求：${error?.message || error}`);
    }
    await context.api.postNote(run.projectId, run.iid, formatMrComment(mr))
      .catch((error) => warn(`[gitlab-issues] MR note failed for #${run.iid}:`, error));
    // A feedback round ends with its own announcement on the MR: the pushed
    // sha is what the reviewers re-read.
    if ((run.feedbackRounds ?? 0) > 0 && pushed?.sha) {
      await context.api.postMergeRequestNote(
        run.projectId,
        mr.iid,
        formatFeedbackPushComment({ round: run.feedbackRounds, sha: pushed.sha }),
      ).catch((error) => warn(`[gitlab-issues] push note failed for #${run.iid}:`, error));
    }
    const next = await transition(run, PHASES.MR_OPEN, { mrIid: mr.iid });
    await context.api.addLabels(run.projectId, run.iid, ['ai-review'])
      .catch((error) => warn(`[gitlab-issues] ai-review label failed for #${run.iid}:`, error));
    return next;
  };

  const finishMerged = async (run, context) => {
    if (run.targetBranch !== context.defaultBranch) {
      await context.api.closeIssue(run.projectId, run.iid)
        .catch((error) => warn(`[gitlab-issues] issue close failed for #${run.iid}:`, error));
    }
    await context.api.addLabels(run.projectId, run.iid, ['ai-done'])
      .catch((error) => warn(`[gitlab-issues] ai-done label failed for #${run.iid}:`, error));
    const retained = await cleanupWorktree(run, context, `MR 已合并，但工作区有未提交改动，已保留：\`${run.worktreePath}\``);
    return ledger.update(keyOf(run), {
      phase: PHASES.DONE,
      worktreePath: retained,
      leaseUntil: null,
      since: isoNow(),
    });
  };

  const handleMrOpen = async (run, context) => {
    const actor = await resolveActor(run);
    if (!actor) {
      return blockWithComment(run, context, BLOCKED_REASONS.MISSING_CREDENTIAL, '触发者账号不可用。');
    }
    let mr;
    try {
      mr = await actor.api.getMergeRequest(run.projectId, run.mrIid);
    } catch (error) {
      if (unauthorized(error)) {
        return blockWithComment(run, context, BLOCKED_REASONS.MISSING_CREDENTIAL, '触发者账号已失效。');
      }
      const status = error?.cause?.response?.status ?? error?.response?.status;
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
    // A merged MR closes its issue through `Closes #<iid>`. Check the issue
    // only after the MR says it is still open, so the auto-close never reads
    // as a manual cancellation; a hand-closed issue ends the run as done.
    const issue = await context.api.getIssue(run.projectId, run.iid);
    if (issue.state !== 'opened') {
      await context.api.addLabels(run.projectId, run.iid, ['ai-done'])
        .catch((error) => warn(`[gitlab-issues] ai-done label failed for #${run.iid}:`, error));
      const retained = await cleanupWorktree(run, context, `issue 已关闭，工作区有未提交改动，已保留：\`${run.worktreePath}\``);
      return ledger.update(keyOf(run), {
        phase: PHASES.DONE,
        worktreePath: retained,
        leaseUntil: null,
        since: isoNow(),
      });
    }
    // The MR is still open and the issue is alive: this is where a reviewer
    // may send the run back to fix things.
    return handleFeedbackScan(run, context);
  };

  const cancelledByHuman = (run, issue) => {
    if (issue.state !== 'opened') return true;
    if (isActivePhase(run.phase) && hasLabel(issue, 'ai-blocked')) return true;
    const watchers = [
      PHASES.TRIAGING, PHASES.PLANNING, PHASES.PREPARING, PHASES.IMPLEMENTING,
      PHASES.REVIEWING, PHASES.VERIFYING, PHASES.MR_OPEN, PHASES.ADDRESSING,
    ];
    return watchers.includes(run.phase) && !hasLabel(issue, 'ai-working');
  };

  const handleCancellation = async (run, context) => {
    const issue = await context.api.getIssue(run.projectId, run.iid);
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

  const TIMED_PHASES = [
    PHASES.TRIAGING, PHASES.PLANNING, PHASES.IMPLEMENTING, PHASES.REVIEWING, PHASES.ADDRESSING,
  ];

  const handleTimeout = async (run, context) => {
    if (!TIMED_PHASES.includes(run.phase)) return false;
    const elapsed = now() - Date.parse(run.since);
    if (!Number.isFinite(elapsed) || elapsed <= context.config.timeoutMinutes * 60_000) return false;
    if (run.sessionId) {
      await sessionClient(run).session.interrupt({ sessionID: run.sessionId }).catch(() => {});
    }
    await blockWithComment(
      run,
      context,
      BLOCKED_REASONS.TIMEOUT,
      `当前阶段超过 ${context.config.timeoutMinutes} 分钟，已中止会话。`,
      { sessionId: null },
    );
    return true;
  };

  const processRun = async (run, context) => {
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
    if (run.phase === PHASES.VERIFYING) return handleVerifying(run, context);
    if (run.phase === PHASES.ADDRESSING) return handleAddressing(run, context);
  };

  const recoverRuns = async (runs, contextFor) => {
    const sessionPhases = [PHASES.PLANNING, PHASES.PREPARING, PHASES.IMPLEMENTING];
    for (const run of runs) {
      if (!isActivePhase(run.phase) || run.phase === PHASES.MR_OPEN) continue;
      if (!run.sessionId) continue;
      const context = contextFor(run);
      if (!context) continue;
      // Single-instance deployment: a lease from the previous process can
      // still be in the future, but no in-process tick owns the session.
      const alive = await sessionClient(run).session.get({ sessionID: run.sessionId })
        .then(() => true)
        .catch((error) => {
          if (error?.status === 404) return false;
          return null;
        });
      if (alive === null) continue;
      if (alive) {
        await touch(run);
        continue;
      }
      // A lost review session only needs a new review: the implementation and
      // its commit are already on the branch. Same for a feedback round — the
      // checklist is on the ledger, the branch is pushed, a fresh session
      // re-addresses the items. A lost triage session is the same shape: the
      // verdict is what the next session produces, and the branch says nothing
      // about whether the report is real.
      if (run.phase === PHASES.TRIAGING || run.phase === PHASES.REVIEWING || run.phase === PHASES.ADDRESSING) {
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
        const remote = await context.api.showBranch(run.projectId, run.branch)
          .then(() => true)
          .catch((error) => {
            const status = error?.cause?.response?.status ?? error?.response?.status;
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
      const projects = [];
      for (const project of await listProjects()) {
        const config = resolveProjectConfig(project);
        if (config.enabled) projects.push({ project, config });
      }
      if (!projects.length) return;
      if (waitForOpenCodeReady) await waitForOpenCodeReady();

      const projectContexts = [];
      const contexts = new Map();
      const byEntryId = new Map();
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
              logger.warn?.(`[gitlab-issues] context failed (${project.id}):`, error?.message || error);
            }
          }
        }
        if (context) {
          projectContexts.push(context);
          contexts.set(`${context.instance}|${context.projectId}`, context);
          byEntryId.set(String(context.project.id), context);
        }
      }
      // Two settings entries can point at the same GitLab project; the entry
      // that claimed the run wins over whichever context resolved last.
      const contextFor = (run) => (run.projectEntryId === undefined
        ? undefined
        : byEntryId.get(String(run.projectEntryId)))
        ?? contexts.get(`${run.origin}|${run.projectId}`);

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

      if (tickCount % issueScanEveryTicks !== 0) return;
      let dispatched = 0;
      const current = await ledger.list();
      let active = slotRuns(current);
      for (const context of projectContexts) {
        if (stopped || dispatched >= maxPerTick || active.length >= maxActiveGlobal) break;
        if (active.filter((run) => run.projectId === context.projectId).length >= maxActivePerProject) continue;
        try {
          const claimed = await scanProject(context);
          if (claimed) {
            dispatched += claimed;
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

  // The panel knows a session as `busy` or `idle`. A session that already ended
  // without an answer is neither: it is no longer running, and the run's phase
  // and blocked reason say what happened. Forwarding that third value fails the
  // panel's schema and hides every run in the list, not just this one.
  const sessionStatusOf = async (run) => {
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
