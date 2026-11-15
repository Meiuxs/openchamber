# GitLab Issue Work Panel and Review Gate Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two additions to the GitLab issue automation, shipped as one batch:

1. A built-in work panel that shows every automation run by work state, links each run to its OpenCode session, and lets the operator act (cancel, reset, approve, reject, take) without leaving OpenChamber.
2. A review gate in the dispatcher: an independent reviewer session inspects the diff before anything is pushed, writes its verdict back as an issue comment, and only an approve lets the run reach the push.

Plus two correctness gaps found during review, fixed in the same batch.

**Architecture:** The panel is a new read/write pair of routes over the existing ledger (`gitlab-issue-runs.json`) plus one new full-page surface in `packages/ui`. The review gate is a new `reviewing` phase in the dispatcher state machine with a second OpenCode session per review round; its verdict flows back into a bounded implement-revision loop. No new labels; the GitLab-visible signal stays the existing label set plus review comments.

**Tech Stack:** Existing dispatcher/ledger/prompts modules in `packages/web/server/lib/gitlab-issues/`, GitBeaker 43.8, the OpenCode v2 client, React + UIStore page pattern in `packages/ui`, vitest for server tests, vitest + RTL for UI tests.

**Spec:** `docs/gitlab-issue-spec/gitlab-issue-review-gate-and-panel-spec.md` (increment over `gitlab-issue-automation-spec.md`; requirements are authoritative there).

**UI mockup:** `docs/gitlab-issue-spec/work-panel-mockup.html` (approved by the maintainer before implementation starts).

## Decisions settled with the maintainer

| Decision | Choice |
| --- | --- |
| Panel form | Built-in full page, not an SDK guest panel. The ledger is server-side data; guest panels cannot call `/api/*`. |
| Data source | The local ledger, via a new read route. Labels and comments stay the human mirror. |
| Scope | Per-project full history plus a global active/blocked summary, one route family. |
| Refresh | Poll every 10 s while the page is visible. No new push infrastructure. |
| Write actions | In scope. Label actions run with the acting operator's bound GitLab account, never the bot. Comment actions post as the operator. Unbound operators see a disabled button and a settings link. |
| Session link | Each run links its current `sessionId`; active runs also show busy/idle. One new session per attempt (existing behavior unchanged). No manual session attachment. |
| Reviewer | A separate OpenCode session (never the implement session reviewing itself). The bot account posts the verdict comment. |
| Gate strictness | Reviewer approve is enough to push. Human review stays at the MR. |
| Revision loop | Up to 3 review-revision rounds (`REVIEW_MAX_REVISIONS = 3`), then `ai-blocked` with the full findings. Global `MAX_ATTEMPTS = 2` is unchanged (it bounds infra retries). |
| Review model | New per-project setting `gitlabIssueReviewModel` (provider/id/variant), falling back to `defaultModel`; agent falls back to `defaultAgent`. |
| Labels | No new labels. `ai-working` stays on through `reviewing`. |

## Global Constraints

- Do not modify `../opencode`.
- Do not add dependencies.
- Never log or persist tokens or bearer values.
- All Git invocations use argument arrays and `shell: false`.
- Host Git calls must work with Git 2.20.
- The server never force-pushes and never writes to the default or a protected branch.
- Issue text is untrusted. The review prompt delimits it as data and every structured field is validated.
- User-facing issue comments are Chinese; source, comments, and docs are English.
- The ledger is authoritative; every label/comment the bot writes follows a ledger write.
- Write actions must never run as the bot account, and must verify Developer (30+) access of the acting account via `accessLevelOf` before touching GitLab.
- `changelog/` is read-only. `bun run check:changed --base HEAD` passes before any commit.

---

## Part A: Review gate

### A1. State machine (`machine.js`)

New phase `REVIEWING`. Transitions change:

```
implementing -> reviewing | blocked          (was: implementing -> verifying | blocked)
reviewing    -> implementing | verifying | blocked
```

