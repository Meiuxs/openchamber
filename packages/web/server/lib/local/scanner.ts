import fs from 'fs';
import path from 'path';
import { isPlainObject, isString } from '../shared/guards.js';
import {
  ISSUE_FILE_PATTERN,
  LocalIssueError,
  STATES,
  appendComment,
  issueFileName,
  readIssue,
  sanitizeSlug,
  setFields,
  splitComments,
  writeIssue,
} from './files.js';

import type { IssueFieldValue, ParsedIssue } from './files.js';
import type { TrackerListOptions, TrackerLiveSummaryWire, TrackerPriority, TrackerStateCategory, TrackerWorkflowState } from '../trackers/tracker-contract.js';

export type Project = {
  id: string;
  path: string;
  label?: string | null;
  issuesDir?: string | null;
};

export type IssueView = {
  projectId: string;
  containerId: string;
  number: number;
  fileName: string;
  identifier: string;
  title: string;
  state: TrackerStateCategory;
  priority: TrackerPriority | null;
  labels: string[];
  assignee: string | null;
  feature: string | null;
  blockedBy: string[];
  createdAt: string | null;
  updatedAt: string | null;
  blocked: boolean;
  body: string;
};

type IssueRecord = { issue: IssueView; fileName: string };
type CacheFile = { mtimeMs: number; size: number; parsed: ParsedIssue | null };
type ScanCache = {
  issuesDir: string;
  readable: boolean;
  files: Map<string, CacheFile>;
  issues: Map<string, IssueRecord>;
  ignored: string[];
};
type Container = { id: string; name: string };
type Located = { project: Project; cache: ScanCache; entry: IssueRecord };
type NormalizedIdentifier = { identifier: string | null; projectHint: string | null };
type ListResult = {
  issues: IssueView[];
  containerByIssue: Map<string, Container>;
  features: string[];
  assignees: string[];
  cursor: string | null;
  hasMore: boolean;
};

const PAGE_SIZE = 100;
const CREATE_MAX_RETRIES = 3;
const DEFAULT_ISSUES_DIR = '.issues';
const OPEN_EXCLUDED = new Set<string>(['done', 'canceled']);
const SETTLED_STATES = new Set<string>(['done', 'canceled']);
const DEFAULT_STATE: TrackerStateCategory = 'triage';
const ISSUE_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

const normalizeIdentifierAndHint = (first: string | null | undefined, second?: string | null): NormalizedIdentifier => {
  if (isString(first) && isString(second)) {
    if (!ISSUE_IDENTIFIER_PATTERN.test(first) && ISSUE_IDENTIFIER_PATTERN.test(second)) {
      return { identifier: second, projectHint: first };
    }
    return { identifier: first, projectHint: second };
  }
  return { identifier: isString(first) ? first : null, projectHint: second || null };
};

const matchesProject = (project: Project, hint: string | null | undefined): boolean => {
  if (!hint || !isString(hint)) return false;
  const trimmed = hint.trim();
  if (project.id === trimmed) return true;
  if (project.path === trimmed) return true;
  try {
    return path.resolve(project.path) === path.resolve(trimmed);
  } catch {
    return false;
  }
};

const caches = new Map<string, ScanCache>();

const nowIso = (): string => new Date().toISOString();

const issuesDirEscapesProject = (value: string): boolean => value.split(/[\\/]/).some((segment) =>
  segment === '..' || /^\.\.\s[\s.]*$/.test(segment));

export const issuesDirOf = (project: Project): string => {
  const value = project.issuesDir;
  if (isString(value) && value.trim() && !path.isAbsolute(value) && !issuesDirEscapesProject(value)) {
    return value;
  }
  return DEFAULT_ISSUES_DIR;
};

const containerOf = (project: Project): Container => ({
  id: project.id,
  name: isString(project.label) && project.label.trim() ? project.label : path.basename(project.path),
});

const fieldOf = (fields: ParsedIssue['fields'], key: string): IssueFieldValue | undefined => {
  const entry = fields.find(([existing]) => existing === key);
  return entry ? entry[1] : undefined;
};

const asString = (value: IssueFieldValue | undefined, fallback: string | null = null): string | null =>
  (isString(value) && value ? value : fallback);

const asStringOr = (value: IssueFieldValue | undefined, fallback: string): string =>
  (isString(value) && value ? value : fallback);

const asStringArray = (value: IssueFieldValue | undefined): string[] => (Array.isArray(value) ? value.filter(isString) : []);

