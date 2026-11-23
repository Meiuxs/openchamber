export const PHASES = Object.freeze({
  CLAIMED: 'claimed',
  TRIAGING: 'triaging',
  PLANNING: 'planning',
  WAITING_APPROVAL: 'waiting-approval',
  PREPARING: 'preparing',
  IMPLEMENTING: 'implementing',
  REVIEWING: 'reviewing',
  RECHECKING: 'rechecking',
  VERIFYING: 'verifying',
  MR_OPEN: 'mr-open',
  ADDRESSING: 'addressing',
  BLOCKED: 'blocked',
  DONE: 'done',
});

export const BLOCKED_REASONS = Object.freeze({
  INVALID_TEMPLATE: 'invalid-template',
  MISSING_CREDENTIAL: 'missing-credential',
  BRANCH_MISSING: 'branch-missing',
  REJECTED: 'rejected',
  VERIFICATION_FAILED: 'verification-failed',
  SESSION_FAILED: 'session-failed',
  REPEATED_ERROR: 'repeated-error',
  CANCELLED: 'cancelled',
  MR_CLOSED: 'mr-closed',
  TIMEOUT: 'timeout',
  REVIEW_REJECTED: 'review-rejected',
  LABEL_EVENTS_UNAVAILABLE: 'label-events-unavailable',
  NOTES_LIMIT: 'notes-limit',
  WORKTREE_MISSING: 'worktree-missing',
  FEEDBACK_LIMIT: 'feedback-limit',
  INSUFFICIENT_INFO: 'insufficient-info',
  NOT_AN_ISSUE: 'not-an-issue',
  RECORD_WRITE_FAILED: 'record-write-failed',
});

const TRANSITIONS = Object.freeze({
  [PHASES.CLAIMED]: [PHASES.PREPARING, PHASES.BLOCKED],
  [PHASES.TRIAGING]: [
    PHASES.PLANNING, PHASES.IMPLEMENTING, PHASES.DONE, PHASES.BLOCKED,
  ],
  [PHASES.PLANNING]: [PHASES.WAITING_APPROVAL, PHASES.BLOCKED],
  [PHASES.WAITING_APPROVAL]: [PHASES.IMPLEMENTING, PHASES.BLOCKED],
  [PHASES.PREPARING]: [PHASES.TRIAGING, PHASES.BLOCKED],
  [PHASES.IMPLEMENTING]: [PHASES.REVIEWING, PHASES.BLOCKED],
  [PHASES.REVIEWING]: [PHASES.IMPLEMENTING, PHASES.RECHECKING, PHASES.VERIFYING, PHASES.BLOCKED],
  // The recheck session only decides whether an approval stands; its own
  // request-changes feeds the normal revision loop.
  [PHASES.RECHECKING]: [PHASES.VERIFYING, PHASES.IMPLEMENTING, PHASES.BLOCKED],
  [PHASES.VERIFYING]: [PHASES.MR_OPEN, PHASES.BLOCKED],
  [PHASES.MR_OPEN]: [PHASES.ADDRESSING, PHASES.DONE, PHASES.BLOCKED],
  [PHASES.ADDRESSING]: [PHASES.REVIEWING, PHASES.BLOCKED],
  // A blocked run may retry verifying in place: the delivery-record gate keeps
  // the worktree, so a successful write resumes the push without a reclaim.
  [PHASES.BLOCKED]: [PHASES.CLAIMED, PHASES.VERIFYING],
  [PHASES.DONE]: [],
});

const ACTIVE_PHASES = Object.freeze(Object.keys(TRANSITIONS)
  .filter((phase) => phase !== PHASES.BLOCKED && phase !== PHASES.DONE));

export const ACTIVE_PHASE_SET = Object.freeze(new Set(ACTIVE_PHASES));

export class PhaseError extends Error {
  from: string;
  to: string;

  constructor(from: string, to: string) {
    super(`Illegal GitLab issue phase transition: ${from} -> ${to}`);
    this.name = 'PhaseError';
    this.from = from;
    this.to = to;
  }
}

const transitionTable: Record<string, string[]> = TRANSITIONS;

export const canTransition = (from: string, to: string): boolean => (transitionTable[from] ?? []).includes(to);

export const assertTransition = (from: string, to: string): string => {
  if (!canTransition(from, to)) throw new PhaseError(from, to);
  return to;
};

export const isActivePhase = (phase: string): boolean => ACTIVE_PHASES.includes(phase);
