export const PHASES = Object.freeze({
  CLAIMED: 'claimed',
  // A read-only pass that decides whether the report describes a real problem
  // at all. It runs before the plan and the implementation, on the same
  // worktree, so a report that contradicts the code never produces a branch.
  TRIAGING: 'triaging',
  PLANNING: 'planning',
  WAITING_APPROVAL: 'waiting-approval',
  PREPARING: 'preparing',
  IMPLEMENTING: 'implementing',
  REVIEWING: 'reviewing',
  VERIFYING: 'verifying',
  MR_OPEN: 'mr-open',
  // A reviewer's comment on the open MR or the issue sent the run back to fix
  // things: it holds a session like implementing does, but it starts from and
  // returns to `mr-open`, so it is a loop off that stop rather than a rail one.
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
  // The comment history of the issue or the MR exceeds what the feedback scan
  // reads, so the run cannot tell whether a new trigger is in there. A human
  // decides what happens to the branch.
  NOTES_LIMIT: 'notes-limit',
  // The mr-open worktree is gone when a feedback round needs it. Rebuilding it
  // from the pushed branch would fabricate a state nobody reviewed, so the run
  // stops for a human reset instead.
  WORKTREE_MISSING: 'worktree-missing',
  // A run may answer at most FEEDBACK_LIMIT comment rounds after the MR opens;
  // past that a human decides what happens to the branch.
  FEEDBACK_LIMIT: 'feedback-limit',
  // The report cannot be checked against the code: no reproduction steps, no
  // version or environment, or no expected result. That is not the same as a
  // report the code contradicts, so the run stops and waits for the reporter.
  INSUFFICIENT_INFO: 'insufficient-info',
  // The report contradicts the code and the automation wanted to close the
  // issue, but the bot may not edit it. The verdict and its evidence are in the
  // comment; a human closes it.
  NOT_AN_ISSUE: 'not-an-issue',
});

const TRANSITIONS = Object.freeze({
  [PHASES.CLAIMED]: [PHASES.PREPARING, PHASES.BLOCKED],
  // Triage decides where a run goes next, so it reaches both rails and the end.
  [PHASES.TRIAGING]: [
    PHASES.PLANNING, PHASES.IMPLEMENTING, PHASES.DONE, PHASES.BLOCKED,
  ],
  [PHASES.PLANNING]: [PHASES.WAITING_APPROVAL, PHASES.BLOCKED],
  // Approval has already settled what to build, so it starts the implementation
  // directly. Going back through preparing would re-run triage on a plan a
  // human just approved.
  [PHASES.WAITING_APPROVAL]: [PHASES.IMPLEMENTING, PHASES.BLOCKED],
  [PHASES.PREPARING]: [PHASES.TRIAGING, PHASES.BLOCKED],
  [PHASES.IMPLEMENTING]: [PHASES.REVIEWING, PHASES.BLOCKED],
  [PHASES.REVIEWING]: [PHASES.IMPLEMENTING, PHASES.VERIFYING, PHASES.BLOCKED],
  [PHASES.VERIFYING]: [PHASES.MR_OPEN, PHASES.BLOCKED],
  [PHASES.MR_OPEN]: [PHASES.ADDRESSING, PHASES.DONE, PHASES.BLOCKED],
  [PHASES.ADDRESSING]: [PHASES.REVIEWING, PHASES.BLOCKED],
  [PHASES.BLOCKED]: [PHASES.CLAIMED],
  [PHASES.DONE]: [],
});

const ACTIVE_PHASES = Object.freeze(Object.keys(TRANSITIONS)
  .filter((phase) => phase !== PHASES.BLOCKED && phase !== PHASES.DONE));

// The set form for callers that need `has` — routes, UIs, anything that must
// mean exactly "a phase that holds a session" without keeping its own copy of
// the list.
export const ACTIVE_PHASE_SET = Object.freeze(new Set(ACTIVE_PHASES));

export class PhaseError extends Error {
  constructor(from, to) {
    super(`Illegal GitLab issue phase transition: ${from} -> ${to}`);
    this.name = 'PhaseError';
    this.from = from;
    this.to = to;
  }
}

export const canTransition = (from, to) => (TRANSITIONS[from] ?? []).includes(to);

export const assertTransition = (from, to) => {
  if (!canTransition(from, to)) throw new PhaseError(from, to);
  return to;
};

export const isActivePhase = (phase) => ACTIVE_PHASES.includes(phase);
