/**
 * Deleting one automation session from the archive.
 *
 * The ledger keeps its record, so the row stays and says the session is gone;
 * this only removes the session on this machine, and the worktree the run
 * worked in once no session of that run needs it any more.
 */
import type { WorktreeMetadata } from '@/types/worktree';

import { worktreeFreedBy, type Run } from './runModel';

export type AutomationRemovalDeps = {
  setSessionDirectory: (sessionId: string, directory: string | null) => void;
  deleteSessions: (ids: string[]) => Promise<{ deletedIds: string[] }>;
  removeWorktree: (project: { id: string; path: string }, worktree: WorktreeMetadata) => Promise<void>;
};

export type AutomationRemoval = {
  deleted: boolean;
  /**
   * `unused` when no worktree had to go (it is still shared, or there is none),
   * `removed` when it went, `failed` when its removal threw after the deletion.
   */
  worktree: 'removed' | 'failed' | 'unused';
};

export const removeAutomationSession = async (
  input: {
    run: Run;
    sessionId: string;
    project: { id: string; path: string } | null;
    runs: readonly Run[];
    /** Every session already gone, this one included. */
    removedSessionIds: ReadonlySet<string>;
  },
  deps: AutomationRemovalDeps,
): Promise<AutomationRemoval> => {
  const { run, project } = input;
  const directory = run.worktreePath ?? project?.path ?? null;
  // An automation session never reached this client's session list, so its
  // folder has to be registered first; otherwise the deletion would be answered
  // in whichever folder happens to be open.
  if (directory) deps.setSessionDirectory(input.sessionId, directory);

  const deleted = await deps.deleteSessions([input.sessionId]);
  if (deleted.deletedIds.length === 0) return { deleted: false, worktree: 'unused' };

  if (!run.worktreePath || !project) return { deleted: true, worktree: 'unused' };
  if (!worktreeFreedBy(run, input.runs, input.removedSessionIds)) return { deleted: true, worktree: 'unused' };

  try {
    await deps.removeWorktree(project, {
      path: run.worktreePath,
      projectDirectory: project.path,
      branch: run.branch ?? '',
      label: run.branch ?? run.worktreePath,
    });
    return { deleted: true, worktree: 'removed' };
  } catch {
    return { deleted: true, worktree: 'failed' };
  }
};
