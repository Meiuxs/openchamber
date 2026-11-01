import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import type { TrackerCreateItemInput, TrackerDeleteItemInput, TrackerEditItemInput, TrackerItem, TrackerProviderId } from './types';

/**
 * The board's item mutations: `POST /api/tracker/:provider/items/create`,
 * `/items/edit` and `DELETE /items`, the writes the descriptor's
 * `create`/`edit`/`delete` capability bits gate. The reads go through
 * `RuntimeAPIs.trackers` (the web adapter in
 * `packages/web/src/api/trackers.ts`); these writes ride the same
 * `runtimeFetch` auth path that adapter uses.
 *
 * All reject on failure — a non-2xx answer, and a 2xx that does not carry what
 * it claims — so a failed write never reaches the caller as a success.
 */

const text = z.string().trim().min(1);
const optionalText = z.string().trim().nullish().catch(null).transform((value) => value || null);
const prioritySchema = z.enum(['none', 'urgent', 'high', 'medium', 'low']);
const categorySchema = z.enum(['triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled']);

/** The item fields the dialog reads back; the tracker's own extras are not kept. */
const itemSchema = z.object({
  provider: text,
  id: text,
  identifier: text,
  title: text,
  url: z.string(),
  state: z.object({
    id: optionalText,
    name: z.string().catch(''),
    category: categorySchema.nullable().catch(null),
  }).nullish().catch(null).transform((state) => state ?? null),
  priority: prioritySchema.nullish().catch(null),
  description: z.string().nullish().catch(null).transform((value) => value ?? null),
  labels: z.array(z.object({ id: text, name: text, color: z.string().nullish().catch(null).transform((color) => color ?? null) }))
    .nullish()
    .catch(undefined)
    .transform((labels) => labels ?? undefined),
  // Kept so a surface that lists the item straight from the answer shows the
  // grouping and the blockers it just wrote, before its next read.
  feature: optionalText,
  blockedBy: z.array(text).nullish().catch(null).transform((identifiers) => identifiers ?? undefined),
}) satisfies z.ZodType<TrackerItem>;

const errorSchema = z.object({ error: z.string() });

/** A failed request as an error: the server's own message when it gave one, else `fallback` with the status. */
const failureOf = async (response: Response, fallback: string): Promise<never> => {
  const answer = errorSchema.safeParse(await response.json().catch(() => null));
  throw new Error((answer.success && answer.data.error.trim()) || `${fallback} (${response.status})`);
};

/** The routes answer `{ connected, item }`; `connected: false` is a failure, not an empty success. */
const itemResultSchema = z.union([
  z.object({ connected: z.literal(false) }),
  z.object({ connected: z.literal(true), item: itemSchema.nullable().catch(null) }),
]);

/** `remove` answers `{ connected, removed }`; a false `removed` is a failure too. */
const removedSchema = z.union([
  z.object({ connected: z.literal(false) }),
  z.object({ connected: z.literal(true), removed: z.boolean().catch(false) }),
]);

const postItem = async (
  provider: TrackerProviderId,
  path: string,
  body: TrackerCreateItemInput | TrackerEditItemInput,
  fallback: string,
): Promise<TrackerItem> => {
  const response = await runtimeFetch(`/api/tracker/${encodeURIComponent(provider)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) await failureOf(response, fallback);
  const result = itemResultSchema.safeParse(await response.json().catch(() => null));
  if (!result.success || !result.data.connected || result.data.item === null) {
    throw new Error(`${fallback}: unreadable answer`);
  }
  return result.data.item;
};

/** Creates an item in one of the tracker's containers; the tracker names it. */
export const createTrackerItem = (provider: TrackerProviderId, input: TrackerCreateItemInput): Promise<TrackerItem> => (
  postItem(provider, '/items/create', input, 'Failed to create the tracker item')
);

/** Edits an item's fields; the tracker leaves a field the input omits alone. */
export const editTrackerItem = (provider: TrackerProviderId, input: TrackerEditItemInput): Promise<TrackerItem> => (
  postItem(provider, '/items/edit', input, 'Failed to save the tracker item')
);

/**
 * Deletes an item for good, under the descriptor's `delete` capability. The
 * item is named in the query, the container with it, so the tracker deletes
 * the one in the project the board is showing rather than the first item
 * carrying that number.
 */
export const deleteTrackerItem = async (provider: TrackerProviderId, input: TrackerDeleteItemInput): Promise<void> => {
  const query = new URLSearchParams({ id: input.id });
  if (input.containerId) query.set('containerId', input.containerId);
  const response = await runtimeFetch(`/api/tracker/${encodeURIComponent(provider)}/items?${query.toString()}`, {
    method: 'DELETE',
  });
  if (!response.ok) await failureOf(response, 'Failed to delete the tracker item');
  const result = removedSchema.safeParse(await response.json().catch(() => null));
  // A 2xx that says nothing about the delete is not a delete: the item may
  // still be there, so the caller must not drop it from the list.
  if (!result.success || !result.data.connected || !result.data.removed) {
    throw new Error('Failed to delete the tracker item: unreadable answer');
  }
};
