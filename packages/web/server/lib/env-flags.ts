import { isString } from './shared/object-guards.js';

export const isEnvFlagEnabled = (value: string | boolean | number | undefined) => {
  if (value === true || value === 1) return true;
  if (!isString(value)) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
};

export const isEnvFlagDisabled = (value: string | boolean | number | undefined) => {
  if (value === false || value === 0) return true;
  if (!isString(value)) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '0' || normalized === 'false';
};

export const shouldSkipApiCompression = () => {
  if (isEnvFlagEnabled(process.env.OPENCHAMBER_SKIP_API_COMPRESSION)) return true;
  if (isEnvFlagEnabled(process.env.OPENCHAMBER_COMPRESS_API)) return false;
  if (isEnvFlagDisabled(process.env.OPENCHAMBER_COMPRESS_API)) return true;
  return process.env.OPENCHAMBER_RUNTIME === 'desktop';
};

export const OPENCHAMBER_VERBOSE_REQUEST_LOGS = isEnvFlagEnabled(process.env.OPENCHAMBER_VERBOSE_REQUEST_LOGS);
