# GitLab issue automation

The design and requirements live in `docs/gitlab-issue-spec/gitlab-issue-automation-spec.md`, with the review gate and the runs panel in `docs/gitlab-issue-spec/gitlab-issue-review-gate-and-panel-spec.md`; this document describes the module as it is now.

## Ownership

This module turns one labeled GitLab issue into a reviewable merge request. It owns the polling dispatcher, the run ledger, the GitLab API adapter, the worktree and push boundary, the five prompt contracts (triage, plan, implement, review, feedback), and the read/act routes of the runs panel. It does not merge merge requests, it does not create issues, and it does not fix CI failures after a merge request opens. After a merge request opens it does answer reviewer comments: a bounded run of comment-driven fix rounds (`addressing`), described below.

- `dispatcher.js` is the timer and the phase loop: project scan cadence, claim, concurrency caps, leases, cancellation, timeout, recovery, triage, review rounds, and merge polling.
- `ledger.js` is the authoritative phase store at `<data dir>/gitlab-issue-runs.json`, keyed by `origin|projectId|iid`.
- `machine.js` declares the phases and the only legal transitions.
- `gitlab.js` parses the issue template, builds branch names, resolves accounts, and wraps the GitBeaker calls the dispatcher uses.
- `workspace.js` creates and removes worktrees, writes the commit identity, and runs authenticated fetch and push through a one-shot credential lease.
- `prompts.js` builds the triage, plan, implementation, review, and feedback prompts and validates the agent's structured output.
- `routes.js` serves the issue-creation route and the panel's read/act routes. The act route changes GitLab labels or posts a command comment as the operator's bound account; it never writes the ledger.


The GitLab labels are a mirror for humans. A label change a human makes is read back each tick; a label change the bot makes follows a ledger write.

## Invariants

- The ledger is authoritative. A label that announces a transition follows its ledger write. A comment the ledger must reference (the plan, the evidence, the merge request) is posted first so its note id can be recorded, and the transition itself is still written before the next phase does anything — a comment alone never announces a move the ledger has not made.
- One run per project and three globally occupy a dispatch slot. A slot covers `claimed`, `preparing`, `triaging`, `planning`, `waiting-approval`, `implementing`, `reviewing`, `verifying`, and `addressing`.
- One claim per project per tick and three globally. The issue list is read every third tick, at most three pages of 100; active runs are checked every tick.
- The agent never pushes. The server pushes only after the branch prefix, a non-empty tree diff against the target, the evidence note, and a review verdict of `approve` all validate.
- A worktree is created with the project's own setup commands (`setup-worktree`: shared ones the project trusted, plus personal ones) and its session starts only after that setup reports `setup-ready`. A failed setup blocks the run with the reason; a slow one leaves the run in `preparing` and the next tick asks again.
- Push and merge-request creation use the triggerer's credential. Fetch and comments use the bot credential. Neither token enters the prompt, a log line, a commit, or the merge request body.
- The server never force-pushes and never writes to the default or a protected branch.
- Issue text is untrusted. The prompt keeps it inside `<issue-content untrusted="true">`, and every structured field is validated before it reaches a comment or a merge request.
- A dirty worktree is never deleted. The path is commented and kept in the ledger.
- A failed issue list read is a skipped tick, not an empty result.
- Every session a run opens stays on the ledger as `sessions` (`{ sessionId, stage, at }`, oldest first, at most 20), because a phase clears `sessionId` when it moves on. The runs route is its only reader.

## Decisions

### Why a feature rebinds its actor at approval

The spec defines the triggerer of a bug as whoever added `ai-ready`, and of a feature as whoever answers `/ai-approve`. A plan therefore starts under the `ai-ready` adder (that account still has to exist to claim the issue), but the transition to `implementing` rewrites `actorUserId` and `actorAccountId` to the approver and rewrites the worktree identity with the approver's name and email. Push and merge request then belong to the approver, which is what the contribution history is expected to show.

### Why the finish check compares trees, not commits

`rev-list --count base..HEAD` counts commits, and a commit that changes nothing still counts. The verifying step runs `git diff --quiet base..HEAD`, which is exactly the spec's "diff against the target is non-empty"; a throwing comparison blocks the run through `failRun` instead of rejecting into the tick log.

