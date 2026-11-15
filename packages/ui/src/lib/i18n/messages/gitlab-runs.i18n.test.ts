import { describe, expect, test } from 'bun:test';

import { gitlabRunsI18n } from './gitlab-runs.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

// A model reference is one technical string everywhere; everything else is translated.
// The label-chip summaries are symbol strings, not prose, so they repeat too.
const SHARED_VALUES = new Set([
  'settings.projects.page.field.gitlabReviewModelPlaceholder',
  'gitlabRuns.confirm.add',
  'gitlabRuns.confirm.remove',
]);

describe('GitLab runs translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = gitlabRunsI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const translated: Record<string, string> = gitlabRunsI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        const value = translated[key];
        expect(value).toBeTruthy();
        if (locale !== 'en' && !SHARED_VALUES.has(key)) expect(value).not.toBe(english[key]);
      }
    }
  });

  test('keeps the issue and account placeholders in every locale', () => {
    for (const locale of locales) {
      const translated: Record<string, string> = gitlabRunsI18n[locale];
      expect(translated['gitlabRuns.action.issue']).toContain('{iid}');
      expect(translated['gitlabRuns.confirm.comment']).toContain('{iid}');
      expect(translated['gitlabRuns.confirm.comment']).toContain('{account}');
      expect(translated['gitlabRuns.attribution']).toContain('{account}');
      expect(translated['gitlabRuns.review.round']).toContain('{round}');
      expect(translated['gitlabRuns.review.round']).toContain('{max}');
    }
  });
});
