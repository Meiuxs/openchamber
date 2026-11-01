import fs from 'fs';
import path from 'path';
import { isString } from '../shared/guards.js';
import {
  ISSUE_FILE_PATTERN,
  LocalIssueError,
  STATES,
  issueFileName,
  readIssue,
  sanitizeSlug,
  setFields,
  splitComments,
  writeIssue,
} from './files.js';

const PAGE_SIZE = 100;
const CREATE_MAX_RETRIES = 3;
const DEFAULT_ISSUES_DIR = '.issues';
const OPEN_EXCLUDED = new Set(['done', 'canceled']);
// A blocker in one of these states no longer blocks the issues waiting on it.
const SETTLED_STATES = new Set(['done', 'canceled']);
const DEFAULT_STATE = 'triage';
const ISSUE_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

const normalizeIdentifierAndHint = (first, second) => {
  if (isString(first) && isString(second)) {
    if (!ISSUE_IDENTIFIER_PATTERN.test(first) && ISSUE_IDENTIFIER_PATTERN.test(second)) {
      return { identifier: second, projectHint: first };
    }
    return { identifier: first, projectHint: second };
  }
  return { identifier: first, projectHint: second || null };
};

const matchesProject = (project, hint) => {
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

// Per-project scan cache: parsed files are reused while `mtimeMs`/`size` are
// unchanged, so only touched files are re-read on every scan. `parsed` is null
// for files that exist but cannot be parsed (recorded in `ignored` so the
// readIssue warning fires once per change, not once per scan).
// Map<projectId, { issuesDir, readable, files: Map<fileName, { mtimeMs, size, parsed }>, issues: Map<identifier, { issue, fileName }>, ignored: string[] }>
const caches = new Map();

const nowIso = () => new Date().toISOString();

// A custom `issuesDir` must be a relative, non-escaping directory name;
// anything else falls back to the default so a bad setting can never point
// the scanner outside the project. The escape check mirrors the settings
// layer's `issuesDirEscapesProject` (../opencode/settings-normalization-runtime.js):
// Win32 path normalization trims trailing whitespace and dot runs from each
// component, so `.. ` and `.. .` resolve as `..` on Windows while a dots-only
// segment (`....`) stays a legal directory name.
const issuesDirEscapesProject = (value) => value.split(/[\\/]/).some((segment) =>
  segment === '..' || /^\.\.\s[\s.]*$/.test(segment));

const issuesDirOf = (project) => {
  const value = project.issuesDir;
  if (isString(value) && value.trim() && !path.isAbsolute(value) && !issuesDirEscapesProject(value)) {
    return value;
  }
  return DEFAULT_ISSUES_DIR;
};

const containerOf = (project) => ({
  id: project.id,
  name: isString(project.label) && project.label.trim() ? project.label : path.basename(project.path),
});

const fieldOf = (fields, key) => {
  const entry = fields.find(([existing]) => existing === key);
  return entry ? entry[1] : undefined;
};

const asString = (value, fallback = null) => (isString(value) && value ? value : fallback);

const asStringArray = (value) => (Array.isArray(value) ? value.filter(isString) : []);

const toIssueView = (project, parsed) => ({
  projectId: project.id,
  containerId: project.id,
  number: parsed.number,
  fileName: parsed.fileName,
  identifier: parsed.identifier,
  title: asString(fieldOf(parsed.fields, 'title'), parsed.identifier),
  state: asString(fieldOf(parsed.fields, 'state'), DEFAULT_STATE),
  priority: asString(fieldOf(parsed.fields, 'priority')),
  labels: asStringArray(fieldOf(parsed.fields, 'labels')),
  feature: asString(fieldOf(parsed.fields, 'feature')),
  blockedBy: asStringArray(fieldOf(parsed.fields, 'blockedBy')),
  createdAt: asString(fieldOf(parsed.fields, 'createdAt')),
  updatedAt: asString(fieldOf(parsed.fields, 'updatedAt')),
  body: parsed.body,
});

// Refreshes the cache for one project and returns its issues sorted by number.
// A missing or unreadable dir yields an empty result for that project only.
const scanProject = (project) => {
  const issuesDir = issuesDirOf(project);
  const dirPath = path.join(project.path, issuesDir);
  let cache = caches.get(project.id);
  if (!cache || cache.issuesDir !== issuesDir) {
    cache = { issuesDir, readable: false, files: new Map(), issues: new Map(), ignored: [] };
    caches.set(project.id, cache);
  }
  cache.ignored = [];

  let entries;
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

  const issues = new Map();
  const seen = new Set();
  for (const fileName of matched) {
    const filePath = path.join(dirPath, fileName);
    const number = Number.parseInt(ISSUE_FILE_PATTERN.exec(fileName)[1], 10);
    const identifier = `LOCAL-${number}`;
    let parsed;
    const cached = cache.files.get(fileName);
    let stat;
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

const decodeCursor = (cursor) => {
  if (cursor == null || cursor === '') return 0;
  let offset;
  try {
    const decoded = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8'));
    offset = decoded && decoded.offset;
  } catch {
    throw new LocalIssueError('Invalid pagination cursor');
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new LocalIssueError('Invalid pagination cursor');
  }
  return offset;
};

const matchesState = (issueState, filter) => {
  if (!filter || filter === 'all') return true;
  if (filter === 'open') return !OPEN_EXCLUDED.has(issueState);
  return issueState === filter;
};

// `all` (or absent) matches any priority; `none` matches issues without one;
// otherwise the issue's priority equals the filter value.
const matchesPriority = (issuePriority, filter) => {
  if (!filter || filter === 'all') return true;
  if (filter === 'none') return issuePriority == null;
  return issuePriority === filter;
};

// A `feature` filter narrows to that grouping slug; absent matches every issue.
const matchesFeature = (issueFeature, filter) => !filter || issueFeature === filter;

// A blocker keeps blocking while its file exists and its state is neither done
// nor canceled. An identifier with no file behind it (deleted, renamed, a typo
// in the frontmatter) blocks nothing, and an issue never blocks itself: either
// would leave the issue blocked with nothing left to settle.
const blocks = (identifier, issues) => {
  const blocker = issues.get(identifier);
  return Boolean(blocker) && !SETTLED_STATES.has(blocker.issue.state);
};

// `blocked` is derived on every scan from the project's own files and never
// stored: the frontmatter keeps `blockedBy`, the blockers' states decide
// whether it still counts, and one write to a blocker settles every issue
// waiting on it without touching their files.
const applyBlocked = (issues) => {
  for (const { issue } of issues.values()) {
    issue.blocked = issue.blockedBy.some((identifier) => (
      identifier !== issue.identifier && blocks(identifier, issues)
    ));
  }
};

// A pasted file name or path (`LOCAL-7-fix-login.md`,
// `.issues/LOCAL-7-fix-login.md`) names one issue: its last path segment
// carries the identifier that the searchable text only holds as `local-7 ...`.
const PASTED_FILE_NAME = /(?:^|[\\/])LOCAL-(\d{1,6})[^\\/]*\.md$/i;

const pastedIdentifier = (query) => {
  const match = PASTED_FILE_NAME.exec(query);
  return match ? `local-${Number.parseInt(match[1], 10)}` : null;
};

// Everything an issue says about itself is searchable, including the grouping
// slug and the labels: they are shown on the row, so a search that ignored
// them would return nothing for text the list visibly holds.
const searchableText = (issue) => [
  issue.identifier,
  issue.title,
  issue.body,
  issue.fileName,
  issue.feature ?? '',
  ...issue.labels,
].join(' ').toLowerCase();

const matchesQuery = (issue, query) => {
  if (!query) return true;
  const pasted = pastedIdentifier(query);
  if (pasted) return issue.identifier.toLowerCase() === pasted;
  return searchableText(issue).includes(query);
};

const createLocalScanner = ({ listProjects }) => {
  const scanAll = async () => {
    const projects = await listProjects();
    return projects.map((project) => ({ project, issues: scanProject(project) }));
  };

  const list = async (options = {}) => {
    const stateFilter = isString(options.state) ? options.state : null;
    const priorityFilter = isString(options.priority) ? options.priority : null;
    const featureFilter = isString(options.feature) && options.feature ? options.feature : null;
    const query = isString(options.query) && options.query.trim() ? options.query.trim().toLowerCase() : null;
    const containerId = isString(options.containerId) && options.containerId ? options.containerId : null;

    // Keyed by projectId, not identifier: identifiers restart at LOCAL-1 in
    // every project, so an identifier key would collide across projects and
    // hand consumers the wrong container. Consumers resolve a returned issue's
    // container via `containerByIssue.get(issue.containerId)`.
    const containerByIssue = new Map();
    const filtered = [];
    // Slugs the feature filter offers: gathered from every issue of the
    // container, not from the filtered page, since options narrowed by the
    // filter in force would leave the chosen slug as the only one pickable.
    const features = new Set();
    for (const { project, issues } of await scanAll()) {
      if (containerId && project.id !== containerId) continue;
      const container = containerOf(project);
      containerByIssue.set(project.id, container);
      for (const issue of issues) {
        if (issue.feature) features.add(issue.feature);
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
      cursor: hasMore
        ? Buffer.from(JSON.stringify({ offset: offset + PAGE_SIZE })).toString('base64')
        : null,
      hasMore,
    };
  };

  const get = async (first, second) => {
    const { identifier, projectHint } = normalizeIdentifierAndHint(first, second);
    if (!identifier) return null;
    if (projectHint) {
      const found = await locate(identifier, projectHint);
      if (found) {
        return { issue: found.entry.issue, container: containerOf(found.project) };
      }
      return null;
    }
    const matches = [];
    for (const { project, issues } of await scanAll()) {
      const issue = issues.find((candidate) => candidate.identifier === identifier);
      if (issue) matches.push({ issue, container: containerOf(project) });
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      console.warn(`Ambiguous local issue ${identifier} in get(); returning first match`);
      return matches[0];
    }
    return null;
  };

  const states = () => STATES.map((name, position) => ({ id: name, name, category: name, position }));

  const locate = async (first, second) => {
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

    let match = null;
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

  // Writes a mutated parsed issue back to disk and refreshes the cache so the
  // next scan reuses the fresh parse instead of re-reading the file.
  const persist = (project, cache, parsed, previousFileName = null) => {
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
    // A state write settles or revives the issues waiting on this one, so the
    // whole project's derived flags are recomputed, not just this issue's.
    applyBlocked(cache.issues);
    return issue;
  };

  const updateState = async (identifier, stateId, projectHint = null) => {
    if (!STATES.includes(stateId)) {
      throw new LocalIssueError(`Unknown local issue state: ${stateId}`);
    }
    const found = await locate(identifier, projectHint);
    if (!found) throw new LocalIssueError(`Unknown local issue: ${identifier}`);
    const parsed = found.cache.files.get(found.entry.fileName).parsed;
    return persist(
      found.project,
      found.cache,
      setFields(parsed, { state: stateId, updatedAt: nowIso() }),
    );
  };

  // Replaces the description (head) while keeping any existing comment
  // entries, so an edit never silently drops the `## Comments` section.
  const replaceBody = (currentBody, description) => {
    const head = description ? `${description}\n` : '';
    const { comments } = splitComments(currentBody);
    if (!comments.length) return head;
    let section = '## Comments\n';
    for (const entry of comments) {
      section += `\n### ${entry.iso} · ${entry.source}\n\n${entry.text}\n`;
    }
    return `${head}${section}`;
  };

  const edit = async (identifier, patch = {}, projectHint = null) => {
    const found = await locate(identifier, projectHint);
    if (!found) throw new LocalIssueError(`Unknown local issue: ${identifier}`);
    const parsed = found.cache.files.get(found.entry.fileName).parsed;
    const oldFileName = found.entry.fileName;
    const fieldsPatch = {};
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
    if (patch.priority !== undefined) fieldsPatch.priority = patch.priority ?? null;
    if (patch.labels !== undefined) fieldsPatch.labels = asStringArray(patch.labels);
    if (patch.feature !== undefined) fieldsPatch.feature = asString(patch.feature);
    if (patch.blockedBy !== undefined) fieldsPatch.blockedBy = asStringArray(patch.blockedBy);
    let next = setFields(parsed, fieldsPatch);
    if (patch.description !== undefined) {
      next = { ...next, body: replaceBody(next.body, patch.description) };
    }
    next.fileName = nextFileName;
    next.slug = nextSlug;
    return persist(found.project, found.cache, setFields(next, { updatedAt: nowIso() }), oldFileName);
  };

  const create = async (containerId, options = {}) => {
    const project = (await listProjects()).find((candidate) => candidate.id === containerId);
    if (!project) throw new LocalIssueError(`Unknown local project: ${containerId}`);
    const title = isString(options.title) ? options.title.trim() : '';
    if (!title) throw new LocalIssueError('Local issue title is required');

    const issuesDir = issuesDirOf(project);
    const dirPath = path.join(project.path, issuesDir);
    fs.mkdirSync(dirPath, { recursive: true });
    const existing = scanProject(project);
    const cache = caches.get(project.id);

    const fields = [
      ['state', 'todo'],
      ['priority', asString(options.priority)],
      ['labels', asStringArray(options.labels)],
      ['assignee', null],
      ['feature', asString(options.feature)],
      ['blockedBy', asStringArray(options.blockedBy)],
    ];
    const body = isString(options.description) && options.description ? `${options.description}\n` : '';

    // Existence-retry loop: the target slot can be taken between the scan and
    // the write (another process creating issues in the same dir). Re-scan,
    // bump, and retry a bounded number of times before giving up.
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
      const parsed = {
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

  const liveSummaries = async (identifiers) => {
    const wanted = Array.isArray(identifiers) ? identifiers.filter(isString) : [];
    const found = new Map();
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
      .filter(Boolean);
  };

  const containers = async () => {
    const scanned = await scanAll();
    return scanned.filter(({ project }) => caches.get(project.id).readable).map(({ project }) => containerOf(project));
  };

  return { list, get, locate, states, updateState, create, edit, liveSummaries, containers };
};

export { createLocalScanner, issuesDirOf };
