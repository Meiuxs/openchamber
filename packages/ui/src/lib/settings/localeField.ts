import type { Locale } from '@/lib/i18n/runtime';
import { useI18nStore } from '@/lib/i18n/store';

export const localeUi = {
  read: () => undefined,
  write: (value: Locale) => {
    void useI18nStore.getState().applyProfileLocale(value);
  },
  autoSave: false,
};