`SLOT_PHASES` gains `REVIEWING` (it holds a session). `BLOCKED_REASONS` gains `REVIEW_REJECTED` (loop exhausted) and `LABEL_EVENTS_UNAVAILABLE` (Part C).

### A2. Ledger fields

| Field | Meaning |
| --- | --- |
| `reviewRounds` | Completed request-changes revision rounds; reset on claim, capped at 3. |
| `reviewNoteId` | Note id of the latest verdict comment. |
| `reviewVerdict` | `approve` or `request-changes`, for the panel. |

`sessionId` continues to hold the current active session (implement or review; the panel shows whichever is live).

### A3. Dispatcher (`dispatcher.js`)

- `handleImplementing` on valid evidence transitions to `REVIEWING` instead of `VERIFYING`, and clears `sessionId` (the implement session is done; the review gets its own).
- New `handleReviewing`:
  1. Without `sessionId`: start a review session via `startSession(run, context, 'review')`, which uses `buildReviewPrompt` and the `gitlabIssueReviewModel` fallback chain.
  2. With `sessionId`: poll `readSessionResult`; on finish, `parseAgentOutput(text, 'review')`. `AgentOutputError` goes through `failRun` as today.
  3. `approve`: post `formatReviewComment(verdict)` with the bot account, store `reviewNoteId`/`reviewVerdict`, transition to `VERIFYING`.
  4. `request-changes`: post the verdict comment, increment `reviewRounds`. If `reviewRounds > REVIEW_MAX_REVISIONS`, `blockWithComment(REVIEW_REJECTED, ...)` carrying all accumulated findings. Otherwise transition back to `IMPLEMENTING` with `sessionId: null` and store the findings on the entry; the next implement prompt embeds them.
- `handleTimeout` extended to `PLANNING` (Part C) and also `REVIEWING` (same `timeoutMinutes` budget).
- Cancellation watcher: `reviewing` joins the `watchers` list (label semantics unchanged).

### A4. Prompt contract (`prompts.js`)

- `buildReviewPrompt({ issue, iid, worktreePath, baseRef, evidence })`: the reviewer reads the issue (inside `<issue-content untrusted="true">`), the evidence fields, and the diff `baseRef..HEAD`; it must not modify files. Output is structured JSON: `{ verdict: 'approve' | 'request-changes', summary: string, findings: [{ file, line?, severity: 'blocker'|'minor', note }] }`. `parseAgentOutput` gains a `'review'` kind with validation: verdict enum, findings array of objects with string fields, non-empty summary.
- `formatReviewComment(verdict)`: Chinese comment, states verdict, summary, findings as a list, and what happens next (approve: push and MR; request-changes: revision round N of 3, or blocked).
- The revision implement prompt (`buildImplementPrompt`) gains an optional `reviewFindings` parameter rendered as a "上一轮审核发现" section.

### A5. Project setting

`resolveProjectConfig` gains `gitlabIssueReviewModel` (`{ providerID, modelID, variant? }`), validated like `defaultModel`; `enabled` does not depend on it (review works with the default). Settings UI: one row in the project's GitLab automation section, placeholder "Same as the default model".

---

## Part B: Work panel

### B1. Server routes (`routes.js`, same module)

Read:

- `GET /api/gitlab-issues/runs?directory=<path>`: all ledger runs for that project's `origin|projectId`, enriched. Response per run: `key` (`origin|projectId|iid`), `iid`, `kind`, `phase`, `blockedReason`, `lastError`, `branch`, `targetBranch`, `mrIid`, `issueUrl` (derived `origin/projectPath/-/issues/iid`), `mrUrl` (derived), `attempts`, `reviewRounds`, `since`, `updatedAt`, `sessionId`, `sessionStatus` (`busy`/`idle`/`null`; only for runs holding a session, resolved with a short timeout against the OpenCode client; `null` on failure, never a fabricated state).
- `GET /api/gitlab-issues/runs` (no directory): same shape across all enabled projects; `done` entries excluded.

A failed ledger read is an error response, never an empty success. A failed GitLab/OpenCode enrichment degrades to `null` fields without failing the route.

