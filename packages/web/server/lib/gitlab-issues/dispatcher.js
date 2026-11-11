import { parseGitLabRemoteUrl } from '../gitlab/repo.js';
import { isRecord, isString } from '../shared/guards.js';
import {
  BLOCKED_REASONS, PHASES, canTransition, isActivePhase,
} from './machine.js';
import {
  TemplateError, assistantText, buildIssueBranch, findAccountForUser, matchReusableBranch,
  parseIssueTemplate, resolveAccount, resolveProjectConfig,
} from './gitlab.js';
import { createGitlabIssueLedger, ledgerKey } from './ledger.js';
import {
  AgentOutputError, buildImplementPrompt, buildPlanPrompt, formatBlockedComment,
  formatEvidenceComment, formatMrComment, formatPlanComment, parseAgentOutput,
} from './prompts.js';

const BUSY_LABELS = ['ai-working', 'ai-plan-review', 'ai-review', 'ai-blocked', 'ai-done'];
const DEFAULT_STARTUP_DELAY_MS = 30_000;
const DEFAULT_TICK_INTERVAL_MS = 10_000;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 2;
// A run occupies a dispatch slot while it holds a session or waits for a
// human. An open MR belongs to its reviewers, so it does not keep the
// project from picking up the next issue.
const SLOT_PHASES = Object.freeze([
  PHASES.CLAIMED, PHASES.PLANNING, PHASES.WAITING_APPROVAL,
  PHASES.PREPARING, PHASES.IMPLEMENTING, PHASES.VERIFYING,
]);

const labelNames = (issue) => (Array.isArray(issue?.labels) ? issue.labels : [])
  .map((label) => (isString(label) ? label : label?.name))
  .filter(Boolean);
const hasLabel = (issue, name) => labelNames(issue).includes(name);
const unauthorized = (error) => error?.cause?.response?.status === 401
  || error?.response?.status === 401 || error?.status === 401;

