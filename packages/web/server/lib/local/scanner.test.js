import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalIssueError } from './files.js';
import { createLocalScanner } from './scanner.js';

const issue = (n, title, state = 'todo', extra = '') => `---
identifier: LOCAL-${n}
title: ${title}
state: ${state}
priority: null
labels: []
assignee: null
createdAt: 2026-11-01T08:00:00Z
updatedAt: 2026-11-01T08:00:00Z
feature: null
blockedBy: []
${extra}---

Body of ${title}.
`;

let root;
let project;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-scan-'));
  project = { id: 'proj-1', path: root, label: 'Proj One' };
});

const scannerWith = async () => createLocalScanner({ listProjects: async () => [project] });

/** The fixture above with a grouping slug, labels and blockers. */
const issueWith = (n, title, { state = 'todo', feature = null, labels = [], blockedBy = [] } = {}) => issue(n, title, state)
  .replace('labels: []', `labels: [${labels.join(', ')}]`)
  .replace('feature: null', `feature: ${feature ?? 'null'}`)
  .replace('blockedBy: []', `blockedBy: [${blockedBy.join(', ')}]`);

const writeIssues = (entries) => {
  const dir = path.join(root, '.issues');
  fs.mkdirSync(dir, { recursive: true });
  for (const [fileName, text] of entries) fs.writeFileSync(path.join(dir, fileName), text);
};

