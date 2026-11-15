/**
 * Whether reading the ledger again could change anything.
 *
 * The runs page polls whenever it is open. The board's per-item row only polls
 * while the run it shows is still moving: an empty answer or a finished one
 * stays put until the person refreshes or returns to the tab.
 */
export const shouldPollRuns = (
  runs: readonly { phase: string }[] | null,
  whileActiveOnly: boolean,
): boolean => !whileActiveOnly || (runs ?? []).some((run) => run.phase !== 'done');
