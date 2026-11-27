# 数据库绑定主选与会话选择 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给项目级数据库绑定加「主选」标记、会话内选择器，以及可读的 SSL 等选项说明。

**Architecture:** 主选存项目目录下的 `.opencode/dbhub/primary.json`，由 `/api/db/primary` 读写，不改 MCP 条目以免重启实例。会话选择存客户端 zustand store（按 sessionID，localStorage 持久化），发送消息时通过现有 `syntheticTexts` 通道注入一条绑定提示。软默认：其它库工具仍可用。

**Tech Stack:** React 19 + TypeScript, zustand v5, express routes, bun test / vitest, Playwright。

**Spec:** `docs/superpowers/specs/2026-11-27-db-binding-session-picker-design.md`

## Global Constraints

- 每次回答中文；代码注释与提交信息用英文（仓库既有风格）。
- 不得把用户姓名/项目/邮箱等个人信息写进对外请求。
- 测试中的 `{{PASSWORD_*}}` 之类是掩码占位符，原样保留。
- 15 个 locale 必须键位一致（`messages.test.ts` 会校验）。
- UI 全量测试有约 16 个既有基线失败，只判断“不新增失败”。
- 未获用户要求不重启后台 dev 服务。

## Review Focus

- 项目没有任何绑定 → 选择器不渲染，设置页不显示主选徽标。
- 主选别名指向已被删除的绑定 → 视为无主选，回退到第一个绑定并发提示。
- 会话选择在多标签/刷新后仍指向已删除的绑定 → 回退到主选，不注入不存在的条目。
- 用户连续发多条消息 → 提示只在首条/切换后注入一次，不重复。
- `primary.json` 损坏或权限不足 → 读写都静默降级（读 null、写返回错误），不阻塞页面。

---

### Task 1: 服务端主选读写

**Files:**
- Modify: `packages/web/server/lib/db/binding-config.ts`
- Modify: `packages/web/server/lib/db/db-test-routes.ts`
- Test: `packages/web/server/lib/db/binding-config.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `bindingConfigPathOf(directory, alias)`、`ALIAS_SLUG`。
- Produces:
  - `primaryConfigPathOf(directory: string): string | null`
  - `readPrimaryBinding(directory: string): Promise<string | null>`
  - `writePrimaryBinding(directory: string, alias: string | null): Promise<{ ok: true; alias: string | null } | { ok: false; error: string }>`
  - `GET /api/db/primary` → `{ ok: true, alias: string | null }`
  - `PUT /api/db/primary` body `{ alias: string | null }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/web/server/lib/db/binding-config.test.ts
import { describe, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPrimaryBinding, writePrimaryBinding, primaryConfigPathOf } from './binding-config.js';

const withDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-db-primary-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

