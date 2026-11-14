/**
 * Prompt enhancement: rewrite a composer draft into a clearer prompt.
 *
 * This half owns output normalization and the reference guard. The transport
 * half is added in Task 4b.
 */

export type PromptEnhancementErrorCode =
  | 'empty-output'
  | 'too-long'
  | 'references-changed'
  | 'model-unavailable'
  | 'timeout'
  | 'aborted';

export class PromptEnhancementError extends Error {
  readonly code: PromptEnhancementErrorCode;

  constructor(code: PromptEnhancementErrorCode, message: string) {
    super(message);
    this.name = 'PromptEnhancementError';
    this.code = code;
  }
}

const countFences = (text: string): number => (text.match(/```/g) ?? []).length;

/** Trims the reply and removes one outer Markdown fence when the model wrapped the whole answer. */
export const normalizePromptEnhancement = (raw: string): string => {
  let text = raw.trim();
  const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fenced) text = fenced[1].trim();
  return text;
};

/** Tokens the rewrite must carry through unchanged. */
export const extractProtectedFragments = (
  draft: string,
  attachmentFilenames: readonly string[],
): string[] => {
  const fragments = new Set<string>();
  for (const match of draft.matchAll(/(?:^|\s)(@[^\s]+|\$[A-Za-z_][\w-]*|#[^\s]+)/g)) {
    if (match[1]) fragments.add(match[1]);
  }
  for (const match of draft.matchAll(/https?:\/\/[^\s)]+/g)) {
    fragments.add(match[0]);
  }
  for (const filename of attachmentFilenames) {
    fragments.add(`[${filename}]`);
  }
  return [...fragments];
};

export type PromptEnhancementOutput = {
  text: string;
  changed: boolean;
};

export const validatePromptEnhancementOutput = (
  draft: string,
  attachmentFilenames: readonly string[],
  raw: string,
): PromptEnhancementOutput => {
  const text = normalizePromptEnhancement(raw);
  if (!text) {
    throw new PromptEnhancementError('empty-output', 'The model returned no text');
  }
  const original = draft.trim();
  if (text === original) {
    return { text: draft, changed: false };
  }
  if (text.length > original.length * 3 && text.length > 1500) {
    throw new PromptEnhancementError('too-long', 'The enhanced prompt grew too far');
  }
  if (countFences(text) < countFences(draft)) {
    throw new PromptEnhancementError('references-changed', 'A code block was removed');
  }
  const missing = extractProtectedFragments(draft, attachmentFilenames)
    .filter((fragment) => !text.includes(fragment));
  if (missing.length > 0) {
    throw new PromptEnhancementError('references-changed', `Missing references: ${missing.join(', ')}`);
  }
  return { text, changed: true };
};
