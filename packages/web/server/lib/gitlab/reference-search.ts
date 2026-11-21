import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SourceControlJson } from '@openchamber/sdk';
import type { GitLabMappedIssue, GitLabMappedMergeRequest } from './mappers.js';
import type { GitLabResourceProject } from './resources.js';
import type { ProviderReadContext } from '../source-control/provider-contract.js';

const ACROSS_CONCURRENCY = 4;
export const ACROSS_PAGE_SIZE = 20;
const BODY_PREVIEW_MAX = 20_000;

const acrossContextSchema = z.strictObject({
  directory: z.string().trim().min(1),
  repositoryId: z.string().min(1),
  provider: z.literal('gitlab'),
  instance: z.string().min(1),
  accountId: z.string().min(1),
  bindingRevision: z.number().int().nonnegative(),
  primaryRemote: z.string().min(1),
});

const acrossRequestSchema = z.strictObject({
  contexts: z.array(acrossContextSchema),
  kind: z.enum(['issue', 'pull']),
  state: z.enum(['open', 'closed', 'merged', 'all', 'unanswered']).optional(),
  people: z.enum(['any', 'assigned', 'created', 'reviewRequested']).optional(),
  labels: z.array(z.string()).optional(),
  query: z.string().optional(),
  cursor: z.string().max(100_000).nullable().optional(),
});

const cursorSchema = z.strictObject({
  v: z.literal(1),
  scope: z.string().min(1),
  pages: z.array(z.number().int().positive().nullable()),
});

export type GitLabAcrossInput = ReturnType<typeof readGitLabAcrossRequest> & NonNullable<unknown>;
type AcrossContext = z.infer<typeof acrossContextSchema>;
type ReferenceAuthor = { login: string; avatarUrl?: string };
type ReferenceLabel = { name: string; color?: string };
type ScopeInput = {
  contexts: AcrossContext[];
  kind: string;
  state?: string | undefined;
  people?: string | undefined;
  labels: string[];
  query?: string | undefined;
};

export function readGitLabAcrossRequest(body: SourceControlJson) {
  const parsed = acrossRequestSchema.safeParse(body);
  if (!parsed.success) return null;
  const folders = new Map<string, AcrossContext>();
  for (const context of parsed.data.contexts) {
    if (!folders.has(context.directory)) folders.set(context.directory, context);
  }
  const labels = [...new Set((parsed.data.labels ?? []).map((label) => label.trim()).filter((label) => label.length > 0 && label.length <= 256))].slice(0, 20);
  return folders.size > 100 ? null : { ...parsed.data, labels, contexts: [...folders.values()], directories: parsed.data.contexts.map((context) => context.directory) };
}

const scopeOf = (input: ScopeInput) => createHash('sha1').update(JSON.stringify({
  contexts: input.contexts.map(({ directory, repositoryId, instance, accountId, bindingRevision, primaryRemote }) => (
    [directory, repositoryId, instance, accountId, bindingRevision, primaryRemote]
  )),
  kind: input.kind,
  state: input.state ?? 'open',
  people: input.people ?? 'any',
  labels: input.labels,
  query: input.query ?? '',
})).digest('hex').slice(0, 16);

export function encodeAcrossCursor(input: ScopeInput, pages: Array<number | null>) {
  return Buffer.from(JSON.stringify({ v: 1, scope: scopeOf(input), pages })).toString('base64url');
}

export function decodeAcrossCursor(input: ScopeInput, cursor: string | null | undefined): Array<number | null> | null {
  if (!cursor) return input.contexts.map(() => 1);
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (!parsed.success || parsed.data.scope !== scopeOf(input) || parsed.data.pages.length !== input.contexts.length) return null;
    return parsed.data.pages;
  } catch {
    return null;
  }
}

const preview = (text: string | undefined) => {
  const value = text ?? '';
  return { body: value.slice(0, BODY_PREVIEW_MAX), bodyTruncated: value.length > BODY_PREVIEW_MAX };
};

const authorOf = (value: { username: string; avatarUrl?: string } | null | undefined): ReferenceAuthor | null => {
  if (!value) return null;
  const author: ReferenceAuthor = { login: value.username };
  if (value.avatarUrl) author.avatarUrl = value.avatarUrl;
  return author;
};

const sourceRepoOf = (project: { owner: string; name: string }) => ({ owner: project.owner, repo: project.name, source: 'origin' });
const labelsOf = (labels: Array<{ name: string; color?: string }> | undefined): ReferenceLabel[] => (labels ?? []).map((label) => {
  const mapped: ReferenceLabel = { name: label.name };
  if (label.color) mapped.color = label.color;
  return mapped;
});

export function issueToReference(issue: GitLabMappedIssue) {
  return {
    kind: 'issue',
    provider: issue.provider,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    ...preview(issue.body),
    createdAt: issue.createdAt ?? null,
    updatedAt: issue.updatedAt ?? null,
    author: authorOf(issue.author),
    labels: labelsOf(issue.labels),
    commentCount: 0,
    sourceRepo: sourceRepoOf(issue.project),
    state: issue.state === 'open' ? 'open' : 'completed',
  };
}

