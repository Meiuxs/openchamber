import { parseGitLabRemoteUrl } from '../gitlab/repo.js';
import { isValidGitRefName } from '../shared/git-ref.js';
import { isPlainObject, isRecord, isString } from '../shared/guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { Application, Request, Response } from '../shared/http-contracts.js';
import type { SettingsProject } from '../settings/settings-normalization-runtime.js';
import type { AuthCredential, createSourceControlAuthStore } from '../source-control/auth-storage.js';
import type { registerSourceControlRoutes } from '../source-control/routes.js';
import type { BindingRead } from '../source-control/binding-service-contracts.js';
import type { createGitlabIssueDispatcher } from './dispatcher.js';
import { ACTIVE_PHASE_SET } from './machine.js';
import {
  buildIssueDescription, createClientForAccount, createGitlabIssueApi,
  labelNamesOf, resolveAccount, resolveProjectConfig,
} from './gitlab.js';
import type { GitlabIssueApi } from './gitlab.js';
import type { RunEntry } from './ledger.js';
import { issueUrlOf, mrUrlOf, recordExists, recordLocationFor } from './record.js';

const ISSUE_KINDS = new Set(['bug', 'feature']);
const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 65_000;

const ACTIONS = new Set(['cancel', 'reset', 'approve', 'reject', 'take']);
const ACTION_PHASES: Record<string, ReadonlySet<string>> = Object.freeze({
  cancel: ACTIVE_PHASE_SET,
  reset: new Set(['blocked']),
  approve: new Set(['waiting-approval']),
  reject: new Set(['waiting-approval']),
  take: new Set(['blocked']),
});
const COMMANDS: Record<string, string> = Object.freeze({
  approve: '/ai-approve',
  reject: '/ai-reject',
  take: '/ai-take',
});

type Dispatcher = ReturnType<typeof createGitlabIssueDispatcher>;
type AuthStore = ReturnType<typeof createSourceControlAuthStore>;
type BindingService = ReturnType<typeof registerSourceControlRoutes>;

interface ErrorFields {
  message?: unknown;
}

const isErrorFields = (error: unknown): error is ErrorFields => isPlainObject(error);
const errorMessage = <Value>(error: Value) => {
  const fields: ErrorFields | null = isErrorFields(error) ? error : null;
  return isString(fields?.message) ? fields.message : String(error);
};

const isJsonRecord = (value: unknown): value is JsonObject => isPlainObject(value);
const bodyOf = <Value>(value: Value): JsonObject => (isJsonRecord(value) ? value : {});
const asText = <Value>(value: Value) => (isString(value) ? value : '');
const asId = (value: JsonValue | undefined): string | number => {
  if (isString(value)) return value;
  if (Number.isInteger(value)) {
    // SAFETY: Number.isInteger confirms an integer number at runtime.
    return value as number;
  }
  return 0;
};

interface IssueState {
  state: string | null;
  labels: string[];
}

export interface GitlabIssueRouteDependencies {
  readProjects: () => Promise<SettingsProject[]>;
  bindingService: BindingService;
  authStore: AuthStore;
  normalizeDirectoryPath: (value: string) => string;
  dispatcher: Dispatcher;
  apiFactory?: ((input: { origin: string; account: AuthCredential }) => GitlabIssueApi) | undefined;
  logger?: Pick<Console, 'warn'> | undefined;
}