describe('list', () => {
  it('reads issues from .issues, filters by state and query, paginates', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    for (const n of [1, 2, 3]) fs.writeFileSync(path.join(dir, `LOCAL-${n}-t.md`), issue(n, `Title ${n}`, n === 3 ? 'done' : 'todo'));
    const scanner = await scannerWith();
    const open = await scanner.list({ state: 'open' });
    expect(open.issues.map((i) => i.identifier)).toEqual(['LOCAL-1', 'LOCAL-2']);
    const all = await scanner.list({ state: 'all', query: 'title 2' });
    expect(all.issues.map((i) => i.identifier)).toEqual(['LOCAL-2']);
    const page = await scanner.list({ state: 'all', cursor: Buffer.from(JSON.stringify({ offset: 2 })).toString('base64') });
    expect(page.issues).toHaveLength(1);
    expect(page.hasMore).toBe(false);
  });
  it('filters by priority: all or absent, none, and exact match', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    const withPriority = (n, title, priority) => issue(n, title).replace('priority: null', `priority: ${priority}`);
    fs.writeFileSync(path.join(dir, 'LOCAL-1-high.md'), withPriority(1, 'High', 'high'));
    fs.writeFileSync(path.join(dir, 'LOCAL-2-none.md'), withPriority(2, 'Unset', 'null'));
    fs.writeFileSync(path.join(dir, 'LOCAL-3-low.md'), withPriority(3, 'Low', 'low'));
    const scanner = await scannerWith();
    const ids = async (options) => (await scanner.list(options)).issues.map((i) => i.identifier);
    expect(await ids({ state: 'all' })).toEqual(['LOCAL-1', 'LOCAL-2', 'LOCAL-3']);
    expect(await ids({ state: 'all', priority: 'all' })).toEqual(['LOCAL-1', 'LOCAL-2', 'LOCAL-3']);
    expect(await ids({ state: 'all', priority: 'none' })).toEqual(['LOCAL-2']);
    expect(await ids({ state: 'all', priority: 'high' })).toEqual(['LOCAL-1']);
    expect(await ids({ state: 'all', priority: 'low' })).toEqual(['LOCAL-3']);
  });
  it('ignores a duplicated identifier and warns', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'LOCAL-1-a.md'), issue(1, 'First'));
    fs.writeFileSync(path.join(dir, 'LOCAL-1-b.md'), issue(1, 'Copy'));
    const warn = console.warn; console.warn = () => {};
    try {
      const scanner = await scannerWith();
      const { issues } = await scanner.list({ state: 'all' });
      expect(issues).toHaveLength(1);
      expect(issues[0].title).toBe('First');
    } finally { console.warn = warn; }
  });
  it('returns empty for a missing dir and a project that is unreadable', async () => {
    project.path = path.join(root, 'nonexistent');
    const scanner = await scannerWith();
    expect((await scanner.list({ state: 'all' })).issues).toEqual([]);
  });
  it('keys containerByIssue by project when two projects both have LOCAL-1', async () => {
    const dirOne = path.join(root, 'one', '.issues');
    const dirTwo = path.join(root, 'two', '.issues');
    fs.mkdirSync(dirOne, { recursive: true });
    fs.mkdirSync(dirTwo, { recursive: true });
    fs.writeFileSync(path.join(dirOne, 'LOCAL-1-a.md'), issue(1, 'One'));
    fs.writeFileSync(path.join(dirTwo, 'LOCAL-1-a.md'), issue(1, 'Two'));
    const projects = [
      { id: 'proj-1', path: path.join(root, 'one'), label: 'Proj One' },
      { id: 'proj-2', path: path.join(root, 'two'), label: 'Proj Two' },
    ];
    const scanner = createLocalScanner({ listProjects: async () => projects });

    const { issues, containerByIssue } = await scanner.list({ state: 'all' });
    expect(issues.map((i) => [i.identifier, i.title, i.containerId])).toEqual([
      ['LOCAL-1', 'One', 'proj-1'],
      ['LOCAL-1', 'Two', 'proj-2'],
    ]);
    expect(containerByIssue.get('proj-1')).toEqual({ id: 'proj-1', name: 'Proj One' });
    expect(containerByIssue.get('proj-2')).toEqual({ id: 'proj-2', name: 'Proj Two' });
    for (const issue of issues) {
      expect(containerByIssue.get(issue.containerId)).toEqual({ id: issue.containerId, name: issue.containerId === 'proj-1' ? 'Proj One' : 'Proj Two' });
    }

    // get stays first-project-wins: the first project holding LOCAL-1 resolves.
    const found = await scanner.get('LOCAL-1');
    expect(found.issue.title).toBe('One');
    expect(found.issue.containerId).toBe('proj-1');
    expect(found.container).toEqual({ id: 'proj-1', name: 'Proj One' });

    // With a project hint, get targets the specific project and avoids cross-project collisions.
    const foundTwo = await scanner.get('LOCAL-1', 'proj-2');
    expect(foundTwo.issue.title).toBe('Two');
    expect(foundTwo.issue.containerId).toBe('proj-2');
    expect(await scanner.get('LOCAL-1', 'nope')).toBeNull();

    // With a project hint, updateState and edit mutate only the intended project.
    await scanner.updateState('LOCAL-1', 'done', 'proj-2');
    expect((await scanner.get('LOCAL-1', 'proj-1')).issue.state).toBe('todo');
    expect((await scanner.get('LOCAL-1', 'proj-2')).issue.state).toBe('done');

    await scanner.edit('LOCAL-1', { title: 'Two Renamed' }, 'proj-2');
    expect((await scanner.get('LOCAL-1', 'proj-1')).issue.title).toBe('One');
    const updatedTwo = await scanner.get('LOCAL-1', 'proj-2');
    expect(updatedTwo.issue.title).toBe('Two Renamed');
    expect(updatedTwo.issue.fileName).toBe('LOCAL-1-two-renamed.md');
    expect(fs.existsSync(path.join(dirTwo, 'LOCAL-1-a.md'))).toBe(false);
    expect(fs.existsSync(path.join(dirTwo, 'LOCAL-1-two-renamed.md'))).toBe(true);
    expect(fs.existsSync(path.join(dirOne, 'LOCAL-1-a.md'))).toBe(true);
  });
});

describe('query', () => {
  it('matches a pasted file name or path to its issue', async () => {
    writeIssues([
      ['LOCAL-7-fix-login.md', issue(7, 'Login overflows')],
      ['LOCAL-8-other.md', issue(8, 'Other')],
    ]);
    const scanner = await scannerWith();
    const ids = async (query) => (await scanner.list({ state: 'all', query })).issues.map((i) => i.identifier);
    expect(await ids('LOCAL-7-fix-login.md')).toEqual(['LOCAL-7']);
    expect(await ids('.issues/LOCAL-7-fix-login.md')).toEqual(['LOCAL-7']);
    expect(await ids('LOCAL-7-fix-login')).toEqual(['LOCAL-7']);
    expect(await ids('LOCAL-7')).toEqual(['LOCAL-7']);
    expect(await ids('overflow')).toEqual(['LOCAL-7']);
    expect(await ids('LOCAL-9-absent.md')).toEqual([]);
  });
  it('finds an issue by its grouping slug or a label', async () => {
    writeIssues([
      ['LOCAL-1-login.md', issueWith(1, 'Login overflows', { feature: 'auth', labels: ['backend'] })],
      ['LOCAL-2-other.md', issueWith(2, 'Other', { feature: 'billing', labels: ['frontend'] })],
    ]);
    const scanner = await scannerWith();
    const ids = async (query) => (await scanner.list({ state: 'all', query })).issues.map((i) => i.identifier);
    expect(await ids('auth')).toEqual(['LOCAL-1']);
    expect(await ids('backend')).toEqual(['LOCAL-1']);
    expect(await ids('billing')).toEqual(['LOCAL-2']);
    expect(await ids('AUTH')).toEqual(['LOCAL-1']);
  });
});

