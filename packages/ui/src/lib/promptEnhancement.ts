/**
 * Prompt enhancement: rewrite a composer draft into a clearer prompt.
 *
 * This half owns output normalization and the reference guard. The transport
 * half is added in Task 4b.
 */

import { z } from 'zod';

import { isVSCodeRuntime } from '@/lib/desktop';
import type { MagicPromptSnapshot } from '@/lib/magicPrompts';
import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { requestSmallModel } from '@/lib/smallModelRequest';

export type PromptEnhancementErrorCode =
  | 'empty-output'
  | 'too-long'
  | 'references-changed'
  | 'model-unavailable'
  | 'provider-unavailable'
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
    const citation = `[${filename}]`;
    if (draft.includes(citation)) fragments.add(citation);
  }
  return [...fragments];
};

type PromptEnhancementOutput = {
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

export type PromptEnhancementTransport = 'small-model' | 'opencode';

export type PromptEnhancementResult = PromptEnhancementOutput & {
  transport: PromptEnhancementTransport;
};

export type PromptEnhancementRequest = {
  draft: string;
  prompts: MagicPromptSnapshot;
  directory: string | null;
  providerID: string;
  modelID: string;
  attachmentFilenames: readonly string[];
  signal: AbortSignal;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 20_000;

export const renderPromptEnhancementPrompts = (prompts: MagicPromptSnapshot, draft: string) => ({
  system: prompts.render('session.promptEnhance.visible'),
  prompt: prompts.render('session.promptEnhance.instructions', { draft }),
});

const smallModelResolutionSchema = z.object({
  available: z.boolean(),
  model: z.object({
    providerID: z.string().optional(),
    modelID: z.string().optional(),
  }).nullish(),
});

const smallModelPayloadSchema = z.object({
  text: z.string().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});

type SmallModelResolution = z.infer<typeof smallModelResolutionSchema>;

const readSmallModelResolution = async (
  request: PromptEnhancementRequest,
  signal: AbortSignal,
): Promise<SmallModelResolution | null> => {
  try {
    const query = new URLSearchParams({ providerID: request.providerID, modelID: request.modelID });
    if (request.directory) query.set('directory', request.directory);
    const response = await runtimeFetch(`/api/small-model?${query.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      directory: request.directory,
      cache: 'no-store',
      signal,
    });
    if (!response.ok) return null;
    const parsed = smallModelResolutionSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
};

const requestSmallModelText = async (
  request: PromptEnhancementRequest,
  system: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string> => {
  const response = await requestSmallModel({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system,
      prompt,
      directory: request.directory ?? undefined,
      preferredProviderID: request.providerID,
      preferredModelID: request.modelID,
      maxOutputTokens: 1024,
      restrictToPreferredProvider: true,
    }),
    directory: request.directory,
    signal,
  }, { notifyOnError: false });

  const parsed = smallModelPayloadSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok) {
    const payload = parsed.success ? parsed.data : null;
    // The OpenCode fallback runs the session model on the same provider, so a
    // provider that refused the call fails there too. Retrying would only
    // spend the whole timeout before reporting the same outage.
    if (payload?.code === 'provider-error') {
      throw new PromptEnhancementError(
        'provider-unavailable',
        payload.error || 'The Small Model provider could not be reached',
      );
    }
    const detail = payload?.error ? `: ${payload.error}` : '';
    throw new PromptEnhancementError('model-unavailable', `The Small Model is unavailable${detail}`);
  }
  if (!parsed.success || parsed.data.text === undefined) {
    throw new PromptEnhancementError('empty-output', 'The Small Model returned no text');
  }
  return parsed.data.text;
};

const generateInOpenCode = async (
  request: PromptEnhancementRequest,
  system: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string> => opencodeClient.generateText(`${system}\n\n${prompt}`, {
  model: { providerID: request.providerID, id: request.modelID },
  directory: request.directory,
  signal,
});

export async function enhancePromptDraft(
  request: PromptEnhancementRequest,
): Promise<PromptEnhancementResult> {
  const { system, prompt } = renderPromptEnhancementPrompts(request.prompts, request.draft);
  const controller = new AbortController();
  const onAbort = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) controller.abort(request.signal.reason);
  request.signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new PromptEnhancementError('timeout', 'Prompt enhancement timed out')),
    request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const finish = (raw: string, transport: PromptEnhancementTransport): PromptEnhancementResult => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const validated = validatePromptEnhancementOutput(request.draft, request.attachmentFilenames, raw);
    return { ...validated, transport };
  };

  try {
    if (isVSCodeRuntime()) {
      return finish(await generateInOpenCode(request, system, prompt, controller.signal), 'opencode');
    }

    const resolution = await readSmallModelResolution(request, controller.signal);
    const smallModelIsSafe = resolution?.available === true
      && resolution.model?.providerID === request.providerID;
    if (smallModelIsSafe) {
      try {
        return finish(await requestSmallModelText(request, system, prompt, controller.signal), 'small-model');
      } catch (error) {
        const unusable = error instanceof PromptEnhancementError
          && (error.code === 'model-unavailable'
            || error.code === 'empty-output'
            || error.code === 'too-long'
            || error.code === 'references-changed');
        if (!unusable) throw error;
      }
    }

    return finish(await generateInOpenCode(request, system, prompt, controller.signal), 'opencode');
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof PromptEnhancementError) throw reason;
      throw new PromptEnhancementError('aborted', 'Prompt enhancement was cancelled');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', onAbort);
  }
}
