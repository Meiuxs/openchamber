import { parseGitLabRemoteUrl } from '../gitlab/repo.js';
import { isValidGitRefName } from '../shared/git-ref.js';
import { isString } from '../shared/guards.js';
import {
  buildIssueDescription, createClientForAccount, createGitlabIssueApi,
  resolveAccount, resolveProjectConfig,
} from './gitlab.js';

const ISSUE_KINDS = new Set(['bug', 'feature']);
const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 65_000;

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
};
