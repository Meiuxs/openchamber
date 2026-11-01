import * as React from 'react';
import { Input } from '@/components/ui/input';
import { SettingsSection, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { useUIStore } from '@/stores/useUIStore';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useI18n } from '@/lib/i18n';

/**
 * The npm registry OpenChamber reads plugin metadata and version checks from
 * (fork: intranet mirror). The box holds raw text while typing; only a whole
 * registry URL the server's resolution accepts persists (the registry's parser
 * drops the rest) and a value that isn't one is called out below the box.
 * Enterprise mode hides the section: where packages come from is the
 * administrator's move, made in the policy file or the environment.
 */
export const NpmRegistrySettings: React.FC = () => {
  const { t } = useI18n();
  const enterpriseMode = useEnterpriseMode();
  const registryValue = useUIStore((state) => state.npmRegistry);
  const setRegistryValue = useUIStore((state) => state.setNpmRegistry);

  const trimmed = registryValue.trim();
  const isValid = React.useMemo(() => {
    if (!trimmed) return true;
    try {
      const url = new URL(trimmed);
      return (url.protocol === 'https:' || url.protocol === 'http:')
        && !url.username && !url.password && !url.search && !url.hash
        && !url.pathname.includes('*');
    } catch {
      return false;
    }
  }, [trimmed]);

  if (enterpriseMode) return null;

  return (
    <SettingsSection
      title={t('settings.openchamber.npmRegistry.title')}
      info={t('settings.openchamber.npmRegistry.info')}
      settingsItem="sessions.npm-registry"
    >
      <SettingsStackedField
        label={t('settings.openchamber.npmRegistry.label')}
        description={isValid
          ? t('settings.openchamber.npmRegistry.syntax')
          : t('settings.openchamber.npmRegistry.invalid')}
        descriptionPlacement="after"
        controlClassName="block max-w-none"
      >
        <Input
          value={registryValue}
          onChange={(event) => setRegistryValue(event.target.value)}
          placeholder="https://registry.npmmirror.com"
          aria-label={t('settings.openchamber.npmRegistry.label')}
          spellCheck={false}
          className="w-full font-mono text-xs"
        />
      </SettingsStackedField>
    </SettingsSection>
  );
};
