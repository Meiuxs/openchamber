# OpenChamber 性能重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `2026-11-25-performance-refactor-design.md` 分四阶段降低构建产物、事件 reducer 热路径、后台轮询与服务端 git 读取开销，每步验证并提交。

**Architecture:** 阶段互不依赖，按"构建体积 → reducer → 轮询 → 服务端"顺序推进。每个任务只动一个可独立回滚的关注点，先写测试再实现；构建类任务用重新构建后的字节数作为验收。

**Tech Stack:** Bun（测试/脚本）、TypeScript、React 19 + Zustand、Vite/Rollup、Vitest（web）、bun:test + happy-dom（ui）。

**Spec:** `docs/superpowers/specs/2026-11-25-performance-refactor-design.md`

## Global Constraints

- 外部行为与 API 响应结构不变；不改视觉、i18n 文案、依赖版本。
- 首屏验收只按 Web/PWA：`packages/web/dist/index.html` 的 108 个 modulepreload；Electron 的 91 个条件注入项不动。
- KaTeX 保持同步渲染，不做异步化；Shiki 保持按需加载。
- 不修改工作区已有的未提交改动（`package.json`、`bun.lock`、`scripts/delivery/RELEASE-NOTES.md` 等）；阶段提交只 `git add` 本任务文件。
- 工作分支：`perf/optimizations-2026-11`（从当前 HEAD 创建）。
- UI 测试套件存在约 16 个既有失败（见 `.claude` 记忆 `ui-suite-baseline-failures`）；验收与改动前基线对比，不要求全绿。
- 每个任务结束必须：目标测试通过 → 提交。提交信息用 `perf(阶段): 描述`。

## Review Focus

- 畸形 wire 事件（缺 `data`/`location`）到达 translate/reducer：不得抛错，应被丢弃。
- 1000+ 消息的长会话中反复更新尾部消息：索引提示失效后不得返回错误消息。
- Shiki 去重后：代码块高亮、diff 预览、文件页语法高亮仍正常。
- KaTeX 去重后：行内与块级公式、代码块里的 `$$` 不误判，仍正常渲染。
- 隐藏标签页 / Capacitor 后台：暂停的只是刷新类轮询；托盘、terminal keepalive、presence/push、relay ping 必须继续。

---

### Task 0: 分支与基线

**Files:** 无代码改动。

**Interfaces:**
- Consumes: 无
- Produces: 后续所有任务使用的分支与基线数字。

- [ ] **Step 1: 创建分支**

```bash
git switch -c perf/optimizations-2026-11
```

- [ ] **Step 2: 记录构建基线**

```bash
cd packages/web && bun run build
```

记录：`dist/index.html` 的 modulepreload 数量与字节、Shiki 同名重复组、KaTeX chunk 数。可用：

```bash
cd packages/web/dist && node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const s=[...h.matchAll(/rel=\"modulepreload\"[^>]*href=\"([^\"]+\\.js)\"/g)].map(m=>m[1].slice(1));console.log(s.length,s.reduce((n,p)=>n+fs.statSync(p).size,0))"
```

- [ ] **Step 3: 记录测试基线**

```bash
bun test packages/ui/src/sync/event-reducer.test.ts packages/ui/src/sync/event-pipeline.test.ts
```

记录通过/失败数量，作为后续对比基线。

---

### Task 1: Shiki 语言包去重

**Files:**
- Modify: `packages/web/vite.config.ts`（在 `defineConfig` 顶层增加 `resolve.dedupe`）
- Test: 构建产物（无单测）

**Interfaces:**
- Consumes: Task 0 的基线数字
- Produces: 单一 Shiki 语法包依赖图；后续任务沿用该配置

- [ ] **Step 1: 加 dedupe 配置**

在 `packages/web/vite.config.ts` 的 `defineConfig({ ... })` 中，与 `root`/`cacheDir` 同级加入：

