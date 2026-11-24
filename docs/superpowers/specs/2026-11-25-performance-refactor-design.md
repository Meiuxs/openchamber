# OpenChamber 性能重构设计（分阶段）

- 日期：2026-11-25
- 状态：待评审
- 范围：构建体积与首屏加载、事件 reducer 热路径、轮询可见性、服务端缓存
- 推进方式：分阶段，每阶段独立提交、独立验证、可回滚

## 1. 意图与为什么

当前工作区（`main`，含未提交的版本号改动）已经完成过大量性能工作：SSE 增量合并（`packages/web/server/lib/event-stream/delta-coalescer.ts`）、流式文本节流（`useStreamingTextThrottle.ts`）、LegendList 虚拟化、`useTimelineRows` 的 previous-ref 复用、`persist-cache` 节流等。进一步优化不应重做这些链路，而应处理实测中仍然明显的两类开销：

1. **构建产物过大**：`packages/web/dist` 的 JS 约 55 MB；Shiki 语法包 15.4 MB 中约 7.4 MB 是同一份内容的重复副本；KaTeX 产出两份（`katex.min` 1.51 MB + `vendor-katex` 270 KB），占 Web 首屏预加载的约 69%。
2. **每个流式事件都要走的 reducer 热路径**存在线性查找与重复序列化。

目标是在不改变外部行为、不破坏打包链路、保持可合并上游的前提下，降低首屏下载/解析成本与流式期间的 CPU 开销。

## 2. 目标 / 非目标 / 反目标

### 目标

- **Web/PWA 首屏**（唯一验收口径）：当前 108 个 modulepreload / 2.59 MB 原始 / 0.73 MB gzip；去掉重复的 KaTeX 后目标 **≤ 2 个 KaTeX chunk、首屏 ≤ 1.9 MB 原始**。（Electron 的 91 个注入预热项不在本次验收范围，保持现状。）
- 产物中去重 Shiki 语言包（目标减少 ≥ 6 MB）与重复的 KaTeX（只保留一份）。
- reducer 每次事件的消息查找从 O(n) 降为 O(1) 常态 + O(n) 兜底；移除每次事件的整对象 `JSON.stringify` 比较。
- 后台/失焦时暂停或降频无意义的轮询。
- 服务端 `git status` 等高频读取有明确的缓存与失效策略。

### 非目标

- 不改写聊天渲染、SSE 合并、虚拟列表等已完成优化的链路。
- 不改视觉、i18n 文案、依赖版本。
- 不改持久化 store 结构或磁盘缓存格式。
- 不整体重构 5000 行的 `git/service.ts`。

### 反目标（即使"能跑"也算失败）

- 为了省 CPU 直接删掉事件结构校验而没有等价廉价守卫，导致畸形事件能击穿 reducer。
- 为了瘦身把首屏依赖改成懒加载但造成首屏白屏时间变长或公式/预览明显延迟。
- 大爆炸式改动、无法按阶段回滚。
- 产物 chunk 路径变化破坏 Electron / 离线包 / VSCode 打包。

## 3. 约束

- 单个代码库多入口：`index.html`、`mobile.html`、`mini-chat.html`；`packages/web/dist` 会被 Electron（`resources/web-dist`）、离线包、VSCode 扩展消费。任何 chunk 变更必须保证这些入口构建通过。
- 仓库已有 `knip.json`、`oxlint`、`tsc`、Bun 测试与既有基线失败（UI 约 16 个与改动无关的失败，见记忆 `ui-suite-baseline-failures`）。验收一律与基线对比。
- 工作区不是干净状态（`package.json` 版本、`bun.lock`、`scripts/delivery/RELEASE-NOTES.md` 已修改）。开工前先建分支，阶段提交只包含本阶段文件，不碰既有未提交改动。
- 上游可合并性：优先改配置与新增窄接口，少动大文件结构。

## 4. 方案选择

