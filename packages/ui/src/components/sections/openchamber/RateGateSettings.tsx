import * as React from 'react';

import { NumberInput } from '@/components/ui/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  SETTINGS_NUMBER_INPUT_CLASS,
  SETTINGS_NUMBER_STEPPER_ROW_CLASS,
  SETTINGS_NUMBER_UNIT_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsFieldRow,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import type { Provider } from '@/lib/opencode/model';
import { cn, isRecord } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useRateGateStatus } from '@/stores/useRateGateStore';
import { useUIStore } from '@/stores/useUIStore';

const toGatewayUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
};

const gatewayUrlOf = (provider: Provider): string | null => {
  const settings = provider.settings;
  if (!isRecord(settings)) return null;
  return toGatewayUrl(settings.baseURL);
};

const gatewayLines = (value: string): string[] => value
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== '');

export const RateGateSettings: React.FC = () => {
  const { t } = useI18n();
  const settingsDirectory = useSettingsDirectory();
  const providers = useConfigStore((state) => selectProvidersForDirectory(state, settingsDirectory));
  const requests = useUIStore((state) => state.modelRateLimitRequests);
  const windowMinutes = useUIStore((state) => state.modelRateLimitWindowMinutes);
  const gateways = useUIStore((state) => state.modelRateLimitGateways);
  const setRequests = useUIStore((state) => state.setModelRateLimitRequests);
  const setWindowMinutes = useUIStore((state) => state.setModelRateLimitWindowMinutes);
  const setGateways = useUIStore((state) => state.setModelRateLimitGateways);
  const status = useRateGateStatus();
  const caps = status?.caps ?? null;

  const candidates = React.useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{ id: string; name: string; url: string }> = [];
    for (const provider of providers) {
      const url = gatewayUrlOf(provider);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      result.push({ id: provider.id, name: provider.name || provider.id, url });
    }
    return result;
  }, [providers]);

  const appendGateway = (url: string) => {
    const lines = gatewayLines(gateways);
    if (lines.includes(url)) return;
    setGateways([...lines, url].join('\n'));
  };

  const requestsMax = caps?.requests ?? 10000;
  const windowMax = caps?.windowMinutes ?? 1440;
  const requestsHint = caps?.requests != null
    ? t('settings.openchamber.rateGate.cap', { value: caps.requests })
    : t('settings.openchamber.rateGate.requestsInfo');
  const windowHint = caps?.windowMinutes != null
    ? t('settings.openchamber.rateGate.cap', { value: caps.windowMinutes })
    : t('settings.openchamber.rateGate.windowInfo');
  const gateOff = gateways.trim() === '';

  return (
    <SettingsSection
      title={t('settings.openchamber.rateGate.title')}
      info={t('settings.openchamber.rateGate.info')}
      contentClassName="space-y-1"
    >
      <SettingsFieldRow
        settingsItem="sessions.rate-gate-requests"
        label={t('settings.openchamber.rateGate.requests')}
        info={requestsHint}
      >
        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
          <NumberInput
            containerClassName="w-fit"
            min={1}
            max={requestsMax}
            step={1}
            className={cn(SETTINGS_NUMBER_INPUT_CLASS, 'tabular-nums')}
            value={requests}
            onValueChange={(next) => {
              if (Number.isFinite(next) && next >= 1 && next <= requestsMax) setRequests(next);
            }}
          />
          <span className={SETTINGS_NUMBER_UNIT_CLASS}>{t('settings.openchamber.rateGate.requestsUnit')}</span>
        </div>
      </SettingsFieldRow>
      <SettingsFieldRow
        settingsItem="sessions.rate-gate-window"
        label={t('settings.openchamber.rateGate.window')}
        info={windowHint}
      >
        <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
          <NumberInput
            containerClassName="w-fit"
            min={1}
            max={windowMax}
            step={1}
            className={cn(SETTINGS_NUMBER_INPUT_CLASS, 'tabular-nums')}
            value={windowMinutes}
            onValueChange={(next) => {
              if (Number.isFinite(next) && next >= 1 && next <= windowMax) setWindowMinutes(next);
            }}
          />
          <span className={SETTINGS_NUMBER_UNIT_CLASS}>{t('settings.openchamber.rateGate.windowUnit')}</span>
        </div>
      </SettingsFieldRow>
      <SettingsStackedField
        settingsItem="sessions.rate-gate-gateways"
        label={t('settings.openchamber.rateGate.gateways')}
        description={t('settings.openchamber.rateGate.gatewaysSyntax')}
        descriptionPlacement="after"
        controlClassName="block max-w-[24rem]"
      >
        <Textarea
          value={gateways}
          onChange={(event) => setGateways(event.target.value)}
          placeholder={'https://gateway.example.com/v1'}
          aria-label={t('settings.openchamber.rateGate.gateways')}
          spellCheck={false}
          rows={2}
          className="w-full resize-none font-mono text-xs"
        />
        {candidates.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Select value="" onValueChange={appendGateway}>
              <SelectTrigger
                className={cn(SETTINGS_SELECT_ROW_TRIGGER_CLASS, 'w-fit max-w-full min-w-[12rem]')}
                aria-label={t('settings.openchamber.rateGate.fromProvider')}
              >
                <SelectValue placeholder={t('settings.openchamber.rateGate.fromProvider')} />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.url}>{candidate.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </SettingsStackedField>
      {gateOff ? (
        <p className="text-xs text-muted-foreground">{t('settings.openchamber.rateGate.disabled')}</p>
      ) : null}
    </SettingsSection>
  );
};
