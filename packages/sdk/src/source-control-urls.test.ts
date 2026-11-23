import { describe, expect, test } from 'bun:test';

import { SOURCE_CONTROL_URL_TEMPLATES_MAX } from './manifest.ts';
import { sourceControlUrlsSchema } from './source-control-urls.ts';

const base = { changeRequest: ['https://git.example/cr/{id}'], issue: ['https://git.example/issues/{id}'] };
const parsed = (value: unknown) => sourceControlUrlsSchema.safeParse(value);

describe('source control url templates', () => {
  test('accepts non-empty templates and trims surrounding whitespace', () => {
    const result = parsed({ ...base, changeRequest: ['  https://git.example/cr/{id}  '] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.changeRequest).toEqual(['https://git.example/cr/{id}']);
    }
  });

  test('accepts a valid guest request path for resolve', () => {
    expect(parsed({ ...base, resolve: '/source-control/resolve' }).success).toBe(true);
  });

  test('rejects a blank template', () => {
    expect(parsed({ ...base, changeRequest: ['   '] }).success).toBe(false);
    expect(parsed({ ...base, issue: [''] }).success).toBe(false);
  });

  test('rejects more than the allowed number of templates', () => {
    const tooMany = Array.from({ length: SOURCE_CONTROL_URL_TEMPLATES_MAX + 1 }, (_, i) => `https://git.example/${i}`);
    expect(parsed({ ...base, changeRequest: tooMany }).success).toBe(false);
  });

  test('rejects a resolve value that is not a guest request path', () => {
    expect(parsed({ ...base, resolve: 'source-control/resolve' }).success).toBe(false);
    expect(parsed({ ...base, resolve: '/a/../b' }).success).toBe(false);
    expect(parsed({ ...base, resolve: 'https://git.example/resolve' }).success).toBe(false);
    expect(parsed({ ...base, resolve: 'x'.repeat(257) }).success).toBe(false);
  });

  test('rejects unknown keys and missing required template lists', () => {
    expect(parsed({ ...base, extra: true }).success).toBe(false);
    expect(parsed({ changeRequest: base.changeRequest }).success).toBe(false);
    expect(parsed({ issue: base.issue }).success).toBe(false);
  });
});
