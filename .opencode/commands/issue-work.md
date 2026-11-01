---
description: Work assigned local issues — menu, verify, fix with confirmation (spec: issue-local-spec/本地Issue自动修复决策方案.md)
---

Focus, if any: $ARGUMENTS

The maintainer assigned local issues (`.issues/*.md`, `state: todo` with a non-null `assignee`) and wants them driven toward a fix. Run this as a conversation, not a report.

1. **Gather the menu.** Scan `.issues/` for issues where `state` is `todo` and `assignee` is set — never `canceled`. Order by `priority` (urgent first, null last); break ties by severity: data-loss and regression first. Propose 3–5 candidates, one line each: the user-visible symptom, the traced mechanism (file:line) from `## Mechanism`, and rough size. Ask which to take — batches of related small fixes in one area are welcome.
2. **Check for work in flight.** Before proposing anything, drop a candidate that is already being worked: `state` is `in-progress`, or `git log --grep "fixes LOCAL-<n\>"` finds commits (word boundary — `LOCAL-1` must not match `LOCAL-11`). Session comments are context, not proof of in-flight work: report them with the candidate, and drop on them only when they show an active fix session. Name what you dropped and why; the fix belongs to its session.
3. **Route before fixing.** A candidate is fixable only when its `labels` include `root-cause:found` and its body has a `## Mechanism` section stating the mechanism with `file:line`.
   - Fixable: continue at step 4.
   - No repro, no mechanism, or the label without a mechanism: diagnose only, write the findings as a comment under `## Comments`, set `state` back to `triage`, bump `updatedAt`, and do not write code. Say why in the comment.
   - The fix changes a default, adds a button or setting, or is anything two reasonable people could disagree about: stop and ask the maintainer. Product decisions are settled in this conversation, never inside the diff.
4. **Verify the anchors.** The body's file:line cites age. The commit recorded under `## Environment` tells you how stale the report is; confirm the cited mechanism still exists on current main. If it is gone, say so, set `state` back to `triage` with a comment, and skip — never fix air.
5. **Fix properly.** Follow AGENTS.md instruction order (matching skills — sync bugs demand `sync-state-invariants`, hot paths `performance-engineering`); minimal fix plus a regression test per local precedent; focused validation.
6. **Close the loop.** Append the touched file paths (with `:line` when useful) to the issue body. Bump `updatedAt` with every state change. When self-verification passes (reproduction green, regression tests pass), set `state` to `done` and append a comment stating what the proof covered and what it did not. Write your decision and diagnostic comments under `## Comments` in the `### <ISO> · <source>` format yourself; do not copy what the status runtime posts from linked sessions, or the same event lands in the file twice. Commit only when the maintainer confirms, with `fixes LOCAL-<n>` in the message per fixed issue. Never commit or push without being asked.
