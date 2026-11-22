/**
 * The files a run changed, read from its sessions' message history.
 *
 * The ledger records which sessions a run opened but not what they edited, so
 * the diff comes from the file-change tool calls in each session. Automation
 * sessions are hidden from the normal session list but message.list still
 * answers by ID, with the run's worktree as the directory.
 */
import * as React from 'react';

import { opencodeClient } from '@/lib/opencode/client';
import { getPrimaryToolPath } from '@/components/chat/message/parts/toolDiffUtils';
import {
  isFileChangeTool,
  isWriteTool,
  toolFileDiffs,
  type ToolFileDiff,
} from '@/lib/opencode/tools';
import type { Metadata, Part } from '@/lib/opencode/model';

import { sessionTrailOf, type Run } from './runModel';

export type ChangedFile = {
  path: string;
  status: 'added' | 'modified';
  added: number | null;
  removed: number | null;
  /** The last session whose tool call touched this path, for opening its diff. */
  sessionId: string;
};

const readStats = (input: Record<string, unknown> | undefined, metadata: Metadata | undefined, isWrite: boolean): { added: number | null; removed: number | null } => {
  const files: ToolFileDiff[] = toolFileDiffs(metadata);
  if (files.length > 0) {
    const withCounts = files.filter((file) => file.additions !== undefined && file.deletions !== undefined);
    if (withCounts.length === files.length) {
      return {
        added: withCounts.reduce((sum, file) => sum + (file.additions ?? 0), 0),
        removed: withCounts.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      };
    }
  }
  const patch = metadata?.patch ?? metadata?.diff;
  if (typeof patch !== 'string') {
    if (isWrite && typeof input?.content === 'string') {
      const lines = input.content.split('\n').length;
      return { added: lines, removed: 0 };
    }
    return { added: null, removed: null };
  }
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed };
};

const collectFiles = (parts: readonly Part[], sessionId: string, into: Map<string, ChangedFile>): void => {
  for (const part of parts) {
    if (part.type !== 'tool' || !isFileChangeTool(part.tool)) continue;
    const state = part.state;
    if (state.status !== 'completed') continue;
    const input = state.input as Record<string, unknown> | undefined;
    const metadata = state.metadata;
    const files = toolFileDiffs(metadata);
    const paths = files.length > 0
      ? files.map((file) => file.file)
      : [getPrimaryToolPath(part.tool, input, metadata)];
    for (const path of paths) {
      if (!path) continue;
      const isWrite = isWriteTool(part.tool);
      const status: ChangedFile['status'] = isWrite && !into.has(path) ? 'added' : 'modified';
      const stats = readStats(input, metadata, isWrite);
      const previous = into.get(path);
      into.set(path, {
        path,
        status: previous?.status ?? status,
        added: (previous?.added ?? 0) + (stats.added ?? 0),
        removed: (previous?.removed ?? 0) + (stats.removed ?? 0),
        sessionId,
      });
    }
  }
};

export const useRunFiles = (run: Run | null): { files: ChangedFile[]; loading: boolean } => {
  const [files, setFiles] = React.useState<ChangedFile[]>([]);
  const [loading, setLoading] = React.useState(false);
  const key = run?.key ?? null;

  React.useEffect(() => {
    if (!run) {
      setFiles([]);
      setLoading(false);
      return;
    }
    const currentRun = run;
    const directory = currentRun.worktreePath;
    let active = true;
    setFiles([]);
    setLoading(true);
    const collected = new Map<string, ChangedFile>();
    const sessions = sessionTrailOf(currentRun).map((session) => session.sessionId);
    void (async () => {
      for (const sessionId of sessions) {
        try {
          const page = await opencodeClient.getSessionMessages(sessionId, { limit: 100 }, directory);
          if (!active) return;
          for (const item of page.items) collectFiles(item.parts, sessionId, collected);
        } catch {
          // One unreadable session must not erase the files the others found.
        }
      }
      if (active) {
        setFiles([...collected.values()].sort((a, b) => a.path.localeCompare(b.path)));
        setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [key, run]);

  return { files, loading };
};
