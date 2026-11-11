import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitlabIssueLedger, ledgerKey } from './ledger.js';

const dirs = [];
const tempFile = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitlab-ledger-'));
  dirs.push(dir);
  return path.join(dir, 'gitlab-issue-runs.json');
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const run = (overrides = {}) => ({
  origin: 'https://gitlab.example.com', projectId: 42, iid: 17, kind: 'bug',
  phase: 'claimed', targetBranch: 'main', branch: 'openchamber/issue-17-fix',
  actorUserId: 7, actorAccountId: 'acc-7', sessionId: null, worktreePath: null,
  mrIid: null, attempts: 1, leaseUntil: null,
  since: '2026-11-12T09:40:00.000Z', updatedAt: '2026-11-12T09:40:00.000Z',
  lastError: null, blockedReason: null, approvalNoteId: null, planNoteId: null,
  evidenceNoteId: null, ...overrides,
});

describe('GitLab issue ledger', () => {
  it('writes atomically and reads back', async () => {
    const filePath = await tempFile();
    const ledger = createGitlabIssueLedger({ filePath });
    const entry = run();
    await ledger.put(entry);
    expect(await ledger.get(ledgerKey(entry.origin, entry.projectId, entry.iid))).toMatchObject(entry);
    const files = await fs.readdir(path.dirname(filePath));
    expect(files).toEqual(['gitlab-issue-runs.json']);
  });

  it('recovers from a corrupted file and preserves it as a backup', async () => {
    const filePath = await tempFile();
    await fs.writeFile(filePath, '{not json', 'utf8');
    const ledger = createGitlabIssueLedger({ filePath });
    expect(await ledger.list()).toEqual([]);
    const files = await fs.readdir(path.dirname(filePath));
    expect(files.some((name) => name.includes('.corrupt-'))).toBe(true);
  });

  it('drops done records older than thirty days on write', async () => {
    const now = Date.parse('2026-11-12T10:00:00.000Z');
    const filePath = await tempFile();
    const ledger = createGitlabIssueLedger({ filePath, now: () => now });
    await ledger.put(run({ iid: 1, phase: 'done', updatedAt: '2026-10-01T00:00:00.000Z' }));
    await ledger.put(run({ iid: 2, phase: 'done', updatedAt: '2026-11-01T00:00:00.000Z' }));
    await ledger.put(run({ iid: 3, phase: 'implementing' }));
    const iids = (await ledger.list()).map((entry) => entry.iid).sort();
    expect(iids).toEqual([2, 3]);
  });

  it('serializes overlapping writes without losing entries', async () => {
    const filePath = await tempFile();
    const ledger = createGitlabIssueLedger({ filePath });
    await Promise.all([1, 2, 3].map((iid) => ledger.put(run({ iid }))));
    expect((await ledger.list()).map((entry) => entry.iid).sort()).toEqual([1, 2, 3]);
  });

  it('updates an entry and stamps updatedAt', async () => {
    const filePath = await tempFile();
    const now = Date.parse('2026-11-12T11:00:00.000Z');
    const ledger = createGitlabIssueLedger({ filePath, now: () => now });
    await ledger.put(run());
    const key = ledgerKey('https://gitlab.example.com', 42, 17);
    const updated = await ledger.update(key, { phase: 'implementing' });
    expect(updated).toMatchObject({ phase: 'implementing', updatedAt: '2026-11-12T11:00:00.000Z' });
    expect(await ledger.get(key)).toMatchObject({ phase: 'implementing' });
  });
});
