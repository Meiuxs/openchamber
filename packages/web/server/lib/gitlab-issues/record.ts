import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunEntry, RunEvent, ReviewHistoryEntry } from './ledger.js';
import { isRecord, isString } from '../shared/guards.js';

type RecordFileSystem = Pick<typeof fs, 'mkdir' | 'readFile' | 'writeFile' | 'rename'>;
type AccessFileSystem = Pick<typeof fs, 'access'>;

export interface RecordLocation {
  primary: string;
  fallback: string;
}

export interface WriteRunRecordInput {
  run: RunEntry;
  checkoutPath: string;
  excludePath: string | null;
  fsImpl?: RecordFileSystem | undefined;
}

const EXCLUDE_ENTRY = '.openchamber/issue-records/';
const RECORD_DIRECTORY = path.join('.openchamber', 'issue-records');
const FALLBACK_DIRECTORY = path.join('.git', 'openchamber', 'issue-records');
const TIMELINE_MAX = 20;

const sanitizeSegment = (segment: string): string => {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned === '.' || cleaned === '..' ? '__' : cleaned;
};

export function recordLocationFor(input: { checkoutPath: string; projectPath: string; iid: number }): RecordLocation {
  const segments = String(input.projectPath ?? '')
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
    .map(sanitizeSegment);
  const fileName = `issue-${input.iid}.md`;
  return {
    primary: path.join(input.checkoutPath, RECORD_DIRECTORY, ...segments, fileName),
    fallback: path.join(input.checkoutPath, FALLBACK_DIRECTORY, ...segments, fileName),
  };
}

