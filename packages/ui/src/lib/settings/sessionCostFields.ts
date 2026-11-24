import { parsePositiveNumber, type SettingsParser } from '@/lib/settings/parsers';
import {
  DEFAULT_SESSION_COST_SETTINGS,
  isUsableSessionCostPair,
  readSessionCostSettings,
  writeSessionCostSettings,
  type SessionCostSettings,
} from '@/stores/useSessionCostSettingsStore';

export const sessionCostField = <K extends keyof SessionCostSettings>(key: K) => ({
  read: () => readSessionCostSettings()[key],
  write: (value: SessionCostSettings[K]) => {
    // SAFETY: a single-key patch built from the key it is typed by.
    writeSessionCostSettings({ [key]: value } as Pick<SessionCostSettings, K>);
  },
  autoSave: false,
});

export const parseSessionCostAmount: SettingsParser<number> = (value, raw) => {
  const amount = parsePositiveNumber(value, raw);
  if (amount === undefined) return undefined;
  const amountOr = (key: 'sessionCostWarnThreshold' | 'sessionCostCriticalThreshold'): number => (
    parsePositiveNumber(raw[key], raw) ?? DEFAULT_SESSION_COST_SETTINGS[key]
  );
  return isUsableSessionCostPair(amountOr('sessionCostWarnThreshold'), amountOr('sessionCostCriticalThreshold')) ? amount : undefined;
};
