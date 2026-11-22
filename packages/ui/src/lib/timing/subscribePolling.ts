export const subscribePolling = (read: () => void, intervalMs: number): () => void => {
  const timer = setInterval(read, intervalMs);
  return () => clearInterval(timer);
};