```ts
resolve: {
  dedupe: [
    'shiki',
    '@shikijs/langs',
    '@shikijs/themes',
    '@shikijs/core',
    '@shikijs/types',
    '@shikijs/engine-oniguruma',
    '@shikijs/engine-javascript',
    '@pierre/theme',
    '@pierre/theming',
    '@pierre/highlights',
    '@pierre/diffs',
  ],
},
```

- [ ] **Step 2: 构建并统计**

```bash
cd packages/web && bun run build
```

统计同名 Shiki 语言 chunk 是否只剩一份（以 `emacs-lisp` 为例应为 1 个文件）：

```bash
cd packages/web/dist/assets && ls emacs-lisp-*.js | wc -l
```

预期：`1`。若仍为 `2`，进入 Step 3。

- [ ] **Step 3: 仅在 Step 2 失败时加 alias**

核对 `node -e "console.log(require.resolve('@shikijs/langs/typescript'))"` 与 `node -e "console.log(require.resolve('shiki/langs/typescript.mjs'))"`；若两者指向不同文件，在 `resolve.alias` 中把 `@shikijs/langs` 指到 `shiki/langs`（或相反方向，以导出形态兼容者为准），再构建复测 Step 2。

- [ ] **Step 4: 验证功能未回退**

```bash
bun test packages/ui/src/components/chat/markdown packages/ui/src/lib/shiki
```

预期：与基线一致（markdown/highlights 相关测试全绿或仅既有失败）。

- [ ] **Step 5: 提交**

```bash
git add packages/web/vite.config.ts
git commit -m "perf(build): dedupe shiki package graphs in vite"
```

---

### Task 2: KaTeX 去重（保持同步渲染）

