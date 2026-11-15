import { parseGitLabRemoteUrl } from '../gitlab/repo.js';
import { isValidGitRefName } from '../shared/git-ref.js';
import { isString } from '../shared/guards.js';
import { ACTIVE_PHASE_SET } from './machine.js';
import {
  buildIssueDescription, createClientForAccount, createGitlabIssueApi,
  labelNamesOf, resolveAccount, resolveProjectConfig,
} from './gitlab.js';

const ISSUE_KINDS = new Set(['bug', 'feature']);
const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 65_000;

const ACTIONS = new Set(['cancel', 'reset', 'approve', 'reject', 'take']);
const ACTION_PHASES = {
  cancel: ACTIVE_PHASE_SET,
  reset: new Set(['blocked']),
  approve: new Set(['waiting-approval']),
  reject: new Set(['waiting-approval']),
  take: new Set(['blocked']),
};
const COMMANDS = {
  approve: '/ai-approve',
  reject: '/ai-reject',
  take: '/ai-take',
};

/**
 * Files an issue through the project's configured bot account. The visual
 * dialog is a confirmation step, not a second automation entry: the issue is
 * created without `ai-ready`, so a person still decides when the dispatcher
 * picks it up.
 */
export const registerGitlabIssueRoutes = (app, dependencies) => {
  const {
    readProjects,
    bindingService,
    authStore,
    normalizeDirectoryPath,
    dispatcher,
    apiFactory = ({ origin, account }) => createGitlabIssueApi({
      client: createClientForAccount(origin, account),
    }),
    logger = console,
  } = dependencies;

  // The settings sanitizer stores a Windows path with backslashes; the UI sends
  // the same directory with forward slashes. Compare one spelling of both.
  const canonicalDirectory = (value) => {
    const normalized = normalizeDirectoryPath(value);
    if (!isString(normalized)) return null;
    return normalized.trim().replace(/\\/g, '/').replace(/\/+$/, '') || null;
  };

  const findProject = async (directory) => {
    const wanted = canonicalDirectory(directory);
    if (!wanted) return null;
    const projects = await readProjects();
    return projects.find((project) => canonicalDirectory(project?.path) === wanted) ?? null;
  };

  const resolveTarget = async (project, config) => {
    const bindingRead = await bindingService.get(project.path);
    const provider = (bindingRead?.binding?.providers ?? []).find((entry) => (
      entry?.provider === 'gitlab' && entry.readiness === 'ready'
    ));
    if (!provider?.instance) return { error: 'not-gitlab-project' };
    const remote = (bindingRead?.repository?.remotes ?? []).find((entry) => (
      entry?.name === provider.primaryRemote
    ));
    const remoteUrl = remote?.fetch?.displayUrl ?? provider.endpoint?.displayUrl ?? '';
    const parsed = parseGitLabRemoteUrl(remoteUrl, provider.instance);
    if (!parsed) return { error: 'not-gitlab-project' };
    if (!config.botAccountId) return { error: 'bot-account-missing' };
    const account = await resolveAccount(authStore, provider.instance, config.botAccountId);
    if (!account) return { error: 'bot-account-unusable' };
    return {
      origin: provider.instance,
      account,
      projectPath: parsed.projectPath,
      api: apiFactory({ origin: provider.instance, account }),
    };
  };

  app.post('/api/gitlab-issues', async (req, res) => {
    const body = req.body ?? {};
    const directory = isString(body.directory) ? body.directory.trim() : '';
    if (!directory) {
      return res.status(400).json({ error: 'invalid-directory' });
    }

    const kind = isString(body.kind) ? body.kind.trim().toLowerCase() : '';
    if (!ISSUE_KINDS.has(kind)) {
      return res.status(400).json({ error: 'invalid-kind' });
    }

    const title = isString(body.title) ? body.title.trim() : '';
    if (!title || title.length > MAX_TITLE_LENGTH || /[\r\n]/.test(title)) {
      return res.status(400).json({ error: 'invalid-title' });
    }

    const targetBranch = isString(body.targetBranch) ? body.targetBranch.trim() : '';
    // A backtick would end the delimited `目标分支:` value the dispatcher parses.
    if (targetBranch && (!isValidGitRefName(targetBranch) || targetBranch.includes('`'))) {
      return res.status(400).json({ error: 'invalid-branch' });
    }

    const description = isString(body.description) ? body.description : '';
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return res.status(413).json({ error: 'description-too-large' });
    }

    let target;
    try {
      const project = await findProject(directory);
      if (!project) {
        return res.status(404).json({ error: 'project-not-found' });
      }
      target = await resolveTarget(project, resolveProjectConfig(project));
    } catch (error) {
      // The whole error can carry the authenticated request (and its token).
      logger.warn?.('[gitlab-issues] lookup failed:', error?.message || error);
      return res.status(500).json({ error: 'lookup-failed' });
    }
    if (target.error) {
      return res.status(409).json({ error: target.error });
    }

    try {
      const issue = await target.api.createIssue(
        target.projectPath,
        title,
        buildIssueDescription({ kind, targetBranch, description }),
      );
      return res.status(201).json({
        iid: issue?.iid ?? null,
        webUrl: issue?.web_url ?? null,
        projectPath: target.projectPath,
      });
    } catch (error) {
      logger.warn?.('[gitlab-issues] create failed:', error?.message || error);
      return res.status(502).json({ error: 'gitlab-request-failed' });
    }
  });

  // The branches an issue may target, default branch first. The dialog reads
  // this so a typed target cannot name a ref the instance does not have, which
  // would otherwise claim the issue and block it with `branch-missing`.
  app.get('/api/gitlab-issues/branches', async (req, res) => {
    const directory = isString(req.query?.directory) ? req.query.directory.trim() : '';
    if (!directory) {
      return res.status(400).json({ error: 'invalid-directory' });
    }
    try {
      const project = await findProject(directory);
      if (!project) return res.status(404).json({ error: 'project-not-found' });
      const target = await resolveTarget(project, resolveProjectConfig(project));
      if (target.error) return res.status(409).json({ error: target.error });
      const info = await target.api.getProject(target.projectPath);
      const listed = await target.api.listBranches(info.id, '');
      const names = (Array.isArray(listed) ? listed : [])
        .map((entry) => entry?.name)
        .filter(isString);
      const defaultBranch = isString(info.default_branch) && info.default_branch ? info.default_branch : null;
      const branches = defaultBranch && names.includes(defaultBranch)
        ? [defaultBranch, ...names.filter((name) => name !== defaultBranch)]
        : names;
      return res.json({ defaultBranch, branches });
    } catch (error) {
      logger.warn?.('[gitlab-issues] branch lookup failed:', error?.message || error);
      return res.status(502).json({ error: 'gitlab-request-failed' });
    }
  });

  // The project's instance and path, without requiring a usable bot account:
  // the panel must still read and act when the bot token is what broke.
  const resolveInstanceProject = async (project) => {
    const bindingRead = await bindingService.get(project.path);
    const provider = (bindingRead?.binding?.providers ?? []).find((entry) => (
      entry?.provider === 'gitlab' && entry.readiness === 'ready'
    ));
    if (!provider?.instance) return null;
    const remote = (bindingRead?.repository?.remotes ?? []).find((entry) => (
      entry?.name === provider.primaryRemote
    ));
    const remoteUrl = remote?.fetch?.displayUrl ?? provider.endpoint?.displayUrl ?? '';
    const parsed = parseGitLabRemoteUrl(remoteUrl, provider.instance);
    if (!parsed) return null;
    return { instance: provider.instance, projectPath: parsed.projectPath };
  };

  // The links this route hands the panel are built without the `/-/` scope
  // separator, because that is the form the instance itself answers with: a
  // GitLab 12.7 deployment (UnionTech UOS intranet) serves
  // `/group/repo/issues/4` and 404s on `/group/repo/-/issues/4`, while a newer
  // one redirects the short form to the `/-/` one. GitLab's own API returns the
  // short form as `web_url` on both.
  const issueUrlOf = (run) => (isString(run.projectPath) && Number.isInteger(run.iid)
    ? `${run.origin}/${run.projectPath}/issues/${run.iid}`
    : null);
  const mrUrlOf = (run) => (isString(run.projectPath) && Number.isInteger(run.mrIid)
    ? `${run.origin}/${run.projectPath}/merge_requests/${run.mrIid}`
    : null);

  const runViewKey = (run) => `${run.origin}|${run.projectId}|${run.iid}`;

  // A run's entry holds what the dispatcher decided, never the issue's own
  // state, so the column the panel puts on the right is read from GitLab. It is
  // cached briefly because the list polls every ten seconds, and a failed read
  // answers "unknown" — a made-up state is worse than a missing one.
  const ISSUE_STATE_TTL_MS = 60_000;
  const issueStateCache = new Map();

  const issueStateOf = async (api, run) => {
    const cached = issueStateCache.get(runViewKey(run));
    if (cached && Date.now() - cached.at < ISSUE_STATE_TTL_MS) return cached.value;
    try {
      const issue = await api.getIssue(run.projectId, run.iid);
      const raw = isString(issue?.state) ? issue.state : '';
      const value = {
        state: raw === 'opened' || raw === 'closed' ? raw : null,
        labels: labelNamesOf(issue),
      };
      issueStateCache.set(runViewKey(run), { at: Date.now(), value });
      if (issueStateCache.size > 200) issueStateCache.clear();
      return value;
    } catch (error) {
      logger.warn?.(`[gitlab-issues] issue state read failed for #${run.iid}:`, error?.message || error);
      return cached?.value ?? null;
    }
  };

  // The bot reads when a project has one, the triggerer otherwise: both have
  // seen the issue, and neither is asked for a permission it never needed.
  const issueStatesOf = async (runs) => {
    const states = new Map();
    if (runs.length === 0) return states;
    const projects = await readProjects().catch(() => []);
    const byEntryId = new Map(projects.map((project) => [String(project.id), project]));
    const apis = new Map();
    await Promise.all(runs.map(async (run) => {
      const project = byEntryId.get(String(run.projectEntryId)) ?? null;
      const config = project ? resolveProjectConfig(project) : null;
      const accountId = config?.botAccountId || run.actorAccountId;
      if (!accountId) return;
      const apiKey = `${run.origin}|${accountId}`;
      let api = apis.get(apiKey);
      if (!api) {
        const account = await resolveAccount(authStore, run.origin, accountId).catch(() => null);
        if (!account) return;
        api = apiFactory({ origin: run.origin, account });
        apis.set(apiKey, api);
      }
      const state = await issueStateOf(api, run);
      if (state) states.set(runViewKey(run), state);
    }));
    return states;
  };

  const toRunView = async (run, issueState) => {
    const holdsSession = ACTIVE_PHASE_SET.has(run.phase) && isString(run.sessionId);
    return {
      key: `${run.origin}|${run.projectId}|${run.iid}`,
      origin: run.origin,
      projectEntryId: run.projectEntryId ?? null,
      iid: run.iid,
      title: run.title ?? null,
      kind: run.kind ?? null,
      phase: run.phase,
      blockedReason: run.blockedReason ?? null,
      blockedFrom: run.blockedFrom ?? null,
      lastError: run.lastError ?? null,
      branch: run.branch ?? null,
      targetBranch: run.targetBranch ?? null,
      mrIid: run.mrIid ?? null,
      issueUrl: issueUrlOf(run),
      mrUrl: mrUrlOf(run),
      attempts: run.attempts ?? 0,
      reviewRounds: run.reviewRounds ?? 0,
      // How many comment-driven fix rounds an open MR has been through; the
      // panel shows the count next to the rail. Optional-read like the other
      // counters so a ledger written before the field still lists.
      feedbackRounds: run.feedbackRounds ?? 0,
      reviewVerdict: run.reviewVerdict ?? null,
      triageVerdict: run.triageVerdict ?? null,
      // Set only for a run that ended without a merge request: the panel needs
      // it to tell a closed-as-not-an-issue run from a merged one.
      outcome: run.outcome ?? null,
      since: run.since ?? null,
      updatedAt: run.updatedAt ?? null,
      sessionId: run.sessionId ?? null,
      sessionStatus: holdsSession ? await dispatcher.sessionStatus(run).catch(() => null) : null,
      // The sessions behind each stop, oldest first: the fix, and one per review
      // round. A phase clears `sessionId` as it moves on, so this is the only
      // trail the panel can offer for the work that already happened.
      sessions: Array.isArray(run.sessions)
        ? run.sessions
          .filter((session) => isString(session?.sessionId))
          .map((session) => ({
            sessionId: session.sessionId,
            stage: isString(session.stage) ? session.stage : null,
            at: isString(session.at) ? session.at : null,
          }))
        : [],
      events: Array.isArray(run.events) ? run.events : [],
      issueState: issueState ?? null,
    };
  };

  app.get('/api/gitlab-issues/runs', async (req, res) => {
    const directory = isString(req.query?.directory) ? req.query.directory.trim() : '';
    let runs;
    try {
      runs = await dispatcher.ledger.list();
    } catch (error) {
      // A failed ledger read is an error, never an empty list.
      logger.warn?.('[gitlab-issues] ledger read failed:', error?.message || error);
      return res.status(500).json({ error: 'ledger-unreadable' });
    }
    try {
      if (directory) {
        const project = await findProject(directory);
        if (!project) return res.status(404).json({ error: 'project-not-found' });
        const target = await resolveInstanceProject(project);
        if (!target) return res.status(409).json({ error: 'not-gitlab-project' });
        const config = resolveProjectConfig(project);
        const account = config.botAccountId
          ? await resolveAccount(authStore, target.instance, config.botAccountId)
          : null;
        const scoped = runs.filter((run) => run.origin === target.instance
          && (run.projectEntryId === project.id || run.projectPath === target.projectPath));
        const states = await issueStatesOf(scoped);
        return res.json({
          bot: {
            status: !config.botAccountId ? 'missing' : account ? 'valid' : 'invalid',
            accountId: config.botAccountId || null,
          },
          runs: await Promise.all(scoped.map((run) => toRunView(run, states.get(runViewKey(run)) ?? null))),
        });
      }
      const enabled = (await readProjects()).filter((project) => resolveProjectConfig(project).enabled);
      const byEntryId = new Map(enabled.map((project) => [String(project.id), project]));
      const scoped = runs.filter((run) => run.phase !== 'done' && byEntryId.has(String(run.projectEntryId)));
      const states = await issueStatesOf(scoped);
      return res.json({
        runs: await Promise.all(scoped.map((run) => toRunView(run, states.get(runViewKey(run)) ?? null))),
      });
    } catch (error) {
      logger.warn?.('[gitlab-issues] runs read failed:', error?.message || error);
      return res.status(500).json({ error: 'runs-unavailable' });
    }
  });

  app.post('/api/gitlab-issues/runs/action', async (req, res) => {
    const body = req.body ?? {};
    const directory = isString(body.directory) ? body.directory.trim() : '';
    const action = isString(body.action) ? body.action.trim() : '';
    const key = isString(body.key) ? body.key.trim() : '';
    const accountId = isString(body.accountId) ? body.accountId.trim() : '';
    if (!ACTIONS.has(action)) return res.status(400).json({ error: 'invalid-action' });
    if (!key || !accountId) return res.status(400).json({ error: 'invalid-request' });

    try {
      const project = await findProject(directory);
      if (!project) return res.status(404).json({ error: 'project-not-found' });
      const target = await resolveInstanceProject(project);
      if (!target) return res.status(409).json({ error: 'not-gitlab-project' });
      const run = await dispatcher.ledger.get(key);
      if (!run || run.origin !== target.instance) return res.status(404).json({ error: 'unknown-run' });
      if (!ACTION_PHASES[action].has(run.phase)) {
        return res.status(409).json({ error: 'phase-mismatch', phase: run.phase });
      }
      if (action === 'take' && run.blockedReason !== 'missing-credential') {
        return res.status(409).json({ error: 'phase-mismatch', phase: run.phase });
      }
      if (accountId === project.gitlabIssueBotAccountId) {
        return res.status(403).json({ error: 'account-is-bot' });
      }
      const accounts = await authStore.listAccounts(run.origin);
      const acting = accounts.find((entry) => entry?.credentialId === accountId && entry?.status === 'valid');
      if (!acting) return res.status(409).json({ error: 'account-unbound' });
      const api = apiFactory({ origin: run.origin, account: acting });
      const level = Number.isInteger(acting.user?.id)
        ? await api.accessLevelOf(run.projectId, acting.user.id)
        : 0;
      if (level < 30) return res.status(403).json({ error: 'insufficient-access' });

      if (action === 'cancel') {
        await api.addLabels(run.projectId, run.iid, ['ai-blocked']);
        await api.removeLabels(run.projectId, run.iid, ['ai-working']);
      } else if (action === 'reset') {
        await api.removeLabels(run.projectId, run.iid, ['ai-blocked']);
        await api.addLabels(run.projectId, run.iid, ['ai-ready']);
      } else {
        // Comment commands are read by the dispatcher as the acting user, so
        // the run's triggerer and the audit trail stay with that account.
        await api.postNote(run.projectId, run.iid, COMMANDS[action]);
      }
      return res.json({ ok: true });
    } catch (error) {
      logger.warn?.('[gitlab-issues] run action failed:', error?.message || error);
      return res.status(502).json({ error: 'gitlab-request-failed' });
    }
  });
};
