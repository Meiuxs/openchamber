/**
 * What one GitLab automation run is and how its ledger answer is shaped.
 *
 * Shared by the runs page and by the board's per-item status, so both read the
 * server's ledger the same way: a run is identified by `key` and by the issue
 * `iid` it belongs to; a change request it opened carries `mrIid`.
 */
import { z } from 'zod';

import type { I18nKey } from '@/lib/i18n';

export const POLL_INTERVAL_MS = 10_000;

// The order is the ledger's phase order; `blocked` stands outside it.
const PHASES = [
  'claimed', 'triaging', 'planning', 'waiting-approval', 'preparing',
  'implementing', 'reviewing', 'verifying', 'mr-open', 'addressing', 'done',
] as const;

export type Phase = typeof PHASES[number] | 'blocked';

export const phaseLabelKey = (phase: Phase): I18nKey => {
  // SAFETY: every phase has a `gitlabRuns.phase.*` entry in the i18n dictionaries.
  return `gitlabRuns.phase.${phase}` as I18nKey;
};

/**
 * `addressing` is the comment-driven fix loop off `mr-open`, not a stop of its
 * own: the rail keeps its fixed stops, so a run in the loop is drawn at the
 * stop it looped from, and so are its sessions.
 */
export const railStopOf = (stage: string | null | undefined): string | null => (
  stage === 'addressing' ? 'mr-open' : (stage ?? null)
);

