import { createGitLabClient } from '../gitlab/client.js';
import { isValidBranchPrefix, isValidGitRefName } from '../shared/git-ref.js';
import { isString } from '../shared/guards.js';

export { isValidBranchPrefix, isValidGitRefName };

export const DEFAULT_BRANCH_PREFIX = 'openchamber/';
const DEFAULT_TIMEOUT_MINUTES = 30;
const MAX_SLUG_LENGTH = 40;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export class TemplateError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'TemplateError';
    this.reason = reason;
  }
}

export const slugifyIssueTitle = (title) => String(title ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, MAX_SLUG_LENGTH)
  .replace(/-+$/g, '');

export const buildIssueBranch = (prefix, iid, title) => {
  const slug = slugifyIssueTitle(title);
  return slug ? `${prefix}issue-${iid}-${slug}` : `${prefix}issue-${iid}`;
};

export const matchReusableBranch = (branches, prefix, iid) => {
  const wanted = `${prefix}issue-${iid}`;
  return (Array.isArray(branches) ? branches : [])
    .map((branch) => (isString(branch) ? branch : branch?.name))
    .find((name) => isString(name) && (name === wanted || name.startsWith(`${wanted}-`))) ?? null;
};

export const parseIssueTemplate = (issue) => {
  const description = String(issue?.description ?? '');
  const typeMatch = /^\s*类型:\s*(.*)$/m.exec(description);
  const kind = typeMatch?.[1]?.trim();
  if (kind !== 'bug' && kind !== 'feature') {
    throw new TemplateError('invalid-template', 'The issue template type line is missing or invalid');
  }
  const targetMatch = /^\s*目标分支:\s*(.*)$/m.exec(description);
  let targetBranch = '';
  if (targetMatch) {
    const raw = targetMatch[1].trim();
    const backticked = /^`([^`]*)`$/.exec(raw);
    targetBranch = (backticked ? backticked[1] : raw).trim();
    if (targetBranch && !isValidGitRefName(targetBranch)) {
      throw new TemplateError('branch-missing', `Target branch is not a valid ref: ${targetBranch}`);
    }
  }
  return { kind, targetBranch };
};

/** The machine-readable header the dispatcher parses, plus the author's body. */
export const buildIssueDescription = ({ kind, targetBranch, description }) => {
  const header = `类型: ${kind}\n目标分支: \`${isString(targetBranch) ? targetBranch.trim() : ''}\``;
  const body = isString(description) ? description.trim() : '';
  return body ? `${header}\n\n${body}` : header;
};

export const resolveProjectConfig = (project) => {
  const rawPrefix = project?.gitlabIssueBranchPrefix;
  const hasPrefix = isString(rawPrefix);
  const prefix = hasPrefix ? rawPrefix.trim() : DEFAULT_BRANCH_PREFIX;
  const prefixValid = hasPrefix ? isValidBranchPrefix(prefix) : true;
  const rawTimeout = project?.gitlabIssueTimeoutMinutes;
  const timeoutValid = rawTimeout === undefined || rawTimeout === null
    || (Number.isInteger(rawTimeout) && rawTimeout >= 1 && rawTimeout <= 1440);
  const timeoutMinutes = timeoutValid && Number.isInteger(rawTimeout) ? rawTimeout : DEFAULT_TIMEOUT_MINUTES;
  const rawBotAccountId = project?.gitlabIssueBotAccountId;
  const botAccountId = isString(rawBotAccountId) ? rawBotAccountId.trim() : '';
  // `provider/model`, the same shape `defaultModel` uses. An unusable value is
  // dropped rather than blocking dispatch: the review falls back to the default.
  const rawReviewModel = project?.gitlabIssueReviewModel;
  const reviewModel = isString(rawReviewModel) && /^\S+\/\S+$/.test(rawReviewModel.trim())
    ? rawReviewModel.trim()
    : '';
  const rawReviewVariant = project?.gitlabIssueReviewVariant;
  const reviewVariant = isString(rawReviewVariant) ? rawReviewVariant.trim() : '';
  const enabled = project?.autoDispatchGitlabIssues === true
    && Boolean(botAccountId) && prefixValid && timeoutValid;
  return {
    enabled, botAccountId, prefix, timeoutMinutes, reviewModel, reviewVariant,
  };
};

