import { describe, expect, test } from 'bun:test';

import { repositoryBindingsI18n } from './repository-bindings.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

const SAME_AS_ENGLISH = new Map<string, string[]>([
  ['de', ['settings.page.repositories.title', 'repoBindings.action.details', 'repoBindings.detail.revision']],
  ['nl', ['settings.page.repositories.title', 'repoBindings.action.details', 'repoBindings.status.duplicate', 'repoBindings.detail.project', 'repoBindings.field.account.label']],
  ['es', ['repoBindings.status.error']],
  ['fr', ['repoBindings.detail.instance', 'repoBindings.status.error']],
  ['tr', ['repoBindings.status.error']],
]);

describe('repository bindings translations', () => {
  test('keeps result placeholders in every locale', () => {
    for (const locale of locales) {
      const value = repositoryBindingsI18n[locale]['repoBindings.result.partial'];
      expect(value).toContain('{failed}');
      expect(value).toContain('{total}');
    }
  });

  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = repositoryBindingsI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const translated: Record<string, string> = repositoryBindingsI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        const value = translated[key];
        expect(value).toBeTruthy();
        if (locale !== 'en' && !SAME_AS_ENGLISH.get(locale)?.includes(key)) expect(value).not.toBe(english[key]);
      }
    }
  });
});