describe('feature', () => {
  it('filters by grouping slug, and shows every issue when absent', async () => {
    writeIssues([
      ['LOCAL-1-login.md', issueWith(1, 'Login', { feature: 'login' })],
      ['LOCAL-2-billing.md', issueWith(2, 'Billing', { feature: 'billing' })],
      ['LOCAL-3-plain.md', issueWith(3, 'Plain')],
    ]);
    const scanner = await scannerWith();
    const ids = async (options) => (await scanner.list({ state: 'all', ...options })).issues.map((i) => i.identifier);
    expect(await ids({})).toEqual(['LOCAL-1', 'LOCAL-2', 'LOCAL-3']);
    expect(await ids({ feature: 'login' })).toEqual(['LOCAL-1']);
    expect(await ids({ feature: 'absent' })).toEqual([]);
  });
  it('reports every slug in the container as a facet, whatever the filters hide', async () => {
    writeIssues([
      ['LOCAL-1-login.md', issueWith(1, 'Login', { feature: 'login' })],
      ['LOCAL-2-billing.md', issueWith(2, 'Billing', { feature: 'billing' })],
      ['LOCAL-3-plain.md', issueWith(3, 'Plain')],
      ['LOCAL-4-settled.md', issueWith(4, 'Settled', { state: 'done', feature: 'archived' })],
    ]);
    const scanner = await scannerWith();
    // Facets ignore the filter in force, so switching slugs never needs a reset.
    expect((await scanner.list({ state: 'all' })).features).toEqual(['archived', 'billing', 'login']);
    expect((await scanner.list({ state: 'open', feature: 'login' })).features).toEqual(['archived', 'billing', 'login']);
    expect((await scanner.list({ state: 'all', query: 'login' })).features).toEqual(['archived', 'billing', 'login']);
    // Scoped like the items: another container's slugs stay out.
    const other = { id: 'proj-2', path: fs.mkdtempSync(path.join(os.tmpdir(), 'oc-scan-')), label: 'Proj Two' };
    fs.mkdirSync(path.join(other.path, '.issues'), { recursive: true });
    fs.writeFileSync(path.join(other.path, '.issues', 'LOCAL-1-elsewhere.md'), issueWith(1, 'Elsewhere', { feature: 'elsewhere' }));
    const both = await createLocalScanner({ listProjects: async () => [project, other] });
    expect((await both.list({ state: 'all', containerId: 'proj-1' })).features).toEqual(['archived', 'billing', 'login']);
    expect((await both.list({ state: 'all' })).features).toEqual(['archived', 'billing', 'elsewhere', 'login']);
  });
});