### Why the claim block clears the working labels

Manual reset is "remove `ai-blocked` and keep `ai-ready`". If a block left `ai-working` or `ai-review` on the issue, the re-claim would fail the busy-label check and the issue would be silently dead. Every block removes the working labels before announcing itself, so the reset the comment describes actually works.

### Why the startup recovery ignores an unexpired lease

Recovery runs once per process, and the previous process can leave a lease up to five minutes in the future. Trusting that lease would skip the only recovery pass, leaving a dead session polled forever. Deployment is single-instance by spec, and in-process ticks are serialized, so the first pass inspects every run directly; later passes are unnecessary because a session that disappears mid-run surfaces as a finished or failed turn.

### Why a run records its settings entry id

Two settings entries can point at the same GitLab project (two checkouts). The ledger key stays `origin|projectId|iid`, but each claim also stores `projectEntryId`, and the tick prefers the context whose settings entry claimed the run. Without it the last resolved context would win and the run could execute in the other checkout.

### Why the ledger is keyed by origin, project id, and issue iid

The same issue number exists in every project, and the same project path may be served by more than one instance. The three values together identify one issue without relying on a local project id that the settings file could change.

### Why waiting-approval counts toward the active cap but mr-open does not

The cap exists to bound the number of issues the automation holds at once, and a feature waiting for approval still holds the branch, the worktree, and the labels. Counting it also keeps a project from collecting several half-finished feature plans. A run in `mr-open` has no session and belongs to its reviewers; counting it would stop a project from starting the next issue until the open merge request is merged or closed.

### Why the commit identity lives in the worktree config

`git config --local` writes to the shared repository config, so a commit made in the main checkout while a run is in progress would carry the triggerer's identity. The automation instead enables `extensions.worktreeConfig` and writes `user.name`, `user.email`, and an empty `credential.helper` with `--worktree`, which scopes them to the automation's worktree. The empty helper resets the repository's persistent helpers; the one-shot lease passes its own helper on the command line, which still applies.

### Why the automation's worktree shares the checkout's installed dependencies

A worktree is a fresh checkout, and a second install underneath its own, longer path is what the automation could not survive: the package store passed the Windows path limit and the install failed after minutes (`../git/DOCUMENTATION.md`, *Why a shared dependency link replaces the install*). The creation is asked for the checkout's `node_modules` by link (`reuseNodeModules`) and the install is skipped; the project's own setup commands are what runs when there is nothing to share. They are the commands the project already declares for a worktree a person makes (`../projects/worktree-setup.js`), merged by the same rule, so a shared command nobody trusted is skipped here too: the automation may run on a machine where nobody is present to accept a pull's commands.

The wait is per tick, never a deadline. An install that takes minutes is slow, not broken, and holding a tick behind it would stall every other project's dispatch. The run stays in `preparing` until the bootstrap reports `setup-ready`. A setup command that fails ends the bootstrap as failed, so the run blocks with that reason and the person reads it on the issue rather than in a log.

### Why mr-open is polled before the cancellation check

A merge request that carries `Closes #<iid>` closes its issue the moment it merges. If the cancellation check ran first, the next tick would read a closed issue and block the run as cancelled instead of marking it done. The mr-open handler reads the merge request first, finishes the run when it is merged or closed, and only then treats a closed issue as a manual finish.

### Why a manual reset deletes the ledger entry

A human who removes `ai-blocked` and leaves `ai-ready` may also have edited the template, the target branch, or the title. Transitioning the old entry back to `claimed` would reuse the stale branch and target. Deleting the entry lets the next scan claim the issue again with freshly parsed fields. A dirty worktree was already kept and commented when the run was blocked.

### Why the bot account is re-read every tick instead of a paused-project set

A paused set survives the credential update that fixes the problem, so the project would never resume without a restart. On a 401 the dispatcher marks the account invalid in the credential store and drops the cached context; the settings page then shows the account as invalid, and the next tick resumes as soon as a valid account is selected.

### Why the dispatcher owns a second credential broker

`networkOperations` issues leases against a repository binding and its account. GitLab issue automation must fetch as the bot and push as the triggerer, neither of which the binding owns. A second broker keeps those leases separate and avoids widening the network operation contract for one caller.

