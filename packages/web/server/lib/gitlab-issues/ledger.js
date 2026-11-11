import fs from 'node:fs/promises';
import path from 'node:path';
import { isPlainObject } from '../shared/guards.js';

const VERSION = 1;
const DONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const ledgerKey = (origin, projectId, iid) => `${origin}|${projectId}|${iid}`;

/**
 * The run ledger for GitLab issue automation. It is the authoritative phase
 * store; GitLab labels only mirror what is written here.
 */
export function createGitlabIssueLedger({ filePath, now = Date.now, fsImpl = fs } = {}) {
  if (!filePath) throw new Error('GitLab issue ledger path is required');
  let cache = null;
  let writeChain = Promise.resolve();

  const load = async () => {
    if (cache) return cache;
    let raw = '';
    try {
      raw = await fsImpl.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      cache = { version: VERSION, runs: {} };
      return cache;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed) || !isPlainObject(parsed.runs)) throw new Error('invalid shape');
      cache = { version: VERSION, runs: { ...parsed.runs } };
    } catch {
      const backup = `${filePath}.corrupt-${Date.now()}`;
      await fsImpl.rename(filePath, backup).catch(() => {});
      console.warn(`[gitlab-issues] ledger was corrupt; moved to ${backup}`);
      cache = { version: VERSION, runs: {} };
    }
    return cache;
  };

  const persist = async () => {
    const state = await load();
    const cutoff = now() - DONE_RETENTION_MS;
    for (const [key, entry] of Object.entries(state.runs)) {
      if (entry?.phase === 'done' && Number.isFinite(Date.parse(entry.updatedAt)) && Date.parse(entry.updatedAt) < cutoff) {
        delete state.runs[key];
      }
    }
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fsImpl.writeFile(tmp, JSON.stringify({ version: VERSION, runs: state.runs }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fsImpl.rename(tmp, filePath);
  };

  const schedule = (operation) => {
    const next = writeChain.then(operation, operation);
    writeChain = next.catch(() => {});
    return next;
  };

  return {
    async list() {
      const state = await load();
      return Object.values(state.runs).filter(isPlainObject);
    },
    async get(key) {
      const state = await load();
      return state.runs[key] ?? null;
    },
    put(entry) {
      return schedule(async () => {
        const state = await load();
        const key = ledgerKey(entry.origin, entry.projectId, entry.iid);
        const updatedAt = entry.updatedAt ?? new Date(now()).toISOString();
        const next = { ...entry, updatedAt };
        state.runs[key] = next;
        await persist();
        return next;
      });
    },
    update(key, patch) {
      return schedule(async () => {
        const state = await load();
        const current = state.runs[key];
        if (!current) throw new Error(`Unknown GitLab issue run: ${key}`);
        const next = { ...current, ...patch, updatedAt: new Date(now()).toISOString() };
        state.runs[key] = next;
        await persist();
        return next;
      });
    },
    remove(key) {
      return schedule(async () => {
        const state = await load();
        delete state.runs[key];
        await persist();
      });
    },
    close() {
      return writeChain;
    },
  };
}
