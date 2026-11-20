export const parseModelRef = (value: string): { providerID: string; id: string } | null => {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
};