Write (single endpoint, action-validated):

- `POST /api/gitlab-issues/runs/action` with `{ directory, key, action, accountId }`.
- Actions: `cancel` (add `ai-blocked`, remove `ai-working`), `reset` (remove `ai-blocked`, ensure `ai-ready`), `approve` (post `/ai-approve` as the operator), `reject` (post `/ai-reject`), `take` (post `/ai-take`).
- Validation: the acting `accountId` must resolve to a valid bound account for the run's `origin`, must not be the bot account, and `accessLevelOf` must be 30+. Actions that the current phase does not accept (for example `approve` outside `waiting-approval`) return 409 with the phase in the body. The ledger is not written by the action; the dispatcher's own tick observes the label/comment change and transitions, so the action path stays out of the state machine.

### B2. UI surface (`packages/ui`)

- `GitlabRunsPanel` full page, mounted like `SourceBoardView`: `useUIStore` state `gitlabRunsPageProjectId` + setter (mutual-exclusion pattern), lazy `OnDemand` branch in `MainLayout`, entry in the project menu next to `onOpenSourceBoard`, plus a command palette item.
- Layout: active runs first (phase chip, issue link, branch, MR link, session link with live busy/idle, blocked guidance per Part D), blocked runs with their guidance text and action buttons, then a collapsed history section with phase filter.
- Global entry point in the panel header toggles the cross-project active/blocked list.
- Poll every 10 s while `document.visibilityState === 'visible'`; stop when hidden; refetch on mount.
- Session link calls `setCurrentSession(sessionId)` to open the automation session in chat.
- Action buttons resolve the acting account from `useSourceControlAuthStore` identities for the run's provider instance; zero or multiple candidates means disabled button plus a link to settings (same pattern as `GitlabIssueDialog`'s bot-account row).
- i18n via a new `gitlab-runs.i18n.ts` merged into every locale, same as `gitlab-issue.i18n.ts`.

### B3. Blocked guidance

The panel reuses the reason-to-guidance mapping from `formatBlockedComment`; no second wording set. Each blocked run shows: reason, the dispatcher's last comment summary, and the exact next step (for example `missing-credential` -> "a Developer replies `/ai-take`", `invalid-template` -> "fix `类型:`/`目标分支:` then re-add `ai-ready`").

---

## Part C: Correctness gap fixes (same batch)

### C1. Label events unavailable must block, not spin

`claim()` resolves the triggerer through `listLabelEvents`. When that call fails (old GitLab without `resource_label_events`, transient API failure other than auth), the issue must not stay `ai-ready` and retry forever: label `ai-blocked`, post the blocked comment naming `label-events-unavailable`, and put the entry with `blockedReason: LABEL_EVENTS_UNAVAILABLE`. A human reset re-claims as today.

### C2. Planning timeout

`handleTimeout` currently covers only `IMPLEMENTING`. Extend it to `PLANNING` (and `REVIEWING` per A3) with the same `config.timeoutMinutes` budget, so a hung plan or review session cannot hold one of the three global slots forever. `waiting-approval` keeps no timeout by design.

---

## Review Focus

1. The action route acting as the bot, or as an account below Developer. Both must be impossible; a test pins each rejection.
2. The review session modifying files. The prompt forbids it and `hasDiffSince` verification still gates the push; a test covers a review output that validates but a branch with no diff.
3. The revision loop turning into an infinite cycle. `reviewRounds` caps at 3 and a test drives a fourth request-changes into `ai-blocked` with `REVIEW_REJECTED`.
4. Review findings entering the next prompt unsanitized. Findings come from the reviewer (itself fed untrusted issue text), so they are re-wrapped as data in the revision prompt; a test pins the delimiter.
5. Ledger read failure in the panel route masquerading as an empty list; a test covers the 500 path.

---

## Tasks

### Task 1: Machine, ledger, and config groundwork

**Files:** `packages/web/server/lib/gitlab-issues/machine.js`, `ledger.js`, `gitlab.js`, and their tests.

