---
identifier: LOCAL-10
title: 本地议题没有发表评论的入口，用户无法对 issue 评论
state: in-progress
priority: medium
labels: [ui, root-cause:found]
assignee: assistant
feature: null
blockedBy: []
createdAt: 2026-11-01T17:20:54.000Z
updatedAt: 2026-11-01T17:53:17.191Z
---
## Symptom
本地 issue 的详情预览面板只展示评论列表，没有输入评论的地方。用户想对某个 issue 补充信息、回答智能体的问题或反馈修复结果时，没有任何 UI 入口，只能手工编辑 `.issues/` 下的 markdown 文件。

## Reproduce
1. 在看板中打开任意本地 issue 的详情预览。
2. 滚动到下方评论区。
3. 观察到只有评论列表（含系统/会话写入的评论），没有输入框或发表按钮。

## Environment
web, win32, main @ ec972170 附近；评论渲染在 `packages/ui/src/components/references/ReferenceComments.tsx`

## Evidence
- 用户报告：「当前的评论用户不能对 issue 进行评论，没有发表评论的地方」。
- 代码现状：评论数据来自 issue 文件的 `## Comments` 小节（`### <ISO> · <作者>` 条目），由 `packages/web/server/lib/local/tracker.js` 解析后在 `ReferenceComments.tsx` 渲染；UI 中没有对应的写入控件，写评论意味着直接改文件。
- 来源：用户，2026-11-01。

## Mechanism
评论是只读链条，三层都只有"读"没有"写"：

1. **UI 层**：`packages/ui/src/components/references/ReferencePreview.tsx` 的 `CommentsSection`（:263-303）把评论条目交给 `ReferenceComments.tsx` 渲染列表后即结束，没有任何输入控件，也没有提交回调。
2. **路由层**：`packages/web/server/lib/trackers/routes.js` 只暴露 `items/list`、`items/get`、`items/update/create/edit`、`DELETE items`、`session-status`（:103-256），没有发表评论的路由；`tracker-contract.d.ts` 的 tracker 接口也没有 add-comment 方法（评论只作为 `sessionStatus.post` 的副产物存在）。
3. **本地 tracker 层**：写文件的机制其实已经齐了——`packages/web/server/lib/local/files.js` 的 `appendComment`（重建规范化 `## Comments` 小节、自动 bump `updatedAt`）+ `writeIssue`（tmp+rename 原子写）；`tracker.js` 的 `postSessionStatusOnce`（:262-281）就是 `scanner.get` → `readIssue` → `appendComment` → `writeIssue` 的现成样板，缺的只是一个面向用户评论的入口方法。

修复形状（最小完整变更）：

- **contract**：`tracker-contract.d.ts` 的 tracker 接口加一个可选方法 `comment({ id, body, containerId, projectDirectory })`（可选，Linear 不实现即不受影响，路由层用 `typeof tracker.comment === 'function'` 判断能力）。
- **local tracker**：`tracker.js` 实现 `comment`，照抄 `postSessionStatusOnce` 的样板：`scanner.get` 定位文件 → `readIssue` → `appendComment(parsed, { iso: nowIso(), source: 'user', text })` → `writeIssue`。评论作者标 `user`（本机安装无多用户概念，与 `### <ISO> · <source>` 标题格式一致；不同于 session 评论的 `session <短id>`）。
- **路由**：`routes.js` 加 `POST /api/tracker/:provider/items/comment`（body 带 id 与 text），tracker 没有该方法时返回 501 并说明该 tracker 不支持。
- **UI**：`ReferenceComments.tsx` 列表末尾加一个输入行（回车或按钮提交），仅在 provider 支持（`/api/tracker/providers` 或 detail 响应标明）时渲染；提交成功后走已有的 detail 重载路径刷新评论列表。
## Comments

### 2026-11-01T17:22:00.000Z · assistant

根因分析完成：三层（UI 渲染、HTTP 路由、tracker 接口）都缺少用户评论的写路径；本地 tracker 的文件写入机制（appendComment + writeIssue）已存在，postSessionStatus 是现成样板。修复形状已写入 Mechanism。未覆盖：UI 输入行的具体交互样式（交给修复会话按设置页/预览面板既有控件风格定）。

### 2026-11-01T17:23:50.553Z · session ses_e67dc6da

Session started — auto-dispatch

### 2026-11-01T17:25:33.435Z · session ses_e67dc6da

Session completed — auto-dispatch

### 2026-11-01T17:53:12.497Z · user

Route smoke test: user comment posted via API.

### 2026-11-01T17:53:17.191Z · user

Route smoke test: user comment posted via API.
