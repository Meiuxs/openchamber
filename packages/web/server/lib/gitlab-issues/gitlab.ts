import { createGitLabClient } from '../gitlab/client.js';
import { isValidBranchPrefix, isValidGitRefName } from '../shared/git-ref.js';
import { isPlainObject, isString } from '../shared/guards.js';
import type { AuthCredential } from '../source-control/auth-storage.js';
import type { SettingsProject } from '../settings/settings-normalization-runtime.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';

export { isValidBranchPrefix, isValidGitRefName };

export const DEFAULT_BRANCH_PREFIX = 'openchamber/';
const DEFAULT_TIMEOUT_MINUTES = 30;
const MAX_SLUG_LENGTH = 40;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type Client = ReturnType<typeof createGitLabClient>;
type Reply = Awaited<ReturnType<Client['Issues']['show']>>;
type PageRequest = { perPage: number; page: number; showExpanded: true };

const isJsonRecord = (value: unknown): value is JsonObject => isPlainObject(value);
const isInteger = (value: unknown): value is number => Number.isInteger(value);
const readRecord = (value: Reply): JsonObject => isJsonRecord(value) ? value : {};

export class TemplateError extends Error {
  reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'TemplateError';
    this.reason = reason;
  }
}

export const slugifyIssueTitle = (title: JsonValue | null | undefined) => String(title ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, MAX_SLUG_LENGTH)
  .replace(/-+$/g, '');

export const buildIssueBranch = (prefix: string, iid: number, title: JsonValue | null | undefined) => {
  const slug = slugifyIssueTitle(title);
  return slug ? `${prefix}issue-${iid}-${slug}` : `${prefix}issue-${iid}`;
};

export const matchReusableBranch = (branches: JsonValue | null | undefined, prefix: string, iid: number) => {
  const wanted = `${prefix}issue-${iid}`;
  return (Array.isArray(branches) ? branches : [])
    .map((branch) => (isString(branch) ? branch : isJsonRecord(branch) && isString(branch.name) ? branch.name : ''))
    .find((name) => isString(name) && (name === wanted || name.startsWith(`${wanted}-`))) ?? null;
};

export const parseIssueTemplate = (issue: JsonObject | null | undefined) => {
  const description = String(issue?.description ?? '');
  const typeMatch = /^\s*类型:\s*(.*)$/m.exec(description);
  const kind = typeMatch?.[1]?.trim();
  if (kind !== 'bug' && kind !== 'feature') {
    throw new TemplateError('invalid-template', 'The issue template type line is missing or invalid');
  }
  const targetMatch = /^\s*目标分支:\s*(.*)$/m.exec(description);
  let targetBranch = '';
  if (targetMatch) {
    const raw = targetMatch[1]?.trim() ?? '';
    const backticked = /^`([^`]*)`$/.exec(raw);
    targetBranch = (backticked ? (backticked[1] ?? '') : raw).trim();
    if (targetBranch && !isValidGitRefName(targetBranch)) {
      throw new TemplateError('branch-missing', `Target branch is not a valid ref: ${targetBranch}`);
    }
  }
  return { kind, targetBranch };
};

export const buildIssueDescription = ({ kind, targetBranch, description }: {
  kind: string;
  targetBranch?: string | null | undefined;
  description?: string | null | undefined;
}) => {
  const header = `类型: ${kind}\n目标分支: \`${isString(targetBranch) ? targetBranch.trim() : ''}\``;
  const body = isString(description) ? description.trim() : '';
  return body ? `${header}\n\n${body}` : header;
};