- [ ] Add `REVIEWING` phase, transitions, `SLOT_PHASES`, `BLOCKED_REASONS.REVIEW_REJECTED` and `LABEL_EVENTS_UNAVAILABLE`.
- [ ] Ledger entry defaults gain `reviewRounds: 0`, `reviewNoteId: null`, `reviewVerdict: null`; reset on claim.
- [ ] `resolveProjectConfig` gains `gitlabIssueReviewModel` parsing and validation.
- [ ] Tests: legal/illegal transition matrix includes `reviewing`.

### Task 2: Prompt contract

**Files:** `packages/web/server/lib/gitlab-issues/prompts.js`, `prompts.test.js`.

- [ ] `buildReviewPrompt`, `formatReviewComment`, revision findings section in `buildImplementPrompt`.
- [ ] `parseAgentOutput` review kind with field validation.
- [ ] Tests: untrusted-content delimiters, invalid verdict rejected, findings schema rejected on malformed input.

### Task 3: Dispatcher review loop

**Files:** `packages/web/server/lib/gitlab-issues/dispatcher.js`, `dispatcher.test.js`.

- [ ] `handleReviewing` with session lifecycle, verdict handling, revision loop, `REVIEW_MAX_REVISIONS = 3`.
- [ ] `handleTimeout` covers `PLANNING` and `REVIEWING`.
- [ ] `handleClaimed` for bug issues routes `preparing -> implementing -> reviewing -> verifying`.
- [ ] Tests: approve path reaches push; request-changes loop revises and then blocks; timeout in planning aborts the session; reviewer session crash recovers to `reviewing` (recovery list gains `reviewing`).

### Task 4: Gap fix C1 in `claim()`

**Files:** `packages/web/server/lib/gitlab-issues/dispatcher.js`, `dispatcher.test.js`.

- [ ] Wrap the `latestTriggerer` label-event read; on non-auth failure block with `LABEL_EVENTS_UNAVAILABLE` plus comment.
- [ ] Test: label-events endpoint failure produces `ai-blocked` and no re-claim churn.

### Task 5: Panel routes

**Files:** `packages/web/server/lib/gitlab-issues/routes.js`, `routes`/`integration` tests.

- [ ] `GET /api/gitlab-issues/runs` with and without `directory`, ledger-error 500, enrichment degradation to `null`.
- [ ] `POST /api/gitlab-issues/runs/action` with action/phase validation, bot-account refusal, access-level check, unbound-account 409.
- [ ] Tests per Review Focus 1 and 5.

### Task 6: Panel UI

**Files:** `packages/ui/src/components/gitlab-runs/GitlabRunsPanel.tsx`, `useUIStore.ts`, `MainLayout.tsx`, `SessionProjectScroller.tsx`, `CommandPalette.tsx`, `gitlab-runs.i18n.ts` (all locales), panel tests.

- [ ] Page state, mount, entries, polling, blocked guidance, action buttons with account resolution, session link, history with filter, global toggle.
- [ ] RTL tests: polling stops when hidden, disabled action without bound account, blocked guidance text matches the reason.

### Task 7: Review-model setting row

**Files:** project settings GitLab automation section, parser, settings tests.

- [ ] `gitlabIssueReviewModel` field (model picker with variant), fallback rendering, save/normalize round-trip.

### Task 8: Spec and documentation

**Files:** `docs/gitlab-issue-spec/gitlab-issue-automation-spec.md`, `packages/web/server/lib/gitlab-issues/DOCUMENTATION.md`, `packages/ui` module documentation touched by the panel.

- [ ] Spec gains the `reviewing` phase, the label timeline delta, the panel route contract, and the gap-fix behaviors.
- [ ] Module documentation ownership line gains the panel routes and the review loop.

### Task 9: Proof

- [ ] `bun run check:changed --base HEAD` passes.
- [ ] Manual run against a bound project: bug issue through `reviewing` with one request-changes revision, then approve, push, MR; panel shows every phase transition live and the action buttons cancel/reset work with attribution on the correct account.