/** `HH:MM` of a recorded time; empty when the record predates the clock. */
export const clockOf = (iso: string | null): string => {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

/**
 * Every session the run opened, oldest first, with each stage drawn at its
 * rail stop (`addressing` hangs off `mr-open`). A ledger written before the
 * run kept its sessions has none, but the session still open belongs to the
 * stop the run is in, so that one is not lost. Shared by the full step view
 * and the compact trail on a folded card.
 */
export const sessionTrailOf = (run: Run): RunSession[] => {
  if (run.sessions.length > 0) {
    return run.sessions.map((session) => ({ ...session, stage: railStopOf(session.stage) }));
  }
  if (run.sessionId) {
    const stage = railStopOf(run.phase === 'blocked' ? run.blockedFrom : run.phase);
    // SAFETY: `stage` came from `run.phase`/`blockedFrom`, which the ledger
    // only fills with a phase name; the rail lists every phase.
    if (stage && stage !== 'done' && railOf(run).includes(stage as Phase)) {
      return [{ sessionId: run.sessionId, stage, at: run.since }];
    }
  }
  return [];
};

const GUIDE_KEYS = {
  'waiting-approval': true,
  'missing-credential': true,
  rejected: true,
  'review-rejected': true,
  'branch-missing': true,
  'invalid-template': true,
  timeout: true,
  cancelled: true,
  'verification-failed': true,
  'repeated-error': true,
  'mr-closed': true,
  'label-events-unavailable': true,
  'session-failed': true,
  'notes-limit': true,
  'worktree-missing': true,
  'feedback-limit': true,
  'insufficient-info': true,
  'not-an-issue': true,
} satisfies Record<string, true>;

export const guideKey = (reason: string | null): I18nKey => {
  if (!reason || !(reason in GUIDE_KEYS)) {
    // SAFETY: the fallback key exists in the dictionaries for any other reason.
    return 'gitlabRuns.guide.repeated-error' as I18nKey;
  }
  // SAFETY: `reason` is narrowed to a key of GUIDE_KEYS, and each key has a
  // `gitlabRuns.guide.*` entry in the i18n dictionaries.
  return `gitlabRuns.guide.${reason}` as I18nKey;
};

/**
 * One entry of a run's own history. `phase` entries move the step line; the
 * rest explain a stop or a slow stage and hang off the phase they happened in.
 *
 * `at` is optional because it is only what the line shows: a ledger written
 * before every event carried one must still list, and an entry without a
 * timestamp is not a reason to fail the whole answer.
 */
export const runEventSchema = z.object({
  at: z.string().nullish().transform((value) => value ?? null),
  kind: z.enum(['phase', 'blocked', 'session']),
  from: z.string().nullish(),
  to: z.string().nullish(),
  phase: z.string().nullish(),
  reason: z.string().nullish(),
  detail: z.string().nullish(),
});

/** The issue's own state, read from GitLab; null when it could not be read. */
const issueStateSchema = z.object({
  state: z.enum(['opened', 'closed']).nullable(),
  labels: z.array(z.string()),
});

export type RunEvent = z.infer<typeof runEventSchema>;
export type RunIssueState = z.infer<typeof issueStateSchema>;

/**
 * One session a run opened, with the stop it served: `stage` is the phase it
 * worked in (`implementing` for the fix, `reviewing` for a review round) and
 * `at` is when it started. The id is what a click opens.
 */
const runSessionSchema = z.object({
  sessionId: z.string(),
  stage: z.string().nullable(),
  at: z.string().nullable(),
});

type RunSession = z.infer<typeof runSessionSchema>;

const runSchema = z.object({
  key: z.string(),
  origin: z.string(),
  // The settings entry that claimed the run: two entries may name one GitLab
  // project, and a global view needs this to find the directory for an action.
  // Optional so a server older than this field still lists.
  projectEntryId: z.string().nullish(),
  iid: z.number(),
  title: z.string().nullable(),
  kind: z.enum(['bug', 'feature']).nullable(),
  phase: z.string(),
  blockedReason: z.string().nullable(),
  blockedFrom: z.string().nullable(),
  lastError: z.string().nullable(),
  branch: z.string().nullable(),
  targetBranch: z.string().nullable(),
  mrIid: z.number().nullable(),
  issueUrl: z.string().nullable(),
  mrUrl: z.string().nullable(),
  attempts: z.number(),
  reviewRounds: z.number(),
  // Comment-driven fix rounds on an open MR. Optional-read so a server older
  // than the field still lists.
  feedbackRounds: z.number().nullish().transform((value) => value ?? 0),
  reviewVerdict: z.enum(['approve', 'request-changes']).nullable(),
  // The first-pass verdict. Optional so a server older than the field lists.
  triageVerdict: z.enum(['valid', 'not-an-issue', 'insufficient-info']).nullish()
    .transform((value) => value ?? null),
  // Why a run ended without a merge request. Optional for the same reason.
  outcome: z.enum(['not-an-issue']).nullish().transform((value) => value ?? null),
  since: z.string().nullable(),
  updatedAt: z.string().nullable(),
  sessionId: z.string().nullable(),
  sessionStatus: z.enum(['busy', 'idle']).nullable(),
  // The sessions behind each stop, oldest first. Optional so a server older
  // than this field still lists; `sessionId` covers the running one then.
  sessions: z.array(runSessionSchema).nullish().transform((value) => value ?? []),
  // Optional so a server older than these fields still lists.
  events: z.array(runEventSchema).nullish().transform((value) => value ?? []),
  issueState: issueStateSchema.nullish(),
});

export const runsResponseSchema = z.object({
  runs: z.array(runSchema),
  bot: z.object({
    status: z.enum(['valid', 'invalid', 'missing']),
    accountId: z.string().nullable(),
  }).optional(),
});

export type Run = z.infer<typeof runSchema>;

/** The stops a run passes through, per issue kind. */
export const railOf = (run: Run): Phase[] => (run.kind === 'feature'
  ? ['claimed', 'preparing', 'triaging', 'planning', 'waiting-approval', 'implementing', 'reviewing', 'verifying', 'mr-open']
  : ['claimed', 'preparing', 'triaging', 'implementing', 'reviewing', 'verifying', 'mr-open']);

export const formatAge = (iso: string | null): string | null => {
  if (!iso) return null;
  const elapsed = Date.now() - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return null;
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(0, 'minute');
  if (minutes < 60) return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-hours, 'hour');
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-Math.round(hours / 24), 'day');
};

/** A run that has not reached its end: the only kind the board's status shows. */
export const isActiveRun = (run: Run): boolean => run.phase !== 'done';

/** What a person may do to a run; the server answers what each one means. */
export type RunAction = 'cancel' | 'reset' | 'approve' | 'reject' | 'take';

/** Whether the action is cast by a comment command or by moving labels. */
export const runActionKind = (action: RunAction): 'comment' | 'labels' => (
  action === 'cancel' || action === 'reset' ? 'labels' : 'comment'
);

/**
 * The literal first line a comment action posts to the issue, so the confirm
 * dialog can show the words instead of only describing the move. Mirrors the
 * server's command table.
 */
export const runActionCommand = (action: RunAction): string => (
  action === 'approve' ? '/ai-approve'
    : action === 'reject' ? '/ai-reject'
      : action === 'take' ? '/ai-take'
        : ''
);