**Files:**
- Modify: `packages/web/vite.config.ts`
- Test: `packages/ui/src/components/chat/markdown/streamdownPlugins.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `resolve` 配置块
- Produces: 全链路只解析到一份 KaTeX

- [ ] **Step 1: 记录当前 KaTeX chunk**

```bash
cd packages/web/dist/assets && ls -la katex.min-*.js vendor-katex-*.js 2>/dev/null
```

预期至少 2 份。记下文件名。

- [ ] **Step 2: 加 dedupe**

在 `resolve.dedupe` 数组补：`'katex'`、`'rehype-katex'`、`'remark-math'`。若 `katex.min-*.js` 仍单独存在，在 `resolve.alias` 加 `{ find: /^katex$/, replacement: path.resolve(__dirname, '../../node_modules/katex') }`（先确认 `katex` 实际安装位置）。

- [ ] **Step 3: 构建并复测**

```bash
cd packages/web && bun run build && cd dist/assets && ls katex.min-*.js vendor-katex-*.js 2>/dev/null | wc -l
```

预期：`1`（或只剩一个 KaTeX 入口文件）。

- [ ] **Step 4: 验证公式渲染**

```bash
bun test packages/ui/src/components/chat/markdown/streamdownPlugins.test.tsx packages/ui/src/components/chat/markdown/selectionMarkdown.test.ts
```

预期：通过（与基线一致）。

- [ ] **Step 5: 记录 Web 首屏字节并提交**

```bash
cd packages/web/dist && node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const s=[...h.matchAll(/rel=\"modulepreload\"[^>]*href=\"([^\"]+\\.js)\"/g)].map(m=>m[1].slice(1));console.log(s.length,s.reduce((n,p)=>n+fs.statSync(p).size,0))"
git add packages/web/vite.config.ts
git commit -m "perf(build): dedupe katex to a single copy"
```

---

### Task 3: reducer 消息索引提示

**Files:**
- Create: `packages/ui/src/sync/message-index-hints.ts`
- Create: `packages/ui/src/sync/message-index-hints.test.ts`
- Modify: `packages/ui/src/sync/event-reducer.ts`（`findMessageIndex`/`hasMessage` 调用点）

**Interfaces:**
- Consumes: `Message` 的 `id: string`
- Produces:
  ```ts
  export type MessageIndexHints = {
    find(messages: readonly { id: string }[], messageID: string): number;
    forget(messageID: string): void;
    clear(): void;
  };
  export const createMessageIndexHints = (): MessageIndexHints;
  ```

- [ ] **Step 1: 写失败测试**

`packages/ui/src/sync/message-index-hints.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { createMessageIndexHints } from "./message-index-hints";

const msg = (id: string) => ({ id });

describe("createMessageIndexHints", () => {
  test("finds a message and returns -1 when missing", () => {
    const hints = createMessageIndexHints();
    const messages = [msg("a"), msg("b"), msg("c")];
    expect(hints.find(messages, "b")).toBe(1);
    expect(hints.find(messages, "zzz")).toBe(-1);
  });

  test("hint stays correct when the array shifts", () => {
    const hints = createMessageIndexHints();
    const before = [msg("a"), msg("b"), msg("c")];
    expect(hints.find(before, "c")).toBe(2);
    const after = [msg("x"), msg("a"), msg("b"), msg("c")];
    expect(hints.find(after, "c")).toBe(3);
  });

  test("forget drops a stale hint but still finds by scan", () => {
    const hints = createMessageIndexHints();
    const messages = [msg("a"), msg("b")];
    expect(hints.find(messages, "b")).toBe(1);
    hints.forget("b");
    expect(hints.find(messages, "b")).toBe(1);
  });

  test("clear resets all hints", () => {
    const hints = createMessageIndexHints();
    const messages = [msg("a")];
    expect(hints.find(messages, "a")).toBe(0);
    hints.clear();
    expect(hints.find(messages, "a")).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
bun test packages/ui/src/sync/message-index-hints.test.ts
```

预期：FAIL，`Cannot find module './message-index-hints'`。

- [ ] **Step 3: 实现**

`message-index-hints.ts`：保存 `last = { messageID, index } | null`；`find` 先校验 `messages[last.index]?.id === messageID` 命中则返回，否则线性 `findIndex` 并回填 `last`（未找到时不回填）。`forget(id)` 仅在 `last?.messageID === id` 时清空。`clear()` 置空。

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test packages/ui/src/sync/message-index-hints.test.ts
```

预期：4 passed。

- [ ] **Step 5: 接入 reducer**

在 `event-reducer.ts` 顶部创建模块级 `const messageIndexHints = createMessageIndexHints();`。把 `message.updated` 的 `findMessageIndex(messages, info.id)`、`message.patched` 的 `findMessageIndex`、`message.removed` 的 `findMessageIndex`、以及 `hasMessage` 里的 `.some` 改为使用 `messageIndexHints.find(messages, messageID)`；`message.removed` 成功删除后调用 `messageIndexHints.forget(messageID)`。保留 `findMessageIndex` 供 `message-ordering.ts` 其他调用继续使用。

- [ ] **Step 6: 跑 reducer 测试**

```bash
bun test packages/ui/src/sync/event-reducer.test.ts packages/ui/src/sync/event-pipeline.test.ts packages/ui/src/sync/message-ordering.test.ts
```

预期：与 Task 0 基线一致。

- [ ] **Step 7: 提交**

```bash
git add packages/ui/src/sync/message-index-hints.ts packages/ui/src/sync/message-index-hints.test.ts packages/ui/src/sync/event-reducer.ts
git commit -m "perf(sync): reuse last-hit message index in event reducer"
```

---

### Task 4: 字段级等价比较

**Files:**
- Create: `packages/ui/src/sync/event-equivalence.ts`
- Create: `packages/ui/src/sync/event-equivalence.test.ts`
- Modify: `packages/ui/src/sync/event-reducer.ts:100-108`（替换 `areJsonEquivalent` 的实现与调用）

**Interfaces:**
- Consumes: `Message`、`Part`（`@/lib/opencode/model`）
- Produces:
  ```ts
  export const areEquivalent = (left: unknown, right: unknown): boolean;
  export const areMessagesEquivalent = (left: Message | undefined, right: Message | undefined): boolean;
  export const arePartsEquivalent = (left: readonly Part[] | undefined, right: readonly Part[] | undefined): boolean;
  ```

- [ ] **Step 1: 写失败测试**

`event-equivalence.test.ts` 覆盖：引用相同、一边 undefined、字符串引用相同不触发序列化、深层对象不同返回 false、数组顺序不同返回 false、以及"与 JSON.stringify 结果一致"的若干样例。

- [ ] **Step 2: 运行确认失败**

```bash
bun test packages/ui/src/sync/event-equivalence.test.ts
```

- [ ] **Step 3: 实现**

策略：先 `===`；一边 undefined 返回 false；数组逐项比较；普通对象先比键集合，再逐键递归，值非引用相等且为非对象时直接 false；仅当双方都是对象/数组时递归；遇到循环或无法判断时回退 `JSON.stringify` 比较并捕获异常返回 false。`areMessagesEquivalent` / `arePartsEquivalent` 是它的类型化包装。

- [ ] **Step 4: 运行确认通过**

```bash
bun test packages/ui/src/sync/event-equivalence.test.ts
```

- [ ] **Step 5: 接入 reducer**

把 `session.patched`、`message.updated`、`message.patched`、`message.parts.replaced` 中的 `areJsonEquivalent(...)` 换成对应类型化比较；`isSameCompletedCompaction` 改为逐字段比较。删除旧的 `areJsonEquivalent` 或保留为内部回退（若保留则不得再被热点调用）。

- [ ] **Step 6: 跑测试并提交**

```bash
bun test packages/ui/src/sync/event-reducer.test.ts packages/ui/src/sync/event-equivalence.test.ts
git add packages/ui/src/sync/event-equivalence.ts packages/ui/src/sync/event-equivalence.test.ts packages/ui/src/sync/event-reducer.ts
git commit -m "perf(sync): compare messages structurally instead of JSON.stringify"
```

---

### Task 5: 合并每帧重复的浅校验

**Files:**
- Modify: `packages/ui/src/sync/event-pipeline.ts`（`classifyStreamPayload` 与 `translateWirePayload`）
- Modify: `packages/ui/src/lib/opencode/wire-admission.ts`（如需导出已解析类型）
- Test: `packages/ui/src/sync/event-pipeline.test.ts`

**Interfaces:**
- Consumes: `payloadTypeSchema`、`wireEventSchema`
- Produces: 每帧只解析一次 `payload.type`；`wireEventSchema` 仍在 wire 事件路径上执行

- [ ] **Step 1: 写测试**

在 `event-pipeline.test.ts` 增加：畸形帧（`payload` 非对象、缺 `type`）被丢弃且不抛错；`openchamber:space-*` 帧仍能被分类。先运行确认新测试失败或缺失。

- [ ] **Step 2: 实现**

`classifyStreamPayload` 已解析 `payloadTypeSchema`，将解析结果的 `type` 传给 `translateWirePayload`，后者不再重复解析同一字段；保留 `wireEventSchema.safeParse` 作为 wire 事件的实际守卫。若 `translateWirePayload` 的签名变化，更新所有调用点。

- [ ] **Step 3: 验证**

```bash
bun test packages/ui/src/sync/event-pipeline.test.ts packages/ui/src/lib/opencode/events.test.ts
```

预期：通过且与基线一致。

- [ ] **Step 4: 提交**

```bash
git add packages/ui/src/sync/event-pipeline.ts packages/ui/src/lib/opencode/wire-admission.ts packages/ui/src/sync/event-pipeline.test.ts
git commit -m "perf(sync): parse stream frame type once per event"
```

---

### Task 6: 可见性轮询 hook

**Files:**
- Create: `packages/ui/src/hooks/useVisibilityInterval.ts`
- Create: `packages/ui/src/hooks/useVisibilityInterval.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type VisibilityIntervalOptions = {
    enabled?: boolean;
    immediate?: boolean;
    runWhenHidden?: boolean;
    visibility?: { isVisible: () => boolean; subscribe: (listener: () => void) => () => void };
  };
  export const useVisibilityInterval = (
    callback: () => void,
    intervalMs: number,
    options?: VisibilityIntervalOptions,
  ): void;
  ```

- [ ] **Step 1: 写失败测试**

用 happy-dom + React act，注入假的 `visibility` 信号，覆盖：可见时按周期触发、隐藏时不再触发、转可见立即补一次、`enabled:false` 不启动、卸载清理。

- [ ] **Step 2: 运行确认失败**

```bash
bun test packages/ui/src/hooks/useVisibilityInterval.test.tsx
```

- [ ] **Step 3: 实现**

默认 `visibility` 用 `document.visibilityState` + `visibilitychange`；注入时用注入实现。`enabled` 为 false 或 `!isVisible() && !runWhenHidden` 时清除定时器；订阅回调里按可见性启停并在转为可见时调用一次回调（若 `immediate !== false`）。回调放进 ref，避免重装定时器。

- [ ] **Step 4: 运行确认通过**

```bash
bun test packages/ui/src/hooks/useVisibilityInterval.test.tsx
```

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/hooks/useVisibilityInterval.ts packages/ui/src/hooks/useVisibilityInterval.test.tsx
git commit -m "feat(ui): add visibility-aware interval hook"
```

---

### Task 7: 替换无守卫轮询

**Files:**
- Modify: `packages/ui/src/components/multirun/RunLaneCard.tsx:33`
- Modify: `packages/ui/src/components/chat/message/parts/WorkingPlaceholder.tsx:67`
- Modify: `packages/ui/src/components/views/PlanView.tsx:531-539`
- Modify: `packages/ui/src/components/ui/MemoryDebugPanel.tsx:236`
- Modify: `packages/ui/src/components/sourceBoard/SourceBoardChecksDialog.tsx:51`
- Modify: `packages/ui/src/hooks/useMergedWorktreeCleanup.ts:204`

**Interfaces:**
- Consumes: Task 6 的 `useVisibilityInterval`
- Produces: 上述刷新类轮询在隐藏时暂停

- [ ] **Step 1: 逐个替换**

把对应 `setInterval` + cleanup 改为 `useVisibilityInterval(cb, ms, { enabled })`；`RunLaneCard` 的 `setNow(Date.now())` 在恢复时立即重算。**不改** `useTraySync`、`useTerminalSessionKeepalive`、`usePushVisibilityBeacon`、relay/tunnel ping、dictation 保活。

- [ ] **Step 2: 类型检查**

```bash
bun run --cwd packages/ui type-check
```

预期：通过（仅既有错误，若有请对比基线）。

- [ ] **Step 3: 跑相关测试**

```bash
bun test packages/ui/src/components/multirun packages/ui/src/components/views/PlanView.test.tsx packages/ui/src/components/sourceBoard packages/ui/src/hooks/useMergedWorktreeCleanup.test.ts
```

预期：与基线一致。

- [ ] **Step 4: 提交**

```bash
git add packages/ui/src/components/multirun/RunLaneCard.tsx packages/ui/src/components/chat/message/parts/WorkingPlaceholder.tsx packages/ui/src/components/views/PlanView.tsx packages/ui/src/components/ui/MemoryDebugPanel.tsx packages/ui/src/components/sourceBoard/SourceBoardChecksDialog.tsx packages/ui/src/hooks/useMergedWorktreeCleanup.ts
git commit -m "perf(ui): pause refresh polling while hidden"
```

---

### Task 8: git status 5 秒缓存

**Files:**
- Create: `packages/web/server/lib/git/status-cache.ts`
- Create: `packages/web/server/lib/git/status-cache.test.js`
- Modify: `packages/web/server/lib/git/service.ts:2908-2930`（`getStatus`）
- Modify: `packages/web/server/lib/server-frame/feature-routes-runtime.ts:696`（广播 activity 时失效缓存）

**Interfaces:**
- Produces:
  ```ts
  export type KeyedTtlCache<T> = {
    get(key: string): T | undefined;
    set(key: string, value: T): void;
    invalidate(key: string): void;
    clear(): void;
  };
  export const createKeyedTtlCache = <T>(options: { ttlMs: number; now?: () => number }): KeyedTtlCache<T>;
  ```
  `service.ts` 导出 `invalidateStatusCache(directory?: string): void`。

- [ ] **Step 1: 写缓存单测**

`status-cache.test.js`：fresh 命中、过期后 `get` 返回 undefined、`invalidate` 单目录、`clear` 全清、`now` 可注入。

- [ ] **Step 2: 运行确认失败**

```bash
cd packages/web && bun test server/lib/git/status-cache.test.js
```

- [ ] **Step 3: 实现缓存模块与接入**

`createKeyedTtlCache` 存 `{ value, at }`；`get` 只在 `now() - at < ttlMs` 时返回。`service.ts` 中 `const STATUS_CACHE_TTL_MS = 5000;`，以 `${normalizedDirectory}\0${lightMode ? 'light' : 'full'}` 为键：先查缓存，命中直接返回；否则走现有 `statusRefresh.run(...)`，成功后 `set`。`invalidateStatusCache(directory?)` 对应单键/全清。

- [ ] **Step 4: 接线失效**

`feature-routes-runtime.ts` 在 `writeSseEvent(... source-control.activity ...)` 之后调用 `invalidateStatusCache(directory)`（从 `../git/service.js` 导入；确认扩展名与现有导入风格一致）。

- [ ] **Step 5: 测试**

```bash
cd packages/web && bun test server/lib/git/status-cache.test.js
bun test server/lib/git/service.test.js
```

预期：新测试通过；`service.test.js` 与基线一致。

- [ ] **Step 6: 提交**

```bash
git add packages/web/server/lib/git/status-cache.ts packages/web/server/lib/git/status-cache.test.js packages/web/server/lib/git/service.ts packages/web/server/lib/server-frame/feature-routes-runtime.ts
git commit -m "perf(git): cache status reads for 5s and invalidate on activity"
```

---

### Task 9: 全量验证与收尾

**Files:** 无新增。

**Interfaces:**
- Consumes: Task 1-8 的提交
- Produces: 最终验证记录

- [ ] **Step 1: 类型检查**

```bash
bun run type-check
```

预期：通过（仅既有错误）。

- [ ] **Step 2: 目标测试全集**

```bash
bun test packages/ui/src/sync packages/ui/src/hooks/useVisibilityInterval.test.tsx packages/ui/src/components/chat/markdown
cd packages/web && bun test server/lib/git/status-cache.test.js server/lib/git/service.test.js server/lib/event-stream
```

与 Task 0 基线对比。

- [ ] **Step 3: 构建核对**

```bash
cd packages/web && bun run build
```

核对：KaTeX 一份、Shiki 语言包一份、首屏 modulepreload 字节数低于基线。

- [ ] **Step 4: 最终提交（如无遗留改动可跳过）**

```bash
git status --short
git commit --allow-empty -m "perf: complete staged performance refactor verification"
```

若 `git status` 显示只有本计划与设计稿，`git add docs/superpowers` 后提交。

---

## Self-Review

- **Spec coverage:** 阶段 1（Task 1-2）、阶段 2（Task 3-5）、阶段 3（Task 6-7）、阶段 4（Task 8）、验收（Task 0/9）均有任务。Electron 预热与 KaTeX 异步化按 spec 明确排除。
- **Step scan:** 每个测试步骤给出文件与断言；实现步骤给出接口与策略，不转录实现体。
- **Type consistency:** `createMessageIndexHints().find/forget/clear`、`areEquivalent/areMessagesEquivalent/arePartsEquivalent`、`useVisibilityInterval`、`createKeyedTtlCache/get/set/invalidate/clear` 在任务间一致。
- **Review Focus:** 畸形事件（Task 5）、长会话索引（Task 3）、Shiki（Task 1）、KaTeX（Task 2）、后台轮询边界（Task 6-7）均有对应测试或验证步骤。
