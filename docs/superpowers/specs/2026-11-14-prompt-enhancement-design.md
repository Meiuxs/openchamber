# Prompt Enhancement

**Date:** 2026-11-14
**Status:** Design approved. Implementation not started.
**Scope:** Fork-only first. Web browser and Electron, plus the VS Code extension-only runtime. Mobile is excluded.

## Goal

Add a button at the bottom-right of the chat composer that rewrites the current draft into a clearer, more structured prompt before the user sends it. The rewrite makes the goal and its implied requirements explicit without inventing facts, files, APIs, or requirements the user did not state.

## Non-goals

- No mobile UI. The mobile footer and pill composer stay unchanged.
- No recent-conversation context and no attachment-content context.
- No multiple versions and no side-by-side diff.
- No automatic send. The user always reviews and sends.
- No new settings toggle.
- No new server route and no OpenCode repository change.
- No VS Code small-model bridge.
- No keyboard shortcut.
- No Magic Prompts test area.

## Settled decisions

| Decision | Choice |
| --- | --- |
| Rewrite goal | Clarify and structure, do not invent requirements |
| Context | Current draft only |
| Result | In-place replacement, undo available |
| Surfaces | Web browser, Electron follows web, VS Code extension-only runtime |
| Mobile | Excluded |
| Empty draft | Disabled |
| New session draft | Allowed, global Magic Prompts |
| Shell and slash-command drafts | Button hidden |
| BTW, parallel and comment modes | Button hidden |
| Busy session | Enhancement allowed; OpenCode startup disables the button |
| Structure | Moderate, only when the draft has multiple parts |
| Length guard | Reject when output is both over 3x the draft and over 1500 characters |
| References | Protect `@`, `$`, `#`, URLs, code fences and attachment citations |
| Ambiguity | Keep it, do not append clarification questions |
| Provider | Strict current composer provider |
| Timeout | 20 seconds |
| Global toggle | None |
| Locale coverage | All 15 locales |
| Icon and copy | `magic` icon, "Enhance prompt" / localized |
| Shortcut | None |
| Isolated spaces | Button shown, request routed with the space directory |
| Expanded composer | Button shown through the shared footer |
| Release path | Fork-only first |

## Runtime scope

- **Web browser:** full feature.
- **Electron:** follows the web UI and server. No separate runtime gate.
- **VS Code extension-only runtime:** full feature through a one-shot `opencodeClient.generateText` call with the current composer model. The `POST /api/small-model/generate` route is OpenChamber-server-only; in VS Code it would be proxied to OpenCode and return 404, so it is never called there.
- **Mobile:** the button is not rendered. The mobile branch of `ComposerFooter` is untouched.
- **Isolated spaces:** the chat composer is shared, and the small-model route exists inside the space server. The request must carry the space directory as a `runtimeFetch` option so `withSpaceDirectory` adds the routing header. Existing callers that pass the directory only in the body leak space content to the host OpenCode; this feature must not repeat that pattern.

## Interaction

The button sits in the right cluster of `ComposerFooter`, before the dictation control and the send disc. The desktop expanded composer renders the same `ComposerFooter`, so the button appears there without a separate implementation.

The button is a `type="button"` inside the composer form. Its `onMouseDown` prevents the default so the editor keeps focus and the soft keyboard stays open where applicable.

| State | Behavior |
| --- | --- |
| Draft has letters and a model is selected | Ready |
| Empty draft or only reference tokens | Disabled, tooltip explains why |
| OpenCode is starting | Disabled, same waiting reason as the send disc |
| No provider or model selected | Disabled, tooltip asks for a model |
| Shell mode | Hidden |
| Draft starts with a slash command | Hidden |
| BTW mode, parallel mode, comment mode | Hidden |
| Request in flight | Disabled, `loader-4` spinning, `aria-busy` |
| Success | Replace the draft, success toast with Undo |
| Output identical to the draft | No replacement, neutral "already clear" toast |
| Draft changed while the request ran | Keep the user's edits, toast "draft changed" |
| Reference token missing | Keep the original, toast "references changed" |
| Timeout or model failure | Keep the original, error toast |

