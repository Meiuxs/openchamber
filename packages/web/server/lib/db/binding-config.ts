import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Writes the dbhub.toml a database binding runs with. dbhub 2.x dropped the
 * `--readonly` flag in favour of per-tool configuration, so the file is part of
 * the binding — one per binding, keyed by its MCP entry name.
 */

const MAX_TOML_BYTES = 8 * 1024;
const ALIAS_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export const bindingFileNameOf = (alias: string): string => `dbhub-${alias}.toml`;

const bindingDirectoryOf = (directory: string): string => path.join(directory, '.opencode', 'dbhub');

/** Absolute path of a binding's TOML, or null when the inputs are unusable. */
export const bindingConfigPathOf = (directory: string, alias: string): string | null => {
  if (!path.isAbsolute(directory)) return null;
  if (!ALIAS_SLUG.test(alias)) return null;
  return path.join(bindingDirectoryOf(directory), bindingFileNameOf(alias));
};

export const writeBindingConfig = async (
  directory: string,
  alias: string,
  toml: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
  if (toml.trim() === '') return { ok: false, error: 'dbhub.toml payload is required' };
  if (Buffer.byteLength(toml, 'utf8') > MAX_TOML_BYTES) return { ok: false, error: 'dbhub.toml payload is too large' };
  const target = bindingConfigPathOf(directory, alias);
  if (!target) return { ok: false, error: 'A binding needs an absolute project directory and a valid name' };
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, toml, { encoding: 'utf8', mode: 0o600 });
  return { ok: true, path: target };
};

export const removeBindingConfig = async (directory: string, alias: string): Promise<boolean> => {
  const target = bindingConfigPathOf(directory, alias);
  if (!target) return false;
  try {
    await rm(target, { force: true });
    return true;
  } catch {
    return false;
  }
};
