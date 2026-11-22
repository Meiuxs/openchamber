import { describe, expect, it } from 'vitest';
import {
  BLOCKED_REASONS, PHASES, PhaseError, assertTransition, canTransition, isActivePhase,
} from './machine.js';

describe('GitLab issue phase machine', () => {
  it('allows every declared transition', () => {
    expect(canTransition(PHASES.CLAIMED, PHASES.PREPARING)).toBe(true);
    expect(canTransition(PHASES.PREPARING, PHASES.TRIAGING)).toBe(true);
    // Triage is what decides the rail, and the only phase that ends a run other
    // than a merge.
    expect(canTransition(PHASES.TRIAGING, PHASES.PLANNING)).toBe(true);
    expect(canTransition(PHASES.TRIAGING, PHASES.IMPLEMENTING)).toBe(true);
    expect(canTransition(PHASES.TRIAGING, PHASES.DONE)).toBe(true);
    expect(canTransition(PHASES.PLANNING, PHASES.WAITING_APPROVAL)).toBe(true);
    // An approved plan is settled; another pass through preparing would triage
    // it again.
    expect(canTransition(PHASES.WAITING_APPROVAL, PHASES.IMPLEMENTING)).toBe(true);
    expect(canTransition(PHASES.IMPLEMENTING, PHASES.REVIEWING)).toBe(true);
    expect(canTransition(PHASES.REVIEWING, PHASES.IMPLEMENTING)).toBe(true);
    expect(canTransition(PHASES.REVIEWING, PHASES.VERIFYING)).toBe(true);
    // The recheck is the second opinion on an approval: it pushes or sends the
    // change back, and never runs a first review of its own.
    expect(canTransition(PHASES.REVIEWING, PHASES.RECHECKING)).toBe(true);
    expect(canTransition(PHASES.RECHECKING, PHASES.VERIFYING)).toBe(true);
    expect(canTransition(PHASES.RECHECKING, PHASES.IMPLEMENTING)).toBe(true);
    expect(canTransition(PHASES.VERIFYING, PHASES.MR_OPEN)).toBe(true);
    expect(canTransition(PHASES.MR_OPEN, PHASES.DONE)).toBe(true);
    expect(canTransition(PHASES.MR_OPEN, PHASES.ADDRESSING)).toBe(true);
    expect(canTransition(PHASES.ADDRESSING, PHASES.REVIEWING)).toBe(true);
    expect(canTransition(PHASES.BLOCKED, PHASES.CLAIMED)).toBe(true);
    for (const phase of Object.values(PHASES)) {
      if (phase !== PHASES.DONE && phase !== PHASES.BLOCKED) {
        expect(canTransition(phase, PHASES.BLOCKED)).toBe(true);
      }
    }
  });

  it('refuses every transition the spec does not declare', () => {
    expect(canTransition(PHASES.CLAIMED, PHASES.IMPLEMENTING)).toBe(false);
    // Both kinds go through triage, so neither rail skips it from claim.
    expect(canTransition(PHASES.CLAIMED, PHASES.PLANNING)).toBe(false);
    expect(canTransition(PHASES.CLAIMED, PHASES.TRIAGING)).toBe(false);
    expect(canTransition(PHASES.TRIAGING, PHASES.PREPARING)).toBe(false);
    expect(canTransition(PHASES.TRIAGING, PHASES.WAITING_APPROVAL)).toBe(false);
    expect(canTransition(PHASES.TRIAGING, PHASES.VERIFYING)).toBe(false);
    expect(canTransition(PHASES.PLANNING, PHASES.PREPARING)).toBe(false);
    expect(canTransition(PHASES.WAITING_APPROVAL, PHASES.PREPARING)).toBe(false);
    expect(canTransition(PHASES.WAITING_APPROVAL, PHASES.DONE)).toBe(false);
    // The push is only reachable through the review gate.
    expect(canTransition(PHASES.IMPLEMENTING, PHASES.VERIFYING)).toBe(false);
    expect(canTransition(PHASES.REVIEWING, PHASES.DONE)).toBe(false);
    expect(canTransition(PHASES.REVIEWING, PHASES.CLAIMED)).toBe(false);
    expect(canTransition(PHASES.RECHECKING, PHASES.REVIEWING)).toBe(false);
    expect(canTransition(PHASES.RECHECKING, PHASES.MR_OPEN)).toBe(false);
    // A feedback round returns through the review gate, never straight to the MR.
    expect(canTransition(PHASES.ADDRESSING, PHASES.MR_OPEN)).toBe(false);
    expect(canTransition(PHASES.ADDRESSING, PHASES.IMPLEMENTING)).toBe(false);
    expect(canTransition(PHASES.DONE, PHASES.CLAIMED)).toBe(false);
    expect(canTransition(PHASES.BLOCKED, PHASES.MR_OPEN)).toBe(false);
    expect(() => assertTransition(PHASES.DONE, PHASES.CLAIMED)).toThrow(PhaseError);
  });

  it('treats blocked and done as inactive', () => {
    expect(isActivePhase(PHASES.WAITING_APPROVAL)).toBe(true);
    expect(isActivePhase(PHASES.BLOCKED)).toBe(false);
    expect(isActivePhase(PHASES.DONE)).toBe(false);
  });

  it('lists the blocked reasons the dispatcher may write', () => {
    expect(Object.values(BLOCKED_REASONS).sort()).toEqual([
      'branch-missing', 'cancelled', 'feedback-limit', 'insufficient-info', 'invalid-template',
      'label-events-unavailable', 'missing-credential', 'mr-closed', 'not-an-issue', 'notes-limit',
      'rejected', 'repeated-error', 'review-rejected', 'session-failed', 'timeout',
      'verification-failed', 'worktree-missing',
    ]);
  });
});
