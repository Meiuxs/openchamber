import { COLLECTION_MAX_PAGES, COLLECTION_PER_PAGE, readPage, requestStatus, supportsDiffList } from './read-support.js';
import { isPlainObject as isPlain } from './validation.js';
import type { JsonValue } from '../shared/json-values.js';
import type { createGitLabClient } from './client.js';

type Client = ReturnType<typeof createGitLabClient>;
type Reply = Awaited<ReturnType<Client['Projects']['show']>>;

export const DIFF_OVERFLOW_MESSAGE = 'GitLab merge request has more changed files than OpenChamber reads';
export const INVALID_DIFF_LIST_MESSAGE = 'GitLab returned an invalid merge request diff list';
// external: https://gitlab.com/gitlab-org/gitlab/-/issues/427168 GitLab before 18.0 answers a merge request's diff list with 500 for any page larger than 30, and self-managed instances still run those versions.
const DIFF_PER_PAGE = 30;
const DIFF_MAX_PAGES = Math.ceil((COLLECTION_MAX_PAGES * COLLECTION_PER_PAGE) / DIFF_PER_PAGE);

const legacyDiffInstances = new Set<string>();

const diffListOf = (value: Reply | undefined): JsonValue[] | null => {
  if (Array.isArray(value)) return value;
  if (!isPlain(value)) return null;
  for (const key of ['changes', 'diffs', 'data'] as const) {
    const list = value[key];
    if (Array.isArray(list)) return list;
  }
  return null;
};

async function readDiffList(client: Client, projectId: string | number, number: number): Promise<JsonValue[] | null> {
  const reply = await client.MergeRequests.allDiffs(projectId, number, {
    maxPages: DIFF_MAX_PAGES, perPage: DIFF_PER_PAGE, showExpanded: true,
  });
  const page = readPage(reply);
  if (page.hasMore) throw new Error(DIFF_OVERFLOW_MESSAGE);
  const diffs = diffListOf(reply);
  if (diffs) return diffs;
  if (isPlain(reply) && Object.hasOwn(reply, 'paginationInfo')) throw new Error(INVALID_DIFF_LIST_MESSAGE);
  return null;
}

export async function readMergeRequestDiffs(client: Client, origin: string, projectId: string | number, number: number) {
  if (!legacyDiffInstances.has(origin)) {
    try {
      const diffs = await readDiffList(client, projectId, number);
      if (diffs) return diffs;
      if (await supportsDiffList(client)) throw new Error(INVALID_DIFF_LIST_MESSAGE);
    } catch (error) {
      const status = requestStatus(error);
      if (status !== 404 && status !== 500) throw error;
    }
  }
  const response = await client.MergeRequests.requester.get(
    `projects/${encodeURIComponent(String(projectId))}/merge_requests/${encodeURIComponent(String(number))}/changes`,
  );
  const payload = isPlain(response?.body) ? response.body : undefined;
  const changes = diffListOf(payload);
  if (!changes) throw new Error(INVALID_DIFF_LIST_MESSAGE);
  legacyDiffInstances.add(origin);
  if (payload?.overflow === true) throw new Error(DIFF_OVERFLOW_MESSAGE);
  return changes;
}