const endpointForRemote = (rawUrl) => {
  let url;
  try {
    url = new URL(String(rawUrl ?? ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return { protocol: 'https', host: url.hostname, port: Number(url.port) || 443, path: url.pathname };
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

  const transition = async (run, to, patch = {}) => {
    if (!canTransition(run.phase, to)) throw new Error(`Illegal transition ${run.phase} -> ${to}`);
    return ledger.update(keyOf(run), {
      phase: to,
      since: isoNow(),
      lastError: null,
      leaseUntil: new Date(now() + leaseMs).toISOString(),
      ...patch,
    });
  };

  const block = async (run, reason, detail = '', patch = {}) => ledger.update(keyOf(run), {
    phase: PHASES.BLOCKED,
    blockedReason: reason,
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
    const assistant = records.find((record) => record?.type === 'assistant' && assistantText(record).length > 0);
    return {
      status: 'idle',
      text: assistantText(assistant),
      completedAt: Number.isFinite(assistant?.time?.completed) ? assistant.time.completed : null,
    };
  };

  const sessionFinished = (run, result) => result.status === 'idle'
    && Number.isFinite(result.completedAt)
    && result.completedAt >= Date.parse(run.since);

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
    if ((run.attempts ?? 0) >= MAX_ATTEMPTS) {
      return failRun(run, context, BLOCKED_REASONS.REPEATED_ERROR, 'Attempt limit reached');
    }
    const client = sessionClient(run);
    const issue = await context.api.getIssue(run.projectId, run.iid);
    const actor = await resolveAccount(authStore, run.origin, run.actorAccountId);
    if (!actor) {
      return blockWithComment(run, context, BLOCKED_REASONS.MISSING_CREDENTIAL, '触发者账号不可用。');
    }
    const title = `#${run.iid}: ${String(issue?.title ?? '').replace(/\s+/g, ' ').trim()}`;
    const payload = { title, location: { directory: run.worktreePath } };
    const modelRef = isString(context.project.defaultModel)
      ? context.project.defaultModel.split('/', 2)
      : null;
    if (modelRef?.length === 2 && modelRef[0] && modelRef[1]) {
      payload.model = { providerID: modelRef[0], id: modelRef[1] };
      if (context.project.defaultVariant) payload.model.variant = context.project.defaultVariant;
    }
    if (context.project.defaultAgent) payload.agent = context.project.defaultAgent;
    const session = await client.session.create(payload);
    const sessionID = session?.data?.id ?? session?.id;
    if (!sessionID) throw new Error('failed to create session');
    await ledger.update(keyOf(run), {
      sessionId: sessionID,
      phase: stage === 'plan' ? PHASES.PLANNING : PHASES.IMPLEMENTING,
      since: isoNow(),
      attempts: (run.attempts ?? 0) + 1,
      leaseUntil: new Date(now() + leaseMs).toISOString(),
    });
    const text = stage === 'plan'
      ? buildPlanPrompt({
        issue, iid: run.iid, projectPath: run.worktreePath, actorLogin: actor.user.login,
      })
      : buildImplementPrompt({
        issue,
        iid: run.iid,
        projectPath: run.worktreePath,
        actorLogin: actor.user.login,
        branch: run.branch,
        targetBranch: run.targetBranch,
      });
    try {
      await client.session.prompt({ sessionID, text });
    } catch (error) {
      // The session exists but never received the work; clear the id so the
      // next tick starts a fresh one instead of polling an empty session.
      await client.session.abort({ sessionID }).catch(() => {});
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
    const labels = labelNames(fresh);
    if (fresh.state !== 'opened' || !labels.includes('ai-ready')
      || labels.some((label) => BUSY_LABELS.includes(label))) return false;
    const key = ledgerKey(context.instance, context.projectId, fresh.iid);
    if (await ledger.get(key)) return false;

    const baseEntry = {
      origin: context.instance,
      projectEntryId: context.project.id,
      projectId: context.projectId,
      iid: fresh.iid,
      kind: null,
      phase: PHASES.BLOCKED,
      targetBranch: '',
      branch: '',
      actorUserId: null,
      actorAccountId: null,
      sessionId: null,
      worktreePath: null,
      mrIid: null,
      attempts: 0,
      leaseUntil: null,
      since: isoNow(),
      updatedAt: isoNow(),
      lastError: null,
      blockedReason: null,
      approvalNoteId: null,
      planNoteId: null,
      evidenceNoteId: null,
      evidence: null,
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

    const triggerer = await context.api.latestTriggerer(context.projectId, fresh.iid, context.botUserId);
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
    return transition(prepared, prepared.kind === 'feature' ? PHASES.PLANNING : PHASES.PREPARING);
  };

  const handlePreparing = async (run, context) => startSession(run, context, 'implement');

  const handlePlanning = async (run, context) => {
    if (!run.sessionId) {
      const prepared = run.worktreePath ? run : await ensureWorktree(run, context);
      if (prepared.phase === PHASES.BLOCKED) return prepared;
      return startSession(prepared, context, 'plan');
    }
    const result = await readSessionResult(sessionClient(run), run.sessionId);
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
    const next = await transition(run, PHASES.PREPARING, {
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
    if (!sessionFinished(run, result)) return;
    let evidence;
    try {
      evidence = parseAgentOutput(result.text, 'implement');
    } catch (error) {
      if (!(error instanceof AgentOutputError)) throw error;
      return failRun(run, context, BLOCKED_REASONS.VERIFICATION_FAILED, error.message);
    }
    const noteId = await context.api.postNote(run.projectId, run.iid, formatEvidenceComment(evidence));
    return transition(run, PHASES.VERIFYING, { evidenceNoteId: noteId, evidence });
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
    try {
      await workspace.pushBranch({
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
    return false;
  };

  const cancelledByHuman = (run, issue) => {
    if (issue.state !== 'opened') return true;
    if (isActivePhase(run.phase) && hasLabel(issue, 'ai-blocked')) return true;
    const watchers = [PHASES.PLANNING, PHASES.PREPARING, PHASES.IMPLEMENTING, PHASES.VERIFYING, PHASES.MR_OPEN];
    return watchers.includes(run.phase) && !hasLabel(issue, 'ai-working');
  };

  const handleCancellation = async (run, context) => {
    const issue = await context.api.getIssue(run.projectId, run.iid);
    if (!cancelledByHuman(run, issue)) return false;
    if (run.sessionId) {
      await sessionClient(run).session.abort({ sessionID: run.sessionId }).catch(() => {});
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

  const handleTimeout = async (run, context) => {
    if (run.phase !== PHASES.IMPLEMENTING) return false;
    const elapsed = now() - Date.parse(run.since);
    if (!Number.isFinite(elapsed) || elapsed <= context.config.timeoutMinutes * 60_000) return false;
    if (run.sessionId) {
      await sessionClient(run).session.abort({ sessionID: run.sessionId }).catch(() => {});
    }
    await blockWithComment(
      run,
      context,
      BLOCKED_REASONS.TIMEOUT,
      `实现阶段超过 ${context.config.timeoutMinutes} 分钟。`,
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
    if (run.phase === PHASES.PLANNING) return handlePlanning(run, context);
    if (run.phase === PHASES.WAITING_APPROVAL) return handleWaitingApproval(run, context);
    if (run.phase === PHASES.IMPLEMENTING) return handleImplementing(run, context);
    if (run.phase === PHASES.VERIFYING) return handleVerifying(run, context);
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

  return {
    tick,
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
