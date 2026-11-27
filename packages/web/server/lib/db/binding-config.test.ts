import { describe, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { primaryConfigPathOf, readPrimaryBinding, writePrimaryBinding } from './binding-config.js';

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-db-primary-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const seedToml = async (dir: string, alias = 'orders'): Promise<void> => {
  await mkdir(path.join(dir, '.opencode', 'dbhub'), { recursive: true });
  await writeFile(path.join(dir, '.opencode', 'dbhub', `dbhub-${alias}.toml`), 'x', 'utf8');
};

describe('primary binding', () => {
  test('round-trips a valid alias', async () => {
    await withDir(async (dir) => {
      await seedToml(dir);
      expect(await writePrimaryBinding(dir, 'orders')).toEqual({ ok: true, alias: 'orders' });
      expect(await readPrimaryBinding(dir)).toBe('orders');
      expect(primaryConfigPathOf(dir)).toBe(path.join(dir, '.opencode', 'dbhub', 'primary.json'));
    });
  });

  test('rejects a missing toml and an invalid slug', async () => {
    await withDir(async (dir) => {
      expect((await writePrimaryBinding(dir, 'orders')).ok).toBe(false);
      await seedToml(dir);
      expect((await writePrimaryBinding(dir, '../etc')).ok).toBe(false);
    });
  });

  test('clears and tolerates corruption', async () => {
    await withDir(async (dir) => {
      await seedToml(dir);
      const target = primaryConfigPathOf(dir);
      expect(target).not.toBeNull();
      await writeFile(target as string, 'not json', 'utf8');
      expect(await readPrimaryBinding(dir)).toBeNull();
      expect(await writePrimaryBinding(dir, null)).toEqual({ ok: true, alias: null });
      expect(await readPrimaryBinding(dir)).toBeNull();
    });
  });

  test('returns null for a non-absolute directory', async () => {
    expect(primaryConfigPathOf('relative/project')).toBeNull();
    expect(await readPrimaryBinding('relative/project')).toBeNull();
  });
});