export async function recordExists(location: RecordLocation, fsImpl: AccessFileSystem = fs): Promise<string | null> {
  for (const candidate of [location.primary, location.fallback]) {
    try {
      await fsImpl.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function issueUrlOf(run: Pick<RunEntry, 'origin' | 'projectPath' | 'iid'>): string | null {
  if (!isString(run.origin) || !isString(run.projectPath) || !Number.isInteger(run.iid)) return null;
  return `${run.origin}/${run.projectPath}/issues/${run.iid}`;
}

export function mrUrlOf(run: Pick<RunEntry, 'origin' | 'projectPath' | 'mrIid'>): string | null {
  if (!isString(run.origin) || !isString(run.projectPath) || !Number.isInteger(run.mrIid)) return null;
  return `${run.origin}/${run.projectPath}/merge_requests/${run.mrIid}`;
}

const normalizeNewlines = (value: string): string => value.replace(/\r\n?/g, '\n');

export function escapeMarkdownCell(text: string | null | undefined): string {
  return normalizeNewlines(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

const escapeInline = (line: string): string => line
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\*/g, '\\*')
  .replace(/_/g, '\\_')
  .replace(/\[/g, '\\[')
  .replace(/\]/g, '\\]')
  .replace(/\(/g, '\\(')
  .replace(/\)/g, '\\)')
  .replace(/!/g, '\\!')
  .replace(/</g, '\\<')
  .replace(/>/g, '\\>')
  .replace(/\|/g, '\\|')
  .replace(/&/g, '\\&');

const escapeLeadingMarker = (line: string): string => {
  const heading = line.replace(/^(\s*)(#{1,6})(?=\s|$)/, (_, prefix: string, hashes: string) => (
    `${prefix}${hashes.split('').map(() => '\\#').join('')}`
  ));
  const bullet = heading.replace(/^(\s*)-(?=\s|$)/, '$1\\-');
  return bullet.replace(/^(\s*)(\d+)([.)])(?=\s|$)/, (_, prefix: string, digits: string, marker: string) => (
    `${prefix}${digits}\\${marker}`
  ));
};

export function escapeMarkdownText(text: string | null | undefined): string {
  return normalizeNewlines(text ?? '')
    .split('\n')
    .map((line) => escapeLeadingMarker(escapeInline(line)))
    .join('  \n');
}

export function fencedText(text: string | null | undefined): string {
  const value = normalizeNewlines(text ?? '');
  const runs = value.match(/`+/g) ?? [];
  const longest = runs.reduce((length, run) => Math.max(length, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${value}\n${fence}`;
}

const isFilled = (value: string | null | undefined): value is string => isString(value) && value.trim().length > 0;

const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);

const tableCell = (value: string | number | null | undefined): string => escapeMarkdownCell(value === null || value === undefined ? '' : String(value));

const headerRow = (label: string, value: string | null | undefined): string | null => (
  isFilled(value) ? `| ${label} | ${tableCell(value)} |` : null
);

const lastEventTime = (events: RunEntry['events']): string | null => {
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const at = events[index]?.at;
    if (isFilled(at)) return at;
  }
  return null;
};

const actorText = (run: RunEntry): string => {
  const parts: string[] = [];
  if (isFiniteNumber(run.actorUserId)) parts.push(`user ${run.actorUserId}`);
  if (isFilled(run.actorAccountId)) parts.push(run.actorAccountId);
  return parts.join(' / ');
};

const approverText = (run: RunEntry): string => {
  const approvedBy = run.approvedBy;
  if (!approvedBy) return '';
  const parts: string[] = [];
  if (isFilled(approvedBy.login)) parts.push(approvedBy.login);
  if (isFiniteNumber(approvedBy.userId)) parts.push(`user ${approvedBy.userId}`);
  if (isFilled(approvedBy.accountId)) parts.push(approvedBy.accountId);
  return parts.join(' / ');
};

const pushLabeled = (lines: string[], label: string, value: string | null | undefined): void => {
  if (!isFilled(value)) return;
  lines.push(`- ${label}：${escapeMarkdownText(value)}`);
};

const multilineList = (lines: string[], prefix: string, value: string | null | undefined): void => {
  const raw = normalizeNewlines(value ?? '');
  if (!raw.includes('\n')) {
    lines.push(`${prefix} ${escapeMarkdownText(raw)}`);
    return;
  }
  lines.push(prefix);
  for (const line of fencedText(raw).split('\n')) lines.push(`  ${line}`);
};

const renderHeader = (run: RunEntry): string | null => {
  const rows = [
    headerRow('项目', run.projectPath),
    headerRow('类型', run.kind),
    headerRow('阶段', run.phase),
    headerRow('目标分支', run.targetBranch),
    headerRow('源分支', run.branch),
    headerRow('触发人', actorText(run)),
    headerRow('审批人', approverText(run)),
    headerRow('Issue', issueUrlOf(run)),
    headerRow('合并请求', mrUrlOf(run)),
    headerRow('阶段开始', run.since),
    headerRow('最近事件', lastEventTime(run.events)),
  ].filter((row): row is string => row !== null);
  if (rows.length === 0) return null;
  return ['| 项目 | 值 |', '| --- | --- |', ...rows].join('\n');
};

const renderSummary = (run: RunEntry): string | null => {
  const lines: string[] = [];
  if (run.triage) {
    const { verdict, summary } = run.triage;
    if (isFilled(verdict) || isFilled(summary)) {
      const suffix = isFilled(summary) ? ` — ${escapeMarkdownText(summary)}` : '';
      lines.push(`- 判定：${escapeMarkdownText(verdict ?? '')}${suffix}`);
    }
    pushLabeled(lines, '判定依据', run.triage.evidence);
    pushLabeled(lines, '缺失信息', run.triage.missing);
  }
  if (run.plan) {
    const files = Array.isArray(run.plan.files) ? run.plan.files.filter(isFilled) : [];
    if (files.length > 0) lines.push(`- 方案文件：${files.map((file) => escapeMarkdownText(file)).join('、')}`);
    pushLabeled(lines, '数据流', run.plan.dataFlow);
    pushLabeled(lines, '验证方式', run.plan.verification);
    pushLabeled(lines, '风险', run.plan.risks);
    pushLabeled(lines, '范围外', run.plan.outOfScope);
  }
  if (run.evidence) {
    pushLabeled(lines, '根因', run.evidence.rootCause);
    pushLabeled(lines, '改动', run.evidence.changes);
    pushLabeled(lines, '风险', run.evidence.risks);
  }
  return lines.length > 0 ? lines.join('\n') : null;
};

const renderChangeFiles = (run: RunEntry): string | null => {
  const files = Array.isArray(run.changeSummary?.files) ? run.changeSummary.files : [];
  if (files.length === 0) return null;
  const lines = ['| 文件 | 状态 | + | - |', '| --- | --- | --- | --- |'];
  for (const file of files) {
    lines.push(`| ${tableCell(file.path)} | ${tableCell(file.status)} | ${file.added === null || file.added === undefined ? '-' : file.added} | ${file.removed === null || file.removed === undefined ? '-' : file.removed} |`);
  }
  return lines.join('\n');
};

const renderCommits = (run: RunEntry): string | null => {
  const commits = Array.isArray(run.changeSummary?.commits) ? run.changeSummary.commits : [];
  if (commits.length === 0) return null;
  return commits
    .map((commit) => `- ${escapeMarkdownText(commit.sha)} ${escapeMarkdownText(commit.subject)}`)
    .join('\n');
};

const renderVerification = (run: RunEntry): string | null => {
  const lines: string[] = [];
  const verification = Array.isArray(run.evidence?.verification) ? run.evidence.verification : [];
  for (const entry of verification) {
    lines.push(`- 会话自验：${escapeMarkdownText(entry.command)} -> ${escapeMarkdownText(entry.result)}`);
  }
  const verifyResult = run.verifyResult;
  if (verifyResult) {
    const code = verifyResult.code === null || verifyResult.code === undefined ? 'unknown' : String(verifyResult.code);
    const tail = isFilled(verifyResult.outputTail) ? `，输出摘要：${escapeMarkdownText(verifyResult.outputTail)}` : '';
    lines.push(`- 服务端验证：${escapeMarkdownText(verifyResult.command)}，退出码 ${code}${tail}`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
};

const renderFindings = (history: ReviewHistoryEntry[]): string[] => {
  const lines: string[] = [];
  for (const entry of history) {
    for (const finding of Array.isArray(entry.findings) ? entry.findings : []) {
      const location = `${escapeMarkdownText(finding.file)}${isFiniteNumber(finding.line) ? `:${finding.line}` : ''}`;
      multilineList(lines, `- ${location} [${escapeMarkdownText(finding.severity)}]`, finding.note);
    }
  }
  return lines;
};

const renderReview = (run: RunEntry): string | null => {
  const history = Array.isArray(run.reviewHistory) ? run.reviewHistory : [];
  const hasImpact = run.reviewImpact !== null && run.reviewImpact !== undefined;
  if (history.length === 0 && !isFilled(run.reviewVerdict) && !isFilled(run.recheckVerdict) && !hasImpact) return null;
  const lines: string[] = [];
  pushLabeled(lines, '最终结论', run.reviewVerdict);
  if (isFiniteNumber(run.reviewRounds)) lines.push(`- 审核轮数：${run.reviewRounds}`);
  pushLabeled(lines, '复核结论', run.recheckVerdict);
  if (history.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('| 序号 | 类型 | 轮次 | 结论 | 摘要 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const entry of history) {
      lines.push(`| ${entry.seq} | ${tableCell(entry.kind)} | ${entry.round} | ${tableCell(entry.verdict)} | ${tableCell(entry.summary)} |`);
    }
    const findings = renderFindings(history);
    if (findings.length > 0) {
      lines.push('');
      lines.push('### 发现');
      lines.push(...findings);
    }
  }
  if (run.reviewImpact) {
    const impact = run.reviewImpact;
    const impactLines: string[] = [];
    pushLabeled(impactLines, '影响模块', impact.modules);
    pushLabeled(impactLines, '业务影响', impact.business);
    pushLabeled(impactLines, '兼容性', impact.compatibility);
    pushLabeled(impactLines, '回滚方式', impact.rollback);
    pushLabeled(impactLines, '测试范围', impact.testScope);
    if (impactLines.length > 0) {
      lines.push('');
      lines.push('### 合并影响');
      lines.push(...impactLines);
    }
  }
  return lines.join('\n');
};

const renderFeedback = (run: RunEntry): string | null => {
  const history = Array.isArray(run.feedbackHistory) ? run.feedbackHistory : [];
  if (history.length === 0) return null;
  const lines: string[] = [];
  for (const entry of history) {
    lines.push(`- 第 ${entry.round} 轮（${escapeMarkdownText(entry.at)}）`);
    for (const item of Array.isArray(entry.items) ? entry.items : []) {
      multilineList(lines, `  - ${escapeMarkdownText(item.author)}：`, item.text);
    }
  }
  return lines.join('\n');
};

const renderEvent = (event: RunEvent): string => {
  const parts: string[] = [];
  if (isFilled(event.at)) parts.push(event.at);
  if (isFilled(event.kind)) parts.push(event.kind);
  if (isFilled(event.from) && isFilled(event.to)) parts.push(`${event.from} -> ${event.to}`);
  else if (isFilled(event.to)) parts.push(`-> ${event.to}`);
  else if (isFilled(event.from)) parts.push(`${event.from} ->`);
  if (isFilled(event.phase)) parts.push(event.phase);
  if (isFilled(event.reason)) parts.push(event.reason);
  if (isFilled(event.detail)) parts.push(event.detail);
  return parts.map((part) => escapeMarkdownText(part)).join(' ');
};

const renderTimeline = (run: RunEntry): string | null => {
  const events = Array.isArray(run.events) ? run.events.filter((event): event is RunEvent => event !== null && event !== undefined) : [];
  if (events.length === 0) return null;
  const kept = events.slice(-TIMELINE_MAX);
  const lines = kept.map((event) => `- ${renderEvent(event)}`);
  if (events.length > TIMELINE_MAX) lines.push(`- 仅保留最近 ${TIMELINE_MAX} 条`);
  return lines.join('\n');
};

const renderBlocked = (run: RunEntry): string | null => {
  const lines: string[] = [];
  pushLabeled(lines, '阻塞原因', run.blockedReason);
  pushLabeled(lines, '阻塞前阶段', run.blockedFrom);
  pushLabeled(lines, '服务端错误', run.lastError);
  pushLabeled(lines, '保留的工作区', run.worktreePath);
  return lines.length > 0 ? lines.join('\n') : null;
};

export function renderRunRecord(run: RunEntry): string {
  const title = isFilled(run.title) ? run.title : `Issue ${run.iid}`;
  const parts = [`# ${escapeMarkdownCell(title)} (#${run.iid})`];
  const header = renderHeader(run);
  if (header) parts.push(header);
  const sections: { heading: string; body: string | null }[] = [
    { heading: '交付摘要', body: renderSummary(run) },
    { heading: '变更文件', body: renderChangeFiles(run) },
    { heading: '提交', body: renderCommits(run) },
    { heading: '验证', body: renderVerification(run) },
    { heading: '审核', body: renderReview(run) },
    { heading: '反馈修复', body: renderFeedback(run) },
    { heading: '运行时间线', body: renderTimeline(run) },
    { heading: '未完成与阻塞', body: renderBlocked(run) },
  ];
  for (const section of sections) {
    if (section.body && section.body.trim().length > 0) parts.push(`## ${section.heading}\n\n${section.body}`);
  }
  parts.push('本文件由 GitLab issue 自动化生成，不随提交。');
  return `${parts.join('\n\n')}\n`;
}

const readExcludeFile = async (excludePath: string, fsImpl: RecordFileSystem): Promise<string> => {
  try {
    return await fsImpl.readFile(excludePath, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return '';
    throw error;
  }
};

const ensureExcludeEntry = async (excludePath: string, fsImpl: RecordFileSystem): Promise<void> => {
  const existing = await readExcludeFile(excludePath, fsImpl);
  const hasEntry = existing.split('\n').some((line) => line.trim() === EXCLUDE_ENTRY);
  if (hasEntry) return;
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  await fsImpl.writeFile(excludePath, `${existing}${separator}${EXCLUDE_ENTRY}\n`, 'utf8');
};

export async function writeRunRecord(input: WriteRunRecordInput): Promise<{ path: string; written: boolean }> {
  const fsImpl = input.fsImpl ?? fs;
  const content = renderRunRecord(input.run);
  const location = recordLocationFor({
    checkoutPath: input.checkoutPath,
    projectPath: input.run.projectPath ?? '',
    iid: input.run.iid,
  });
  let target = location.fallback;
  if (isString(input.excludePath) && input.excludePath.length > 0) {
    try {
      await ensureExcludeEntry(input.excludePath, fsImpl);
      target = location.primary;
    } catch {
      target = location.fallback;
    }
  }
  await fsImpl.mkdir(path.dirname(target), { recursive: true });
  const current = await fsImpl.readFile(target, 'utf8').catch(() => null);
  if (current === content) return { path: target, written: false };
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsImpl.writeFile(temporary, content, 'utf8');
  await fsImpl.rename(temporary, target);
  return { path: target, written: true };
}