| 方案 | 说明 | 取舍 |
|---|---|---|
| A. 分阶段推进（已选） | bundle → reducer → 轮询 → 服务端，每阶段提交 + 验证 | 每步可回滚、问题定位快；周期稍长 |
| B. 只做 bundle | 先拿最大收益 | 首屏改善明显，但流式 CPU 与后台轮询不变 |
| C. 一次性全做 | 全部改完统一验证 | 快，但回归定位难、回滚粒度粗 |

用户选择 A。以下为各阶段的实现设计。

## 5. 阶段 1：构建体积与首屏加载

### 5.1 背景（实测，Web 口径）

- `dist` 共约 55 MB JS、1300 个 chunk；同名 chunk 重复 329 组，冗余约 7.4 MB。
- Shiki 存在两条隔离的依赖图：
  - `shiki-Ci4cdHsM-*.js → langs-DvQbCuOp.js`（`@shikijs/langs` 路径）
  - `vendor-shiki-*.js → resolveLanguages-*.js`（`shiki` 包路径）
  - 结果：`emacs-lisp`、`cpp`、`typescript`、`tsx`、`wolfram` 等语言各产出两份。
- KaTeX 有两份：`katex.min-*.js`（1.51 MB）与 `vendor-katex-*.js`（270 KB），两者合计约占 Web 首屏 2.59 MB 的 69%。
- Web 首屏 108 个 modulepreload / 2.59 MB 原始 / 0.73 MB gzip；`ReceivedPagePanel`、`useAppFontEffects`、`useProjectsStore` 只出现在 Electron 的条件注入清单里（91 项 / 7.15 MB），**不属于本次 Web 验收范围**。
- KaTeX JS 由 `streamdown` 的公式插件链引入（入口只引 `katex.min.css`），因此去重需同时处理 `katex` 与 `streamdown` 内的副本；本次**保持同步渲染管线**，不改造为异步边界。

### 5.2 改动

1. **Shiki 去重**
   - 在 `packages/web/vite.config.ts` 增加 `resolve.dedupe`：`shiki`、`@shikijs/langs`、`@shikijs/themes`、`@shikijs/core`、`@shikijs/types`、`@shikijs/engine-oniguruma`、`@shikijs/engine-javascript`、`@pierre/theme`、`@pierre/theming`、`@pierre/highlights`、`@pierre/diffs`。
   - 若 dedupe 不足，使用 alias 让 `@shikijs/langs/*` 与 `shiki/langs/*` 指向同一实现（先核对两者导出形态，再决定 alias 方向）。
   - 保留 `manualChunks` 中对 `@shikijs/langs`、`@shikijs/themes`、`@pierre/*` 返回 `undefined` 的按需加载策略。
2. **KaTeX 去重（不做异步化）**
   - 定位 `katex.min` 与 `vendor-katex` 的分别来源（`streamdown` 插件链与 `rehype-katex`/直接依赖），通过 `resolve.dedupe: ['katex', 'rehype-katex', 'katex/dist/katex.min.js']` 与必要的 alias，让全链路只解析到同一份 KaTeX。
   - 保持同步渲染管线与 `preloadMarkdownRenderer` 现有预热行为，不引入首帧公式跳变。
3. **Web 首屏收敛（不裁 Electron 预热清单）**
   - 阶段 1 的 Web 首屏收益主要来自 KaTeX 去重；不再把分享页/设置页 lazy 化列入本阶段（它们只影响 Electron 注入图）。
   - 若去重后仍有明显的大 vendor 项，按实际统计决定是否合并低频 vendor chunk；不为了数字手工裁剪 `vite-preload-app-graph.ts` 的预热清单。
4. **VSCode/mobile 链路**
   - 只要求 `packages/vscode` 与 mobile 构建不被破坏，不纳入首屏指标。

### 5.3 验收

- `bun run --cwd packages/web build` 成功，三个入口（web/mobile/mini-chat）产物存在。
- 重新统计 Web 首屏：`index.html` 中 108 个 modulepreload 的字节数下降；KaTeX 只剩一份；Shiki 语言 chunk 只剩一份。
- 手工验证：Markdown 代码高亮、diff 预览、文件页语法高亮、公式渲染、分享页打开。
- 相关既有测试（markdown / highlights / share 页面）与基线对比。

