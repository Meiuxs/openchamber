import fs from 'node:fs/promises';
import path from 'node:path';
import { isPlainObject, isRecord, isString } from '../shared/guards.js';
import type { EvidenceResult, Finding } from './prompts.js';

export interface RunEvent {
  at?: string | null | undefined;
  kind?: string | null | undefined;
  from?: string | null | undefined;
  to?: string | null | undefined;
  reason?: string | null | undefined;
  detail?: string | null | undefined;
  phase?: string | null | undefined;
}

export interface RunSession {
  sessionId?: string | null | undefined;
  stage?: string | null | undefined;
  at?: string | null | undefined;
}

export interface NoteWatermarks {
  issue?: number | null | undefined;
  mergeRequest?: number | null | undefined;
}

export interface RunFeedbackItem {
  channel?: string | null | undefined;
  noteId?: number | null | undefined;
  userId?: number | null | undefined;
  author?: string | null | undefined;
  text?: string | null | undefined;
}

export interface RunEntry {
  origin: string;
  projectEntryId?: string | null | undefined;
  projectId: string | number;
  iid: number;
  projectPath?: string | null | undefined;
  title?: string | null | undefined;
  kind?: string | null | undefined;
  phase: string;
  targetBranch?: string | null | undefined;
  branch?: string | null | undefined;
  actorUserId?: number | null | undefined;
  actorAccountId?: string | null | undefined;
  sessionId?: string | null | undefined;
  sessions?: RunSession[] | undefined;
  worktreePath?: string | null | undefined;
  mrIid?: number | null | undefined;
  attempts?: number | undefined;
  leaseUntil?: string | null | undefined;
  since?: string | null | undefined;
  updatedAt?: string | null | undefined;
  lastError?: string | null | undefined;
  blockedReason?: string | null | undefined;
  blockedFrom?: string | null | undefined;
  triageVerdict?: string | null | undefined;
  triageNoteId?: number | null | undefined;
  outcome?: string | null | undefined;
  approvalNoteId?: number | null | undefined;
  planNoteId?: number | null | undefined;
  evidenceNoteId?: number | null | undefined;
  evidence?: EvidenceResult | null | undefined;
  reviewRounds?: number | undefined;
  reviewNoteId?: number | null | undefined;
  reviewVerdict?: string | null | undefined;
  reviewFindings?: Finding[] | null | undefined;
  feedbackRounds?: number | undefined;
  lastFeedbackActor?: number | null | undefined;
  feedbackItems?: RunFeedbackItem[] | null | undefined;
  noteWatermarks?: NoteWatermarks | null | undefined;
  events?: RunEvent[] | undefined;
}

interface LedgerState {
  version: number;
  runs: Record<string, RunEntry>;
}

type LedgerFileSystem = Pick<typeof fs, 'readFile' | 'rename' | 'mkdir' | 'writeFile'>;

export interface GitlabIssueLedgerOptions {
  filePath?: string | undefined;
  now?: (() => number) | undefined;
  fsImpl?: LedgerFileSystem | undefined;
}

export interface GitlabIssueLedger {
  list(): Promise<RunEntry[]>;
  get(key: string): Promise<RunEntry | null>;
  put(entry: RunEntry): Promise<RunEntry>;
  update(key: string, patch: Partial<RunEntry>): Promise<RunEntry>;
  remove(key: string): Promise<void>;
  close(): Promise<void>;
}


const VERSION = 1;
const DONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const ledgerKey = (origin: string, projectId: string | number, iid: number) => `${origin}|${projectId}|${iid}`;

const hasCode = (error: unknown): error is { code?: string | undefined } => isRecord(error) && 'code' in error;

export function createGitlabIssueLedger({ filePath, now = Date.now, fsImpl = fs }: GitlabIssueLedgerOptions = {}): GitlabIssueLedger {
  if (!filePath) throw new Error('GitLab issue ledger path is required');
  let cache: LedgerState | null = null;
  let writeChain: Promise<void> = Promise.resolve();

  const load = async (): Promise<LedgerState> => {
    if (cache) return cache;
    let raw = '';
    try {
      raw = await fsImpl.readFile(filePath, 'utf8');
    } catch (error) {
      if (!hasCode(error) || error.code !== 'ENOENT') throw error;
      cache = { version: VERSION, runs: {} };
      return cache;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed) || !isPlainObject(parsed.runs)) throw new Error('invalid shape');
      // SAFETY: entries are written only by this module and the outer shape was just validated.
      const runs = Object.assign({} as Record<string, RunEntry>, parsed.runs);
      cache = { version: VERSION, runs };
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
      if (entry?.phase === 'done' && isString(entry.updatedAt) && Number.isFinite(Date.parse(entry.updatedAt)) && Date.parse(entry.updatedAt) < cutoff) {
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

  const schedule = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const next = writeChain.then(() => operation(), () => operation());
    writeChain = next.then(() => {}, () => {});
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
        const next: RunEntry = { ...entry, updatedAt };
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
        const next: RunEntry = { ...current, ...patch, updatedAt: new Date(now()).toISOString() };
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
