---
name: gitlab-mr-auto-fix
description: Use when asked to automatically fix, diagnose, or resolve GitLab MR CI failures or review comments using glab CLI, isolated git worktrees, structured Issue reports, and feature branch pushes.
---

# GitLab MR Auto-Fix Workflow

Automate diagnosing, fixing, and verifying GitLab MR CI failures or review comments. All operations use the `glab` CLI and operate in an isolated Git worktree to protect the local working tree.

## Workflow Phases

```
[1. Context & Filter] -> [2. Local Repro] -> [3. Report to Issue] -> [4. Worktree Fix] -> [5. Verify & Push]
```

### Phase 1 — Context Extraction & Failure Filtering

1. Read MR details:
   ```bash
   glab mr view <MR_ID>
   ```
   Extract:
   - Target and source branches (`<FEATURE_BRANCH>`).
   - Associated Issue ID (e.g. `Fixes #123`, `Closes #123`, or related issue mention).
   - Latest pipeline ID and status.

2. Check circuit breaker:
   Inspect the latest commit on the feature branch:
   ```bash
   glab mr view <MR_ID>
   ```
   If the latest commit message contains `[auto-fix]` and the pipeline still failed:
   - **Stop immediately**. Do not attempt another automated push.
   - Post an alert note on the Issue/MR asking for manual intervention.

3. Classify failure via `glab ci trace`:
   ```bash
   glab ci trace
   ```
   - **Infrastructure errors** (Runner timeout, network blip, Docker image pull error, 502/503):
     Call `glab ci retry` or report as infra failure. Do not modify code.
   - **Code/Test errors** (Compilation failure, syntax error, linter failure, unit/integration test failure, review comment):
     Proceed to Phase 2.

### Phase 2 — Local Reproduction & Diagnosis

1. Identify the exact failing file, line, and assertion from the CI trace or review discussion.
2. Formulate a local reproduction command:
   - Prioritize targeted test runner (e.g. `bun test path/to/failing.test.ts`, `npm test -- -t "test name"`).
   - Fall back to standard project check (`bun run check:changed --base HEAD`).
3. Run the reproduction command to confirm the failure is consistently reproducible.

### Phase 3 — Post Diagnostic Report to Issue

1. Check for duplicate comments:
   Query existing notes to ensure `<!-- gitlab-mr-fix: pipeline-<PIPELINE_ID> -->` was not already posted:
   ```bash
   glab issue view <ISSUE_ID> --comments
   ```
   If already posted for this pipeline, skip reposting.

2. Target determination:
   - If an associated Issue ID exists: post to that Issue.
   - If no Issue is linked: fall back to MR discussion (`glab mr note <MR_ID> -m "..."`).

3. Post the structured report:
   ```bash
   glab issue note <ISSUE_ID> --message "$REPORT_BODY"
   ```

   **Report Template**:
   ```markdown
   <!-- gitlab-mr-fix: pipeline-<PIPELINE_ID> -->
   ### 🔍 缺陷定位与修复报告

   - **关联 MR**：!<MR_ID>
   - **影响分支**：`<FEATURE_BRANCH>`

   #### 1. 根因分析
   [详细描述触发 Bug 或 CI 失败的核心机制，说明为何会产生该现象]

   #### 2. 关联代码
   - 关键文件与行号：`path/to/file.ts:123`
   - 关键函数/模块：`functionName()`
   - 涉及提交：`abc1234`

   #### 3. 复现路径与验证现象
   - 复现命令：`bun test path/to/test.ts`
   - 报错现象/堆栈摘要：
     ```text
     [关键错误输出]
     ```

   #### 4. 解决方案与变更说明
   - [说明具体的改动逻辑及边界考虑]
   - 预期效果：[说明本地验证结果]
   ```

### Phase 4 — Worktree Isolation & Minimal Fix

1. Create a clean temporary worktree from the remote feature branch:
   ```bash
   git fetch origin <FEATURE_BRANCH>
   git worktree add -b fix/mr-<MR_ID>-temp ../temp-mr-<MR_ID>-worktree origin/<FEATURE_BRANCH>
   ```
   *Note: Do not checkout or modify the main working directory.*

2. Navigate into the worktree directory:
   Apply the minimal necessary fix addressing the root cause. Do not include unrelated formatting or refactoring.

3. Run verification checks inside the worktree:
   - Run the reproduction command to verify it now passes.
   - Run project standard checks (`bun run check:changed --base HEAD` or equivalent).

4. Verification gate:
   - **If checks fail**: Do not commit or push. Clean up worktree, post the failure details to the Issue/MR note, and stop.
   - **If checks pass**: Proceed to Phase 5.

### Phase 5 — Commit, Push & Notification

1. Inside the worktree, commit with the `[auto-fix]` marker using existing user git identity:
   ```bash
   git commit -m "fix: resolve MR !<MR_ID> CI failure [auto-fix]"
   ```

2. Push directly from the worktree to the remote feature branch:
   ```bash
   git push origin HEAD:<FEATURE_BRANCH>
   ```

3. If the fix was addressing a review discussion, reply to that discussion thread without resolving it:
   ```bash
   glab mr note <MR_ID> --message "已针对该问题提交修复提交: [auto-fix] $(git rev-parse --short HEAD)"
   ```

4. Clean up the temporary worktree:
   ```bash
   cd <MAIN_WORKSPACE>
   git worktree remove ../temp-mr-<MR_ID>-worktree --force
   git branch -D fix/mr-<MR_ID>-temp
   ```

5. Safely notify the main workspace:
   Execute `git fetch origin <FEATURE_BRANCH>` in the main workspace so remote commits are fetched, and notify the user:
   "修复已验证并通过 `[auto-fix]` 推送至远端 `<FEATURE_BRANCH>`。本地主工作区未受影响，后续保存当前改动后可执行 `git pull --rebase`。"

## Rules & Safety Constraints

- **Only glab CLI**: All GitLab interactions must use `glab` commands.
- **Zero local tree disruption**: Never run `git checkout`, `git merge`, or `git reset` in the primary workspace. Always use a temporary worktree.
- **Circuit breaker**: Exactly 1 automated fix attempt per pipeline. A failing `[auto-fix]` commit stops the automation.
- **Strict verification gate**: An unverified fix is never pushed.
