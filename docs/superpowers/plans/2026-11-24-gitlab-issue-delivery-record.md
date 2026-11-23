# GitLab issue delivery record implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-written Markdown delivery note for every GitLab issue run, stored inside the project checkout and never committed.

**Architecture:** The dispatcher captures git facts at evidence, block, and verify time, keeps bounded review and feedback history in the ledger, and renders a Markdown note from the ledger on every tick. The runs route exposes the note path when the file exists, and the runs panel opens it through the existing local file viewer. A pre-push gate blocks a run when the note cannot be written and retries in place.

**Tech Stack:** TypeScript server under `packages/web/server`, React UI under `packages/ui`, `vitest` for server tests, `bun:test` plus `react-dom/server` for UI tests.

**Spec:** `docs/superpowers/specs/2026-11-24-gitlab-issue-delivery-record-design.md`

## Global Constraints

- Do not run git or GitHub commands. The maintainer reviews the working tree; no commits.
- No browser tests or dev-instance runs. Unit tests are the acceptance bar.
- Each subagent edits only its task's files and runs only its task's focused test command. The coordinator runs the combined type-check, lint, and full test files at the end.
- Preserve unrelated worktree changes. The checkout already has user edits; never revert or restage them.
- Git commands must work on Git 2.20. Do not add newer flags.
- No new dependencies.
- Do not hide all of `.openchamber/` in `.git/info/exclude`. Exclude only `.openchamber/issue-records/`.
- Every UI string goes through i18n and gets a real translation in all 15 dictionaries. English text copied into another locale is a defect.
- Generated record headings are Chinese, matching the automation's issue comments. Code, comments, and repository docs are English.
- Existing ledger entries and older servers must keep working. All new fields are optional on read.

## Review Focus

1. Issue title, review finding, or feedback text containing Markdown that would forge a section, break a table, or close a fence. Expected: rendered as text, document structure intact.
2. A read-only `.git` or a checkout whose exclude file cannot be written. Expected: note lands in `.git/openchamber/issue-records/`, `git status` stays clean, push is not blocked.
3. `record-write-failed` that persists. Expected: run stays blocked with its worktree, holds no dispatch slot, retries each tick, manual reset still works.
4. A run with no worktree at block time or an old ledger entry without the new fields. Expected: note renders the sections it can, no throw.
5. Two GitLab projects sharing one checkout, or a project path with `..` segments. Expected: separate record paths and no path escape.

---

### Task 1: Ledger record fields

**Files:**
- Modify: `packages/web/server/lib/gitlab-issues/ledger.ts`
- Test: `packages/web/server/lib/gitlab-issues/ledger.test.js`

**Interfaces:**
- Consumes: existing `RunEntry`, `Finding` from `prompts.ts`.
- Produces: exported types `ChangeSummaryFile`, `ChangeSummaryCommit`, `ChangeSummary`, `VerifyResult`, `ApprovedBy`, `ReviewHistoryEntry`, `FeedbackHistoryEntry`; optional `RunEntry` fields `changeSummary`, `verifyResult`, `approvedBy`, `reviewHistory`, `feedbackHistory`.

- [ ] **Step 1: Add the round-trip test**

Append to `ledger.test.js`:

```js
it('round-trips the delivery record fields', async () => {
  const filePath = await tempFile();
  const ledger = createGitlabIssueLedger({ filePath });
  const entry = run({
    changeSummary: {
      baseRef: 'origin/main',
      files: [{ path: 'src/a.ts', status: 'modified', added: 3, removed: 1 }],
      commits: [{ sha: 'abc1234', subject: 'fix: guard the retry' }],
      capturedAt: '2026-11-24T09:00:00.000Z',
    },
    verifyResult: { command: 'bun test', code: 0, outputTail: 'ok', at: '2026-11-24T09:01:00.000Z' },
    approvedBy: { login: 'mei', userId: 7, accountId: 'acc-7', at: '2026-11-24T08:00:00.000Z' },
    reviewHistory: [{
      seq: 1, kind: 'review', round: 0, verdict: 'approve', summary: 'Looks right', findings: [],
      at: '2026-11-24T09:02:00.000Z',
    }],
    feedbackHistory: [{ round: 1, items: [{ author: 'rev', text: 'rename this' }], at: '2026-11-24T09:03:00.000Z' }],
  });
  await ledger.put(entry);
  expect(await ledger.get(ledgerKey(entry.origin, entry.projectId, entry.iid))).toMatchObject(entry);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/web && bunx vitest run server/lib/gitlab-issues/ledger.test.js`