Only one request may be in flight. The button stays disabled until it settles.

The Undo action restores the pre-enhancement snapshot only when the current draft is still exactly the enhanced text. If the user edited after replacement, Undo does nothing and shows the draft-changed notice. The success toast lasts four seconds.

## Prompt

Two Magic Prompts are added under the existing `Session` group:

- `session.promptEnhance.visible` is the system message.
- `session.promptEnhance.instructions` contains the rules and a `{{draft}}` placeholder.

Default visible prompt:

```text
You rewrite a developer's draft prompt so a coding agent can act on it without guessing.
```

Default instructions:

```text
Rewrite the draft below. Return only the rewritten prompt: no preamble,
explanations, quotes, or code fences.

Rules:
- Keep the draft's language.
- Keep every file, agent, skill, and snippet reference exactly as written:
  @name, $name, #name, /command, file paths, URLs, inline code, and code blocks.
- Do not answer the request, and do not add facts, files, APIs, or requirements
  the draft does not state.
- Make the goal explicit and organize the request when that helps: task,
  concrete requirements, constraints already implied, and what done looks like.
- Use structure only when the draft has multiple parts. A short draft stays one
  paragraph.
- Resolve an ambiguity only when one reading is clearly intended; otherwise keep
  it open.
- Stay close to the original length. If the draft is already clear, return it
  almost unchanged.

Draft:
{{draft}}
```

The settings page and sidebar gain a `session.promptEnhance` entry with the visible and instructions blocks. Users can override it globally or per project through the existing Magic Prompts storage.

## Output handling

1. Trim the model output.
2. If the whole output is wrapped in one Markdown code fence, remove that outer fence and trim again.
3. If the result is empty, treat the request as failed.
4. If the result equals the trimmed draft, return a no-change result.
5. Reject the result when it is both longer than three times the draft and longer than 1500 characters. Keep the original and show the failure toast.
6. Check protected fragments. Every `@token`, `$name`, `#token`, URL and fenced block from the original must still appear in the result, and the number of code fences must not decrease. Attachment citations passed by the caller, such as `[diagram.png]`, must also survive. A missing fragment keeps the original draft and shows the references-changed toast.

The reference check is deliberately conservative. A false positive keeps the original draft, which is safe and costs one retry.

## Model routing and provider boundary

The feature is pinned to the provider of the composer's current model. A Small Model override that names another provider is not used for this draft.

1. Read `currentProviderId` and `currentModelId` from `useConfigStore` at click time. If either is missing, fail with the model-missing notice.
2. **VS Code runtime:** call `opencodeClient.generateText` with the current model and the space directory. Do not call `GET /api/small-model` or `POST /api/small-model/generate`.
3. **Web and Electron:** call `GET /api/small-model` with `directory`, `providerID` and `modelID`, passing `directory` as a `runtimeFetch` option as well as in the query. Read `available` and `model.providerID`.
4. When `available` is true and the resolved provider matches the current provider, call `POST /api/small-model/generate` with:
   - `system`: the rendered visible prompt.
   - `prompt`: the rendered instructions, including the draft.
   - `directory`: the space-aware directory.
   - `preferredProviderID` and `preferredModelID`.
   - `maxOutputTokens: 1024`.
   - `restrictToPreferredProvider: true`, for older servers.
   Pass `directory` as a `runtimeFetch` option too.
5. When the Small Model is unavailable, resolves to another provider, returns 404, returns `small-model-unavailable`, or the pre-flight read fails, call `opencodeClient.generateText` with the current model. This fallback always passes the model explicitly; without it OpenCode uses its default model, which may belong to another provider.
6. If both transports fail, keep the draft and show the error toast. When the Small Model is the reason, the toast offers the Small Model settings action.

The 20-second timeout aborts both transports. The `generateText` wrapper gains an optional `signal` and forwards it as the SDK's second `RequestOptions` argument.