## 6. 阶段 2：事件 reducer 热路径

### 6.1 背景

`packages/ui/src/sync/event-reducer.ts`：

- `findMessageIndex` 是 `findIndex`（`message-ordering.ts:3`），在 `message.updated`(:448)、`message.patched`(:481)、`message.removed`(:522) 每次事件调用；`hasMessage` 用 `.some`，在 `message.part.updated`(:535)、`message.parts.replaced`(:575) 每次调用。
- `areJsonEquivalent` 用 `JSON.stringify` 双向比较（:100），调用点 :352、:451、:491、:577；`isSameCompletedCompaction` 同样 stringify。
- 客户端每个帧跑两次 zod：`event-pipeline.ts:283` `wireEventSchema.safeParse`、`:305` `payloadTypeSchema.safeParse`。

### 6.2 改动

1. **消息查找加速（不改变 State 形状）**
   - 在 reducer 模块内维护 `Map<sessionID, { array: Message[]; index: number; id: string }>` 的"最后命中"缓存。
   - 查找顺序：先验证 `messages[cached.index]?.id === id` → 命中返回；否则线性扫描并回填缓存。
   - 流式事件绝大多数指向尾部消息，可把常态成本降到 O(1)。
   - 仅在数组被替换时更新缓存；不写入持久化状态。
2. **廉价等价比较**
   - 新增 `areMessageEquivalent` / `arePartsEquivalent`：先比引用，再比关键字段（`id`、`time`、`tokens`、`finish`、`error`、`cost`、`retry`、`snapshot`；parts 比长度、每个 part 的 `id/type/state/text/time`）。
   - 字段集合无法覆盖时回退 `JSON.stringify`，保证行为与现状一致。
   - `isSameCompletedCompaction` 改为逐字段比较。
3. **校验：保留浅守卫，去掉重复解析**
   - 澄清：客户端现有校验只有两处浅守卫——`lib/opencode/wire-admission.ts:4` 的 `wireEventSchema`（`{id,type,location?}`）与 `sync/event-pipeline.ts:204` 的 `payloadTypeSchema`（`{type}`）；仓库内没有按事件类型展开的完整 schema。因此**不以“省 CPU”为由删除校验**。
   - 改动仅限：让同一帧只解析一次（`classifyStreamPayload` 已解析 `payloadTypeSchema`，`translateWirePayload` 再解析 `wireEventSchema`，两者信息可合并为一次守卫），并在 `lib/opencode/events.ts` 的 translator 入口补一次廉价的 `data`/`location` 存在性守卫，避免畸形事件在 reducer 之前抛错。
   - 若后续性能剖析证明这两处 `safeParse` 确实是热点，再单独评估；本阶段不承诺该收益。

### 6.3 验收

- `packages/ui/src/sync/event-reducer.test.ts`、`event-pipeline.test.ts`、`session-message-loader.test.ts` 等全绿（与基线比较）。
- 新增单测：缓存命中/失效、字段级比较与 JSON 回退一致、畸形事件守卫。
- 用 `openchamber_sync_perf=1` 的计数器对比改动前后 `streamingMessagesVisited` / reducer 事件处理耗时（可选，作为证据）。

## 7. 阶段 3：轮询可见性

### 7.1 背景

UI 中 40+ 处 `setInterval`，部分无可见性守卫（`MemoryDebugPanel` 500 ms、`RunLaneCard` 1 s、`WorkingPlaceholder` 500 ms、`useTraySync`、`useTerminalSessionKeepalive`、`useMergedWorktreeCleanup`、`PlanView` 2 s 等）。已有良好样板：`useFileFreshness`（visible 守卫 + 文件监听升级为 30 s）与 `useGitlabRuns`（仅在 visible 时拉取）。

### 7.2 改动

