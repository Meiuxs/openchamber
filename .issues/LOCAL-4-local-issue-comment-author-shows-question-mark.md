---
identifier: LOCAL-4
title: 本地 issue 评论作者显示为问号
state: done
priority: medium
labels: [root-cause:found]
assignee: assistant
createdAt: 2026-11-01T14:48:00.000Z
updatedAt: 2026-11-01T15:40:00.000Z
feature: null
blockedBy: []
---
## Symptom
在本地 issue 的详情预览面板中，评论列表里评论人的头像显示为问号 ?，作者名字显示为破折号 —。

## Reproduce
1. 在 `.issues/` 下的 issue 文件中添加一条包含 `## Comments` 的评论（例如 `### 2026-11-01T12:00:00Z · session a1b2`）。
2. 在看板中打开该本地 issue 预览详情。
3. 观察下方评论区域，评论作者头像显示为 `?`，名称显示为 `—`。

## Environment
web, win32, main @ ec9721702099e98696b1b95dc205d8733d066d1f

## Evidence
- `packages/web/server/lib/local/tracker.js:168-173` 在解析 `## Comments` 转换为 `TrackerItem` 时，将 `author` 写死为 `null`：
  ```javascript
  comments: comments.map((comment, index) => ({
    id: `comment-${index}`,
    body: comment.text,
    createdAt: comment.iso,
    author: null,
  }))
  ```
- `packages/ui/src/components/references/ReferenceComments.tsx:40` 在头像回退逻辑中直接取 `comment.author`，若为 `null` 则渲染 `?`：
  ```tsx
  <span>{(comment.author ?? '?').slice(0, 1).toUpperCase()}</span>
  ```
- 当前排查会话

## Mechanism
在 `packages/web/server/lib/local/files.js:268` 中，解析 Markdown 评论头 `### <iso> · <source>` 会提取出 `source` 字段。但在 `packages/web/server/lib/local/tracker.js:168-173` 的 `toTrackerItem` 函数中，映射评论对象时并未将 `comment.source` 转化为 `TrackerPerson` 结构（`{ name: comment.source, avatarUrl: null }` 或对应的作者信息），而是硬编码了 `author: null`。前端在 `ReferencePreview.tsx:836` 映射评论属性时执行 `author: comment.author?.name ?? null`，致使最终传递到 `ReferenceComments.tsx` 的 `author` 为 `null`，头像回退为 `?`，作者名回退为 `—`。

## Fix
- packages/web/server/lib/local/tracker.js:172
- packages/web/server/lib/local/tracker.test.js (regression test: names a comment author from the source its heading records)

## Comments

### 2026-11-01T15:40:00.000Z · assistant
Anchor confirmed on current main (tracker.js:172 was still `author: null`). The comment author is now built from the heading source, e.g. `session a1b2`. Proof: new vitest case plus the 22 tests in tracker.test.js pass. Not covered: visual check in the running board.
