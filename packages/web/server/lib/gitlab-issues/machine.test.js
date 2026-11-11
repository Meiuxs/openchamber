import { describe, expect, it } from 'vitest';
import {
  BLOCKED_REASONS, PHASES, PhaseError, assertTransition, canTransition, isActivePhase,
} from './machine.js';

describe('GitLab issue phase machine', () => {
  it('allows every declared transition', () => {
    expect(canTransition(PHASES.CLAIMED, PHASES.PLANNING)).toBe(true);
    expect(canTransition(PHASES.CLAIMED, PHASES.PREPARING)).toBe(true);
    expect(canTransition(PHASES.PLANNING, PHASES.WAITING_APPROVAL)).toBe(true);
    expect(canTransition(PHASES.WAITING_APPROVAL, PHASES.PREPARING)).toBe(true);
    expect(canTransition(PHASES.PREPARING, PHASES.IMPLEMENTING)).toBe(true);
    expect(canTransition(PHASES.IMPLEMENTING, PHASES.VERIFYING)).toBe(true);
    expect(canTransition(PHASES.VERIFYING, PHASES.MR_OPEN)).toBe(true);
    expect(canTransition(PHASES.MR_OPEN, PHASES.DONE)).toBe(true);
    expect(canTransition(PHASES.BLOCKED, PHASES.CLAIMED)).toBe(true);
    for (const phase of Object.values(PHASES)) {
      if (phase !== PHASES.DONE && phase !== PHASES.BLOCKED) {
        expect(canTransition(phase, PHASES.BLOCKED)).toBe(true);
      }
    }
  });

  it('refuses every transition the spec does not declare', () => {
    expect(canTransition(PHASES.CLAIMED, PHASES.IMPLEMENTING)).toBe(false);
    expect(canTransition(PHASES.PLANNING, PHASES.PREPARING)).toBe(false);
    expect(canTransition(PHASES.WAITING_APPROVAL, PHASES.DONE)).toBe(false);
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
      'branch-missing', 'cancelled', 'invalid-template', 'missing-credential',
      'mr-closed', 'rejected', 'repeated-error', 'timeout', 'verification-failed',
    ]);
  });
});
