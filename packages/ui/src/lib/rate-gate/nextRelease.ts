import type { RateGateAccount } from './status';

export const nextReleaseAt = (accounts: readonly RateGateAccount[], now: number): number | null => {
  let next: number | null = null;
  for (const account of accounts) {
    if (account.remaining >= account.limit) continue;
    const at = account.limitedUntil !== null && account.limitedUntil > now
      ? account.limitedUntil
      : account.resetAt;
    if (at <= now) continue;
    if (next === null || at < next) next = at;
  }
  return next;
};