### Why the server push passes `--no-verify`

The commit was made by the agent in the worktree, where a repository hook can be edited. The server push must not execute code the agent could have planted. Hooks that the repository owner wants enforced belong in the merge request pipeline, which runs after the push.

### Why an existing open merge request is adopted

A crash between push and the ledger write can leave a branch with an open merge request and a run still in `verifying`. Creating another merge request would duplicate the review. The verifying step lists open merge requests for the branch first and records the one it finds.

### Why a dirty worktree stays on disk

Removing it would discard work that may be the only copy of the change. The cleanup step checks `git status --porcelain`, comments the path, and keeps `worktreePath` in the ledger so a human can inspect it. The run still reaches `done`, because the merge request is merged and the issue is closed.

### Why recovery only re-decides phases that hold a session

A verifying run's session is already finished; its state belongs to the branch and the merge request, not to the session. Recovery therefore only checks `planning`, `preparing`, and `implementing`. A lost session returns to `implementing` when the branch has commits and to `claimed` when it does not. Waiting-approval and verifying continue from their stored phase. `triaging`, `reviewing` and `addressing` take a third path: the session is cleared and the same phase opens a fresh one next tick, because what those phases decide — is the report real, does the diff pass, are the feedback items answered — is not recorded anywhere on the branch.

### Why the bot account is re-read every tick instead of a paused-project set

A paused set survives the credential update that fixes the problem, so the project would never resume without a restart. Re-reading the account costs one credential-store read per enabled project and lets the next tick resume as soon as the settings point at a valid account.

### Why the review is a separate session, not the implementer's own check

An agent that reviews its own change confirms its own reasoning. A second session reads the diff with a reviewer prompt and only that prompt, so the verdict is independent of the implementation transcript. It still cannot push: `verifying` re-checks the diff, and an approve produces no commit.

### Why review findings are re-wrapped as data

Findings come from a session that itself read untrusted issue text, so they can carry injected instructions. The revision prompt keeps them inside `<review-findings untrusted="true">` and the parser only accepts `{ file, line?, severity, note }` objects with string fields, the same treatment the issue body gets.

### Why a label-event read failure blocks instead of retrying

An instance without `resource_label_events` would leave every `ai-ready` issue in a permanent claim-retry loop with no comment on the issue explaining it. The run is blocked once with `label-events-unavailable` and a comment, so the GitLab side says what is wrong and the reset path the comment names works.

### Why planning and reviewing share the implementing timeout

A session that never finishes holds the project slot and one of the three global slots. Before the timeout covered them, three hung plans stalled every project until a human removed a label. The timeout is the only automatic exit from a stuck session that is not a crash. Triage runs under the same budget for the same reason: it is the first session every run opens, so a hung one now stalls the run before any other work exists.

### Why a session that ends without an answer blocks the run

A session that never produced the json block a phase needs used to reach the phase timeout, which then reported `timeout` about a model that had already refused the request. A turn that ends unanswered — the provider rejects the model id, the quota is spent, the turn is interrupted before its first token — is now blocked by the phase that opened it, with the session failure as the reason, so the issue comment names the likely cause. The evidence is the `idle` record OpenCode appends when a run ends, never an empty record page: a prompt that has not reached the server yet lists no records either, and failing on that would block a session that is only starting. A finished turn that carries no text counts as the same failure, because `parseAgentOutput` can only answer with its own missing json. The panel's session dot keeps its two states — `busy` and `idle` — so a session that ended unanswered reports no status at all; forwarding a third value would fail the panel's schema and hide every run in the list, not just this one.

### Why the panel acts through GitLab instead of the ledger

The ledger is the dispatcher's write. A route that wrote it could move a run into a phase the state machine never approved, and the next tick would fight it. Label and comment actions are the same inputs a person typing in GitLab produces, so attribution lands on the acting account's GitLab identity and the dispatcher stays the only writer.

### Why a run keeps its own event trail