export const resolveProjectConfig = (project: JsonObject | SettingsProject | null | undefined) => {
  const rawPrefix = project?.gitlabIssueBranchPrefix;
  const hasPrefix = isString(rawPrefix);
  const prefix = hasPrefix && isString(rawPrefix) ? rawPrefix.trim() : DEFAULT_BRANCH_PREFIX;
  const prefixValid = hasPrefix ? isValidBranchPrefix(prefix) : true;
  const rawTimeout = project?.gitlabIssueTimeoutMinutes;
  const timeoutValid = rawTimeout === undefined || rawTimeout === null
    || (isInteger(rawTimeout) && rawTimeout >= 1 && rawTimeout <= 1440);
  const timeoutMinutes = timeoutValid && isInteger(rawTimeout) ? rawTimeout : DEFAULT_TIMEOUT_MINUTES;
  const rawBotAccountId = project?.gitlabIssueBotAccountId;
  const botAccountId = isString(rawBotAccountId) ? rawBotAccountId.trim() : '';
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

export interface IssueAuthStore {
  readAccount(origin: string, accountId: string): Promise<AuthCredential | null>;
  listAccounts(origin: string): Promise<AuthCredential[]>;
  markAccountInvalid(origin: string, accountId: string): Promise<boolean>;
}

export const resolveAccount = async (authStore: IssueAuthStore, origin: string, accountId: string | null | undefined) => {
  if (!origin || !accountId) return null;
  const account = await authStore.readAccount(origin, accountId);
  return account?.status === 'valid' ? account : null;
};

const escapeRegExp = (value: string) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const parseFeedbackCommand = (body: string | null | undefined, botUsername: string | null | undefined) => {
  const username = escapeRegExp(String(botUsername ?? '').trim());
  if (!username) return null;
  const first = String(body ?? '').trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  const match = new RegExp(`^@${username}\\s*(?:修复|fix)(?:\\s*[:：]\\s*(.*))?$`, 'i').exec(first);
  if (!match) return null;
  return { text: (match[1] ?? '').trim() || null };
};

export const isBareBotMention = (body: string | null | undefined, botUsername: string | null | undefined) => {
  const username = escapeRegExp(String(botUsername ?? '').trim());
  if (!username) return false;
  return new RegExp(`@${username}\\b`, 'i').test(String(body ?? ''));
};

export const findAccountForUser = async (authStore: IssueAuthStore, origin: string, userId: number | null | undefined) => {
  if (!origin || !Number.isInteger(userId)) return null;
  const accounts = await authStore.listAccounts(origin);
  return accounts.find((account) => account?.status === 'valid' && account?.user?.id === userId) ?? null;
};

export const createClientForAccount = (origin: string, account: AuthCredential) => createGitLabClient({
  origin,
  token: account.token,
  tokenType: account.source === 'oauth' ? 'oauth' : 'token',
});

const isTextPart = (item: JsonValue): item is JsonObject & { type: 'text'; text: string } =>
  isJsonRecord(item) && item.type === 'text' && isString(item.text);

export const assistantText = (record: JsonObject | null | undefined) => (Array.isArray(record?.content) ? record.content : [])
  .filter(isTextPart)
  .map((item) => item.text)
  .join('')
  .trim();

const readAll = async (fetchPage: (page: PageRequest) => Promise<Reply>, limit: number | null = null): Promise<JsonObject[]> => {
  const collected: JsonObject[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetchPage({ perPage: PAGE_SIZE, page, showExpanded: true });
    const record = isJsonRecord(response) ? response : null;
    const data = record && Array.isArray(record.data)
      ? record.data.map((item) => (isJsonRecord(item) ? item : {}))
      : [];
    collected.push(...data);
    if (!record || !isJsonRecord(record.paginationInfo) || !record.paginationInfo.next) return collected;
    if (limit && page >= limit) return collected;
  }
  throw Object.assign(
    new Error('GitLab returned more pages than the automation reads'),
    { name: 'GitlabListOverflowError' },
  );
};

const ISSUE_SCAN_PAGES = 3;

export const labelNamesOf = (issue: JsonObject | null | undefined) => (Array.isArray(issue?.labels) ? issue.labels : [])
  .map((label) => (isString(label) ? label : isJsonRecord(label) && isString(label.name) ? label.name : ''))
  .filter(Boolean);

const labelList = (labels: JsonValue | JsonValue[] | null | undefined) => (Array.isArray(labels) ? labels : [labels])
  .map((label) => String(label))
  .filter(Boolean);

export const BOT_NOTE_MARKER = '<!-- openchamber-automation -->';
export const isBotNoteBody = (body: string | null | undefined) => String(body ?? '').startsWith(BOT_NOTE_MARKER);
export const withBotMarker = (body: string | null | undefined) => `${BOT_NOTE_MARKER}\n${String(body ?? '')}`;

export interface LatestCommandOptions {
  sinceIso?: string | null | undefined;
  commands: string[];
  minAccessLevel?: number | null | undefined;
}

export function createGitlabIssueApi({ client }: { client: Client }) {
  // SAFETY: the deployed GitBeaker client exposes these services; the vendored declaration omits them.
  const extended = client as Client & {
    Issues: Client['Issues'] & { create(projectId: string | number, title: string, options: { description: string }): Promise<Reply> };
    Branches: Client['Branches'] & { show(projectId: string | number, branch: string): Promise<Reply> };
    IssueLabelEvents: { all(projectId: string | number, iid: number, options: PageRequest): Promise<Reply> };
  };
  const editLabels = async (projectId: string | number, iid: number, change: (current: string[]) => string[]) => {
    const current = labelNamesOf(readRecord(await client.Issues.show(iid, { projectId })));
    return client.Issues.edit(projectId, iid, { labels: change(current).join(',') });
  };

  const latestTriggerer = async (projectId: string | number, iid: number): Promise<{ userId: number } | null> => {
    const events = await api.listLabelEvents(projectId, iid);
    const newest = events
      .filter((event) => event?.action === 'add' && isJsonRecord(event.label) && event.label.name === 'ai-ready'
        && isJsonRecord(event.user) && isInteger(event.user.id))
      .sort((left, right) => Date.parse(String(right.created_at ?? 0)) - Date.parse(String(left.created_at ?? 0)))[0];
    return newest && isJsonRecord(newest.user) && isInteger(newest.user.id) ? { userId: newest.user.id } : null;
  };

  const accessLevelOf = async (projectId: string | number, userId: number): Promise<number> => {
    const members = await api.listMembers(projectId);
    const member = members.find((entry) => Number(entry?.id) === Number(userId));
    return isInteger(member?.access_level) ? member.access_level : 0;
  };

  const latestCommand = async (projectId: string | number, iid: number, { sinceIso, commands, minAccessLevel = null }: LatestCommandOptions) => {
    const notes = await api.listNotes(projectId, iid);
    const accessByUser = minAccessLevel === null
      ? null
      : new Map((await api.listMembers(projectId)).map((member): [number, number] => [Number(member?.id), Number(member?.access_level)]));
    const since = Date.parse(String(sinceIso ?? 0)) || 0;
    const matches = notes.filter((note) => {
      if (!isInteger(note?.id) || isBotNoteBody(String(note?.body ?? ''))) return false;
      if ((Date.parse(String(note?.created_at ?? 0)) || 0) < since) return false;
      const authorId = isJsonRecord(note?.author) ? note.author.id : undefined;
      if (accessByUser && (accessByUser.get(Number(authorId)) ?? 0) < (minAccessLevel ?? 0)) return false;
      const first = String(note?.body ?? '').trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
      return commands.includes(first);
    });
    const newest = matches.sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0))[0];
    if (!newest) return null;
    return {
      command: String(newest.body).trim().split(/\r?\n/, 1)[0]?.trim() ?? '',
      userId: isJsonRecord(newest.author) && isInteger(newest.author.id) ? newest.author.id : 0,
      noteId: isInteger(newest.id) ? newest.id : 0,
    };
  };

  const api = {
    currentUser: async () => readRecord(await client.Users.showCurrentUser()),
    getProject: async (projectId: string | number) => readRecord(await client.Projects.show(projectId)),
    listOpenIssues: (projectId: string | number) => readAll((page) => client.Issues.all({
      projectId,
      labels: 'ai-ready',
      state: 'opened',
      page: page.page,
      perPage: page.perPage,
      maxPages: 1,
      showExpanded: true,
      withLabelsDetails: true,
    }), ISSUE_SCAN_PAGES),
    getIssue: async (projectId: string | number, iid: number) => readRecord(await client.Issues.show(iid, { projectId })),
    createIssue: async (projectId: string | number, title: string, description: string) => readRecord(await extended.Issues.create(projectId, title, { description })),
    listNotes: (projectId: string | number, iid: number) => readAll((page) => client.IssueNotes.all(projectId, iid, {
      perPage: page.perPage,
      page: page.page,
      showExpanded: true,
      sort: 'asc',
    })),
    postNote: async (projectId: string | number, iid: number, body: string) => {
      const note = readRecord(await client.IssueNotes.create(projectId, iid, body));
      if (!isInteger(note?.id)) throw new Error('GitLab did not return a note id');
      return note.id;
    },
    listMergeRequestNotes: (projectId: string | number, iid: number) => readAll((page) => client.MergeRequestNotes.all(projectId, iid, {
      perPage: page.perPage,
      page: page.page,
      showExpanded: true,
      sort: 'asc',
    })),
    postMergeRequestNote: async (projectId: string | number, iid: number, body: string) => {
      const note = readRecord(await client.MergeRequestNotes.create(projectId, iid, body));
      if (!isInteger(note?.id)) throw new Error('GitLab did not return a note id');
      return note.id;
    },
    listLabelEvents: (projectId: string | number, iid: number) => readAll((page) => extended.IssueLabelEvents.all(projectId, iid, {
      perPage: page.perPage,
      page: page.page,
      showExpanded: true,
    })),
    listMembers: (projectId: string | number) => readAll((page) => client.ProjectMembers.all(projectId, {
      includeInherited: true,
      perPage: page.perPage,
      page: page.page,
      showExpanded: true,
    })),
    addLabels: (projectId: string | number, iid: number, labels: JsonValue | JsonValue[] | null | undefined) => editLabels(projectId, iid, (current) => (
      [...new Set([...current, ...labelList(labels)])]
    )),
    removeLabels: (projectId: string | number, iid: number, labels: JsonValue | JsonValue[] | null | undefined) => editLabels(projectId, iid, (current) => {
      const removing = new Set(labelList(labels));
      return current.filter((label) => !removing.has(label));
    }),
    closeIssue: (projectId: string | number, iid: number) => client.Issues.edit(projectId, iid, { stateEvent: 'close' }),
    listBranches: (projectId: string | number, search: string) => readAll((page) => client.Branches.all(projectId, {
      search,
      perPage: page.perPage,
      page: page.page,
      showExpanded: true,
    })),
    showBranch: (projectId: string | number, branch: string) => extended.Branches.show(projectId, branch),
    listOpenMergeRequests: (projectId: string | number, sourceBranch: string) => readAll((page) => client.MergeRequests.all({
      projectId,
      state: 'opened',
      sourceBranch,
      perPage: page.perPage,
      page: page.page,
      showExpanded: true,
    })),
    createMergeRequest: async (projectId: string | number, sourceBranch: string, targetBranch: string, title: string, description: string) => readRecord(await client.MergeRequests.create(
      projectId,
      sourceBranch,
      targetBranch,
      title,
      { description },
    )),
    getMergeRequest: async (projectId: string | number, iid: number) => readRecord(await client.MergeRequests.show(projectId, iid)),
    latestTriggerer,
    accessLevelOf,
    latestCommand,
  };

  return api;
}

export type GitlabIssueApi = ReturnType<typeof createGitlabIssueApi>;