export const registerGitlabIssueRoutes = (app: Application, dependencies: GitlabIssueRouteDependencies) => {
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

  const canonicalDirectory = (value: string | null | undefined) => {
    const normalized = normalizeDirectoryPath(value ?? '');
    if (!isString(normalized)) return null;
    return normalized.trim().replace(/\\/g, '/').replace(/\/+$/, '') || null;
  };

  const findProject = async (directory: string) => {
    const wanted = canonicalDirectory(directory);
    if (!wanted) return null;
    const projects = await readProjects();
    return projects.find((project) => canonicalDirectory(project?.path) === wanted) ?? null;
  };

  const readBindingOrNull = async (path: string): Promise<BindingRead | null> => {
    try {
      return await bindingService.get(path);
    } catch (error) {
      const code = isRecord(error) ? error.code : null;
      if (code === 'UNSUPPORTED_SOURCE_CONTROL_REPOSITORY') return null;
      throw error;
    }
  };

  const resolveTarget = async (project: SettingsProject, config: ReturnType<typeof resolveProjectConfig>) => {
    const bindingRead: BindingRead | null = await readBindingOrNull(project.path);
    const provider = (bindingRead?.binding?.providers ?? []).find((entry) => (
      entry?.provider === 'gitlab' && entry.readiness === 'ready'
    ));
    if (!provider?.instance) return { error: 'not-gitlab-project' };
    const remote = (bindingRead?.repository?.remotes ?? []).find((entry) => (
      entry?.name === provider.primaryRemote
    ));
    const remoteUrl = asText(remote?.fetch?.displayUrl ?? provider.endpoint?.displayUrl ?? '');
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

  app.post('/api/gitlab-issues', async (req: Request, res: Response) => {
    const body = bodyOf(req.body);
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
      logger.warn?.('[gitlab-issues] lookup failed:', errorMessage(error));
      return res.status(500).json({ error: 'lookup-failed' });
    }
    if ('error' in target) {
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
      logger.warn?.('[gitlab-issues] create failed:', errorMessage(error));
      return res.status(502).json({ error: 'gitlab-request-failed' });
    }
  });

  app.get('/api/gitlab-issues/branches', async (req: Request, res: Response) => {
    const directory = isString(req.query?.directory) ? req.query.directory.trim() : '';
    if (!directory) {
      return res.status(400).json({ error: 'invalid-directory' });
    }
    try {
      const project = await findProject(directory);
      if (!project) return res.status(404).json({ error: 'project-not-found' });
      const target = await resolveTarget(project, resolveProjectConfig(project));
      if ('error' in target) return res.status(409).json({ error: target.error });
      const info = await target.api.getProject(target.projectPath);
      const listed = await target.api.listBranches(asId(info.id), '');
      const names = (Array.isArray(listed) ? listed : [])
        .map((entry) => entry?.name)
        .filter(isString);
      const defaultBranch = isString(info.default_branch) && info.default_branch ? info.default_branch : null;
      const branches = defaultBranch && names.includes(defaultBranch)
        ? [defaultBranch, ...names.filter((name) => name !== defaultBranch)]
        : names;
      return res.json({ defaultBranch, branches });
    } catch (error) {
      logger.warn?.('[gitlab-issues] branch lookup failed:', errorMessage(error));
      return res.status(502).json({ error: 'gitlab-request-failed' });
    }
  });

  const resolveInstanceProject = async (project: SettingsProject) => {
    const bindingRead: BindingRead | null = await readBindingOrNull(project.path);
    const provider = (bindingRead?.binding?.providers ?? []).find((entry) => (
      entry?.provider === 'gitlab' && entry.readiness === 'ready'
    ));
    if (!provider?.instance) return null;
    const remote = (bindingRead?.repository?.remotes ?? []).find((entry) => (
      entry?.name === provider.primaryRemote
    ));
    const remoteUrl = asText(remote?.fetch?.displayUrl ?? provider.endpoint?.displayUrl ?? '');
    const parsed = parseGitLabRemoteUrl(remoteUrl, provider.instance);
    if (!parsed) return null;
    return { instance: provider.instance, projectPath: parsed.projectPath };
  };

  const runViewKey = (run: RunEntry) => `${run.origin}|${run.projectId}|${run.iid}`;

  const ISSUE_STATE_TTL_MS = 60_000;
  const issueStateCache = new Map<string, { at: number; value: IssueState }>();

  const issueStateOf = async (api: GitlabIssueApi, run: RunEntry) => {
    const cached = issueStateCache.get(runViewKey(run));
    if (cached && Date.now() - cached.at < ISSUE_STATE_TTL_MS) return cached.value;
    try {
      const issue = await api.getIssue(run.projectId, run.iid);
      const raw = isString(issue?.state) ? issue.state : '';
      const value: IssueState = {
        state: raw === 'opened' || raw === 'closed' ? raw : null,
        labels: labelNamesOf(issue),
      };
      issueStateCache.set(runViewKey(run), { at: Date.now(), value });
      if (issueStateCache.size > 200) issueStateCache.clear();
      return value;
    } catch (error) {
      logger.warn?.(`[gitlab-issues] issue state read failed for #${run.iid}:`, errorMessage(error));
      return cached?.value ?? null;
    }
  };

  const issueStatesOf = async (runs: RunEntry[]) => {
    const states = new Map<string, IssueState>();
    if (runs.length === 0) return states;
    const projects = await readProjects().catch(() => []);
    const byEntryId = new Map(projects.map((project) => [String(project.id), project]));
    const apis = new Map<string, GitlabIssueApi>();
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

  const recordPathOf = async (run: RunEntry, projectDirectory: string | null) => {
    if (!projectDirectory) return null;
    const location = recordLocationFor({
      checkoutPath: projectDirectory,
      projectPath: run.projectPath ?? '',
      iid: run.iid,
    });
    return recordExists(location).catch(() => null);
  };

  const toRunView = async (run: RunEntry, issueState: IssueState | null, projectDirectory: string | null) => {
    const holdsSession = ACTIVE_PHASE_SET.has(run.phase) && isString(run.sessionId);
    const recordPath = await recordPathOf(run, projectDirectory);
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
      worktreePath: run.worktreePath ?? null,
      mrIid: run.mrIid ?? null,
      issueUrl: issueUrlOf(run),
      mrUrl: mrUrlOf(run),
      recordPath: recordPath ?? null,
      projectDirectory: recordPath ? projectDirectory : null,
      attempts: run.attempts ?? 0,
      reviewRounds: run.reviewRounds ?? 0,
      feedbackRounds: run.feedbackRounds ?? 0,
      reviewVerdict: run.reviewVerdict ?? null,
      reviewFindings: run.reviewFindings ?? null,
      reviewImpact: run.reviewImpact ?? null,
      triageVerdict: run.triageVerdict ?? null,
      triage: run.triage ?? null,
      plan: run.plan ?? null,
      evidence: run.evidence ?? null,
      outcome: run.outcome ?? null,
      since: run.since ?? null,
      updatedAt: run.updatedAt ?? null,
      sessionId: run.sessionId ?? null,
      sessionStatus: holdsSession ? await dispatcher.sessionStatus(run).catch(() => null) : null,
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

  app.get('/api/gitlab-issues/runs', async (req: Request, res: Response) => {
    const directory = isString(req.query?.directory) ? req.query.directory.trim() : '';
    const includeDone = req.query?.includeDone === '1';
    let runs: RunEntry[];
    try {
      runs = await dispatcher.ledger.list();
    } catch (error) {
      logger.warn?.('[gitlab-issues] ledger read failed:', errorMessage(error));
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
          runs: await Promise.all(scoped.map((run) => toRunView(run, states.get(runViewKey(run)) ?? null, project.path))),
        });
      }
      const enabled = (await readProjects()).filter((project) => resolveProjectConfig(project).enabled);
      const byEntryId = new Map(enabled.map((project) => [String(project.id), project]));
      const scoped = runs.filter((run) => (includeDone || run.phase !== 'done') && byEntryId.has(String(run.projectEntryId)));
      const states = await issueStatesOf(scoped);
      return res.json({
        runs: await Promise.all(scoped.map((run) => toRunView(
          run,
          states.get(runViewKey(run)) ?? null,
          byEntryId.get(String(run.projectEntryId))?.path ?? null,
        ))),
      });
    } catch (error) {
      logger.warn?.('[gitlab-issues] runs read failed:', errorMessage(error));
      return res.status(500).json({ error: 'runs-unavailable' });
    }
  });

  app.post('/api/gitlab-issues/runs/action', async (req: Request, res: Response) => {
    const body = bodyOf(req.body);
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
      if (!ACTION_PHASES[action]?.has(run.phase)) {
        return res.status(409).json({ error: 'phase-mismatch', phase: run.phase });
      }
      if (action === 'take' && run.blockedReason !== 'missing-credential') {
        return res.status(409).json({ error: 'phase-mismatch', phase: run.phase });
      }
      const accounts = await authStore.listAccounts(run.origin);
      const acting = accounts.find((entry) => entry?.credentialId === accountId && entry?.status === 'valid');
      if (!acting) return res.status(409).json({ error: 'account-unbound' });
      const api = apiFactory({ origin: run.origin, account: acting });
      const level = Number.isInteger(acting.user?.id)
        ? await api.accessLevelOf(run.projectId, Number(acting.user.id))
        : 0;
      if (level < 30) return res.status(403).json({ error: 'insufficient-access' });

      if (action === 'cancel') {
        await api.addLabels(run.projectId, run.iid, ['ai-blocked']);
        await api.removeLabels(run.projectId, run.iid, ['ai-working']);
      } else if (action === 'reset') {
        await api.removeLabels(run.projectId, run.iid, ['ai-blocked']);
        await api.addLabels(run.projectId, run.iid, ['ai-ready']);
      } else {
        await api.postNote(run.projectId, run.iid, COMMANDS[action] ?? '');
      }
      return res.json({ ok: true });
    } catch (error) {
      logger.warn?.('[gitlab-issues] run action failed:', errorMessage(error));
      return res.status(502).json({ error: 'gitlab-request-failed' });
    }
  });
};
