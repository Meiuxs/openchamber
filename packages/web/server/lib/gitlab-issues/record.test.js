import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  escapeMarkdownCell, escapeMarkdownText, fencedText,
  recordExists, recordLocationFor, renderRunRecord, writeRunRecord,
} from './record.js';

const dirs = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const run = (overrides = {}) => ({
  origin: 'https://gitlab.example.com',
  projectEntryId: 'project-1',
  projectId: 42,
  projectPath: 'group/repo',
  title: 'Fix login',
  iid: 17,
  kind: 'bug',
  phase: 'implementing',
  targetBranch: 'main',
  branch: 'openchamber/issue-17-fix-login',
  actorUserId: 7,
  actorAccountId: 'acc-7',
  worktreePath: 'D:/worktrees/issue-17',
  mrIid: null,
  attempts: 1,
  reviewRounds: 0,
  feedbackRounds: 0,
  reviewVerdict: null,
  since: '2026-11-24T09:00:00.000Z',
  updatedAt: '2026-11-24T09:05:00.000Z',
  lastError: null,
  blockedReason: null,
  triage: { verdict: 'valid', summary: 'It reproduces', evidence: null, missing: null },
  plan: null,
  evidence: {
    rootCause: 'The retry loop drops the token',
    changes: 'Keep the token',
    verification: [{ command: 'bun test auth', result: 'pass' }],
    risks: 'Token refresh ordering',
  },
  changeSummary: {
    baseRef: 'origin/main',
    files: [{ path: 'src/a.ts', status: 'modified', added: 3, removed: 1 }],
    commits: [{ sha: 'abc1234', subject: 'fix: keep the token' }],
    capturedAt: '2026-11-24T09:04:00.000Z',
  },
  verifyResult: { command: 'bun test', code: 0, outputTail: 'ok', at: '2026-11-24T09:04:30.000Z' },
  reviewHistory: [
    { seq: 1, kind: 'review', round: 1, verdict: 'request-changes', summary: 'Rename it', findings: [{ file: 'src/a.ts', line: 4, severity: 'blocker', note: 'Use the `retry` helper' }], at: '2026-11-24T09:05:00.000Z' },
    { seq: 2, kind: 'review', round: 1, verdict: 'approve', summary: 'Now it is right', findings: [], at: '2026-11-24T09:06:00.000Z' },
  ],
  feedbackHistory: [{ round: 1, items: [{ author: 'rev', text: 'Please rename this' }], at: '2026-11-24T09:07:00.000Z' }],
  events: [{ at: '2026-11-24T09:00:00.000Z', kind: 'phase', from: null, to: 'claimed' }],
  ...overrides,
});

describe('record helpers', () => {
  it('builds stable primary and fallback paths without escaping the checkout', () => {
    const location = recordLocationFor({ checkoutPath: 'D:/repo', projectPath: '../group/repo', iid: 17 });
    expect(location.primary).toBe(path.join('D:/repo', '.openchamber', 'issue-records', '__', 'group', 'repo', 'issue-17.md'));
    expect(location.fallback).toBe(path.join('D:/repo', '.git', 'openchamber', 'issue-records', '__', 'group', 'repo', 'issue-17.md'));
    const other = recordLocationFor({ checkoutPath: 'D:/repo', projectPath: 'group/other', iid: 17 });
    expect(other.primary).not.toBe(location.primary);
  });

  it('escapes table cells, block markers, and fences', () => {
    expect(escapeMarkdownCell('a | b\nc')).toBe('a \\| b c');
    expect(escapeMarkdownText('## forged\n- item')).toContain('\\#\\# forged');
    expect(fencedText('```js\nx\n```')).toContain('````');
  });
});

describe('renderRunRecord', () => {
  it('renders the delivery sections that the ledger can fill', () => {
    const text = renderRunRecord(run());
    expect(text).toContain('# Fix login (#17)');
    expect(text).toContain('## 交付摘要');
    expect(text).toContain('The retry loop drops the token');
    expect(text).toContain('src/a.ts');
    expect(text).toContain('abc1234');
    expect(text).toContain('bun test auth');
    expect(text).toContain('review');
    expect(text).toContain('Please rename this');
  });

  it('omits sections with no data and never throws on an old entry', () => {
    const text = renderRunRecord(run({
      triage: null, plan: null, evidence: null, changeSummary: null, verifyResult: null,
      reviewHistory: null, reviewImpact: null, feedbackHistory: null, events: null,
    }));
    expect(text).not.toContain('## 变更文件');
    expect(text).not.toContain('## 验证');
    expect(text).toContain('# Fix login (#17)');
  });

  it('keeps forged headings and table pipes as text', () => {
    const text = renderRunRecord(run({ title: 'Fix | login\n## 审核' }));
    expect(text).toContain('Fix \\| login ## 审核 (#17)');
    expect(text).toContain('\n## 审核\n');
  });
});

describe('writeRunRecord', () => {
  it('writes under the checkout, appends the exclude entry once, and skips identical content', async () => {
    const checkout = await fs.mkdtemp(path.join(os.tmpdir(), 'record-checkout-'));
    dirs.push(checkout);
    const exclude = path.join(checkout, '.git', 'info', 'exclude');
    await fs.mkdir(path.dirname(exclude), { recursive: true });
    const first = await writeRunRecord({ run: run(), checkoutPath: checkout, excludePath: exclude });
    expect(first.written).toBe(true);
    expect(await fs.readFile(exclude, 'utf8')).toContain('.openchamber/issue-records/');
    const second = await writeRunRecord({ run: run(), checkoutPath: checkout, excludePath: exclude });
    expect(second.written).toBe(false);
    expect((await fs.readFile(exclude, 'utf8')).match(/\.openchamber\/issue-records\//g)).toHaveLength(1);
    const newer = await writeRunRecord({
      run: run({ updatedAt: '2026-11-24T10:00:00.000Z' }),
      checkoutPath: checkout,
      excludePath: exclude,
    });
    expect(newer.written).toBe(false);
  });

  it('falls back when the exclude file cannot be written', async () => {
    const checkout = await fs.mkdtemp(path.join(os.tmpdir(), 'record-checkout-'));
    dirs.push(checkout);
    const exclude = path.join(checkout, '.git', 'info', 'exclude');
    await fs.mkdir(path.dirname(exclude), { recursive: true });
    const failingFs = {
      ...fs,
      readFile: async (file, encoding) => {
        if (String(file) === exclude) throw new Error('read-only');
        return fs.readFile(file, encoding);
      },
      writeFile: async (file, data, options) => {
        if (String(file) === exclude) throw new Error('read-only');
        return fs.writeFile(file, data, options);
      },
    };
    const result = await writeRunRecord({ run: run(), checkoutPath: checkout, excludePath: exclude, fsImpl: failingFs });
    expect(result.path).toContain(path.join('.git', 'openchamber', 'issue-records'));
  });

  it('falls back inside .git when no exclude path is available', async () => {
    const checkout = await fs.mkdtemp(path.join(os.tmpdir(), 'record-checkout-'));
    dirs.push(checkout);
    const result = await writeRunRecord({ run: run(), checkoutPath: checkout, excludePath: null });
    expect(result.path).toContain(path.join('.git', 'openchamber', 'issue-records'));
    expect(await recordExists(recordLocationFor({ checkoutPath: checkout, projectPath: 'group/repo', iid: 17 }))).toBe(result.path);
  });
});