export function mergeRequestToReference(changeRequest: GitLabMappedMergeRequest) {
  return {
    kind: 'pull',
    provider: changeRequest.provider,
    number: changeRequest.number,
    title: changeRequest.title,
    url: changeRequest.url,
    ...preview(changeRequest.body),
    createdAt: changeRequest.createdAt ?? null,
    updatedAt: changeRequest.updatedAt ?? null,
    author: authorOf(changeRequest.author),
    labels: labelsOf(changeRequest.labels),
    commentCount: 0,
    sourceRepo: sourceRepoOf(changeRequest.project),
    state: changeRequest.state,
    draft: changeRequest.draft,
    head: changeRequest.head ?? '',
    base: changeRequest.base ?? '',
    headSha: changeRequest.headSha ?? '',
    headRepo: changeRequest.headProject
      ? { owner: changeRequest.headProject.owner, repo: changeRequest.headProject.name, url: changeRequest.headProject.url }
      : null,
  };
}

export type GitLabAcrossReference = ReturnType<typeof issueToReference> | ReturnType<typeof mergeRequestToReference>;
type Reference = GitLabAcrossReference;
export type GitLabAcrossPage = { items: GitLabAcrossReference[]; hasMore: boolean };
export type GitLabAcrossRequestCache = {
  projects: Map<string, Promise<GitLabResourceProject>>;
  pages: Map<string, Promise<GitLabAcrossPage>>;
};

export async function mapLimited<Item, Result>(items: Item[], limit: number, task: (item: Item | undefined, index: number) => Promise<Result>): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  }));
  return results;
}

type FolderFailureStatus = 'no-repo' | 'disconnected' | 'invalid-context' | 'error';
type FolderResult = {
  status: 'included';
  target: { owner: string; repo: string; url: string };
  items: Reference[];
  hasMore: boolean;
} | {
  status: FolderFailureStatus;
};

type FolderError = {
  code?: string | undefined;
  status?: number | undefined;
  sourceControlAccountUnavailable?: boolean | undefined;
  response?: { status?: number | undefined } | undefined;
  cause?: { response?: { status?: number | undefined } | undefined } | undefined;
};

const folderFailure = z.object({
  code: z.string().optional(),
  status: z.number().optional(),
  sourceControlAccountUnavailable: z.boolean().optional(),
  response: z.object({ status: z.number().optional() }).optional(),
  cause: z.object({ response: z.object({ status: z.number().optional() }).optional() }).optional(),
});

const failureStatus = (value: FolderError): FolderFailureStatus => {
  const status = value.status ?? value.response?.status ?? value.cause?.response?.status;
  if (value.code === 'SOURCE_CONTROL_BINDING_STALE' || status === 409) return 'invalid-context';
  if (value.sourceControlAccountUnavailable === true || status === 401) return 'disconnected';
  return 'error';
};

type FolderOutcome = {
  directory: string;
  instance: string;
  status: 'included';
  target: { owner: string; repo: string; url: string };
  items: Reference[];
  hasMore: boolean;
} | {
  directory: string;
  instance: string;
  status: FolderFailureStatus;
};

const updatedAtOf = (item: Reference) => Date.parse(item.updatedAt ?? '') || 0;

export async function runAcrossSearch({
  input,
  validateContext,
  readPage,
}: {
  input: NonNullable<ReturnType<typeof readGitLabAcrossRequest>>;
  validateContext: (context: AcrossContext) => Promise<ProviderReadContext | null>;
  readPage: (context: ProviderReadContext, page: number | null, index: number) => Promise<FolderResult>;
}) {
  const pages = decodeAcrossCursor(input, input.cursor);
  if (!pages) throw Object.assign(new Error('Invalid references cursor'), { status: 400, code: 'INVALID_REFERENCES_CURSOR' });

  const folders: FolderOutcome[] = await mapLimited(input.contexts, ACROSS_CONCURRENCY, async (context, index) => {
    if (!context) throw new Error('Missing GitLab across context');
    try {
      const trusted = await validateContext(context);
      if (!trusted) return { directory: context.directory, instance: context.instance, status: 'invalid-context' as const };
      const result = await readPage(trusted, pages[index] ?? null, index);
      if (result.status !== 'included') {
        const failed: FolderFailureStatus = result.status;
        return { directory: context.directory, instance: trusted.instance, status: failed };
      }
      return { directory: context.directory, instance: trusted.instance, status: 'included' as const, target: result.target, items: result.items, hasMore: result.hasMore };
    } catch (error) {
      // SAFETY: folderFailure parses any thrown value before failureStatus reads its fields.
      const parsed = folderFailure.safeParse(error);
      return { directory: context.directory, instance: context.instance, status: failureStatus(parsed.success ? parsed.data : {}) };
    }
  });

  const items: Array<Reference & { directory: string }> = [];
  const seen = new Set<string>();
  for (const [index, folder] of folders.entries()) {
    if (folder.status !== 'included') continue;
    const directory = input.contexts[index]?.directory ?? folder.directory;
    for (const item of folder.items) {
      const key = JSON.stringify([
        folder.instance.toLowerCase(), folder.target.owner.toLowerCase(), folder.target.repo.toLowerCase(),
        item.kind, item.number,
        item.sourceRepo.owner.toLowerCase(), item.sourceRepo.repo.toLowerCase(),
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ ...item, directory });
    }
  }
  items.sort((left, right) => updatedAtOf(right) - updatedAtOf(left));

  const nextPages = folders.map((folder, index) => {
    if (folder.status !== 'included') return null;
    const current = pages[index];
    return folder.hasMore ? (current ?? 0) + 1 : null;
  });
  const hasMore = nextPages.some((page) => page !== null);
  const total = items.length;

  return {
    items,
    cursor: hasMore ? encodeAcrossCursor(input, nextPages) : null,
    hasMore,
    total,
    repositories: folders.map((folder) => (
      folder.status === 'included'
        ? { directory: folder.directory, status: 'included', repo: folder.target }
        : { directory: folder.directory, status: folder.status }
    )),
  };
}