The directory is the session directory when there is one, otherwise the composer's current directory, otherwise `null`. A `null` directory reads global Magic Prompts and lets the server use its default location.

## Correctness invariants

- Never replace a draft that changed after the request started.
- Never replace a draft when a protected reference disappeared.
- Never replace a draft with empty output.
- Never send automatically.
- Never modify attachments, linked references, pending forms or the queue.
- Never let a failed request change the draft.
- Abort on unmount, draft identity change, runtime switch and timeout.
- One request in flight at a time.
- Content goes only to the current composer provider. The pre-flight read is the egress control.
- A malformed or failed pre-flight is not evidence that the Small Model is safe to use; fall back to the current model instead.

## Implementation

### New module

`packages/ui/src/lib/promptEnhancement.ts` owns the whole operation:

```ts
type PromptEnhancementRequest = {
  draft: string;
  directory: string | null;
  providerID: string;
  modelID: string;
  protectedFragments: readonly string[];
  signal: AbortSignal;
};

type PromptEnhancementResult = {
  text: string;
  changed: boolean;
  transport: 'small-model' | 'opencode';
};
```

It renders the Magic Prompts, performs the pre-flight provider check, chooses the transport, sanitizes the output, applies the length guard and checks the protected fragments. It imports `loadMagicPrompts`, `requestSmallModel`, `runtimeFetch`, `opencodeClient`, `isVSCodeRuntime` and `useConfigStore`.

Typed errors distinguish timeout, empty output, too long, missing references and unavailable model. `ChatInput` maps each to its toast key.

### Composer button

New `packages/ui/src/components/chat/composer/ui/ComposerEnhanceButton.tsx`:

```ts
type ComposerEnhanceButtonProps = {
  state: 'disabled' | 'ready' | 'loading';
  disabledReason?: string;
  footerIconButtonClass: string;
  iconSizeClass: string;
  onClick: () => void;
};
```

It uses `Icon name="magic"` and switches to `loader-4` with `animate-spin` while loading. The tooltip shows the label and, when disabled, the reason. Run `bun run icons:generate` after the icon is used.

`ComposerFooter` gains one prop:

```ts
enhancePrompt: {
  state: 'hidden' | 'disabled' | 'ready' | 'loading';
  disabledReason?: string;
  onClick: () => void;
};
```

The desktop right cluster renders the button before the dictation control and the send disc. The mobile branch is untouched. `hidden` also covers shell mode, slash-command drafts, BTW, parallel and comment modes.

### ChatInput

`ChatInput` owns the transient state:

- `isEnhancingPrompt`
- `enhanceAbortRef`
- the pre-enhancement snapshot

The ready condition requires a normal input mode, no slash command, at least one letter, a selected provider and model, no OpenCode startup wait, and no BTW or parallel mode. The handler snapshots the draft and draft identity, runs `enhancePromptDraft`, and applies the result only when both are unchanged. The success toast carries the Undo action. Cleanup aborts the controller on unmount and on draft identity changes.

`currentProviderId` and `currentModelId` are read through `useConfigStore` selectors so the button updates when the model changes.

### Magic Prompts settings

- `packages/ui/src/lib/magicPrompts.ts`: add the two ids, definitions and default templates.
- `packages/ui/src/components/sections/magic-prompts/MagicPromptsPage.tsx`: add `session.promptEnhance` with the two blocks.
- `packages/ui/src/components/sections/magic-prompts/MagicPromptsSidebar.tsx`: add the item under the Session group.
- 15 locale files under `packages/ui/src/lib/i18n/messages/`: add the button, tooltip, toast and settings keys.

New i18n keys:

- `chat.chatInput.actions.enhancePromptAria`
- `chat.chatInput.actions.enhancePromptTooltip`
- `chat.chatInput.actions.undoEnhance`
- `chat.chatInput.toast.enhanceSuccess`
- `chat.chatInput.toast.enhanceNoChange`
- `chat.chatInput.toast.enhanceFailed`
- `chat.chatInput.toast.enhanceTimeout`
- `chat.chatInput.toast.enhanceDraftChanged`
- `chat.chatInput.toast.enhanceReferencesChanged`
- `chat.chatInput.toast.enhanceModelMissing`
- `chat.chatInput.enhancePrompt.disabledNoText`
- `chat.chatInput.enhancePrompt.disabledOpenCodeStarting`
- `chat.chatInput.enhancePrompt.disabledNoModel`
- `settings.magicPrompts.page.group.sessionPromptEnhance.title`
- `settings.magicPrompts.page.group.sessionPromptEnhance.description`
- `settings.magicPrompts.sidebar.item.sessionPromptEnhance`

### OpenCode client

`packages/ui/src/lib/opencode/client.ts` gains an optional `signal` on `generateText` and forwards it to the SDK's `experimental.generate.text` second argument. The SDK already accepts `RequestOptions.signal`.

### Documentation

- `packages/docs/content/docs/chat-input.mdx`: add an "Enhance a draft" section covering the button, what it preserves, Undo, no automatic send, and the model fallback.
- `packages/docs/content/docs/magic-prompts.mdx`: add the Prompt Enhancement entry.

English docs are in scope. Localized docs pages follow the repository's existing translation workflow.

## Testing

Unit tests for `promptEnhancement`:

- Renders the visible and instruction prompts with the draft.
- Matches the provider and uses the Small Model.
- Resolves to another provider and uses `generateText`.
- VS Code uses `generateText` and never calls the small-model routes.
- Small-model 404 and pre-flight failure fall back to `generateText`.
- Timeout aborts.
- Strips an outer fence and rejects empty output.
- Rejects the 3x and 1500-character case.
- Rejects missing `@`, `$`, `#`, URL, fence and attachment citation fragments.
- Returns a no-change result for identical text.

UI tests:

- `ComposerEnhanceButton` disabled, ready, loading, aria and click behavior.
- `ChatInput` replaces the draft, offers Undo, refuses a changed draft, refuses missing references, handles no-change, and never sends.
- Magic Prompts settings render the new entry and the default templates.
- The i18n parity test passes for all 15 locales.

Manual verification:

- Browser web at desktop width.
- Electron.
- VS Code extension-only runtime.
- Mobile: no button and no footer regression.
- Isolated space: the request carries the space directory.
- Small Model unavailable: fallback to the current model.
- Small Model configured to another provider: fallback to the current model, and no draft content reaches the other provider.
- 20-second timeout.
- IME input during a request.
- `bun run check:changed --base HEAD` passes.

## Acceptance criteria

1. In the browser, a short Chinese draft is replaced by a clearer version, the message is not sent, and both `Ctrl+Z` and the toast Undo restore the original.
2. Electron behaves the same without a separate gate.
3. In the VS Code extension, enhancement works through the current model and never calls `POST /api/small-model/generate`.
4. Mobile shows no button and its footer is unchanged.
5. In an isolated space, enhancement works and the request is routed to the space server.
6. When the Small Model would use another provider, the current model is used instead and no draft content reaches the other provider.
7. Original `@`, `$`, `#`, URL, code-fence and attachment-citation fragments survive, or the original draft is kept.
8. A request that exceeds 20 seconds leaves the draft unchanged and shows a timeout notice.
9. A draft changed during the request is never overwritten.
10. The new Magic Prompts are editable globally and per project.

## Known limits

- The provider pre-flight and the generation call are two requests. A settings change in the milliseconds between them is not guarded. A hard guarantee would need a server-side `requireProvider` option on the small-model route, which is out of scope for this version.
- The VS Code fallback uses the current chat model, so its cost and latency can differ from the web path.
- The reference check is conservative and can reject a harmless rewrite. The original draft is kept.
- The model can still change meaning. The reference check and Undo are the safety net, not a guarantee.

## Rollout

- Fork-only first. Upstream contribution requires an accepted feature request, which is a separate decision after the fork version settles.
- No changelog line. `changelog/` stays read-only.
- The implementation follows the fork's feature workflow: isolated worktree, requirement and code review sub-agents, relevant tests only, and a commit after confirmation.
