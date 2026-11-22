export const scheduleAt = (at: number, run: () => void): (() => void) => {
  const timer = setTimeout(run, Math.max(0, at - Date.now()));
  return () => clearTimeout(timer);
};