Expected: FAIL, the new fields are not preserved by the TypeScript shape.

- [ ] **Step 3: Add the types and fields**

In `ledger.ts`, add after `RunFeedbackItem`:

```ts
export interface ChangeSummaryFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: number | null;
  removed: number | null;
}

export interface ChangeSummaryCommit {
  sha: string;
  subject: string;
}

export interface ChangeSummary {
  baseRef: string;
  files: ChangeSummaryFile[];
  commits: ChangeSummaryCommit[];
  capturedAt: string;
}

export interface VerifyResult {
  command: string;
  code: number | null;
  outputTail: string;
  at: string;
}

export interface ApprovedBy {
  login: string;
  userId: number | null;
  accountId: string | null;
  at: string;
}

export interface ReviewHistoryEntry {
  seq: number;
  kind: 'review' | 'recheck';
  round: number;
  verdict: 'approve' | 'request-changes';
  summary: string;
  findings: Finding[];
  at: string;
}

export interface FeedbackHistoryEntry {
  round: number;
  items: { author: string; text: string }[];
  at: string;
}
```

Add to `RunEntry`, next to the existing optional fields:

```ts
  changeSummary?: ChangeSummary | null | undefined;
  verifyResult?: VerifyResult | null | undefined;
  approvedBy?: ApprovedBy | null | undefined;
  reviewHistory?: ReviewHistoryEntry[] | null | undefined;
  feedbackHistory?: FeedbackHistoryEntry[] | null | undefined;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/web && bunx vitest run server/lib/gitlab-issues/ledger.test.js`
Expected: PASS.

---

### Task 2: Workspace change summary

**Files:**
- Modify: `packages/web/server/lib/gitlab-issues/workspace.ts`
- Modify: `packages/web/server/lib/gitlab-issues/dispatcher.ts` (interface only, the `CreateGitlabIssueWorkspaceLike` declaration)
- Test: `packages/web/server/lib/gitlab-issues/workspace.test.js`

**Interfaces:**
- Consumes: `ChangeSummary`, `ChangeSummaryFile` from `ledger.ts`.
- Produces: workspace method `describeChanges(input: { cwd: string; baseRef: string }): Promise<ChangeSummary | null>`.

- [ ] **Step 1: Add the failing tests**

Append to `workspace.test.js`:

```js
it('describes the diff and commits against the merge base', async () => {
  const { spawnImpl, calls } = fakeSpawn([
    {
      when: (args) => args[0] === 'diff' && args.includes('--numstat'),
      stdout: '3\t1\tsrc/a.ts\n-\t-\tassets/logo.png\n',
    },
    {
      when: (args) => args[0] === 'diff' && args.includes('--name-status'),
      stdout: 'M\tsrc/a.ts\nA\tassets/logo.png\nD\tsrc/old.ts\n',
    },
    {
      when: (args) => args[0] === 'log',
      stdout: 'abc1234\tfix: guard the retry\ndef5678\tchore: naming\n',
    },
  ]);
  const workspace = createGitlabIssueWorkspace({ spawnImpl, credentialBroker: broker() });
  const summary = await workspace.describeChanges({ cwd: 'D:/repo', baseRef: 'origin/main' });
  expect(summary).toMatchObject({
    baseRef: 'origin/main',
    files: [
      { path: 'assets/logo.png', status: 'added', added: null, removed: null },
      { path: 'src/a.ts', status: 'modified', added: 3, removed: 1 },
      { path: 'src/old.ts', status: 'deleted', added: null, removed: null },
    ],
    commits: [
      { sha: 'abc1234', subject: 'fix: guard the retry' },
      { sha: 'def5678', subject: 'chore: naming' },
    ],
  });
  const diffCall = calls.find((call) => call.args.includes('--numstat'));
  expect(diffCall.args.join(' ')).toContain('origin/main...HEAD');
});

it('returns null when git cannot describe the change', async () => {
  const { spawnImpl } = fakeSpawn([
    { when: (args) => args[0] === 'diff' && args.includes('--numstat'), stderr: 'bad revision', code: 128 },
  ]);
  const workspace = createGitlabIssueWorkspace({ spawnImpl, credentialBroker: broker() });
  await expect(workspace.describeChanges({ cwd: 'D:/repo', baseRef: 'origin/main' })).resolves.toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/web && bunx vitest run server/lib/gitlab-issues/workspace.test.js`