const toIssueView = (project: Project, parsed: ParsedIssue): IssueView => ({
  projectId: project.id,
  containerId: project.id,
  number: parsed.number,
  fileName: parsed.fileName,
  identifier: parsed.identifier,
  title: asStringOr(fieldOf(parsed.fields, 'title'), parsed.identifier),
  // SAFETY: frontmatter state is served verbatim; the board coerces values outside the contract's state union.
  state: asStringOr(fieldOf(parsed.fields, 'state'), DEFAULT_STATE) as TrackerStateCategory,
  // SAFETY: frontmatter priority is served verbatim; the board coerces values outside the contract's priority union.
  priority: asString(fieldOf(parsed.fields, 'priority')) as TrackerPriority | null,
  labels: asStringArray(fieldOf(parsed.fields, 'labels')),
  assignee: asString(fieldOf(parsed.fields, 'assignee')),
  feature: asString(fieldOf(parsed.fields, 'feature')),
  blockedBy: asStringArray(fieldOf(parsed.fields, 'blockedBy')),
  createdAt: asString(fieldOf(parsed.fields, 'createdAt')),
  updatedAt: asString(fieldOf(parsed.fields, 'updatedAt')),
  blocked: false,
  body: parsed.body,
});

const scanProject = (project: Project): IssueView[] => {
  const issuesDir = issuesDirOf(project);
  const dirPath = path.join(project.path, issuesDir);
  let cache = caches.get(project.id);
  if (!cache || cache.issuesDir !== issuesDir) {
    cache = { issuesDir, readable: false, files: new Map(), issues: new Map(), ignored: [] };
    caches.set(project.id, cache);
  }
  cache.ignored = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    cache.readable = false;
    cache.issues = new Map();
    return [];
  }
  cache.readable = true;

  const matched = entries.filter((name) => ISSUE_FILE_PATTERN.test(name)).sort();
  const matchedSet = new Set(matched);
  for (const name of cache.files.keys()) {
    if (!matchedSet.has(name)) cache.files.delete(name);
  }

  const issues = new Map<string, IssueRecord>();
  const seen = new Set<string>();
  for (const fileName of matched) {
    const filePath = path.join(dirPath, fileName);
    const number = Number.parseInt(ISSUE_FILE_PATTERN.exec(fileName)?.[1] ?? '', 10);
    const identifier = `LOCAL-${number}`;
    let parsed: ParsedIssue | null = null;
    const cached = cache.files.get(fileName);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      parsed = cached.parsed;
    } else {
      parsed = readIssue(dirPath, fileName);
      cache.files.set(fileName, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
    }
    if (!parsed) {
      cache.ignored.push(fileName);
      continue;
    }
    if (seen.has(identifier)) {
      console.warn('Ignoring duplicate local issue file:', filePath);
      continue;
    }
    seen.add(identifier);
    issues.set(identifier, { issue: toIssueView(project, parsed), fileName });
  }
  applyBlocked(issues);
  cache.issues = issues;
  return [...issues.values()]
    .sort((a, b) => a.issue.number - b.issue.number)
    .map((entry) => entry.issue);
};

const isInteger = (value: unknown): value is number => Number.isInteger(value);

const decodeCursor = (cursor: string | undefined): number => {
  if (cursor == null || cursor === '') return 0;
  let offset: unknown;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8'));
    offset = isPlainObject(decoded) ? decoded.offset : undefined;
  } catch {
    throw new LocalIssueError('Invalid pagination cursor');
  }
  if (!isInteger(offset) || offset < 0) {
    throw new LocalIssueError('Invalid pagination cursor');
  }
  return offset;
};

const matchesState = (issueState: string, filter: string | null): boolean => {
  if (!filter || filter === 'all') return true;
  if (filter === 'open') return !OPEN_EXCLUDED.has(issueState);
  return issueState === filter;
};

const matchesPriority = (issuePriority: string | null, filter: string | null): boolean => {
  if (!filter || filter === 'all') return true;
  if (filter === 'none') return issuePriority == null;
  return issuePriority === filter;
};

const matchesFeature = (issueFeature: string | null, filter: string | null): boolean => !filter || issueFeature === filter;

const blocks = (identifier: string, issues: Map<string, IssueRecord>): boolean => {
  const blocker = issues.get(identifier);
  return blocker !== undefined && !SETTLED_STATES.has(blocker.issue.state);
};

const applyBlocked = (issues: Map<string, IssueRecord>): void => {
  for (const { issue } of issues.values()) {
    issue.blocked = issue.blockedBy.some((identifier) => (
      identifier !== issue.identifier && blocks(identifier, issues)
    ));
  }
};

