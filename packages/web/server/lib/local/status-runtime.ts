import { asNonEmptyString, isPlainObject } from '../shared/guards.js';

import type {
  TrackerRuntimeEvent,
  TrackerSessionStatusKind,
  TrackerSessionStatusResult,
  TrackerSessionStatusRuntime,
} from '../trackers/tracker-contract.js';

interface LocalEventFields {
  info?: unknown;
  status?: unknown;
  error?: unknown;
  sessionID?: unknown;
  sessionId?: unknown;
  session?: unknown;
  type?: unknown;
  name?: unknown;
}

type LocalPost = (input: { kind: TrackerSessionStatusKind; sessionId: string }) => Promise<TrackerSessionStatusResult> | TrackerSessionStatusResult;

function readProperties(payload: TrackerRuntimeEvent): LocalEventFields {
  if (!isPlainObject(payload)) return {};
  return isPlainObject(payload.properties) ? payload.properties : {};
}

function readNested(properties: LocalEventFields, key: 'info' | 'status' | 'error'): LocalEventFields {
  return isPlainObject(properties[key]) ? properties[key] : {};
}

function extractSessionId(payload: TrackerRuntimeEvent): string {
  const properties = readProperties(payload);
  const info = readNested(properties, 'info');
  return asNonEmptyString(info.sessionID)
    || asNonEmptyString(info.sessionId)
    || asNonEmptyString(properties.sessionID)
    || asNonEmptyString(properties.sessionId)
    || asNonEmptyString(properties.session)
    || '';
}

function extractStatusType(payload: TrackerRuntimeEvent): string {
  if (!isPlainObject(payload) || payload.type !== 'session.status') return '';
  const properties = readProperties(payload);
  const status = readNested(properties, 'status');
  const info = readNested(properties, 'info');
  return asNonEmptyString(status.type) || asNonEmptyString(info.type) || '';
}

function extractErrorName(payload: TrackerRuntimeEvent): string {
  if (!isPlainObject(payload) || payload.type !== 'session.error') return '';
  const properties = readProperties(payload);
  return asNonEmptyString(readNested(properties, 'error').name) || '';
}

export function createLocalSessionStatusRuntime({ post }: { post: LocalPost }): TrackerSessionStatusRuntime {
  if (!(post instanceof Function)) {
    throw new Error('createLocalSessionStatusRuntime requires a post function');
  }

  let stopped = false;

  const processPayload = (payload: TrackerRuntimeEvent): void => {
    if (stopped) return;
    const sessionId = extractSessionId(payload);
    if (!sessionId) return;

    if (isPlainObject(payload) && payload.type === 'session.error') {
      if (extractErrorName(payload) === 'MessageAbortedError') return;
      void Promise.resolve(post({ kind: 'failure', sessionId })).catch((error) => {
        console.warn('[local] failed to post session failure comment:', error?.message || error);
      });
      return;
    }

    if (extractStatusType(payload) !== 'idle') return;
    void Promise.resolve(post({ kind: 'completed', sessionId })).catch((error) => {
      console.warn('[local] failed to post session completed comment:', error?.message || error);
    });
  };

  const stop = (): void => {
    stopped = true;
  };

  return { processPayload, stop };
}