Expected: FAIL, `describeChanges` is not a function.

- [ ] **Step 3: Implement `describeChanges`**

In `workspace.ts`, import the types with `import type { ChangeSummary, ChangeSummaryFile } from './ledger.js';`.

Add before the returned object:

```ts
const parseNumstat = (text: string): Map<string, { added: number | null; removed: number | null }> => {
  const counts = new Map<string, { added: number | null; removed: number | null }>();
  for (const line of text.split('\n')) {
    const [added, removed, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (!file) continue;
    counts.set(file, {
      added: added === '-' ? null : Number.parseInt(added ?? '', 10) || 0,
      removed: removed === '-' ? null : Number.parseInt(removed ?? '', 10) || 0,
    });
  }
  return counts;
};

const parseNameStatus = (text: string): ChangeSummaryFile[] => {
  const files: ChangeSummaryFile[] = [];
  for (const line of text.split('\n')) {
    const [code, first, second] = line.split('\t');
    if (!code || !first) continue;
    const status = code.startsWith('A') ? 'added'
      : code.startsWith('D') ? 'deleted'
        : code.startsWith('R') ? 'renamed' : 'modified';
    files.push({ path: (second ?? first).trim(), status, added: null, removed: null });
  }
  return files;
};

const describeChanges = async ({ cwd, baseRef }: { cwd: string; baseRef: string }): Promise<ChangeSummary | null> => {
  try {
    const [numstat, nameStatus, log] = await Promise.all([
      run(['diff', '--numstat', `${baseRef}...HEAD`], { cwd }),
      run(['diff', '--name-status', `${baseRef}...HEAD`], { cwd }),
      run(['log', '--format=%h%x09%s', `${baseRef}..HEAD`], { cwd }),
    ]);
    const counts = parseNumstat(numstat.stdout);
    const files = parseNameStatus(nameStatus.stdout).map((file) => ({ ...file, ...(counts.get(file.path) ?? {}) }));
    const commits = log.stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [sha, ...subject] = line.split('\t');
      return { sha: sha ?? '', subject: subject.join('\t') };
    });
    return { baseRef, files, commits, capturedAt: new Date().toISOString() };
  } catch {
    return null;
  }
};
```

Expose it in the returned object as `describeChanges`.

- [ ] **Step 4: Declare it in the dispatcher's workspace interface**

In `dispatcher.ts`, add to `CreateGitlabIssueWorkspaceLike`:

```ts
  describeChanges(input: { cwd: string; baseRef: string }): Promise<ChangeSummary | null>;
```