const PASTED_FILE_NAME = /(?:^|[\\/])LOCAL-(\d{1,6})[^\\/]*\.md$/i;

const pastedIdentifier = (query: string): string | null => {
  const match = PASTED_FILE_NAME.exec(query);
  return match ? `local-${Number.parseInt(match[1] ?? '', 10)}` : null;
};

const searchableText = (issue: IssueView): string => [
  issue.identifier,
  issue.title,
  issue.body,
  issue.fileName,
  issue.feature ?? '',
  ...issue.labels,
].join(' ').toLowerCase();

const matchesQuery = (issue: IssueView, query: string | null): boolean => {
  if (!query) return true;
  const pasted = pastedIdentifier(query);
  if (pasted) return issue.identifier.toLowerCase() === pasted;
  return searchableText(issue).includes(query);
};

const parsedOf = (found: Located): ParsedIssue => {
  const cached = found.cache.files.get(found.entry.fileName);
  if (!cached?.parsed) {
    throw new LocalIssueError(`Unknown local issue: ${found.entry.issue.identifier}`);
  }
  return cached.parsed;
};

export const createLocalScanner = ({ listProjects }: { listProjects: () => Promise<Project[]> }) => {
  const scanAll = async (): Promise<Array<{ project: Project; issues: IssueView[] }>> => {
    const projects = await listProjects();
    return projects.map((project) => ({ project, issues: scanProject(project) }));
  };

  const list = async (options: TrackerListOptions = {}): Promise<ListResult> => {
    const stateFilter = isString(options.state) ? options.state : null;
    const priorityFilter = isString(options.priority) ? options.priority : null;
    const featureFilter = isString(options.feature) && options.feature ? options.feature : null;
    const query = isString(options.query) && options.query.trim() ? options.query.trim().toLowerCase() : null;
    const containerId = isString(options.containerId) && options.containerId ? options.containerId : null;

    const containerByIssue = new Map<string, Container>();
    const filtered: IssueView[] = [];
    const features = new Set<string>();
    const assignees = new Set<string>();
    for (const { project, issues } of await scanAll()) {
      if (containerId && project.id !== containerId) continue;
      const container = containerOf(project);
      containerByIssue.set(project.id, container);
      for (const issue of issues) {
        if (issue.feature) features.add(issue.feature);
        if (issue.assignee) assignees.add(issue.assignee);
        if (!matchesState(issue.state, stateFilter)) continue;
        if (!matchesPriority(issue.priority, priorityFilter)) continue;
        if (!matchesFeature(issue.feature, featureFilter)) continue;
        if (!matchesQuery(issue, query)) continue;
        filtered.push(issue);
      }
    }

    const offset = decodeCursor(options.cursor);
    const hasMore = offset + PAGE_SIZE < filtered.length;
    return {
      issues: filtered.slice(offset, offset + PAGE_SIZE),
      containerByIssue,
      features: [...features].sort((a, b) => a.localeCompare(b)),
      assignees: [...assignees].sort((a, b) => a.localeCompare(b)),
      cursor: hasMore
        ? Buffer.from(JSON.stringify({ offset: offset + PAGE_SIZE })).toString('base64')
        : null,
      hasMore,
    };
  };

  const get = async (first: string | null | undefined, second?: string | null): Promise<{ issue: IssueView; container: Container } | null> => {
    const { identifier, projectHint } = normalizeIdentifierAndHint(first, second);
    if (!identifier) return null;
    if (projectHint) {
      const found = await locate(identifier, projectHint);
      if (found) {
        return { issue: found.entry.issue, container: containerOf(found.project) };
      }
      return null;
    }
    const matches: Array<{ issue: IssueView; container: Container }> = [];
    for (const { project, issues } of await scanAll()) {
      const issue = issues.find((candidate) => candidate.identifier === identifier);
      if (issue) matches.push({ issue, container: containerOf(project) });
    }
    if (matches.length === 1) return matches[0] ?? null;
    if (matches.length > 1) {
      console.warn(`Ambiguous local issue ${identifier} in get(); returning first match`);
      return matches[0] ?? null;
    }
    return null;
  };

  const states = (): TrackerWorkflowState[] => STATES.map((name, position) => ({ id: name, name, category: name, position }));

  const locate = async (first: string | null | undefined, second?: string | null): Promise<Located | null> => {
    const { identifier, projectHint } = normalizeIdentifierAndHint(first, second);
    if (!identifier) return null;

    if (projectHint) {
      const projects = await listProjects();
      const project = projects.find((p) => matchesProject(p, projectHint));
      if (!project) return null;
      scanProject(project);
      const cache = caches.get(project.id);
      const entry = cache && cache.issues.get(identifier);
      if (entry) return { project, cache, entry };
      return null;
    }

    let match: Located | null = null;
    for (const { project } of await scanAll()) {
      const cache = caches.get(project.id);
      const entry = cache && cache.issues.get(identifier);
      if (entry) {
        if (match) {
          console.warn(`Ambiguous local issue identifier ${identifier} across projects; specify project container`);
        } else {
          match = { project, cache, entry };
        }
      }
    }
    return match;
  };

  const persist = (project: Project, cache: ScanCache, parsed: ParsedIssue, previousFileName: string | null = null): IssueView => {
    const dirPath = path.join(project.path, cache.issuesDir);
    writeIssue(dirPath, parsed);
    if (previousFileName && previousFileName !== parsed.fileName) {
      const oldFilePath = path.join(dirPath, previousFileName);
      if (fs.existsSync(oldFilePath)) {
        try {
          fs.unlinkSync(oldFilePath);
        } catch (err) {
          console.warn('Failed to remove previous issue file:', oldFilePath, err);
        }
      }
      cache.files.delete(previousFileName);
    }
    const stat = fs.statSync(path.join(dirPath, parsed.fileName));
    cache.files.set(parsed.fileName, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
    const issue = toIssueView(project, parsed);
    cache.issues.set(parsed.identifier, { issue, fileName: parsed.fileName });
    applyBlocked(cache.issues);
    return issue;
  };

  const isKnownState = (value: string): value is TrackerStateCategory => STATES.some((state) => state === value);

  const updateState = async (identifier: string, stateId: string, projectHint: string | null | undefined = null): Promise<IssueView> => {
    if (!isKnownState(stateId)) {
      throw new LocalIssueError(`Unknown local issue state: ${stateId}`);
    }
    const found = await locate(identifier, projectHint);
    if (!found) throw new LocalIssueError(`Unknown local issue: ${identifier}`);
    return persist(
      found.project,
      found.cache,
      setFields(parsedOf(found), { state: stateId, updatedAt: nowIso() }),
    );
  };

  const comment = async (identifier: string, text: string, projectHint: string | null | undefined = null): Promise<IssueView> => {
    if (!isString(text) || !text.trim()) {
      throw new LocalIssueError('Local issue comment is required');
    }
    const found = await locate(identifier, projectHint);
    if (!found) throw new LocalIssueError(`Unknown local issue: ${identifier}`);
    return persist(found.project, found.cache, appendComment(parsedOf(found), { iso: nowIso(), source: 'user', text: text.trim() }));
  };

  const replaceBody = (currentBody: string, description: string | null | undefined): string => {
    const head = description ? `${description}\n` : '';
    const { comments } = splitComments(currentBody);
    if (!comments.length) return head;
    let section = '## Comments\n';
    for (const entry of comments) {
      section += `\n### ${entry.iso} · ${entry.source}\n\n${entry.text}\n`;
    }
    return `${head}${section}`;
  };

  const edit = async (identifier: string, patch: Record<string, IssueFieldValue> = {}, projectHint: string | null | undefined = null): Promise<IssueView> => {
    const found = await locate(identifier, projectHint);
    if (!found) throw new LocalIssueError(`Unknown local issue: ${identifier}`);
    const parsed = parsedOf(found);
    const oldFileName = found.entry.fileName;
    const fieldsPatch: Record<string, IssueFieldValue> = {};
    let nextSlug = parsed.slug;
    let nextFileName = oldFileName;
    if (patch.title !== undefined) {
      const title = isString(patch.title) ? patch.title.trim() : '';
      if (!title) throw new LocalIssueError('Local issue title is required');
      fieldsPatch.title = patch.title;
      nextSlug = sanitizeSlug(title);
      nextFileName = issueFileName(parsed.number, nextSlug);
      if (nextFileName !== oldFileName) {
        const dirPath = path.join(found.project.path, found.cache.issuesDir);
        const targetPath = path.join(dirPath, nextFileName);
        if (fs.existsSync(targetPath)) {
          throw new LocalIssueError(`Target issue file already exists: ${nextFileName}`);
        }
      }
    }
    if (patch.priority !== undefined) fieldsPatch.priority = asString(patch.priority, 'low');
    if (patch.labels !== undefined) fieldsPatch.labels = asStringArray(patch.labels);
    if (patch.assignee !== undefined) fieldsPatch.assignee = asString(patch.assignee);
    if (patch.feature !== undefined) fieldsPatch.feature = asString(patch.feature);
    if (patch.blockedBy !== undefined) fieldsPatch.blockedBy = asStringArray(patch.blockedBy);
    let next = setFields(parsed, fieldsPatch);
    if (patch.description !== undefined) {
      next = { ...next, body: replaceBody(next.body, asString(patch.description)) };
    }
    next.fileName = nextFileName;
    next.slug = nextSlug;
    return persist(found.project, found.cache, setFields(next, { updatedAt: nowIso() }), oldFileName);
  };

  const locateUnambiguous = async (identifier: string): Promise<Located | null> => {
    let found: Located | null = null;
    for (const { project } of await scanAll()) {
      const cache = caches.get(project.id);
      const entry = cache && cache.issues.get(identifier);
      if (!entry) continue;
      if (found) throw new LocalIssueError(`Local issue ${identifier} exists in more than one project; name its container`);
      found = { project, cache, entry };
    }
    return found;
  };

  const remove = async (identifier: string, projectHint: string | null | undefined = null): Promise<IssueView> => {
    const found = projectHint
      ? await locate(identifier, projectHint)
      : await locateUnambiguous(identifier);
    if (!found) throw new LocalIssueError(`Unknown local issue: ${identifier}`);
    const dirPath = path.join(found.project.path, found.cache.issuesDir);
    fs.rmSync(path.join(dirPath, found.entry.fileName), { force: true });
    found.cache.files.delete(found.entry.fileName);
    found.cache.issues.delete(found.entry.issue.identifier);
    applyBlocked(found.cache.issues);
    return found.entry.issue;
  };

  const create = async (containerId: string, options: Record<string, IssueFieldValue> = {}): Promise<IssueView> => {
    const project = (await listProjects()).find((candidate) => candidate.id === containerId);
    if (!project) throw new LocalIssueError(`Unknown local project: ${containerId}`);
    const title = isString(options.title) ? options.title.trim() : '';
    if (!title) throw new LocalIssueError('Local issue title is required');

    const issuesDir = issuesDirOf(project);
    const dirPath = path.join(project.path, issuesDir);
    fs.mkdirSync(dirPath, { recursive: true });
    const existing = scanProject(project);
    const cache = caches.get(project.id);
    if (!cache) throw new LocalIssueError(`Unknown local project: ${containerId}`);

    const fields: Array<[string, IssueFieldValue]> = [
      ['state', 'todo'],
      ['priority', asString(options.priority, 'low')],
      ['labels', asStringArray(options.labels)],
      ['assignee', asString(options.assignee)],
      ['feature', asString(options.feature)],
      ['blockedBy', asStringArray(options.blockedBy)],
    ];
    const body = isString(options.description) && options.description ? `${options.description}\n` : '';

    let maxNumber = existing.reduce((max, issue) => Math.max(max, issue.number), 0);
    const slug = sanitizeSlug(title);
    for (let attempt = 0; ; attempt++) {
      const number = maxNumber + 1;
      const identifier = `LOCAL-${number}`;
      const fileName = issueFileName(number, slug);
      if (fs.existsSync(path.join(dirPath, fileName))) {
        if (attempt >= CREATE_MAX_RETRIES) {
          throw new LocalIssueError(`Could not allocate a free issue number in ${dirPath}`);
        }
        const rescanned = scanProject(project);
        maxNumber = rescanned.reduce((max, issue) => Math.max(max, issue.number), number);
        continue;
      }
      const parsed: ParsedIssue = {
        fileName,
        number,
        slug,
        identifier,
        fields: [['identifier', identifier], ['title', title], ...fields,
          ['createdAt', nowIso()], ['updatedAt', nowIso()]],
        body,
      };
      return persist(project, cache, parsed);
    }
  };

  const liveSummaries = async (identifiers: string[]): Promise<TrackerLiveSummaryWire[]> => {
    const wanted = Array.isArray(identifiers) ? identifiers.filter(isString) : [];
    const found = new Map<string, IssueView>();
    for (const { issues } of await scanAll()) {
      for (const issue of issues) {
        if (wanted.includes(issue.identifier)) found.set(issue.identifier, issue);
      }
    }
    return wanted
      .map((identifier) => {
        const issue = found.get(identifier);
        return issue
          ? { identifier, title: issue.title, state: { name: issue.state, category: issue.state, type: issue.state } }
          : null;
      })
      .filter((item) => item !== null);
  };

  const containers = async (): Promise<Container[]> => {
    const scanned = await scanAll();
    return scanned.filter(({ project }) => caches.get(project.id)?.readable).map(({ project }) => containerOf(project));
  };

  return { list, get, locate, states, updateState, comment, create, edit, remove, liveSummaries, containers };
};