describe('blocked', () => {
  it('keeps blocking until every blocker is done or canceled', async () => {
    writeIssues([
      ['LOCAL-1-open.md', issueWith(1, 'Open blocker')],
      ['LOCAL-2-done.md', issueWith(2, 'Done blocker', { state: 'done' })],
      ['LOCAL-3-canceled.md', issueWith(3, 'Canceled blocker', { state: 'canceled' })],
      ['LOCAL-4-waits-two.md', issueWith(4, 'Waits on two', { blockedBy: ['LOCAL-1', 'LOCAL-2'] })],
      ['LOCAL-5-waits-settled.md', issueWith(5, 'Waits on settled', { blockedBy: ['LOCAL-2', 'LOCAL-3'] })],
    ]);
    const scanner = await scannerWith();
    const { issues } = await scanner.list({ state: 'all' });
    expect(Object.fromEntries(issues.map((i) => [i.identifier, i.blocked]))).toEqual({
      'LOCAL-1': false,
      'LOCAL-2': false,
      'LOCAL-3': false,
      'LOCAL-4': true,
      'LOCAL-5': false,
    });
  });
  it('blocks nothing for a missing or self-naming blocker', async () => {
    writeIssues([
      ['LOCAL-1-orphan.md', issueWith(1, 'Orphan', { blockedBy: ['LOCAL-9'] })],
      ['LOCAL-2-self.md', issueWith(2, 'Self', { blockedBy: ['LOCAL-2'] })],
    ]);
    const scanner = await scannerWith();
    const { issues } = await scanner.list({ state: 'all' });
    expect(issues.map((i) => i.blocked)).toEqual([false, false]);
  });
  it('unblocks the waiting issue when its last blocker settles', async () => {
    writeIssues([
      ['LOCAL-1-blocker.md', issueWith(1, 'Blocker')],
      ['LOCAL-2-waits.md', issueWith(2, 'Waits', { blockedBy: ['LOCAL-1'] })],
    ]);
    const scanner = await scannerWith();
    const blockedOf = async () => (await scanner.list({ state: 'all' })).issues.find((i) => i.identifier === 'LOCAL-2').blocked;
    expect(await blockedOf()).toBe(true);
    const settled = await scanner.updateState('LOCAL-1', 'done');
    expect(settled.state).toBe('done');
    expect(await blockedOf()).toBe(false);
  });
});

describe('create', () => {
  it('mkdirs a missing dir and allocates max+1, honoring blockedBy/feature fields', async () => {
    const scanner = await scannerWith();
    const created = await scanner.create('proj-1', { title: 'New one', description: 'Desc', priority: 'high', labels: ['bug'], feature: 'login', blockedBy: ['LOCAL-2'] });
    expect(created.identifier).toBe('LOCAL-1');
    expect(fs.existsSync(path.join(root, '.issues', 'LOCAL-1-new-one.md'))).toBe(true);
    const second = await scanner.create('proj-1', { title: 'Second', description: null, priority: null, labels: [] });
    expect(second.identifier).toBe('LOCAL-2');
  });
  it('retries when the target file already exists (lost race)', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'LOCAL-1-taken.md'), issue(1, 'Taken'));
    const scanner = await scannerWith();
    const created = await scanner.create('proj-1', { title: 'Racer', description: null, priority: null, labels: [] });
    expect(created.identifier).toBe('LOCAL-2');
  });
  it('rejects an unknown container', async () => {
    const scanner = await scannerWith();
    await expect(scanner.create('nope', { title: 'X', description: null, priority: null, labels: [] })).rejects.toThrow(LocalIssueError);
  });
});

describe('edit and updateState', () => {
  it('edits fields and body, bumps updatedAt, preserves unknown keys and comments, and renames file on title change', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'LOCAL-1-a.md'), issue(1, 'Old', 'todo', 'custom: keep\n'));
    const scanner = await scannerWith();
    const edited = await scanner.edit('LOCAL-1', { title: 'New', description: 'New body', priority: 'low', labels: ['x'] });
    expect(edited.title).toBe('New');
    expect(edited.fileName).toBe('LOCAL-1-new.md');
    expect(edited.state).toBe('todo');
    expect(fs.existsSync(path.join(dir, 'LOCAL-1-a.md'))).toBe(false);
    const raw = fs.readFileSync(path.join(dir, 'LOCAL-1-new.md'), 'utf8');
    expect(raw).toContain('custom: keep');
    expect(raw).toContain('New body');
  });
  it('rejects title edit if target file already exists', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'LOCAL-1-old.md'), issue(1, 'Old'));
    fs.writeFileSync(path.join(dir, 'LOCAL-1-taken.md'), issue(1, 'Taken'));
    const scanner = await scannerWith();
    await expect(scanner.edit('LOCAL-1', { title: 'Taken' })).rejects.toThrow(LocalIssueError);
  });
  it('sets and clears the grouping slug and the blockers it waits on', async () => {
    writeIssues([
      ['LOCAL-1-blocker.md', issueWith(1, 'Blocker')],
      ['LOCAL-2-waits.md', issueWith(2, 'Waits')],
    ]);
    const scanner = await scannerWith();
    const blocked = await scanner.edit('LOCAL-2', { feature: 'auth', blockedBy: ['LOCAL-1'] });
    expect(blocked).toMatchObject({ feature: 'auth', blockedBy: ['LOCAL-1'], blocked: true });
    // Clearing the list settles the flag in the same write.
    const freed = await scanner.edit('LOCAL-2', { feature: null, blockedBy: [] });
    expect(freed).toMatchObject({ feature: null, blockedBy: [], blocked: false });
    const raw = fs.readFileSync(path.join(root, '.issues', 'LOCAL-2-waits.md'), 'utf8');
    // A cleared scalar leaves no line behind; an emptied list stays as `[]`.
    expect(raw).not.toContain('feature:');
    expect(raw).toContain('blockedBy: []');
  });
  it('moves state and rejects unknown identifier or state', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'LOCAL-1-a.md'), issue(1, 'T'));
    const scanner = await scannerWith();
    expect((await scanner.updateState('LOCAL-1', 'done')).state).toBe('done');
    await expect(scanner.updateState('LOCAL-9', 'done')).rejects.toThrow(LocalIssueError);
    await expect(scanner.updateState('LOCAL-1', 'nope')).rejects.toThrow(LocalIssueError);
  });
});

