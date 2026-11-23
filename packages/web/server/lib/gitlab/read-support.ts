import { isPlainObject as isPlain } from './validation.js';
import type { createGitLabClient } from './client.js';

type Client = ReturnType<typeof createGitLabClient>;
type Reply = Awaited<ReturnType<Client['Projects']['show']>>;

export const COLLECTION_PER_PAGE = 100;
export const COLLECTION_MAX_PAGES = 20;

interface Failure { status?: unknown; response?: { status?: unknown }; cause?: { response?: { status?: unknown } } }
const hasFailure = (value: unknown): value is Failure => value != null;
export function requestStatus(cause: unknown) {
  const error = hasFailure(cause) ? cause : undefined;
  return error?.cause?.response?.status ?? error?.response?.status ?? error?.status;
}

export function readPage(payload: Reply) {
  if (!isPlain(payload) || !Array.isArray(payload.data)) return { items: null, hasMore: false };
  return { items: payload.data, hasMore: Boolean(isPlain(payload.paginationInfo) && payload.paginationInfo.next) };
}

export type InstanceVersion = { major: number; minor: number };
const instanceVersions = new WeakMap<Client, Promise<InstanceVersion | null>>();
export const instanceVersion = (client: Client): Promise<InstanceVersion | null> => {
  const requester = client?.MergeRequests?.requester;
  if (!requester?.get) return Promise.resolve(null);
  if (!instanceVersions.has(client)) {
    instanceVersions.set(client, Promise.resolve()
      .then(() => requester.get('version'))
      .then((response) => {
        const body = isPlain(response?.body) ? response.body : null;
        const match = /^(\d+)\.(\d+)/.exec(String(body?.version ?? ''));
        return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
      })
      .catch(() => null));
  }
  return instanceVersions.get(client) ?? Promise.resolve(null);
};
export const atLeast = (version: InstanceVersion | null, major: number, minor: number): boolean =>
  version !== null && (version.major > major || (version.major === major && version.minor >= minor));
export const supportsDiffList = async (client: Client): Promise<boolean> => {
  const version = await instanceVersion(client);
  return version === null || atLeast(version, 15, 7);
};
