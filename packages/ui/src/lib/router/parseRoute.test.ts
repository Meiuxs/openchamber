import { describe, expect, test } from 'bun:test';

import { parseRoute } from './parseRoute';

describe('parseRoute session', () => {
  test('reads a session id including OpenCode underscores', () => {
    const route = parseRoute(new URLSearchParams('session=ses_abc123'));
    expect(route.sessionId).toBe('ses_abc123');
  });

  test('decodes a percent-encoded session id', () => {
    const route = parseRoute(new URLSearchParams('session=ses%5Fabc123'));
    expect(route.sessionId).toBe('ses_abc123');
  });

  test('ignores a blank session param', () => {
    const route = parseRoute(new URLSearchParams('session='));
    expect(route.sessionId).toBeNull();
  });
});

describe('parseRoute message', () => {
  test('reads a linked message next to its session', () => {
    const route = parseRoute(new URLSearchParams('session=ses_abc&message=msg_123'));
    expect(route.messageId).toBe('msg_123');
  });

  test('ignores a message without a session', () => {
    expect(parseRoute(new URLSearchParams('message=msg_123')).messageId).toBeNull();
  });

  test('rejects a message id outside the identifier alphabet', () => {
    expect(parseRoute(new URLSearchParams('session=ses_abc&message=msg"]')).messageId).toBeNull();
  });
});

describe('parseRoute reference', () => {
  const link = 'https://openchamber.local/tracker/local/LOCAL-2';

  test('carries the item link a deep link names', () => {
    expect(parseRoute(new URLSearchParams(`reference=${encodeURIComponent(link)}`)).reference).toBe(link);
  });

  test('only reads an http(s) link', () => {
    expect(parseRoute(new URLSearchParams('reference=javascript%3Aalert(1)')).reference).toBeNull();
    expect(parseRoute(new URLSearchParams('reference=data%3Atext%2Fhtml%2Cx')).reference).toBeNull();
    expect(parseRoute(new URLSearchParams('reference=not%20a%20url')).reference).toBeNull();
    expect(parseRoute(new URLSearchParams('reference=')).reference).toBeNull();
    expect(parseRoute(new URLSearchParams('')).reference).toBeNull();
  });
});
