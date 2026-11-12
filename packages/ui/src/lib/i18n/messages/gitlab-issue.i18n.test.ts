import { describe, expect, test } from 'bun:test';

import { gitlabIssueI18n } from './gitlab-issue.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('GitLab issue dialog translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = gitlabIssueI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const translated: Record<string, string> = gitlabIssueI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        const value = translated[key];
        expect(value).toBeTruthy();
        if (locale !== 'en') expect(value).not.toBe(english[key]);
      }
    }
  });

  test('the created message keeps its issue number placeholder in every locale', () => {
    for (const locale of locales) {
      expect(gitlabIssueI18n[locale]['gitlabIssue.created']).toContain('{iid}');
    }
  });
});
