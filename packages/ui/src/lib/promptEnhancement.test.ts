import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch';
import type { PromptEnhancementErrorCode } from './promptEnhancement';

type GenerateTextOptions = {
  model?: { providerID: string; id: string };
  directory?: string | null;
  signal?: AbortSignal;
};
type GenerateTextCall = { prompt: string; options?: GenerateTextOptions };
type RuntimeFetchCall = { input: string | URL | Request; init?: RequestInit };
type SmallModelOptions = { notifyOnError?: boolean; silentStatuses?: number[] };
type SmallModelCall = { init: RuntimeFetchOptions; options?: SmallModelOptions };
type Responder<T> = (call: T) => Promise<Response>;

let vscodeRuntime = false;
let generateTextCalls: GenerateTextCall[] = [];
let runtimeFetchCalls: RuntimeFetchCall[] = [];
let smallModelCalls: SmallModelCall[] = [];

const defaultRuntimeFetch = async ({ input }: RuntimeFetchCall): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
  if (url.pathname === '/api/small-model') {
    return Response.json({ available: true, model: { providerID: 'provider', modelID: 'model' } });
  }
  return Response.json({ text: 'SMALL TEXT' });
};

const defaultSmallModel = async (): Promise<Response> => Response.json({ text: 'SMALL TEXT' });

let runtimeFetchResponder: Responder<RuntimeFetchCall> = defaultRuntimeFetch;
let smallModelResponder: Responder<SmallModelCall> = defaultSmallModel;

const generateText = mock(async (prompt: string, options?: GenerateTextOptions) => {
  generateTextCalls.push({ prompt, options });
  return 'OPENCODE TEXT';
});

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: { generateText },
}));
mock.module('@/lib/desktop', () => ({
  isVSCodeRuntime: () => vscodeRuntime,
}));

const runtimeFetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
  const call = { input, init };
  runtimeFetchCalls.push(call);
  return runtimeFetchResponder(call);
});
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch }));

const requestSmallModel = mock(async (init: RuntimeFetchOptions, options?: SmallModelOptions) => {
  const call = { init, options };
  smallModelCalls.push(call);
  return smallModelResponder(call);
});
mock.module('@/lib/smallModelRequest', () => ({ requestSmallModel }));

const {
  enhancePromptDraft,
  extractProtectedFragments,
  normalizePromptEnhancement,
  PromptEnhancementError,
  renderPromptEnhancementPrompts,
  validatePromptEnhancementOutput,
} = await import('./promptEnhancement');

const errorCode = (run: () => void): PromptEnhancementErrorCode => {
  try {
    run();
  } catch (error) {
    if (!(error instanceof PromptEnhancementError)) throw error;
    return error.code;
  }
  throw new Error('Expected the call to throw');
};

describe('normalizePromptEnhancement', () => {
  test('trims the reply and removes one outer fence', () => {
    expect(normalizePromptEnhancement('  ```text\nRewrite this\n```  ')).toBe('Rewrite this');
    expect(normalizePromptEnhancement('Rewrite this')).toBe('Rewrite this');
  });
});

describe('extractProtectedFragments', () => {
  test('keeps file, skill, snippet, URL and attachment references', () => {
    const fragments = extractProtectedFragments(
      '@src/foo.ts $debug #signoff see https://example.test/x and [diagram.png]',
      ['diagram.png'],
    );

    expect(fragments).toContain('@src/foo.ts');
    expect(fragments).toContain('$debug');
    expect(fragments).toContain('#signoff');
    expect(fragments).toContain('https://example.test/x');
    expect(fragments).toContain('[diagram.png]');
    expect(fragments).not.toContain('$5');
  });

  test('an attachment the draft does not cite is not a protected fragment', () => {
    expect(extractProtectedFragments('summarize this', ['report.pdf'])).toEqual([]);
  });
});

describe('validatePromptEnhancementOutput', () => {
  test('an unchanged draft reports no change', () => {
    expect(validatePromptEnhancementOutput('Fix it', [], 'Fix it')).toEqual({ text: 'Fix it', changed: false });
  });

  test('an empty reply fails', () => {
    expect(() => validatePromptEnhancementOutput('Fix it', [], '   ')).toThrow(PromptEnhancementError);
  });

  test('a rewrite that keeps every reference passes', () => {
    const result = validatePromptEnhancementOutput(
      'Fix @src/foo.ts with $debug, see https://example.test/x\n```ts\nconst a = 1;\n```',
      [],
      'Goal: fix the bug in @src/foo.ts using $debug.\nSee https://example.test/x\n```ts\nconst a = 1;\n```',
    );

    expect(result.changed).toBe(true);
    expect(result.text).toContain('@src/foo.ts');
  });

  test('a dropped file reference keeps the original', () => {
    expect(errorCode(() => validatePromptEnhancementOutput('Fix @src/foo.ts', [], 'Fix the bug'))).toBe('references-changed');
  });

  test('a dropped skill reference keeps the original', () => {
    expect(errorCode(() => validatePromptEnhancementOutput('Use $debug please', [], 'Please debug it'))).toBe('references-changed');
  });

  test('a dropped snippet reference keeps the original', () => {
    expect(errorCode(() => validatePromptEnhancementOutput('Use #signoff please', [], 'Please sign off'))).toBe('references-changed');
  });

  test('a dropped URL keeps the original', () => {
    expect(errorCode(() => validatePromptEnhancementOutput('Read https://example.test/x', [], 'Read the page'))).toBe('references-changed');
  });

  test('a dropped attachment citation keeps the original', () => {
    expect(errorCode(() => validatePromptEnhancementOutput('Describe [diagram.png]', ['diagram.png'], 'Describe the diagram'))).toBe('references-changed');
  });

  test('a dropped code fence keeps the original', () => {
    expect(errorCode(() => validatePromptEnhancementOutput('Fix\n```ts\nconst a = 1;\n```', [], 'Fix the code'))).toBe('references-changed');
  });

  test('a runaway rewrite keeps the original', () => {
    const draft = 'Fix the bug';
    const reply = 'Fix the bug '.repeat(200);
    expect(errorCode(() => validatePromptEnhancementOutput(draft, [], reply))).toBe('too-long');
  });

  test('an attachment the draft does not cite does not have to appear', () => {
    expect(validatePromptEnhancementOutput('summarize this', ['report.pdf'], 'Summarize this.')).toEqual({
      text: 'Summarize this.',
      changed: true,
    });
  });
});

