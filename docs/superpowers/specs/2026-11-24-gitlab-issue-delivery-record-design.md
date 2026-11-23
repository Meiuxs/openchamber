# GitLab issue delivery record

**Date:** 2026-11-24
**Status:** Design approved in conversation. Implementation not started.
**Scope:** GitLab issue automation server and the runs panel. Local issue automation is unchanged.

## Goal

Every GitLab issue run keeps one Markdown delivery note for review and handoff. The server writes the note into the project's checkout, after every ledger change, and never commits it. One file per issue, reused across runs.

The note answers the question a reviewer or the next owner asks: what did this issue produce, how was it verified, what did review say, what could break, and where is the merge request.

## Why the server writes it

The agent already returns structured fields for each phase. The server validates them, posts them as issue comments, and stores them in the ledger. Writing the note from the ledger gives the same content on every render, works for read-only phases such as triage and planning, and survives a lost session.

An agent-written note would depend on prompt compliance. Triage and planning sessions cannot write files at all. A note written in the worktree would also make the worktree dirty, and the current cleanup rule keeps a dirty worktree forever.

## Non-goals

- No agent-authored prose beyond the structured JSON fields.
- No commit, stage, or push of the note. No change to the repository's tracked `.gitignore`.
- No collection of images, binaries, or generated artifacts.
- No change to issue comments, merge request text, or labels.
- No backfill of content that a run never recorded. An old run gets a note with the sections its ledger can fill.

## Constraints

- The ledger stays authoritative. The note is a rendering, not a second store.
- Git facts must be captured while the worktree exists, before cleanup removes it.
- Git commands stay compatible with Git 2.20.
- Issue text, review findings, and feedback are untrusted. They are rendered as text, never interpreted.
- The note path uses the issue number, not the title, so a title edit does not move the file.
- The file must not appear in `git status`. `.openchamber/issue-records/` is added to `.git/info/exclude`, which is local to the clone and never committed. The whole `.openchamber/` is never excluded: the server and the app keep tracked files there (`project.json`, `plans/`, `notes-todos.json`, `workflows/`), and hiding it would make new notes and workflows look lost.
- The runs answer and the panel treat the note as optional, so an older server still lists.

## Approaches

**A. Server renders from the ledger.** A new `record.ts` renders Markdown and rewrites the file from the dispatcher tick. Chosen.

**B. Agent writes in the worktree, server copies.** Richer prose, but read-only phases cannot write, prompt compliance is uncertain, and the dirty worktree blocks cleanup.

**C. Server renders only at milestones.** Fewer writes, but a run blocked mid-phase has a stale or missing note, which is the moment handoff matters most.

Approach A costs one small render per tick per run. The ledger already updates on every phase change, so the note is current at every point a person can look.

## Design

### File location

```
<checkout>/.openchamber/issue-records/<namespace>/<repo>/issue-<iid>.md
```

- `<checkout>` is the local folder of the settings entry that claimed the run, resolved from `run.projectEntryId`. The dispatcher already has it as `context.project.path`; the runs route resolves it from `readProjects()`.
- The `<namespace>/<repo>` part is the GitLab `projectPath` already stored on the run. It keeps two GitLab projects that share one checkout from colliding on an issue number.
- `issue-<iid>.md` is stable for the life of the issue. A rerun after a manual reset rewrites the same file.
- `.openchamber/issue-records/` is appended once to `.git/info/exclude`. The path comes from `git rev-parse --git-path info/exclude`, with `<checkout>/.git/info/exclude` as a fallback. Existing content is kept, and a duplicate line is not written.
- When the exclude file cannot be written, the record moves to `<checkout>/.git/openchamber/issue-records/<namespace>/<repo>/issue-<iid>.md`. That path never appears in `git status`, so the promise holds without blocking a push on a read-only `.git`.
- Writes are atomic: write a temporary file in the same directory, then rename.
- If the rendered text matches the existing file, no write happens. A tick that changes nothing does no disk I/O beyond the read.

### Document shape

Section headings are Chinese, matching the automation's issue comments. Field values are written as the model returned them.

```markdown
# <title> (#<iid>)

| 项目 | <namespace/repo> |
| 类型 | bug / feature |
| 阶段 | <phase> |
| 目标分支 | <targetBranch> |
| 源分支 | <branch> |
| 触发人 | <actor> |
| 审批人 | <approvedBy> |
| Issue | <url> |
| 合并请求 | <mrUrl> |
| 阶段开始 | <since> |
| 最近事件 | <last event time> |

## 交付摘要
判定结论、方案要点、根因与改动，取自 triage / plan / evidence。

## 变更文件
| 文件 | 状态 | + | - |
取自 changeSummary。

## 提交
- <sha> <subject>
取自 changeSummary。

## 验证
- 会话自验：`command` -> `result`
- 服务端验证：`command`，退出码 <code>，输出摘要 <tail>
取自 evidence.verification 和 verifyResult。

## 审核
- 最终结论、审核轮数、复核结论
- 历次审核：序号、类型（审核/复核）、轮次、结论、摘要、发现列表
- 合并影响：模块、业务影响、兼容性、回滚、测试范围
取自 reviewHistory、reviewVerdict、recheckVerdict、reviewImpact。

## 反馈修复
- 每轮：轮次、反馈条目、时间
取自 feedbackHistory。

## 运行时间线
- <time> <event>
取自 events，标注只保留最近 20 条。

## 未完成与阻塞
阻塞原因、服务端错误、保留的工作区路径。
```

