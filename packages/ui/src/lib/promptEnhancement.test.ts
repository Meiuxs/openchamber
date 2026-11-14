import { describe, expect, test } from 'bun:test';

import {
  extractProtectedFragments,
  normalizePromptEnhancement,
  PromptEnhancementError,
  type PromptEnhancementErrorCode,
  validatePromptEnhancementOutput,
} from './promptEnhancement';

const errorCode = (run: () => void): PromptEnhancementErrorCode => {
  try {
    run();
  } catch (error) {
    if (!(error instanceof PromptEnhancementError)) throw error;
    return error.code;
  }
  throw new Error('Expected the call to throw');
};

describe('normalizePromptEnhancement', () => {
  test('trims the reply and removes one outer fence', () => {
    expect(normalizePromptEnhancement('  ```text\nRewrite this\n```  ')).toBe('Rewrite this');
    expect(normalizePromptEnhancement('Rewrite this')).toBe('Rewrite this');
  });
});

describe('extractProtectedFragments', () => {
  test('keeps file, skill, snippet, URL and attachment references', () => {
    const fragments = extractProtectedFragments(
      '@src/foo.ts $debug #signoff see https://example.test/x and [diagram.png]',
      ['diagram.png'],
    );

    expect(fragments).toContain('@src/foo.ts');
    expect(fragments).toContain('$debug');
    expect(fragments).toContain('#signoff');
    expect(fragments).toContain('https://example.test/x');
    expect(fragments).toContain('[diagram.png]');
    expect(fragments).not.toContain('$5');
  });
});

describe('validatePromptEnhancementOutput', () => {
  test('an unchanged draft reports no change', () => {
    expect(validatePromptEnhancementOutput('Fix it', [], 'Fix it')).toEqual({ text: 'Fix it', changed: false });
  });

  test('an empty reply fails', () => {
    expect(() => validatePromptEnhancementOutput('Fix it', [], '   ')).toThrow(PromptEnhancementError);
  });

  test('a rewrite that keeps every reference passes', () => {
    const result = validatePromptEnhancementOutput(
      'Fix @src/foo.ts with $debug, see https://example.test/x\n```ts\nconst a = 1;\n```',
      [],
      'Goal: fix the bug in @src/foo.ts using $debug.\nSee https://example.test/x\n```ts\nconst a = 1;\n```',
    );

    expect(result.changed).toBe(true);
    expect(result.text).toContain('@src/foo.ts');
  });

  test('a dropped file reference keeps the original', () => {
    expect(errorCode(() => validatePromptEnhancementOutput('Fix @src/foo.ts', [], 'Fix the bug'))).toBe('references-changed');
  });

  test('a dropped skill reference keeps the original', () => {
    expect(errorCode(() => validatePromptEnhancementOutput('Use $debug please', [], 'Please debug it'))).toBe('references-changed');
  });

  test('a dropped snippet reference keeps the original', () => {
    expect(errorCode(() => validatePromptEnhancementOutput('Use #signoff please', [], 'Please sign off'))).toBe('references-changed');
  });

  test('a dropped URL keeps the original', () => {
    expect(errorCode(() => validatePromptEnhancementOutput('Read https://example.test/x', [], 'Read the page'))).toBe('references-changed');
  });

  test('a dropped attachment citation keeps the original', () => {
    expect(errorCode(() => validatePromptEnhancementOutput('Describe [diagram.png]', ['diagram.png'], 'Describe the diagram'))).toBe('references-changed');
  });

  test('a dropped code fence keeps the original', () => {
    expect(errorCode(() => validatePromptEnhancementOutput('Fix\n```ts\nconst a = 1;\n```', [], 'Fix the code'))).toBe('references-changed');
  });

  test('a runaway rewrite keeps the original', () => {
    const draft = 'Fix the bug';
    const reply = 'Fix the bug '.repeat(200);
    expect(errorCode(() => validatePromptEnhancementOutput(draft, [], reply))).toBe('too-long');
  });
});
