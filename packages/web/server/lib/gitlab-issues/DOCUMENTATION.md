# GitLab issue automation

The design and requirements live in `docs/gitlab-issue-spec/gitlab-issue-automation-spec.md`; this document describes the module as it is now.

## Ownership

This module turns one labeled GitLab issue into a reviewable merge request. It owns the polling dispatcher, the run ledger, the GitLab API adapter, the worktree and push boundary, and the two prompt contracts. It does not merge merge requests, it does not create issues, and it does not fix CI failures after a merge request opens.

- `dispatcher.js` is the timer and the phase loop: project scan cadence, claim, concurrency caps, leases, cancellation, timeout, recovery, and merge polling.
- `ledger.js` is the authoritative phase store at `<data dir>/gitlab-issue-runs.json`, keyed by `origin|projectId|iid`.
- `machine.js` declares the phases and the only legal transitions.
- `gitlab.js` parses the issue template, builds branch names, resolves accounts, and wraps the GitBeaker calls the dispatcher uses.
- `workspace.js` creates and removes worktrees, writes the commit identity, and runs authenticated fetch and push through a one-shot credential lease.
- `prompts.js` builds the plan and implementation prompts and validates the agent's structured output.

The GitLab labels are a mirror for humans. A label change a human makes is read back each tick; a label change the bot makes follows a ledger write.

## Invariants

- The ledger is authoritative. Every transition is written before the bot label or comment that announces it.
- One run per project and three globally occupy a dispatch slot. A slot covers `claimed`, `planning`, `waiting-approval`, `preparing`, `implementing`, and `verifying`.
- One claim per project per tick and three globally. The issue list is read every third tick, at most three pages of 100; active runs are checked every tick.
- The agent never pushes. The server pushes only after the branch prefix, a non-empty tree diff against the target, and the evidence note all validate.
- Push and merge-request creation use the triggerer's credential. Fetch and comments use the bot credential. Neither token enters the prompt, a log line, a commit, or the merge request body.
- The server never force-pushes and never writes to the default or a protected branch.
- Issue text is untrusted. The prompt keeps it inside `<issue-content untrusted="true">`, and every structured field is validated before it reaches a comment or a merge request.
- A dirty worktree is never deleted. The path is commented and kept in the ledger.
- A failed issue list read is a skipped tick, not an empty result.

## Decisions

### Why a feature rebinds its actor at approval

The spec defines the triggerer of a bug as whoever added `ai-ready`, and of a feature as whoever answers `/ai-approve`. A plan therefore starts under the `ai-ready` adder (that account still has to exist to claim the issue), but the transition to `preparing` rewrites `actorUserId` and `actorAccountId` to the approver and rewrites the worktree identity with the approver's name and email. Push and merge request then belong to the approver, which is what the contribution history is expected to show.

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

A verifying run's session is already finished; its state belongs to the branch and the merge request, not to the session. Recovery therefore only checks `planning`, `preparing`, and `implementing`. A lost session returns to `implementing` when the branch has commits and to `claimed` when it does not. Waiting-approval and verifying continue from their stored phase.

### Why the bot account is re-read every tick instead of a paused-project set

A paused set survives the credential update that fixes the problem, so the project would never resume without a restart. Re-reading the account costs one credential-store read per enabled project and lets the next tick resume as soon as the settings point at a valid account.

### Why `blockedReason` has an `invalid-template` value

The spec enumerates the reasons for blocked runs but has no value for a missing or invalid `类型:` line. Without one the ledger cannot say why the run is blocked. The value is added here and reads as the template problem it is.