A phase alone says where a run is, never how it got there: a card that showed
only `implementing` could not tell a first attempt from a fourth, or a stopped
session from one that never started. The ledger therefore carries `events`, one
entry per phase move plus the ones that explain a stop or a slow stage (a block
with its reason, a session start), and the newest twenty are kept so a long-lived
run does not grow the file without bound. The entries are structured, not
sentences: the panel renders them in the reader's language, and the server keeps
no copy of UI text. A run recorded before the trail existed has no `events` and
the panel says so rather than inventing the history. Every entry carries `at`,
including the phase moves `transition` writes: one entry without a time was once
enough to fail the whole runs answer and leave the panel with nothing.

### Why a run keeps the sessions it opened, not only the current one

`sessionId` is the session the phase in progress is polling, and every phase clears it when it moves on. The work a person wants to inspect afterwards — the fix, the review that asked for changes, the next fix — would otherwise have no link left anywhere. The ledger therefore appends each started session to `sessions` with the stop it served and its start time, bounded like the event trail. The panel draws them under their stop; a run recorded before the field has none, and the session still running covers that case.

### Why the panel's links carry no `/-/` separator

The route hands the panel `issueUrl` and `mrUrl` built as `/group/repo/issues/N`, not `/group/repo/-/issues/N`, because that is the form the deployment answers with: GitLab 12.7 (the intranet one) serves the short path and answers 404 on the `/-/` form, while a newer instance redirects the short one to the `/-/` one, and GitLab's API returns the short form as `web_url` on both. The route builds these two links itself — it does not read the source-control descriptor — so the descriptor's own lists were fixed separately (`../gitlab/DOCUMENTATION.md`, *Why GitLab links lead with the short form*).

### Why the runs answer reads the issue's own state

The ledger holds what the dispatcher decided, and the issue's `opened`/`closed`
state plus its labels are GitLab's to say. The list route reads them per run
through the bot account when the project has one and through the triggerer
otherwise, and caches each answer for a minute because the panel polls every ten
seconds. A failed read answers "unknown" (and keeps a previous value when there is
one): presenting a made-up `closed` would be worse than presenting nothing, and a
`done` run is not a proxy for it either — a person may close the issue first.

### Why `blockedReason` has an `invalid-template` value

The spec enumerates the reasons for blocked runs but has no value for a missing or invalid `类型:` line. Without one the ledger cannot say why the run is blocked. The value is added here and reads as the template problem it is.

### Why a label edit sends the whole set

GitLab 12.7 answers 400 to an issue update whose body carries only `add_labels` or `remove_labels`; it accepts those parameters from 12.10 on. The dispatcher reads the issue, computes the resulting set, and sends `labels`, which every version accepts. The read costs one request per label change and removes the version split entirely.

### Why a loopback remote may be plain HTTP

The push credential lease hands git a one-time helper for the remote host, and the endpoint is built from the remote URL. Local development runs the instance over plain HTTP on loopback, an origin the provider already accepts through `allowLoopbackHttp`, so that case gets an endpoint too. Every other remote still needs TLS before the lease is issued.

### Why a feedback round is a comment command with per-channel watermarks

A person reads the MR and types `@<bot> 修复` in the MR or the issue; the bot polls both note lists once per mr-open tick. Each channel carries its own watermark stored as a note id, so a comment that lands mid-round is either part of the next batch or waits for it — a shared time-based watermark would split or double-read comments whose clocks differ between channels. The command is a first-line mention of the bound bot username, never a hard-coded one, and only Developer-and-above authors count, the same bar the approval commands use. A mention without the command word is not a trigger; the bot answers it with usage so the silence a person would read as a broken bot is instead a one-line instruction.

### Why the first mr-open poll only sets the watermarks

The watermarks start null and the first poll records the newest note ids without triggering anything. Comments written while the run was still building predate the merge request, and a trigger that only fires from the moment the MR exists is what a person reading the issue expects; retroactively reacting to an old comment would start a round nobody asked for at that point. The init is persisted in the same poll, so it cannot run twice.

### Why addressing loops off mr-open instead of being a rail stop

The rail is the sequence every run walks from claim to an open merge request; a feedback round is a detour some runs never take. Adding a stop would stretch the rail for all of them, so the state machine holds `addressing` as its own phase while the rail, the panel and the run steps draw it at `mr-open`, where the loop started, with the round count shown beside it. The round reuses the branch, the worktree and the review gate: the session gets the feedback list, its evidence comes back in the implement contract, and the review reads the checklist item by item until it approves — a feedback round that skipped review would push unreviewed commits under an MR a human is already reading.