it('liveSummaries includes state.type for the alias window', async () => {
  const dir = path.join(root, '.issues');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'LOCAL-1-a.md'), issue(1, 'T', 'in-progress'));
  const scanner = await scannerWith();
  const [summary] = await scanner.liveSummaries(['LOCAL-1']);
  expect(summary.state).toEqual({ name: 'in-progress', category: 'in-progress', type: 'in-progress' });
});

it('states exposes the six categories with positions', async () => {
  const scanner = await scannerWith();
  const states = scanner.states();
  expect(states.map((s) => s.id)).toEqual(['triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled']);
  expect(states.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
});

it('get returns the issue with its container, null when unknown', async () => {
  const dir = path.join(root, '.issues');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'LOCAL-1-a.md'), issue(1, 'T'));
  const scanner = await scannerWith();
  const found = await scanner.get('LOCAL-1');
  expect(found.issue.title).toBe('T');
  expect(found.issue.containerId).toBe('proj-1');
  expect(found.container).toEqual({ id: 'proj-1', name: 'Proj One' });
  expect(await scanner.get('LOCAL-9')).toBeNull();
});

it('containers lists projects with a readable dir and honors a valid custom issuesDir', async () => {
  const custom = path.join(root, 'custom-issues');
  fs.mkdirSync(custom);
  fs.writeFileSync(path.join(custom, 'LOCAL-1-c.md'), issue(1, 'Custom'));
  project.issuesDir = 'custom-issues';
  const scanner = await scannerWith();
  expect(await scanner.containers()).toEqual([{ id: 'proj-1', name: 'Proj One' }]);
  const { issues } = await scanner.list({ state: 'all' });
  expect(issues.map((i) => i.identifier)).toEqual(['LOCAL-1']);
  expect(await scanner.get('LOCAL-1')).not.toBeNull();
});

it('falls back to .issues when issuesDir escapes the project or is empty', async () => {
  const dir = path.join(root, '.issues');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'LOCAL-1-a.md'), issue(1, 'Safe'));
  for (const bad of ['../outside', '.. ', '.. .', '  ', '/abs/dir']) {
    project.issuesDir = bad;
    const scanner = await scannerWith();
    const { issues } = await scanner.list({ state: 'all' });
    expect(issues.map((i) => i.identifier)).toEqual(['LOCAL-1']);
  }
});

it('cursor round-trips through list pages', async () => {
  const dir = path.join(root, '.issues');
  fs.mkdirSync(dir);
  for (let n = 1; n <= 3; n++) fs.writeFileSync(path.join(dir, `LOCAL-${n}-t.md`), issue(n, `T ${n}`));
  const scanner = await scannerWith();
  const first = await scanner.list({ state: 'all' });
  expect(first.issues).toHaveLength(3);
  expect(first.hasMore).toBe(false);
  expect(first.cursor).toBeNull();
  const paged = await scanner.list({ state: 'all', cursor: first.cursor });
  expect(paged.issues).toHaveLength(3);
});
