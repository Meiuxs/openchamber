/**
 * Splitting a `provider/model` reference, shared by every automation that
 * opens a session with an explicit model.
 *
 * The model id may itself hold slashes: the magpie provider's
 * `magpie/workbuddy-ai/glm-5.3-flash` is the model `workbuddy-ai/glm-5.3-flash`,
 * and splitting on the last slash instead of the first asked the provider for a
 * model it does not have. The variant is a separate setting, never part of the
 * string.
 */
export const parseModelRef = (value) => {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
};