- 新增 `packages/ui/src/hooks/useVisibilityInterval.ts`：
  - "后台"定义：浏览器/WebView 的 `document.hidden`，并在 Capacitor 运行时组合 `App.addListener('appStateChange')`（沿用 `MobileConnectionHeartbeat.tsx:31` 的现有模式），避免移动 WebView 里 `visibilityState` 不可靠。
  - 可见时按周期触发；`visibilitychange`/`appStateChange` 转可见时立即补一次；隐藏时暂停。
  - 支持 `enabled`、立即执行选项、以及 `runWhenHidden` 逃生开关。
- 替换范围：只替换"刷新数据 / 计时展示"类（`MemoryDebugPanel`、`RunLaneCard`、`WorkingPlaceholder`、`PlanView`、`SourceBoardChecksDialog`、`useMergedWorktreeCleanup` 等）。
- **明确不暂停**（协议/托盘语义）：`useTraySync`（窗口隐藏时托盘仍需更新）、`useTerminalSessionKeepalive`、`usePushVisibilityBeacon`、relay/tunnel ping、`ComposerDictation`/`AnnotationDictation` 的会话保活。这些要么保留原样，要么单独评估，不纳入本阶段。
- 对依赖 `setNow` 的计时展示隐藏时暂停，恢复时重算，避免恢复瞬间显示错误时长。

### 7.3 验收

- 新增 `useVisibilityInterval` 单测（隐藏暂停、恢复补跑、清理）。
- 相关组件测试与基线对比。
- 手工检查后台标签页不再持续请求。

## 8. 阶段 4：服务端缓存与同步 IO

### 8.1 背景

`git/service.ts:2914` 的 `getStatus` 已用 `createSerialRefresh` 合并并发读（单飞已存在），缺的是跨请求 TTL。服务端已有回合结束信号：`server-frame/feature-routes-runtime.ts:684` 在 turn idle 后 3 秒广播 `openchamber:source-control.activity`。该信号覆盖 agent 回合，但**不覆盖**用户手动编辑/外部进程改文件。

### 8.2 改动（已确认口径：最大陈旧 ≤5 秒）

- 给 `getStatus` 加跨请求短 TTL 缓存（默认 5000 ms，可配置），与现有 `createSerialRefresh` 单飞叠加。
- 失效来源：收到 `source-control.activity`（turn idle 后约 3 秒）时立即失效；TTL 兜底保证手动编辑最多看到约 5 秒旧状态。
- 审计服务端同步 IO，确认是否落在请求热路径；只在确认后改为异步，避免无收益改动。
- 保持 API 响应结构不变。

### 8.3 验收

- `packages/web` 相关测试与基线对比。
- 手动/脚本验证：连续刷新 git 状态时上游 `git` 调用次数下降（可用现有诊断计数器或临时日志）。

## 9. 交付方式与回滚

- 从当前 `HEAD` 新建分支 `perf/optimizations-2026-11`；每个阶段一个提交，提交信息含阶段名与关键指标。
- 每阶段结束产出"前后对比"数字（首屏 MB/文件数、Shiki/KaTeX 份数、测试结果）。
- 任阶段验证失败即回滚该阶段提交，不影响其他阶段。

## 10. 留给实现者的决定

- Shiki 去重最终用 dedupe 还是 alias，按实际导出形态定。
- KaTeX 单一来源的收敛方式（dedupe/rehype-katex 处理），以构建后只剩一份为准。
- reducer 缓存是否需要按 directory 维度隔离（多目录同名 session 的风险），按 `State` 结构定。
- 校验合并后守卫的具体形态，以不丢失 `wireEventSchema` 现有信息为准。
- 轮询替换清单中，除第 7.2 节明确列出的协议心跳外，其余按"刷新数据/计时展示"逐项判断。

## 11. 变更记录

- 2026-11-25：初稿，基于 codegraph 探索与 dist 实测。
- 2026-11-25：按独立实现者评审修正——首屏口径改为 Web/PWA（108 个 / 2.59 MB，Electron 91 项不在范围）；KaTeX 只做去重、保持同步渲染；阶段 2.3 改为保留浅守卫、去重复解析；阶段 3 明确移动端 AppState 与不暂停清单；阶段 4 确认 ≤5 秒陈旧口径。