describe('primary binding', () => {
  test('round-trips a valid alias', async () => {
    await withDir(async (dir) => {
      await mkdir(path.join(dir, '.opencode', 'dbhub'), { recursive: true });
      await writeFile(path.join(dir, '.opencode', 'dbhub', 'dbhub-orders.toml'), 'x');
      expect(await writePrimaryBinding(dir, 'orders')).toEqual({ ok: true, alias: 'orders' });
      expect(await readPrimaryBinding(dir)).toBe('orders');
    });
  });

  test('rejects a missing toml and an invalid slug', async () => {
    await withDir(async (dir) => {
      expect((await writePrimaryBinding(dir, 'orders')).ok).toBe(false);
      await mkdir(path.join(dir, '.opencode', 'dbhub'), { recursive: true });
      await writeFile(path.join(dir, '.opencode', 'dbhub', 'dbhub-orders.toml'), 'x');
      expect((await writePrimaryBinding(dir, '../etc')).ok).toBe(false);
    });
  });

  test('clears and tolerates corruption', async () => {
    await withDir(async (dir) => {
      await mkdir(path.join(dir, '.opencode', 'dbhub'), { recursive: true });
      const p = primaryConfigPathOf(dir);
      await writeFile(p!, 'not json');
      expect(await readPrimaryBinding(dir)).toBeNull();
      expect(await writePrimaryBinding(dir, null)).toEqual({ ok: true, alias: null });
      expect(await readPrimaryBinding(dir)).toBeNull();
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --cwd packages/web vitest run server/lib/db/binding-config.test.ts`
Expected: FAIL，`writePrimaryBinding is not a function`。

- [ ] **Step 3: 实现**

`binding-config.ts` 增加常量 `PRIMARY_FILE_NAME = 'primary.json'`；`primaryConfigPathOf` 复制 `bindingConfigPathOf` 的绝对路径校验后返回 `<dir>/.opencode/dbhub/primary.json`。`readPrimaryBinding` 读文件并 `JSON.parse`，取 `alias` 字符串且通过 `ALIAS_SLUG`，任何异常返回 `null`。`writePrimaryBinding`：`alias === null` 时 `rm(..., { force: true })` 并返回 `{ ok: true, alias: null }`；否则校验 slug 且 `dbhub-<alias>.toml` 存在（`fs.stat`），再写 `JSON.stringify({ alias })`，mode 0600。

`db-test-routes.ts` 增加 `GET /api/db/primary` 与 `PUT /api/db/primary`（`express.json({ limit: '4kb' })`）；DELETE binding 成功后若被删 alias 等于当前主选则 `writePrimaryBinding(dir, null)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --cwd packages/web vitest run server/lib/db/binding-config.test.ts`
Expected: 3 passed。

- [ ] **Step 5: 提交**

```bash
git add packages/web/server/lib/db
git commit -m "feat(db): persist a primary database binding per project"
```

---

### Task 2: 客户端解析与提示文本

**Files:**
- Modify: `packages/ui/src/lib/db-bindings/dsn.ts`
- Test: `packages/ui/src/lib/db-bindings/dsn.test.ts`

**Interfaces:**
- Consumes: 现有 `isDbhubServer`、`readDbBindingSpec`、`bindingNameOf`。
- Produces:
  - `type DbBindingChoice = { entryName: string; spec: DbBindingSpec }`
  - `listDbBindings(servers: readonly McpServerWithScope[]): DbBindingChoice[]`
  - `resolveEffectiveBinding(bindings, primaryName: string | null, selectedEntry: string | null): DbBindingChoice | null`
  - `buildDbBindingPrompt(choice: DbBindingChoice): string`
  - `dbBindingPromptFor(input: { bindings; primaryName; selectedEntry; announcedEntry }): { entryName: string; text: string } | null`（与 `announcedEntry` 相同则返回 null）

- [ ] **Step 1: 写失败测试**

在 `dsn.test.ts` 追加：

```ts
describe('session binding choice', () => {
  const srv = (name: string, host: string) => ({
    name, type: 'local', scope: 'project',
    command: ['npx', '-y', '@bytebase/dbhub'],
    environment: { DSN: `mysql://u@${host}:3306/orders`, OPENCHAMBER_DB_READONLY: '1' },
  }) as unknown as McpServerWithScope;

  test('lists only dbhub entries and resolves primary/selection', () => {
    const all = [srv('dbhub-orders', 'db.a'), srv('dbhub-archive', 'db.b'), { name: 'x', type: 'remote', url: 'https://x' } as unknown as McpServerWithScope];
    const list = listDbBindings(all);
    expect(list.map((b) => b.entryName)).toEqual(['dbhub-orders', 'dbhub-archive']);
    expect(resolveEffectiveBinding(list, 'dbhub-archive', null)?.entryName).toBe('dbhub-archive');
    expect(resolveEffectiveBinding(list, 'dbhub-archive', 'dbhub-orders')?.entryName).toBe('dbhub-orders');
    // stale primary / stale selection fall back to the first binding
    expect(resolveEffectiveBinding(list, 'dbhub-gone', null)?.entryName).toBe('dbhub-orders');
    expect(resolveEffectiveBinding(list, null, 'dbhub-gone')?.entryName).toBe('dbhub-orders');
    expect(resolveEffectiveBinding([], null, null)).toBeNull();
  });

  test('builds a prompt with name, target and mode only', () => {
    const list = listDbBindings([srv('dbhub-orders', 'db.a')]);
    const text = buildDbBindingPrompt(list[0]!);
    expect(text).toContain('dbhub-orders');
    expect(text).toContain('db.a:3306/orders');
    expect(text).toContain('只读');
    expect(text).toContain('dbhub-orders_execute_sql');
    expect(text).not.toContain('password');
  });

  test('announces once per binding', () => {
    const bindings = listDbBindings([srv('dbhub-orders', 'db.a')]);
    const input = { bindings, primaryName: null, selectedEntry: null, announcedEntry: null };
    expect(dbBindingPromptFor(input)?.entryName).toBe('dbhub-orders');
    expect(dbBindingPromptFor({ ...input, announcedEntry: 'dbhub-orders' })).toBeNull();
    expect(dbBindingPromptFor({ ...input, bindings: [] })).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/ui/src/lib/db-bindings/dsn.test.ts`
Expected: FAIL，`listDbBindings is not a function`。

- [ ] **Step 3: 实现**

`dsn.ts` 追加上述 4 个导出。`listDbBindings` 过滤 `isDbhubServer` 并 `readDbBindingSpec` 非空者。`resolveEffectiveBinding`：`selectedEntry` 命中则用它，否则 `primaryName` 命中则用它，否则 `bindings[0] ?? null`。`buildDbBindingPrompt` 返回：

```
本会话数据库：{alias}（{entryName}，{host}:{port}/{database}，{只读|读写}）。未明确指定其它库时请使用它；查库优先调用 {entryName}_execute_sql / {entryName}_search_objects。
```

alias 取 `spec.alias`，空则用 entryName 去掉 `dbhub-` 前缀。`dbBindingPromptFor` = `resolveEffectiveBinding` 后比较 `announcedEntry`，命中则 `null`，否则返回 `{ entryName, text: buildDbBindingPrompt(choice) }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test packages/ui/src/lib/db-bindings/dsn.test.ts`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/lib/db-bindings
git commit -m "feat(db): resolve the effective binding and build its session prompt"
```

---

### Task 3: 主选/会话选择 store

**Files:**
- Create: `packages/ui/src/stores/useDbBindingStore.ts`
- Test: `packages/ui/src/stores/useDbBindingStore.test.ts`

**Interfaces:**
- Consumes: `runtimeFetch`、`buildDbBindingPrompt`、`resolveEffectiveBinding`、`listDbBindings`。
- Produces (`useDbBindingStore`):
  - `primaryByDirectory: Record<string, string | null>`
  - `loadPrimary(directory: string): Promise<void>`
  - `setPrimary(directory: string, entryName: string | null): Promise<{ ok: boolean }>`
  - `selectionBySession: Record<string, string | null>`
  - `announcedBySession: Record<string, string | null>`
  - `setSelection(sessionId: string, entryName: string | null): void`
  - `markAnnounced(sessionId: string, entryName: string | null): void`
  - `forgetSession(sessionId: string): void`

- [ ] **Step 1: 写失败测试**

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { useDbBindingStore } from './useDbBindingStore';

beforeEach(() => {
  useDbBindingStore.setState({ selectionBySession: {}, announcedBySession: {}, primaryByDirectory: {} });
});

describe('useDbBindingStore', () => {
  test('stores per-session selection and announcement', () => {
    const s = useDbBindingStore.getState();
    s.setSelection('s1', 'dbhub-orders');
    s.markAnnounced('s1', 'dbhub-orders');
    expect(useDbBindingStore.getState().selectionBySession.s1).toBe('dbhub-orders');
    expect(useDbBindingStore.getState().announcedBySession.s1).toBe('dbhub-orders');
    s.forgetSession('s1');
    expect(useDbBindingStore.getState().selectionBySession.s1).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/ui/src/stores/useDbBindingStore.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

zustand `create` + `persist`（localStorage key `openchamber.dbBindings`，`partialize` 三个 map，读写 try/catch）。store 里的值统一是**条目名**（`dbhub-orders`）：`loadPrimary` 把路由返回的 alias 用 `bindingNameOf` 转成条目名再存（null 保持 null）；`setPrimary(directory, entryName)` 用 `bindingSlugOf` 转回 alias 发给 `PUT`，成功后更新 map；`setSelection` 同时清空该会话的 `announcedBySession`，使切换后重新注入。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test packages/ui/src/stores/useDbBindingStore.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/stores/useDbBindingStore.ts packages/ui/src/stores/useDbBindingStore.test.ts
git commit -m "feat(db): keep primary and per-session binding choice in a store"
```

---

### Task 4: 设置页——主选徽标与选项说明

**Files:**
- Modify: `packages/ui/src/components/sections/database/DatabasePage.tsx`
- Modify: `packages/ui/src/lib/i18n/messages/db-bindings.i18n.ts`

**Interfaces:**
- Consumes: Task 1 路由、Task 3 store、Task 2 `bindingNameOf`。
- Produces: 无（纯 UI）。

- [ ] **Step 1: 补 i18n（15 locale）**

新增键：`settings.db.grid.primaryBadge`、`settings.db.grid.action.makePrimary`、`settings.db.grid.action.clearPrimary`、`settings.db.dialog.sslHint`、`settings.db.dialog.sslOption.default/disable/prefer/require/verify-ca/verify-full`、`settings.db.dialog.versionHint`、`settings.db.picker.label`、`settings.db.picker.defaultOption`、`settings.db.picker.aria`、`settings.db.prompt.binding`。`sslOption.*` 文案即 spec §6 的六行说明。英文与中文为准，其余 locale 直译。

- [ ] **Step 2: 设置页接主选**

`DatabasePage` 用 `useDbBindingStore` 的 `primaryByDirectory[settingsDirectory]`；挂载时 `loadPrimary(settingsDirectory)`。只有一个绑定时把它视作主选（不写文件）。卡片 `badges` 增加 `<SettingsCardPill tone="accent">` 主选标记；`actions` 增加「设为主选 / 取消主选」。`handleDelete` 成功后若删的是主选则 `setPrimary(dir, null)`。

- [ ] **Step 3: SSL 选项可读**

`SelectItem` 内容改为两行（名称 + `typography-micro` 说明），`Select` 下方渲染当前选择的一行说明；「默认」项的原始值 `default` 仅作内部值。补 dbhub 版本 hint。

- [ ] **Step 4: 验证**

Run: `bun run --cwd packages/ui type-check && bun test packages/ui/src/lib/i18n/messages.test.ts`
Expected: type-check 0 错误；locale 键位一致。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/components/sections/database packages/ui/src/lib/i18n/messages/db-bindings.i18n.ts
git commit -m "feat(db): show the primary badge and explain the SSL options"
```

---

### Task 5: 会话选择器

**Files:**
- Create: `packages/ui/src/components/chat/composer/ui/SessionDbBindingPicker.tsx`
- Modify: `packages/ui/src/components/chat/composer/ui/ComposerFooter.tsx`

**Interfaces:**
- Consumes: `useMcpConfigStore` + `selectMcpServersForDirectory`、`listDbBindings`、`resolveEffectiveBinding`、`useDbBindingStore`、`useI18n`。
- Produces: `<SessionDbBindingPicker directory sessionId />`。

- [ ] **Step 1: 实现组件**

用 DropdownMenu：触发器是 `Icon name="database-2"` + 生效绑定别名（`typography-meta`，窄屏只留图标）。菜单项：第一项「主选（默认）」清空选择；其余每个绑定一行，显示别名 + host/db + 只读 chip。无绑定或 `isBtw` 时返回 `null`。触发器 `aria-label` 用 `settings.db.picker.aria`。

- [ ] **Step 2: 接进页脚左侧按钮组**

在 `ComposerFooter` 左组（附件/权限按钮之后）插入 `<SessionDbBindingPicker directory={directory} sessionId={currentSessionId} />`，与 `SessionGoalButton` 同级；并行模式与 btw 不渲染。

- [ ] **Step 3: 验证**

Run: `bun run --cwd packages/ui type-check`
Expected: 0 错误。

- [ ] **Step 4: 提交**

```bash
git add packages/ui/src/components/chat/composer/ui
git commit -m "feat(db): pick the session database from the composer"
```

---

### Task 6: 发送时注入绑定提示

**Files:**
- Modify: `packages/ui/src/components/chat/composer/input/useComposerSubmission.ts`
- Test: `packages/ui/src/lib/db-bindings/dsn.test.ts`（已覆盖纯函数）+ 手工/E2E 验证

**Interfaces:**
- Consumes: Task 2 `listDbBindings/resolveEffectiveBinding/buildDbBindingPrompt`，Task 3 store。
- Produces: 无新导出。

- [ ] **Step 1: 计算并注入**

在 `useComposerSubmission` 组装 `syntheticTexts` 处追加：读取当前目录 dbhub 绑定与 `primaryByDirectory[directory]`、`selectionBySession[sessionId]`，调用 `dbBindingPromptFor`；有结果则 push `text` 并 `markAnnounced(sessionId, entryName)`。`isBtwActive` 或 `sessionId` 为空时跳过。

- [ ] **Step 2: 验证纯函数回退路径**

Run: `bun test packages/ui/src/lib/db-bindings/dsn.test.ts packages/ui/src/stores/useDbBindingStore.test.ts`
Expected: 全部通过（含 stale primary/selection 回退）。

- [ ] **Step 3: 提交**

```bash
git add packages/ui/src/components/chat/composer/input/useComposerSubmission.ts
git commit -m "feat(db): tell the session which database it should use"
```

---

### Task 7: 端到端验证

**Files:** 无（验证任务）

- [ ] **Step 1: 起本地服务**（需用户同意后才起 dev；否则说明跳过）

Run: `cd /d/Code/openchamber && bun run dev`
Expected: UI `http://127.0.0.1:5180`，API 3902。

- [ ] **Step 2: Playwright 全链路**

1. 两个绑定 → 右键「设为主选」→ 卡片出现主选徽标；
2. 新会话页脚显示主选名 → 发一条消息 → 转录出现“本会话数据库：…”提示；
3. 切换选择 → 再发一条 → 出现新提示，不重复旧提示；
4. 删除主选 → 主选态清空，选择器回退到剩余绑定。

- [ ] **Step 3: 质量门**

Run: `bun run --cwd packages/ui type-check && bun run --cwd packages/web type-check:server && bun test packages/ui/src/lib/db-bindings packages/ui/src/stores/useDbBindingStore.test.ts`
Expected: 全绿；UI 全量测试对照基线约 16 个既有失败，无新增。

- [ ] **Step 4: 提交并推 fork main**

```bash
git push fork main
```