const prompts = {
  render: (id: string, variables?: Record<string, string>) => (
    id === 'session.promptEnhance.visible' ? 'SYSTEM' : `RULES\n${variables?.draft ?? ''}`
  ),
};

const request = (overrides: Partial<Parameters<typeof enhancePromptDraft>[0]> = {}) => ({
  draft: 'fix the bug',
  prompts,
  directory: '/spaces/space-1/repo',
  providerID: 'provider',
  modelID: 'model',
  attachmentFilenames: [],
  signal: new AbortController().signal,
  timeoutMs: 1000,
  ...overrides,
});

describe('renderPromptEnhancementPrompts', () => {
  test('renders the role and the instructions with the draft', () => {
    expect(renderPromptEnhancementPrompts(prompts, 'fix the bug')).toEqual({
      system: 'SYSTEM',
      prompt: 'RULES\nfix the bug',
    });
  });
});

beforeEach(() => {
  generateTextCalls = [];
  runtimeFetchCalls = [];
  smallModelCalls = [];
  runtimeFetchResponder = defaultRuntimeFetch;
  smallModelResponder = defaultSmallModel;
  vscodeRuntime = false;
});

describe('enhancePromptDraft', () => {
  test('uses the Small Model when the resolved provider matches and carries the space directory', async () => {
    const result = await enhancePromptDraft(request());

    expect(result).toEqual({ text: 'SMALL TEXT', changed: true, transport: 'small-model' });
    expect(generateTextCalls).toHaveLength(0);
    expect(smallModelCalls).toHaveLength(1);
    const call = smallModelCalls[0];
    const body = JSON.parse(String(call?.init.body));
    expect(body.system).toBe('SYSTEM');
    expect(body.directory).toBe('/spaces/space-1/repo');
    expect(body.preferredProviderID).toBe('provider');
    expect(body.preferredModelID).toBe('model');
    expect(body.restrictToPreferredProvider).toBe(true);
    expect(body.prompt).toContain('fix the bug');
    expect(call?.init.directory).toBe('/spaces/space-1/repo');
    expect(call?.options).toEqual({ notifyOnError: false });
  });

  test('uses OpenCode with the current model when the Small Model resolves to another provider', async () => {
    runtimeFetchResponder = async () => Response.json({ available: true, model: { providerID: 'other' } });

    const result = await enhancePromptDraft(request());

    expect(result.transport).toBe('opencode');
    expect(smallModelCalls).toHaveLength(0);
    const call = generateTextCalls[0];
    expect(call?.prompt).toBe('SYSTEM\n\nRULES\nfix the bug');
    expect(call?.options?.model).toEqual({ providerID: 'provider', id: 'model' });
    expect(call?.options?.directory).toBe('/spaces/space-1/repo');
    expect(call?.options?.signal instanceof AbortSignal).toBe(true);
  });

  test('uses OpenCode when the Small Model is unavailable or the pre-flight fails', async () => {
    runtimeFetchResponder = async () => Response.json({ available: false, model: null });
    expect((await enhancePromptDraft(request())).transport).toBe('opencode');

    runtimeFetchResponder = async () => Response.json({}, { status: 500 });
    expect((await enhancePromptDraft(request())).transport).toBe('opencode');
  });

  test('the VS Code runtime uses OpenCode and never reads the Small Model', async () => {
    vscodeRuntime = true;

    const result = await enhancePromptDraft(request());

    expect(result.transport).toBe('opencode');
    expect(runtimeFetchCalls).toHaveLength(0);
    expect(smallModelCalls).toHaveLength(0);
  });

  test('a small-model 404 falls back to OpenCode', async () => {
    smallModelResponder = async () => Response.json(
      { error: 'No small model', code: 'small-model-unavailable' },
      { status: 404 },
    );

    const result = await enhancePromptDraft(request());

    expect(result.transport).toBe('opencode');
    expect(generateTextCalls).toHaveLength(1);
  });

  test('a provider failure fails over nothing: the fallback runs on the same provider', async () => {
    smallModelResponder = async () => Response.json(
      { error: 'The provider refused: ECONNREFUSED: Unable to connect.', code: 'provider-error' },
      { status: 502 },
    );

    let failureCode: PromptEnhancementErrorCode | null = null;
    try {
      await enhancePromptDraft(request());
    } catch (error) {
      if (!(error instanceof PromptEnhancementError)) throw error;
      failureCode = error.code;
    }

    expect(failureCode).toBe('provider-unavailable');
    expect(generateTextCalls).toHaveLength(0);
  });

  test('a hung request aborts at the timeout', async () => {
    runtimeFetchResponder = ({ init }) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason));
    });

    let failureCode: PromptEnhancementErrorCode | null = null;
    try {
      await enhancePromptDraft(request({ timeoutMs: 10 }));
    } catch (error) {
      if (!(error instanceof PromptEnhancementError)) throw error;
      failureCode = error.code;
    }
    expect(failureCode).toBe('timeout');
    expect(generateTextCalls).toHaveLength(0);
  });
});