The header never uses `updatedAt`. Every tick calls `touch`, which rewrites `updatedAt` through `ledger.update`, so a value from it would change every ten seconds and defeat the identical-content check. `since` and the last event time move only on real transitions.

Empty sections are omitted. The footer states that the file is generated by the automation and is not part of the commit.

The record does not quote the issue description. It links the issue instead, because the description can change and is already one click away.

### Untrusted text

Issue titles, review summaries, finding notes, and feedback text come from people and from a model that read people's text. The file preview renders Markdown, so they are escaped before they become part of the document.

- Table cells: escape `\` first, then `|`, and turn newlines into spaces.
- Single-line fields: escape `\`, then `` ` ``, `*`, `_`, `[`, `]`, `(`, `)`, `!`, `<`, `>`, and `&`. A leading `#`, `-`, `>`, or `1.` is escaped too, so it cannot become a heading or list.
- Multi-line fields: each line gets the single-line treatment, and lines are joined with a hard line break. This keeps the text readable and stops a line from opening a section.
- Finding notes and feedback items longer than one line are rendered in a fenced block. The fence uses one more backtick than the longest run in the content, so a triple backtick inside a reviewer's comment cannot close it.

The exporter never trusts a field to be one line. A newline in a cell is the common case, not the exception.

### New ledger fields

Everything is optional on read, so old entries still render.

| Field | Shape | Written when |
|---|---|---|
| `changeSummary` | `{ baseRef, files: [{ path, status, added, removed }], commits: [{ sha, subject }], capturedAt }` | after implement or feedback evidence, before block cleanup, and at verifying |
| `verifyResult` | `{ command, code, outputTail, at }` | the server verify command finishes, pass or fail |
| `approvedBy` | `{ login, userId, accountId, at }` | the approve command is accepted |
| `reviewHistory` | `[{ seq, kind, round, verdict, summary, findings, at }]` | every review and recheck answer |
| `feedbackHistory` | `[{ round, items: [{ author, text }], at }]` | every feedback batch |

Bounds: 10 review entries, 5 feedback entries, 50 feedback items per entry, 2000 characters per item, 4000 characters of verify output. The caps match the ledger's existing event and session caps.

No `recordPath` is added to the ledger. The path is derived from the checkout and the issue number, and the runs route reports it only when the file exists. A stored absolute path would go stale when a project folder moves, and a computed path without the existence check would offer a link to a file that was never written.

`reviewHistory` replaces the derived round number. `seq` is the run-wide review pass count, assigned as `length + 1`, so it stays monotonic across feedback rounds, which reset `reviewRounds` to zero. `kind` is `review` or `recheck`. `round` keeps the phase-local `reviewRounds` value for readers who compare it with the issue comments. This keeps a feedback round from appearing as round 0 and keeps a recheck from overwriting the first reviewer's entry. `reviewFindings` stays as it is.

### Capturing git facts

A new helper in `workspace.ts` returns, for `cwd` and `baseRef`:

- `git diff --numstat base...HEAD`
- `git diff --name-status base...HEAD`
- `git log --format=%h%x09%s base..HEAD`

Both diff commands run against the merge base, which is what the MR shows. A failing command captures nothing and leaves the previous summary in place. The helper never throws into the tick.

Call sites:

1. After an implement or feedback session produces evidence, before the transition to reviewing.
2. In `blockWithComment`, before `cleanupWorktree`. This is the only place that still has the worktree for a run that blocks before verifying.
3. In `handleVerifying`, before the push.

### Writing from the dispatcher

The tick already resolves a context per run. Build a second map from `projectEntryId` to the project path using the same `listProjects()` result. The path does not depend on a usable GitLab account, so a broken bot credential does not stop the record.

After `processRun` and after the claim scan, re-list the ledger and call `writeRunRecord` for each run whose checkout path resolves. The writer renders, compares, and writes. It returns the path it used, which the gate can report in a blocked comment; nothing about the path is persisted in the ledger.

Failures are logged with `warn` and do not change the run, except at the verifying gate below.

### The gate

`handleVerifying` captures the final change summary and verify result, writes the record, then asks for a push credential. If the write fails or no checkout path resolves, the run blocks with `record-write-failed` and the push does not happen.