export const resolveAccount = async (authStore, origin, accountId) => {
  if (!origin || !accountId) return null;
  const account = await authStore.readAccount(origin, accountId);
  return account?.status === 'valid' ? account : null;
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The comment that sends a run back to fix things: first line
// `@<bot username> 修复` or `@<bot username> fix`, case-insensitive, with the
// rest of the line after a colon joining the feedback body. A bare mention
// without the command word is not a trigger; the caller replies with usage.
export const parseFeedbackCommand = (body, botUsername) => {
  const username = escapeRegExp(String(botUsername ?? '').trim());
  if (!username) return null;
  const first = String(body ?? '').trim().split(/\r?\n/, 1)[0].trim();
  const match = new RegExp(`^@${username}\\s*(?:修复|fix)(?:\\s*[:：]\\s*(.*))?$`, 'i').exec(first);
  if (!match) return null;
  return { text: (match[1] ?? '').trim() || null };
};

/** A plain mention of the bot with no trigger word, so a usage reply helps. */
export const isBareBotMention = (body, botUsername) => {
  const username = escapeRegExp(String(botUsername ?? '').trim());
  if (!username) return false;
  return new RegExp(`@${username}\\b`, 'i').test(String(body ?? ''));
};

export const findAccountForUser = async (authStore, origin, userId) => {
  if (!origin || !Number.isInteger(userId)) return null;
  const accounts = await authStore.listAccounts(origin);
  return accounts.find((account) => account?.status === 'valid' && account?.user?.id === userId) ?? null;
};

export const createClientForAccount = (origin, account) => createGitLabClient({
  origin,
  token: account.token,
  tokenType: account.source === 'oauth' ? 'oauth' : 'token',
});

/** The assistant text of one OpenCode message record. */
export const assistantText = (record) => (Array.isArray(record?.content) ? record.content : [])
  .filter((item) => item?.type === 'text' && isString(item.text))
  .map((item) => item.text)
  .join('')
  .trim();

// `limit` stops after that many pages without treating the remainder as an
// error: the issue scan reads three pages per project per scan by design.
const readAll = async (fetchPage, limit = null) => {
  const collected = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetchPage({ perPage: PAGE_SIZE, page, showExpanded: true });
    const data = Array.isArray(response?.data) ? response.data : [];
    collected.push(...data);
    if (!response?.paginationInfo?.next) return collected;
    if (limit && page >= limit) return collected;
  }
  // A named error so callers can tell "the list is beyond what the automation
  // parses" from any other fetch failure: the feedback scan turns it into a
  // block instead of stalling on the same exception every tick.
  throw Object.assign(
    new Error('GitLab returned more pages than the automation reads'),
    { name: 'GitlabListOverflowError' },
  );
};

const ISSUE_SCAN_PAGES = 3;

// Issue labels come back as strings or `{ name }` objects depending on the
// endpoint and the `withLabelsDetails` flag; every reader uses this one.
export const labelNamesOf = (issue) => (Array.isArray(issue?.labels) ? issue.labels : [])
  .map((label) => (isString(label) ? label : isString(label?.name) ? label.name : ''))
  .filter(Boolean);
const labelList = (labels) => [].concat(labels).map((label) => String(label)).filter(Boolean);

