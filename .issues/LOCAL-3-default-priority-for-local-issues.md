---
identifier: LOCAL-3
title: 本地 issue 默认应有优先级且不应存在无优先级
state: done
priority: medium
labels: [root-cause:found]
assignee: assistant
createdAt: 2026-11-01T13:25:03.354Z
updatedAt: 2026-11-01T15:25:38.989Z
feature: null
blockedBy: []
---
## Symptom
新建本地 issue 时默认优先级为无（none/null），且优先级选择下拉项中允许选择无优先级。

## Reproduce
1. 打开看板 SourceBoard 的本地（Local）页签。
2. 点击新建议题按钮打开 TrackerIssueDialog 弹窗。
3. 优先级下拉框默认选中「无」，且可主动选择「无」；保存后落盘的 markdown 文件 frontmatter 中 `priority` 为 `null`。

## Environment
web, win32, branch main (commit ec9721702099e98696b1b95dc205d8733d066d1f)

## Evidence
- `packages/ui/src/components/sourceBoard/TrackerIssueDialog.tsx:18` 定义了 `PRIORITIES: readonly TrackerPriority[] = ['none', 'urgent', 'high', 'medium', 'low']`
- `packages/ui/src/components/sourceBoard/TrackerIssueDialog.tsx:60` 默认状态为 `initial?.priority ?? 'none'`
- `packages/web/server/lib/local/tracker.js:50` 的 `normalizePriority` 将 `none` 转为 `null` 写入 frontmatter
- 当前调试与代码走查会话

## Mechanism
在 `packages/ui/src/components/sourceBoard/TrackerIssueDialog.tsx:18` 中，优先级候选列表包含了 `'none'`，且在 line 60 默认选中 `'none'`。用户新建议题未手动更改优先级时，表单向后端发送 `{ priority: 'none' }`。在 `packages/web/server/lib/local/tracker.js:50` 的 `normalizePriority` 将 `'none'` 规范化为 `null`，并通过 `packages/web/server/lib/local/scanner.js:460` 保存到 `.issues/LOCAL-<n>-<slug>.md` frontmatter 的 `priority: null`。应调整默认优先级（如 `medium`）并移除「无」优先级选项，确保本地 issue 始终有确定优先级。

## Comments

### 2026-11-01T14:18:00.000Z · assistant
与维护者确认产品决策：本地 issue 默认优先级为 low（低），彻底移除「无」优先级选项。开始推进 UI 表单与服务端落盘默认值修复。

### 2026-11-01T15:25:38.989Z · assistant
修复完成。落盘路径三处都归一为 `low`：`TrackerIssueDialog` 的 `PRIORITIES` 去掉 `none` 且默认 `low`（`packages/ui/src/components/sourceBoard/TrackerIssueDialog.tsx:18,61`）；`normalizePriority` 把 `none`/缺失转 `low`，create 与 edit 都过这一层（`packages/web/server/lib/local/tracker.js:48-50,340,355`）；scanner 缺省写 `low`（`packages/web/server/lib/local/scanner.js:440,470`），读取侧 `issue.priority ?? 'low'` 兜底旧文件（`tracker.js:143`）。存量两个 `priority: null` 的文件（LOCAL-1、LOCAL-2）已改写为 `low`；`.opencode/commands/local-issues.md` 的建单规则不再允许 `null`。测试覆盖：`server/lib/local/tracker.test.js:118`（create/edit 归一 + 文件内容断言）、`TrackerIssueDialog.test.tsx`（默认 low、旧数据 none 编辑后写 low）。规格升到 v2.8（决策 27）。
