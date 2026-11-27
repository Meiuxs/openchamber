import { beforeEach, describe, expect, test } from 'bun:test';

import { useDbBindingStore } from './useDbBindingStore';

beforeEach(() => {
  useDbBindingStore.setState({
    primaryByDirectory: {},
    selectionBySession: {},
    announcedBySession: {},
  });
});

describe('useDbBindingStore', () => {
  test('keeps a per-session selection and its announced marker', () => {
    const store = useDbBindingStore.getState();
    store.setSelection('s1', 'dbhub-orders');
    store.markAnnounced('s1', 'dbhub-orders');
    expect(useDbBindingStore.getState().selectionBySession.s1).toBe('dbhub-orders');
    expect(useDbBindingStore.getState().announcedBySession.s1).toBe('dbhub-orders');
  });

  test('changing the selection forgets what was announced', () => {
    const store = useDbBindingStore.getState();
    store.markAnnounced('s1', 'dbhub-orders');
    store.setSelection('s1', 'dbhub-archive');
    expect(useDbBindingStore.getState().announcedBySession.s1).toBeUndefined();
  });

  test('forgetting a session drops both maps', () => {
    const store = useDbBindingStore.getState();
    store.setSelection('s1', 'dbhub-orders');
    store.markAnnounced('s1', 'dbhub-orders');
    store.forgetSession('s1');
    expect(useDbBindingStore.getState().selectionBySession.s1).toBeUndefined();
    expect(useDbBindingStore.getState().announcedBySession.s1).toBeUndefined();
  });

  test('loads the alias from the server and stores the entry name', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, alias: 'orders' }), { status: 200 })) as typeof fetch;
    try {
      await useDbBindingStore.getState().loadPrimary('/tmp/project');
      expect(useDbBindingStore.getState().primaryByDirectory['/tmp/project']).toBe('dbhub-orders');
    } finally {
      globalThis.fetch = original;
    }
  });
});