### Why the feedback prompt points at the diff instead of inlining it

The MR diff can be large and the agent works in the worktree that holds it, so the prompt names the base ref and the agent reads the diff itself; inlining it would balloon every feedback prompt for information the session fetches anyway. The feedback list, by contrast, is inlined: it is short, it is the round's actual task, and it is wrapped as untrusted data like the issue body, because a comment can carry injected instructions just as an issue can.

### Why the session title carries the stage

The sidebar and the tab strip are the only surfaces that show these sessions without opening the runs panel, and `#17: Fix login` alone cannot tell a fix round from a review or a feedback round once several sessions pile up on one issue. The title therefore ends with the stage label (`· 判定` / `· 方案` / `· 修复` / `· 审核` / `· 反馈修复第 N 轮`), written at creation and never changed after; the run itself stays the structural link, carried by the ledger, not by the title.

### Why a lost addressing worktree blocks instead of rebuilding

The mr-open worktree is the state the reviewer commented on. Rebuilding it from the pushed branch would fabricate a checkout nobody reviewed and let the session edit a different tree than the MR describes, so a missing worktree blocks with `worktree-missing` for a human reset.

### Why a run stops after five feedback rounds

Unbounded rounds let a two-person disagreement hold a session slot and burn model quota forever, with no point where the run says "this needs a human". Five rounds, counted in `feedbackRounds`, bound the loop; the block names `feedback-limit` and the blocked comment already carries the reset path.

### Why triage runs after the worktree instead of at claim time

The verdict has to read the repository, so it needs a checkout; a verdict written from the issue text alone would be a guess. The worktree is created at claim anyway, and a feature reuses the same checkout for its plan, so triage costs no second creation. Both kinds therefore go `claimed -> preparing -> triaging` instead of branching at claim, and only the phase after the verdict splits by kind.

### Why an approved plan does not go back through preparing

`preparing` now leads into triage. An approval that returned there would re-run the problem check on a scope a human just approved, and the second verdict could close an issue someone already decided to build. Approval goes straight to `implementing`; `waiting-approval -> preparing` is no longer a legal transition, so no later edit can reintroduce the detour.

### Why only an unfalsifiable report blocks and only a contradicted one closes

`insufficient-info` and `not-an-issue` look alike from the model's side and are opposites for the reporter. A report missing reproduction steps or a version cannot be checked, so closing it would punish the person who filed it for a form the template never enforced; it blocks, the issue stays open, and the reset path is the comment's ask for the missing detail. `not-an-issue` is reserved for the case the code, a test, or a doc contradicts the report, and the parser refuses the verdict without an `evidence` field, so the closing comment always names what a reader can check. `valid` stays the default because a gate that closes issues on ambiguity is worse than one that fixes something that did not need fixing.

### Why the bot closes the issue itself and a failed close blocks

The verdict is already written in the comment, so leaving the close to a human would leave an `ai-done` run pointing at an open issue, and the run would sit in the ledger as finished while the issue still looks queued. Closing with the bot credential finishes the run in one step. On GitLab 12.7 a Reporter may not be allowed to edit an issue; the catch cannot mark the run `done`, because the issue is still open and the panel would report a finished run over a live issue, so the run blocks with `not-an-issue` and the comment asks a human to close it.

### Why triage does not consume the retry budget

`MAX_ATTEMPTS` bounds infrastructure retries, and a triage pass is neither an implementation attempt nor the run's real work. Counting it would leave a run only one attempt for the session that actually edits files. The verdict branch resets `attempts` to zero and the triage session starts without incrementing it, which is how the review rounds already behave.

### Why a wrong not-an-issue verdict needs the ledger row removed

Reopening the issue is not enough to make the automation look at it again: `claim()` skips any issue that already has a ledger entry, so the reopened issue stays ignored even after `ai-ready` is re-added. A person who disagrees with the verdict reopens the issue, deletes that `done` row from `<data dir>/gitlab-issue-runs.json`, and adds `ai-ready`; the next scan claims it as a new run.