Import `ChangeSummary` as a type from `./ledger.js`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/web && bunx vitest run server/lib/gitlab-issues/workspace.test.js`
Expected: PASS.

---

### Task 3: Record renderer and writer

**Files:**
- Create: `packages/web/server/lib/gitlab-issues/record.ts`
- Test: `packages/web/server/lib/gitlab-issues/record.test.js`

**Interfaces:**
- Consumes: `RunEntry` and the Task 1 types from `ledger.ts`.
- Produces:
  - `recordLocationFor(input: { checkoutPath: string; projectPath: string; iid: number }): { primary: string; fallback: string }`
  - `recordExists(location: { primary: string; fallback: string }): Promise<string | null>`
  - `issueUrlOf(run: Pick<RunEntry, 'origin' | 'projectPath' | 'iid'>): string | null`
  - `mrUrlOf(run: Pick<RunEntry, 'origin' | 'projectPath' | 'mrIid'>): string | null`
  - `escapeMarkdownCell(text: string | null | undefined): string`
  - `escapeMarkdownText(text: string | null | undefined): string`
  - `fencedText(text: string | null | undefined): string`
  - `renderRunRecord(run: RunEntry): string`
  - `writeRunRecord(input: { run: RunEntry; checkoutPath: string; excludePath: string | null; fsImpl?: WriteFs }): Promise<{ path: string; written: boolean }>`

- [ ] **Step 1: Write the failing tests**

Create `record.test.js` with these cases. Use `fs.mkdtemp` under `os.tmpdir()` and clean up in `afterEach`, following `ledger.test.js`.

```js
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
    expect(text).toContain('Fix \\| login');
    expect(text).not.toContain('\n## 审核');
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/web && bunx vitest run server/lib/gitlab-issues/record.test.js`
Expected: FAIL, `Cannot find module './record.js'`.

- [ ] **Step 3: Implement `record.ts`**

Implement the exported functions with these rules:

- `recordLocationFor`: split `projectPath` on `/` and `\`, drop empty segments, replace any segment that is `.` or `..` with `__`, replace characters outside `[A-Za-z0-9._-]` with `_`, then join under `.openchamber/issue-records` and `.git/openchamber/issue-records`.
- `issueUrlOf` and `mrUrlOf`: return `${origin}/${projectPath}/issues/${iid}` and `${origin}/${projectPath}/merge_requests/${mrIid}` when the fields are strings and `iid`/`mrIid` are integers, else null. This mirrors the route's current helpers.
- `escapeMarkdownCell`: replace `\` with `\\`, `|` with `\|`, and every newline with a space.
- `escapeMarkdownText`: normalize CRLF, escape `\`, then `` ` ``, `*`, `_`, `[`, `]`, `(`, `)`, `!`, `<`, `>`, `|`, `&`; escape a leading `#`, `-`, `>`, or an ordered-list marker such as `1.`. Join lines with a hard break (two trailing spaces plus newline).
- `fencedText`: choose a backtick fence one longer than the longest backtick run in the text, minimum three, and wrap the text with a `text` language.
- `renderRunRecord`: build the document in the order in the spec. Omit every section whose data is empty. Use `escapeMarkdownCell` in tables, `escapeMarkdownText` for prose, and `fencedText` for finding notes and feedback items. Header shows `since` and the last event time, never `updatedAt`. Footer: `本文件由 GitLab issue 自动化生成，不随提交。`
- `writeRunRecord`: render once. Ensure the primary parent directory. If `excludePath` is set, read it and append `.openchamber/issue-records/` on its own line when missing; if that read or write throws, switch to the fallback path. Compare existing content and return `{ path, written: false }` when identical. Otherwise write a temporary file in the same directory and rename it over the target.
- `recordExists`: `fs.access` the primary path, then the fallback path, returning the first that exists or null.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/web && bunx vitest run server/lib/gitlab-issues/record.test.js`
Expected: PASS.

---

### Task 4: Machine reason and retry transition

**Files:**
- Modify: `packages/web/server/lib/gitlab-issues/machine.ts`
- Test: `packages/web/server/lib/gitlab-issues/machine.test.js`

**Interfaces:**
- Produces: `BLOCKED_REASONS.RECORD_WRITE_FAILED = 'record-write-failed'`; legal transition `blocked -> verifying`.

- [ ] **Step 1: Add the failing assertions**

In `machine.test.js`, add a test:

```js
it('allows a record-write failure to retry verifying in place', () => {
  expect(BLOCKED_REASONS.RECORD_WRITE_FAILED).toBe('record-write-failed');
  expect(canTransition(PHASES.BLOCKED, PHASES.VERIFYING)).toBe(true);
  expect(canTransition(PHASES.BLOCKED, PHASES.MR_OPEN)).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/web && bunx vitest run server/lib/gitlab-issues/machine.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `RECORD_WRITE_FAILED: 'record-write-failed'` to `BLOCKED_REASONS`, and change `[PHASES.BLOCKED]: [PHASES.CLAIMED]` to `[PHASES.BLOCKED]: [PHASES.CLAIMED, PHASES.VERIFYING]` with a comment explaining the retry.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/web && bunx vitest run server/lib/gitlab-issues/machine.test.js`
Expected: PASS.

---

### Task 5: Blocked comment for the failed record

**Files:**
- Modify: `packages/web/server/lib/gitlab-issues/prompts.ts`
- Test: `packages/web/server/lib/gitlab-issues/prompts.test.js`

**Interfaces:**
- Produces: `formatRecordWriteComment(path: string): string`.

- [ ] **Step 1: Add the failing test**

Add to `prompts.test.js`:

```js
it('names the record path and the automatic retry', () => {
  const text = formatRecordWriteComment('D:/repo/.openchamber/issue-records/group/repo/issue-17.md');
  expect(text).toContain('D:/repo/.openchamber/issue-records/group/repo/issue-17.md');
  expect(text).toContain('自动重试');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/web && bunx vitest run server/lib/gitlab-issues/prompts.test.js`
Expected: FAIL, no such export.

- [ ] **Step 3: Implement**

```ts
export const formatRecordWriteComment = (recordPath: string) => [
  `交付说明写入失败：\`${recordPath}\``,
  '',
  '修复该路径的权限或所在磁盘后，自动化会在下一轮自动重试，不需要人工重置。',
].join('\n');
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/web && bunx vitest run server/lib/gitlab-issues/prompts.test.js`
Expected: PASS.

---

### Task 6: Dispatcher integration

**Files:**
- Modify: `packages/web/server/lib/gitlab-issues/dispatcher.ts`
- Test: `packages/web/server/lib/gitlab-issues/dispatcher.test.js`

**Interfaces:**
- Consumes: `recordLocationFor`, `writeRunRecord` from `record.ts`; `formatRecordWriteComment` from `prompts.ts`; `workspace.describeChanges`; the ledger fields from Task 1; the machine reason from Task 4.
- Produces: `DispatcherDependencies.writeRecord?: (input: { run: RunEntry; checkoutPath: string; excludePath: string | null }) => Promise<{ path: string; written: boolean }>`; run entries carrying `changeSummary`, `verifyResult`, `approvedBy`, `reviewHistory`, `feedbackHistory`.

- [ ] **Step 1: Add the failing tests**

Add to `dispatcher.test.js`, using the existing ledger, API, and session stubs:

1. `captures the change summary when implementation produces evidence` — after the implementing handler runs with a fake workspace returning a summary, the ledger entry has `changeSummary`.
2. `appends a review history entry for each review answer` — drive approve and request-changes answers; expect two entries with `seq` 1 and 2, and `kind: 'review'`.
3. `appends a recheck entry and keeps the first review entry` — after recheck, expect a third entry with `kind: 'recheck'` and the first entry unchanged.
4. `keeps review history monotonic across a feedback round` — after `reviewRounds` resets to 0, the next history entry still gets the next `seq`.
5. `records the approver on plan approval` — expect `approvedBy.login`, `userId`, `accountId`.
6. `blocks before pushing when the record cannot be written` — inject `writeRecord` that throws; expect `phase: 'blocked'`, `blockedReason: 'record-write-failed'`, `worktreePath` retained, no push call.
7. `returns a record-write failure to verifying when the retry succeeds` — start from a blocked entry with that reason, inject a writer that resolves; call `tick`; expect `phase: 'verifying'` and `ai-blocked` removed.
8. `writes a record for a run whose checkout resolves` — tick with a temp checkout and a ledger run; expect `issue-17.md` under `.openchamber/issue-records/group/repo/`.
9. `stores the verify command result on success and failure` — expect `verifyResult.code` 0 and non-zero respectively.
10. `keeps history bounded and truncates long feedback` — append 12 review entries and 6 feedback batches with 2001-character item text; expect 10 review entries, 5 feedback entries, and each stored text at most 2000 characters.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/web && bunx vitest run server/lib/gitlab-issues/dispatcher.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement the dispatcher pieces**

Add to the file:

- `const REVIEW_HISTORY_MAX = 10;`, `FEEDBACK_HISTORY_MAX = 5;`, `VERIFY_OUTPUT_TAIL = 4000;`, `FEEDBACK_ITEM_MAX = 2000;`.
- `appendReviewHistory(run, entry)` returning the bounded array with `seq = (run.reviewHistory?.length ?? 0) + 1`.
- `appendFeedbackHistory(run, entry)` returning the bounded array, truncating each item's text.
- `captureChanges(run, context)` returning `{ changeSummary }` or `{}` when there is no worktree or `describeChanges` returns null.
- `excludePathFor(checkoutPath)` running `workspace.run(['rev-parse', '--git-path', 'info/exclude'], { cwd: checkoutPath })`, resolving a relative answer against the checkout, and returning null on failure.
- `writeRecordFor(run, checkoutPath)` calling the injected `writeRecord` (default `writeRunRecord`) with the computed exclude path.
- `writeRecordBestEffort(run, checkoutPath)` wrapping the above in `try/catch` and logging a warn on failure.

Wire the call sites:

- `handleImplementing`: after parsing evidence, capture changes and include `changeSummary` in the transition to `reviewing`.
- `handleAddressing`: same at its evidence transition.
- `blockWithComment`: capture changes before `cleanupWorktree` and merge them into the patch passed to `block`.
- `handleVerifying`: after the verify command, include `verifyResult` in the ledger patch. Capture changes before push. Call `writeRecordFor` strictly and, on failure, post `formatRecordWriteComment(recordPath)` and block with `record-write-failed` using `block` directly (no cleanup), `ai-blocked` added, working labels removed. Extend `failRun(run, context, reason, detail, patch = {})` so a failed verify command can carry `verifyResult` into the same blocked write.
- Update every fake workspace in `dispatcher.test.js` to implement `describeChanges`, defaulting to `null` unless the test supplies a summary.
- `handleReviewing`: append a `reviewHistory` entry on approve, request-changes, and the round-cap block, carrying `review.summary`.
- `handleRechecking`: append an entry with `kind: 'recheck'`.
- `scanFeedback`: append a `feedbackHistory` entry when entering `addressing`.
- `handleWaitingApproval`: record `approvedBy` at the transition to `implementing`.
- `handleBlocked`: when `blockedReason === 'record-write-failed'`, try `writeRecordFor`; on success remove `ai-blocked`, add `ai-working`, post a short note, and `transition(run, PHASES.VERIFYING)`; on failure return without another comment.
- `tick`: after the run loop and after the claim scan, re-list the ledger and call `writeRecordBestEffort` for each run whose `projectEntryId` maps to a `SettingsProject` path.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/web && bunx vitest run server/lib/gitlab-issues/dispatcher.test.js`
Expected: PASS.

---

### Task 7: Runs route exposes the note

**Files:**
- Modify: `packages/web/server/lib/gitlab-issues/routes.ts`
- Test: `packages/web/server/lib/gitlab-issues/routes.test.js`

**Interfaces:**
- Consumes: `recordLocationFor`, `recordExists`, `issueUrlOf`, `mrUrlOf` from `record.ts`.
- Produces: runs answer fields `recordPath: string | null` and `projectDirectory: string | null`.

- [ ] **Step 1: Add the failing tests**

In `routes.test.js`, add a test that registers the routes with a temp checkout:

```js
it('reports the record path only when the file exists', async () => {
  // create checkout/issue file, register routes with a ledger run and a matching project
  // expect run.recordPath === file path and run.projectDirectory === checkout
});

it('reports null for a run whose record was never written', async () => {
  // same setup without the file; expect both fields null
});
```

Follow the existing route test setup for `readProjects`, `dispatcher.ledger.list`, and the response capture.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/web && bunx vitest run server/lib/gitlab-issues/routes.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Replace the local `issueUrlOf` and `mrUrlOf` with imports from `record.ts`.
- Build a `Map<string, SettingsProject>` from `readProjects()` once per request, keyed by `String(project.id)`.
- Change `toRunView(run, issueState, projectDirectory)` to accept the checkout path, compute the location with `run.projectPath ?? ''`, call `recordExists`, and return `recordPath` and `projectDirectory`.
- In the directory-scoped branch pass the known project path; in the global branch pass the map lookup or null.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/web && bunx vitest run server/lib/gitlab-issues/routes.test.js`
Expected: PASS.

---

### Task 8: Runs panel action and strings

**Files:**
- Modify: `packages/ui/src/components/gitlab-runs/runModel.ts`
- Modify: `packages/ui/src/components/gitlab-runs/RunDetail.tsx`
- Modify: `packages/ui/src/lib/i18n/messages/gitlab-runs.i18n.ts`
- Test: `packages/ui/src/components/gitlab-runs/RunDetail.record.test.tsx`

**Interfaces:**
- Consumes: the route fields from Task 7.
- Produces: `Run.recordPath: string | null`, `Run.projectDirectory: string | null`; the delivery note action.

- [ ] **Step 1: Add the failing test**

Create `RunDetail.record.test.tsx` modelled on `RunDetail.layout.test.tsx`. Render `RunDetail` with a complete `Run` fixture, once with `recordPath` and `projectDirectory` set and once without. Expect the delivery note label in the first markup and its absence in the second. Use the `en` dictionary through `I18nProvider`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/ui && bun test --conditions=openchamber-source src/components/gitlab-runs/RunDetail.record.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `runModel.ts`: add `recordPath` and `projectDirectory` as optional strings that transform to null. Add `'record-write-failed': true` to `GUIDE_KEYS`.
- `RunDetail.tsx`: when `run.recordPath` and `run.projectDirectory` are set, render a button beside the issue and merge request links labelled `t('gitlabRuns.detail.deliveryRecord')`. It calls `useUIStore.getState().openContextFile(run.projectDirectory, run.recordPath)`.
- `gitlab-runs.i18n.ts`: add both keys to all 15 locales with the translations below.

| Locale | `gitlabRuns.detail.deliveryRecord` | `gitlabRuns.guide.record-write-failed` |
|---|---|---|
| en | Delivery note | The delivery note could not be written. Fix the folder permission or the path shown in the run; the automation retries on its own. To start over, remove `ai-blocked` and keep `ai-ready`. |
| de | Übergabenotiz | Die Übergabenotiz konnte nicht geschrieben werden. Beheben Sie die Ordnerberechtigung oder den im Lauf angezeigten Pfad; die Automatisierung versucht es selbst erneut. Zum Neustart `ai-blocked` entfernen und `ai-ready` behalten. |
| fr | Note de passation | La note de passation n'a pas pu être écrite. Corrigez les droits du dossier ou le chemin affiché dans l'exécution ; l'automatisation réessaie d'elle-même. Pour recommencer, retirez `ai-blocked` et gardez `ai-ready`. |
| nl | Oplevernota | De oplevernota kon niet worden geschreven. Herstel de maprechten of het pad dat bij de run staat; de automatisering probeert het zelf opnieuw. Om opnieuw te beginnen `ai-blocked` verwijderen en `ai-ready` laten staan. |
| es | Nota de entrega | No se pudo escribir la nota de entrega. Corrige los permisos de la carpeta o la ruta que muestra la ejecución; la automatización lo reintenta sola. Para empezar de nuevo, quita `ai-blocked` y conserva `ai-ready`. |
| ja | 引き継ぎ資料 | 引き継ぎ資料を書き込めませんでした。実行に表示されたフォルダーの権限またはパスを修正してください。自動化が自動で再試行します。最初からやり直すには `ai-blocked` を外し、`ai-ready` を残します。 |
| pt-BR | Nota de entrega | Não foi possível gravar a nota de entrega. Corrija as permissões da pasta ou o caminho mostrado na execução; a automação tenta novamente sozinha. Para recomeçar, remova `ai-blocked` e mantenha `ai-ready`. |
| uk | Нотатка передачі | Нотатку передачі не вдалося записати. Виправте дозволи теки або шлях, показаний у запуску; автоматизація повторить спробу сама. Щоб почати заново, приберіть `ai-blocked` і залиште `ai-ready`. |
| ko | 인계 문서 | 인계 문서를 작성하지 못했습니다. 실행에 표시된 폴더 권한이나 경로를 고치면 자동화가 스스로 다시 시도합니다. 처음부터 다시 하려면 `ai-blocked`를 제거하고 `ai-ready`를 유지하세요. |
| pl | Notatka przekazania | Nie udało się zapisać notatki przekazania. Napraw uprawnienia folderu lub ścieżkę pokazaną w uruchomieniu; automatyzacja ponowi próbę sama. Aby zacząć od nowa, usuń `ai-blocked` i pozostaw `ai-ready`. |
| zh-CN | 交付说明 | 交付说明写入失败。修复运行中显示的目录权限或路径后，自动化会自动重试。若要重新开始，移除 `ai-blocked` 并保留 `ai-ready`。 |
| zh-TW | 交付說明 | 交付說明寫入失敗。修正執行中顯示的目錄權限或路徑後，自動化會自行重試。若要重新開始，移除 `ai-blocked` 並保留 `ai-ready`。 |
| tr | Teslim notu | Teslim notu yazılamadı. Çalıştırmada gösterilen klasör iznini veya yolu düzeltin; otomasyon kendisi yeniden dener. Baştan başlamak için `ai-blocked` etiketini kaldırın ve `ai-ready` etiketini koruyun. |
| ar | مذكرة التسليم | تعذّر كتابة مذكرة التسليم. أصلح أذونات المجلد أو المسار المعروض في التشغيل؛ ستُعيد الأتمتة المحاولة تلقائيًا. للبدء من جديد، أزل `ai-blocked` وأبقِ `ai-ready`. |
| he | פתק מסירה | לא ניתן היה לכתוב את פתק המסירה. תקן את הרשאות התיקייה או את הנתיב המוצג בהרצה; האוטומציה תנסה שוב מעצמה. כדי להתחיל מחדש, הסר `ai-blocked` והשאר `ai-ready`. |

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/ui && bun test --conditions=openchamber-source src/components/gitlab-runs/RunDetail.record.test.tsx`
Expected: PASS.

---

### Task 9: Documentation

**Files:**
- Modify: `packages/web/server/lib/gitlab-issues/DOCUMENTATION.md`
- Modify: `packages/ui/src/components/gitlab-runs/DOCUMENTATION.md`
- Modify: `docs/gitlab-issue-spec/gitlab-issue-automation-spec.md`

- [ ] **Step 1: Server module document**

Add an ownership line for `record.ts`, an invariant for the record path and the no-commit rule, and decision entries:

- Why the server writes the note and not the agent.
- Why only `issue-records/` is excluded.
- Why the note path is derived instead of stored.
- Why `record-write-failed` retries in place.

- [ ] **Step 2: Runs panel document**

Add the delivery note action, the `recordPath` and `projectDirectory` optional fields, and the `record-write-failed` guide key.

- [ ] **Step 3: Base spec**

Add a section after the merge-and-finish section describing the note, its location, the capture points, and the gate. State that it is not committed.

- [ ] **Step 4: Check the docs**

Run: `bun run docs:validate`
Expected: PASS. If the script does not exist at the moment of the run, report it and skip.

---

## Coordinator finish

After every task, the coordinator:

1. Reads the combined diff for interface drift, stale names, and unrelated edits.
2. Runs `cd packages/web && bunx vitest run server/lib/gitlab-issues/` and `cd packages/ui && bun test --conditions=openchamber-source src/components/gitlab-runs/`.
3. Runs `bun run check:changed` once on the finished diff.
4. Reports the test output and any check that could not run.