The blocked path keeps the worktree. It uses the ordinary `block` call, not `blockWithComment`, because the latter cleans the worktree before blocking and a retry would have nothing left to push from. The blocked comment and the `ai-blocked` label are posted explicitly.

`record-write-failed` is retryable in place. `handleBlocked` tries the write again on every tick. On success it removes `ai-blocked`, adds `ai-working`, posts a short note, and transitions back to `verifying`; the phase table gains `blocked -> verifying` for this reason. On failure it stays blocked without posting the same comment again. A blocked run holds no dispatch slot, so a broken path cannot starve other projects. The manual reset path stays available: a person who removes `ai-blocked` and keeps `ai-ready` deletes the entry and starts over.

`record-write-failed` joins the blocked reasons, the machine's reasons, the panel's guide keys, and the i18n dictionaries. The guide says the delivery note could not be written and names the local path.

The gate only cares whether the note exists. A failed `.git/info/exclude` write is not a failure: the writer falls back to the `.git` path, and the gate passes.

This is the only place where the note can stop a run. Everywhere else it is a best-effort record.

### Runs route and panel

`toRunView` adds:

- `recordPath`: the absolute path of the note, or null.
- `projectDirectory`: the checkout path used to open the file, or null.

Both are derived from `projectEntryId` through `readProjects()`. The route checks the primary path first and the `.git` fallback second, and returns `recordPath` only when one of them exists. A run whose settings entry is gone returns null for both. The renderer and the route share one path helper so the two cannot disagree. The existence check is one `fs.access` per scoped run, next to the issue-state read the route already performs.

`runModel.ts` reads both as optional. `RunDetail` shows a delivery note action beside the issue and merge request links when `recordPath` is set. The action opens the file through the existing local file path, `useUIStore.getState().openContextFile(projectDirectory, recordPath)`, which already covers web, desktop, VS Code, and mobile.

The section nav does not change. The note is a separate document, not a section inside the panel.

### Documentation

- `packages/web/server/lib/gitlab-issues/DOCUMENTATION.md`: the record, its location, the capture points, and the verifying gate.
- `docs/gitlab-issue-spec/gitlab-issue-automation-spec.md`: a new section for the delivery record.
- `packages/ui/src/components/gitlab-runs/DOCUMENTATION.md`: the note action and the optional fields.
- i18n dictionaries: the action label and the `record-write-failed` guide, in every locale.

## Failure and edge cases

- **Checkout path unresolved.** No write. At verifying, blocks and retries in place. Elsewhere, warns.
- **Workspace write fails.** Same as above. Permission errors are the common cause.
- **Exclude path is read-only.** The note goes to the `.git` fallback. A push is not blocked.
- **`record-write-failed` persists.** The run stays blocked, keeps its worktree, and holds no dispatch slot. The issue carries the path that failed, and the manual reset path still works.
- **Record exists but the ledger entry is gone.** The file stays. Ledger retention deletes a done run after 30 days and does not touch the file.
- **Worktree retained because it is dirty.** The note names the retained path.
- **Two runs on one issue.** Only one ledger entry exists per issue, so only one file. A manual reset deletes the entry and the next claim rewrites the same file.
- **Old runs.** Missing fields omit their sections. The note still renders from phase, events, and sessions. The first tick after the upgrade writes the file.
- **Concurrent writes.** Only the dispatcher tick writes, and ticks are serialized. The atomic rename handles a reader opening the file mid-write.
- **A repository that ignores `.openchamber/` already.** The exclude entry is still appended once; duplicates are harmless.
- **`.openchamber/` holds tracked files.** Only `issue-records/` is excluded, so notes and workflows the app writes there keep appearing in `git status`.

## Testing

- `record.test.js`: renders every section; omits empty sections; caps long text; escapes table cells, leading markers, and fences; stable path from project path and iid; identical content skips the write; the `.git` fallback is used when the exclude write fails; atomic write failure surfaces.
- `workspace` tests: the change summary parses numstat, name-status, and log output, and a failing command yields null without throwing.
- `dispatcher` tests: capture at evidence, capture before block cleanup, verifying blocks on write failure and keeps the worktree, a blocked `record-write-failed` run returns to verifying when the write succeeds, done run writes after cleanup, review and feedback history stay bounded, `seq` stays monotonic across feedback rounds.
- `routes` tests: `recordPath` and `projectDirectory` present when the file exists and the settings entry resolves, null for a missing file or a deleted entry.
- `RunDetail` tests: the action appears with a record and is absent without one.
- Docs and i18n checks as the repository requires.

## Left to the builder

- The exact Chinese wording of headings and the footer.
- Whether the note action sits beside the links or in the header actions area, following the panel's current layout.
- The final caps, if the numbers above prove awkward in practice.