export function createGitlabIssueApi({ client }) {
  // GitLab before 12.10 has no `add_labels`/`remove_labels` on the issue update
  // and answers 400 when the body carries only those, so the bot reads the
  // issue and sends the computed set. Older versions accept `labels`.
  const editLabels = async (projectId, iid, change) => {
    const current = labelNamesOf(await client.Issues.show(iid, { projectId }));
    return client.Issues.edit(projectId, iid, { labels: change(current).join(',') });
  };

  const api = {
    currentUser: () => client.Users.showCurrentUser(),
    getProject: (projectId) => client.Projects.show(projectId),
    listOpenIssues: (projectId) => readAll((page) => client.Issues.all({
      projectId,
      labels: 'ai-ready',
      state: 'opened',
      page: page.page,
      perPage: page.perPage,
      maxPages: 1,
      showExpanded: true,
      withLabelsDetails: true,
    }), ISSUE_SCAN_PAGES),
    getIssue: (projectId, iid) => client.Issues.show(iid, { projectId }),
    createIssue: (projectId, title, description) => client.Issues.create(projectId, title, { description }),
    listNotes: (projectId, iid) => readAll((page) => client.IssueNotes.all(projectId, iid, {
      perPage: page.perPage,
      page: page.page,
      showExpanded: true,
      sort: 'asc',
    })),
    postNote: async (projectId, iid, body) => {
      const note = await client.IssueNotes.create(projectId, iid, body);
      if (!Number.isInteger(note?.id)) throw new Error('GitLab did not return a note id');
      return note.id;
    },
    listMergeRequestNotes: (projectId, iid) => readAll((page) => client.MergeRequestNotes.all(projectId, iid, {
      perPage: page.perPage,
      page: page.page,
      showExpanded: true,
      sort: 'asc',
    })),
    postMergeRequestNote: async (projectId, iid, body) => {
      const note = await client.MergeRequestNotes.create(projectId, iid, body);
      if (!Number.isInteger(note?.id)) throw new Error('GitLab did not return a note id');
      return note.id;
    },
    listLabelEvents: (projectId, iid) => readAll((page) => client.IssueLabelEvents.all(projectId, iid, {
      perPage: page.perPage,
      page: page.page,
      showExpanded: true,
    })),
    listMembers: (projectId) => readAll((page) => client.ProjectMembers.all(projectId, {
      includeInherited: true,
      perPage: page.perPage,
      page: page.page,
      showExpanded: true,
    })),
    addLabels: (projectId, iid, labels) => editLabels(projectId, iid, (current) => (
      [...new Set([...current, ...labelList(labels)])]
    )),
    removeLabels: (projectId, iid, labels) => editLabels(projectId, iid, (current) => {
      const removing = new Set(labelList(labels));
      return current.filter((label) => !removing.has(label));
    }),
    closeIssue: (projectId, iid) => client.Issues.edit(projectId, iid, { stateEvent: 'close' }),
    listBranches: (projectId, search) => readAll((page) => client.Branches.all(projectId, {
      search,
      perPage: page.perPage,
      page: page.page,
      showExpanded: true,
    })),
    showBranch: (projectId, branch) => client.Branches.show(projectId, branch),
    listOpenMergeRequests: (projectId, sourceBranch) => readAll((page) => client.MergeRequests.all({
      projectId,
      state: 'opened',
      sourceBranch,
      perPage: page.perPage,
      page: page.page,
      showExpanded: true,
    })),
    createMergeRequest: (projectId, sourceBranch, targetBranch, title, description) => client.MergeRequests.create(
      projectId,
      sourceBranch,
      targetBranch,
      title,
      { description },
    ),
    getMergeRequest: (projectId, iid) => client.MergeRequests.show(projectId, iid),
  };

  api.latestTriggerer = async (projectId, iid, botUserId) => {
    const events = await api.listLabelEvents(projectId, iid);
    const newest = events
      .filter((event) => event?.action === 'add' && event?.label?.name === 'ai-ready'
        && Number.isInteger(event?.user?.id) && event.user.id !== botUserId)
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0];
    return newest ? { userId: newest.user.id } : null;
  };

  api.accessLevelOf = async (projectId, userId) => {
    const members = await api.listMembers(projectId);
    const member = members.find((entry) => Number(entry?.id) === Number(userId));
    return Number.isInteger(member?.access_level) ? member.access_level : 0;
  };

  api.latestCommand = async (projectId, iid, { sinceIso, botUserId, commands, minAccessLevel = null }) => {
    const notes = await api.listNotes(projectId, iid);
    const accessByUser = minAccessLevel === null
      ? null
      : new Map((await api.listMembers(projectId)).map((member) => [Number(member?.id), Number(member?.access_level)]));
    const since = Date.parse(sinceIso ?? 0) || 0;
    const matches = notes.filter((note) => {
      if (!Number.isInteger(note?.id) || note?.author?.id === botUserId) return false;
      if ((Date.parse(note?.created_at ?? 0) || 0) < since) return false;
      if (accessByUser && (accessByUser.get(Number(note?.author?.id)) ?? 0) < minAccessLevel) return false;
      const first = String(note?.body ?? '').trim().split(/\r?\n/, 1)[0].trim();
      return commands.includes(first);
    });
    const newest = matches.sort((left, right) => right.id - left.id)[0];
    if (!newest) return null;
    return {
      command: String(newest.body).trim().split(/\r?\n/, 1)[0].trim(),
      userId: newest.author?.id,
      noteId: newest.id,
    };
  };

  return api;
}
