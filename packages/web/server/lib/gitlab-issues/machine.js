export const PHASES = Object.freeze({
  CLAIMED: 'claimed',
  PLANNING: 'planning',
  WAITING_APPROVAL: 'waiting-approval',
  PREPARING: 'preparing',
  IMPLEMENTING: 'implementing',
  VERIFYING: 'verifying',
  MR_OPEN: 'mr-open',
  BLOCKED: 'blocked',
  DONE: 'done',
});

export const BLOCKED_REASONS = Object.freeze({
  INVALID_TEMPLATE: 'invalid-template',
  MISSING_CREDENTIAL: 'missing-credential',
  BRANCH_MISSING: 'branch-missing',
  REJECTED: 'rejected',
  VERIFICATION_FAILED: 'verification-failed',
  REPEATED_ERROR: 'repeated-error',
  CANCELLED: 'cancelled',
  MR_CLOSED: 'mr-closed',
  TIMEOUT: 'timeout',
});

const TRANSITIONS = Object.freeze({
  [PHASES.CLAIMED]: [PHASES.PLANNING, PHASES.PREPARING, PHASES.BLOCKED],
  [PHASES.PLANNING]: [PHASES.WAITING_APPROVAL, PHASES.BLOCKED],
  [PHASES.WAITING_APPROVAL]: [PHASES.PREPARING, PHASES.BLOCKED],
  [PHASES.PREPARING]: [PHASES.IMPLEMENTING, PHASES.BLOCKED],
  [PHASES.IMPLEMENTING]: [PHASES.VERIFYING, PHASES.BLOCKED],
  [PHASES.VERIFYING]: [PHASES.MR_OPEN, PHASES.BLOCKED],
  [PHASES.MR_OPEN]: [PHASES.DONE, PHASES.BLOCKED],
  [PHASES.BLOCKED]: [PHASES.CLAIMED],
  [PHASES.DONE]: [],
});

const ACTIVE_PHASES = Object.freeze(Object.keys(TRANSITIONS)
  .filter((phase) => phase !== PHASES.BLOCKED && phase !== PHASES.DONE));

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
