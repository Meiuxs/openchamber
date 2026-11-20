import fs from 'fs';
import os from 'os';
import path from 'path';
import { isBoolean, isPlainObject } from '../shared/guards.js';

type Preferences = { sessionComments: boolean };
interface PreferencesDocument {
  sessionComments?: unknown;
}

const DEFAULT_PREFERENCES: Preferences = { sessionComments: true };

function readEnv(name: string): string {
  const raw = process.env[name];
  return raw ? raw.trim() : '';
}

function resolveDataDir(): string {
  const fromEnv = readEnv('OPENCHAMBER_DATA_DIR');
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), '.config', 'openchamber');
}

function storageFile(): string {
  return path.join(resolveDataDir(), 'local-tracker.json');
}

function ensureStorageDir(): void {
  const dir = resolveDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isPreferencesDocument(value: unknown): value is PreferencesDocument {
  return isPlainObject(value);
}

function readJsonFile(filePath: string): PreferencesDocument | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const parsed: unknown = JSON.parse(trimmed);
    return isPreferencesDocument(parsed) ? parsed : null;
  } catch (error) {
    console.error('Failed to read local tracker preferences file:', error);
    return null;
  }
}

function writeJsonFile(filePath: string, payload: Preferences): void {
  ensureStorageDir();
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // SAFETY: chmod 0600 is best-effort; the rename still publishes the file on filesystems without POSIX modes.
  }
  fs.renameSync(tmpFile, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // SAFETY: chmod 0600 is best-effort; the file is already published and readable by its owner.
  }
}

function normalizePreferences(value: PreferencesDocument | null): Preferences {
  if (!isPreferencesDocument(value)) {
    return { ...DEFAULT_PREFERENCES };
  }
  return { sessionComments: isBoolean(value.sessionComments) ? value.sessionComments : true };
}

export function readLocalPreferences(): Preferences {
  return normalizePreferences(readJsonFile(storageFile()));
}

export function writeLocalPreferences(input: PreferencesDocument | null): Preferences {
  const next = normalizePreferences(input);
  writeJsonFile(storageFile(), next);
  return next;
}
