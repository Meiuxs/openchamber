import { atLeast, instanceVersion, requestStatus } from './read-support.js';
import { isPlainObject, isString } from './validation.js';
import type { createGitLabClient } from './client.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';

type Client = ReturnType<typeof createGitLabClient>;
type Field = JsonValue | undefined;
type Permissions = { resolve: Map<Field, boolean>; reply: boolean };
type ThreadPermissionsResult = { unsupported: boolean; permissions: Permissions | null };

const permissionlessInstances = new WeakSet<Client>();

export const supportsThreadPermissions = async (client: Client): Promise<boolean> => {
  if (permissionlessInstances.has(client)) return false;
  const version = await instanceVersion(client);
  if (version !== null && !atLeast(version, 13, 7)) {
    permissionlessInstances.add(client);
    return false;
  }
  return true;
};

export const rememberThreadPermissionsUnsupported = (client: Client): void => {
  permissionlessInstances.add(client);
};

export const THREAD_PERMISSIONS_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      discussionLocked
      userPermissions { createNote }
      discussions(first: 100) { nodes { id notes(first: 1) { nodes { userPermissions { resolveNote } } } } }
    }
  }
}`;

const objectOf = (value: JsonValue | undefined): JsonObject | undefined => isPlainObject(value) ? value : undefined;
const listOf = (value: JsonValue | undefined): JsonValue[] | undefined => Array.isArray(value) ? value : undefined;

export const threadPermissionsFrom = (payload: JsonObject | undefined): ThreadPermissionsResult => {
  if (listOf(payload?.errors)?.length) return { unsupported: true, permissions: null };
  const request = objectOf(objectOf(objectOf(payload?.data)?.project)?.mergeRequest);
  const nodes = listOf(objectOf(request?.discussions)?.nodes);
  if (!request || !nodes) return { unsupported: false, permissions: null };
  const resolve = new Map<Field, boolean>();
  for (const value of nodes) {
    const node = objectOf(value);
    const id = isString(node?.id) ? node.id.split('/').at(-1) : '';
    const first = objectOf(listOf(objectOf(node?.notes)?.nodes)?.[0]);
    const allowed = objectOf(first?.userPermissions)?.resolveNote;
    if (id && (allowed === true || allowed === false)) resolve.set(id, allowed);
  }
  return {
    unsupported: false,
    permissions: {
      reply: request.discussionLocked !== true && objectOf(request.userPermissions)?.createNote !== false,
      resolve,
    },
  };
};

type Anchor = {
  baseSha: JsonValue | undefined;
  startSha: JsonValue | undefined;
  headSha: JsonValue | undefined;
  oldPath: JsonValue | undefined;
  newPath: JsonValue | undefined;
  oldLine?: number | undefined;
  newLine?: number | undefined;
};

export const legacyDiscussionPosition = (position: { line?: number | undefined }, anchor: Anchor) => {
  if (position.line === undefined) {
    throw Object.assign(new Error('This GitLab version cannot anchor a comment to a whole file'), { status: 422 });
  }
  const lines = 'newLine' in anchor ? { oldLine: anchor.oldLine, newLine: anchor.newLine } : {};
  return {
    baseSha: anchor.baseSha,
    startSha: anchor.startSha,
    headSha: anchor.headSha,
    oldPath: anchor.oldPath,
    newPath: anchor.newPath,
    positionType: 'text',
    ...lines,
  };
};

export const discussionIdOfNote = (discussions: JsonValue[] | null, noteId: number): string | null => {
  for (const value of discussions ?? []) {
    const discussion = objectOf(value);
    if (!isString(discussion?.id) || !discussion.id) continue;
    if (listOf(discussion.notes)?.some((note) => objectOf(note)?.id === noteId)) return discussion.id;
  }
  return null;
};

export const updateReviewNoteFallback = async (
  client: Client,
  projectId: string | number,
  number: number,
  commentId: number,
  body: string,
  draftSupported: boolean,
  findDiscussionId: () => Promise<string | null>,
): Promise<void> => {
  if (draftSupported) {
    try {
      const updated = await client.MergeRequestDraftNotes.edit(projectId, number, commentId, { note: body });
      if (!isPlainObject(updated) || !Number.isInteger(updated.id)) throw new Error('GitLab returned an invalid draft note');
      return;
    } catch (error) {
      if (requestStatus(error) !== 404) throw error;
    }
  }
  const discussionId = await findDiscussionId();
  if (discussionId !== null) {
    const updated = await client.MergeRequestDiscussions.editNote(projectId, number, discussionId, commentId, { body });
    if (!isPlainObject(updated) || !Number.isInteger(updated.id)) throw new Error('GitLab returned an invalid note');
    return;
  }
  const updated = await client.MergeRequestNotes.edit(projectId, number, commentId, { body });
  if (!isPlainObject(updated) || !Number.isInteger(updated.id)) throw new Error('GitLab returned an invalid note');
};

export const deleteReviewNoteFallback = async (
  client: Client,
  projectId: string | number,
  number: number,
  commentId: number,
  draftSupported: boolean,
  findDiscussionId: () => Promise<string | null>,
): Promise<void> => {
  if (draftSupported) {
    try {
      await client.MergeRequestDraftNotes.remove(projectId, number, commentId);
      return;
    } catch (error) {
      if (requestStatus(error) !== 404) throw error;
    }
  }
  const discussionId = await findDiscussionId();
  if (discussionId !== null) {
    await client.MergeRequestDiscussions.removeNote(projectId, number, discussionId, commentId);
    return;
  }
  await client.MergeRequestNotes.remove(projectId, number, commentId);
};
