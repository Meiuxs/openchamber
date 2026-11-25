# 会话框关联选择器对齐 Issue/PR 板 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让会话框「加号 → 关联 Issue/PR」选择器与 Issue/PR 板使用同一套仓库发现与选择：根目录不是仓库时扫描子目录并跨仓库列出，根是仓库时可在根与子仓库间切换，且附加条目按自身目录解析。

**Architecture:** 把板的仓库范围解析、仓库选择器、跨仓库说明下沉到中性模块；`ReferencePickerDialog` 用可选 `nestedRepositories` 接管范围并把 `directories` 传给已有的跨仓库模式；选择条目在勾选瞬间盖上目录，附加时按目录取 read context。

**Tech Stack:** React + TypeScript、Zustand、bun:test、oxlint、tsc。

**Spec:** `docs/superpowers/specs/2026-11-26-composer-reference-nested-repositories-design.md`

## Global Constraints

- 只在 `source === 'repository'` 时启用仓库范围逻辑；tracker 选择器不受影响。
- `NewWorktreeDialog`、VS Code 行为不变。
- 不持久化所选的仓库；每次打开用默认值。
- 附加的 read context 用 `firstByOrder(contexts, descriptors)`（descriptor `order`），与列表/预览一致。
- 不提交、不推送与本次无关的既有改动（`bun.lock`、根目录 zip、`.playwright-*` 等）。
- UI 测试用 bun:test：在 `packages/ui` 下 `bun test <path>`；lint：`bun run --cwd packages/ui lint`；类型：`bun run --cwd packages/ui type-check`。

## Review Focus

- 在仓库 A 勾选条目后切到仓库 B 再确认：chip 必须用 A 的目录/绑定，不能静默用 B。（Task 3 的 `repositorySelection` 测试 + Task 6 的 `contextFor` 测试）
- tracker（Linear/Local）选择器里不应出现仓库选择器，`useReferenceBrowser` 的 `directories` 必须是 `null`。（Task 4 的 `scopesRepositories` / `listDirectoriesOf` 测试）
- 一个目录绑定多个 provider 时，附加必须与列表选同一个 host。（Task 6 的 descriptor order 测试）
- 根目录不是仓库且没有子仓库时，仍显示 `no-repo` 空状态而不是报错。（Task 4 纯函数覆盖 `all=false` 路径；Task 5 复用现有空状态）
- 子仓库中的条目预览/状态必须走条目目录，否则评论、链接、上传都会读错目录。（Task 5 的 `itemDirectory` 接线）

---

### Task 1: 下沉仓库范围解析

**Files:**
- Create: `packages/ui/src/lib/source-control/repositoryScope.ts`
- Modify: `packages/ui/src/components/sourceBoard/boardRepository.ts`
- Test: `packages/ui/src/components/sourceBoard/boardRepository.test.ts`、`boardRepository.hooks.test.tsx`（既有，不改）

**Interfaces:**
- Produces:
  - `type RepositoryScope = { status: 'pending' | 'failed' | 'ready'; directory: string | null; repositories: readonly string[]; all: boolean; allAvailable: boolean; choosable: boolean }`
  - `type RepositoryChoice = { path: string | null; all: boolean | undefined }`
  - `resolveRepositoryScope(root: string | null, rootIsGitRepo: boolean | null, nestedRepos: NestedRepoDiscovery | undefined, choice: RepositoryChoice, acrossAvailable: boolean): RepositoryScope`
  - `useRepositoryScope(root: string | null, choice: RepositoryChoice): RepositoryScope & { retry: () => void; discoveryFailed: boolean; discoveryPending: boolean }`
  - `repositoryLabel(repository: string, root: string): string`

- [ ] **Step 1: 迁入实现**

把 `boardRepository.ts` 中 `BoardRepository`、`RepositoryChoice`、`resolveBoardRepository`、`useFolderRepositories`、`useBoardRepository`、`repositoryLabel` 的**函数体与注释原样**移到新文件 `repositoryScope.ts`，并改名：`BoardRepository` → `RepositoryScope`、`resolveBoardRepository` → `resolveRepositoryScope`、`useBoardRepository` → `useRepositoryScope`。导入保持不变（`useRuntimeAPIs`、`discoverNestedRepos`、`useGitStore`/`useIsGitRepo`/`useNestedRepos`/`NestedRepoDiscovery`、`useDirectoryStore`）。

- [ ] **Step 2: 板模块改为 re-export**

`boardRepository.ts` 删除已迁走的定义，加入：

```ts
import type { RepositoryChoice, RepositoryScope as BoardRepository } from '@/lib/source-control/repositoryScope';
export { repositoryLabel, resolveRepositoryScope as resolveBoardRepository, useRepositoryScope as useBoardRepository } from '@/lib/source-control/repositoryScope';
export type { RepositoryChoice, RepositoryScope as BoardRepository } from '@/lib/source-control/repositoryScope';
```

保留 `choiceForFocus`、`shouldRememberAll`、`resolveBoardTab`、`useLinkRepository`、`resolvePullLinkTarget`、`folderOfRepository`。`resolveBoardTab` 的 `repositoryStatus: BoardRepository['status']` 用上面的类型导入。

- [ ] **Step 3: 运行板测试**

Run: `cd packages/ui && bun test src/components/sourceBoard/boardRepository.test.ts src/components/sourceBoard/boardRepository.hooks.test.tsx`
Expected: PASS（全部既有用例通过）。

- [ ] **Step 4: Lint**

Run: `bun run --cwd packages/ui lint`
Expected: 0 errors（未使用导入会被报出，按提示清理）。

---

### Task 2: 下沉仓库选择器与跨仓库说明

**Files:**
- Create: `packages/ui/src/components/sourceControl/RepositoryPicker.tsx`
- Create: `packages/ui/src/components/sourceControl/RepositoryAcrossNote.tsx`
- Modify: `packages/ui/src/components/sourceBoard/SourceBoardPickers.tsx`
- Modify: `packages/ui/src/components/sourceBoard/SourceBoardAcrossNote.tsx`
- Test: `packages/ui/src/components/sourceBoard/SourceBoardPickers.test.tsx`（既有，不改）

**Interfaces:**
- Produces:
  - `RepositoryPicker: React.FC<{ repositories: readonly string[]; selected: string | null; root: string; allAvailable: boolean; onSelect: (repository: string | null) => void; sheet?: boolean; size?: 'toolbar' | 'inline' }>`
  - `RepositoryAcrossNote: React.FC<{ leftOut: readonly AcrossExclusion[]; root: string; askedProvider: string | null }>`

- [ ] **Step 1: 迁移 `SourceBoardRepositoryPicker`**

把组件及其私有类型 `RepositoryEntry` 原样移到 `components/sourceControl/RepositoryPicker.tsx`，导出名 `RepositoryPicker`。`repositoryLabel` 改从 `@/lib/source-control/repositoryScope` 导入。新增可选 `size: 'toolbar' | 'inline' = 'toolbar'`，`triggerClass` 与 `TRIGGER_CLASS` 使用该尺寸（同时把 `TRIGGER_CLASS` 复制到新文件，`inline` 值为 `'h-7 max-w-[14rem] px-1.5 typography-meta'`）。

- [ ] **Step 2: `SourceBoardPickers.tsx` 改为 re-export**

删除该组件与 `RepositoryEntry`，加入：

```ts
export { RepositoryPicker as SourceBoardRepositoryPicker } from '@/components/sourceControl/RepositoryPicker';
```

清理因此未使用的导入（`repositoryLabel`、`MobileOverlayPanel`、`MobileSheetRow`、`MobileSheetSearch`、`Icon` 若他处仍用则保留）。先用 `rg -n "MobileOverlayPanel|MobileSheetRow|MobileSheetSearch|repositoryLabel" packages/ui/src/components/sourceBoard/SourceBoardPickers.tsx` 确认。

- [ ] **Step 3: 迁移 `SourceBoardAcrossNote`**

把组件原样移到 `components/sourceControl/RepositoryAcrossNote.tsx`，导出名 `RepositoryAcrossNote`，`repositoryLabel` 改从 shared 模块导入。`sourceBoard/SourceBoardAcrossNote.tsx` 整个文件改为：

```ts
export { RepositoryAcrossNote as SourceBoardAcrossNote } from '@/components/sourceControl/RepositoryAcrossNote';
```

- [ ] **Step 4: 运行测试**

Run: `cd packages/ui && bun test src/components/sourceBoard/SourceBoardPickers.test.tsx`
Expected: PASS。

- [ ] **Step 5: Lint**

Run: `bun run --cwd packages/ui lint`
Expected: 0 errors。

---

### Task 3: 选择变体携带目录

**Files:**
- Modify: `packages/ui/src/components/references/referencePickerItems.ts`
- Create: `packages/ui/src/components/references/referencePickerItems.test.ts`

**Interfaces:**
- Produces:
  - `ReferencePickerSelection` 的 repository 变体增加 `directory?: string`
  - `type RepositoryPickerItem = Extract<ReferencePickerItem, { source: 'repository' }>`
  - `itemWithDirectory(item: RepositoryPickerItem, directory: string | null): RepositoryPickerItem` — 已有 `item.directory` 时原样返回，否则在 `directory` 非空时复制并写入。
  - `repositorySelection(item: RepositoryPickerItem, includeDiff: boolean, directory: string | null): ReferencePickerSelection` — 返回 `{ source: 'repository', reference: item.reference, includeDiff, directory: item.directory ?? directory ?? undefined }`。

- [ ] **Step 1: 写失败测试**

`referencePickerItems.test.ts`：

```ts
import { describe, expect, test } from 'bun:test';
import type { RepositoryIssueReference } from '@/lib/api/types';
import { itemWithDirectory, repositorySelection } from './referencePickerItems';

const issue = (number: number, owner = 'acme', repo = 'app'): RepositoryIssueReference => ({
    kind: 'issue', provider: 'github', number, title: `#${number}`,
    url: `https://github.com/${owner}/${repo}/issues/${number}`, state: 'open',
    body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null,
    labels: [], commentCount: 0, sourceRepo: { owner, repo, source: 'origin' },
});
const item = { source: 'repository' as const, reference: issue(7) };

describe('reference selection directory', () => {
  test('stamps the folder the item was listed in', () => {
    expect(itemWithDirectory(item, '/work/a')).toMatchObject({ directory: '/work/a' });
  });
  test('keeps a directory already carried by the item', () => {
    const listed = { ...item, directory: '/work/a' };
    expect(itemWithDirectory(listed, '/work/b')).toBe(listed);
    expect(repositorySelection(listed, false, '/work/b')).toMatchObject({ directory: '/work/a' });
  });
  test('selection falls back to the given directory', () => {
    expect(repositorySelection(item, true, '/work/a')).toMatchObject({ directory: '/work/a', includeDiff: true });
  });
  test('no directory stays undefined', () => {
    expect(repositorySelection(item, false, null).directory).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/ui && bun test src/components/references/referencePickerItems.test.ts`
Expected: FAIL（`itemWithDirectory`/`repositorySelection` 未导出）。

- [ ] **Step 3: 实现**

在 `referencePickerItems.ts` 的类型与导出中按 Interfaces 增加字段和两个函数。

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/ui && bun test src/components/references/referencePickerItems.test.ts`
Expected: PASS。

---

### Task 4: 选择器的范围映射（纯函数）

**Files:**
- Create: `packages/ui/src/components/references/pickerRepositoryScope.ts`
- Create: `packages/ui/src/components/references/pickerRepositoryScope.test.ts`

**Interfaces:**
- Consumes: `RepositoryScope`（Task 1）、`ReferencePickerSource`（`referencePickerItems.ts`）。
- Produces:
  - `scopesRepositories(source: ReferencePickerSource, nestedRepositories: boolean): boolean` — `nestedRepositories && source === 'repository'`。
  - `listDirectoryOf(scope: RepositoryScope | null, directory: string | null): string | null` — `scope?.directory ?? directory`。
  - `listDirectoriesOf(scope: RepositoryScope | null): readonly string[] | null` — `scope?.all ? scope.repositories : null`。
  - `DEFAULT_REPOSITORY_CHOICE: RepositoryChoice` — `{ path: null, all: undefined }`。
  - `repositoryChoiceFromPicker(repository: string | null): RepositoryChoice` — `repository === null ? { path: null, all: true } : { path: repository, all: false }`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from 'bun:test';
import type { RepositoryScope } from '@/lib/source-control/repositoryScope';
import { DEFAULT_REPOSITORY_CHOICE, listDirectoriesOf, listDirectoryOf, repositoryChoiceFromPicker, scopesRepositories } from './pickerRepositoryScope';

const scope = (patch: Partial<RepositoryScope>): RepositoryScope => ({
    status: 'ready', directory: '/work/a', repositories: ['/work/a', '/work/b'],
    all: false, allAvailable: true, choosable: true, ...patch,
});

describe('picker repository scope', () => {
  test('only repository sources take a repository scope', () => {
    expect(scopesRepositories('repository', true)).toBe(true);
    expect(scopesRepositories('tracker:linear', true)).toBe(false);
    expect(scopesRepositories('repository', false)).toBe(false);
  });
  test('a single repository lists that directory and no directories', () => {
    expect(listDirectoryOf(scope({}), '/root')).toBe('/work/a');
    expect(listDirectoriesOf(scope({}))).toBeNull();
  });
  test('all repositories lists the root and passes every folder', () => {
    expect(listDirectoryOf(scope({ all: true, directory: '/root' }), '/root')).toBe('/root');
    expect(listDirectoriesOf(scope({ all: true }))).toEqual(['/work/a', '/work/b']);
  });
  test('no scope keeps the caller directory and no across list', () => {
    expect(listDirectoryOf(null, '/root')).toBe('/root');
    expect(listDirectoriesOf(null)).toBeNull();
  });
  test('a chosen repository becomes a single choice; all becomes the all choice', () => {
    expect(repositoryChoiceFromPicker('/work/b')).toEqual({ path: '/work/b', all: false });
    expect(repositoryChoiceFromPicker(null)).toEqual({ path: null, all: true });
    expect(DEFAULT_REPOSITORY_CHOICE).toEqual({ path: null, all: undefined });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/ui && bun test src/components/references/pickerRepositoryScope.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `pickerRepositoryScope.ts`**

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/ui && bun test src/components/references/pickerRepositoryScope.test.ts`
Expected: PASS。

---

### Task 5: 对话框接入范围，条目按目录预览

**Files:**
- Modify: `packages/ui/src/components/references/ReferencePickerDialog.tsx`
- Modify: `packages/ui/src/components/chat/composer/input/renderComposerDialogs.tsx`

**Interfaces:**
- Consumes: Task 1 `useRepositoryScope`、Task 2 `RepositoryPicker`/`RepositoryAcrossNote`、Task 3 `itemWithDirectory`/`repositorySelection`、Task 4 的四个纯函数。
- Produces: `ReferencePickerDialog` 新增可选 prop `nestedRepositories?: boolean`。

- [ ] **Step 1: 加 props 与范围**

在 props 类型与 `ReferencePickerSurface` 解构中加入 `nestedRepositories = false`。在 Surface 中：

```ts
const [choice, setChoice] = React.useState<RepositoryChoice>(DEFAULT_REPOSITORY_CHOICE);
const scoped = scopesRepositories(source, nestedRepositories);
const scope = useRepositoryScope(scoped ? directory : null, choice);
const browser = useReferenceBrowser({
  source,
  directory: listDirectoryOf(scope, directory),
  directories: listDirectoriesOf(scope),
  isMobile,
  initialGitHubKind,
  retainedItems: checked,
});
```

- [ ] **Step 2: 勾选与确认带目录**

`toggleChecked` 对 repository 变体写入目录：

```ts
const next = new Map(current);
if (next.has(key)) next.delete(key);
else next.set(key, item.source === 'repository' ? itemWithDirectory(item, browser.directory) : item);
```

`toSelection` 的 repository 分支改为：

```ts
{ source: 'repository', ...repositorySelection(item, diffIncluded.has(referencePickerItemKey(item)), browser.directory) }
```

（保留 `repositorySelection` 返回的 `directory`；不要再用其它目录覆盖。）

- [ ] **Step 3: 头部仓库选择器**

桌面头部：在标题之后、`{tabs}` 之前插入：

```tsx
{scoped && scope?.choosable && directory ? (
  <RepositoryPicker
    repositories={scope.repositories}
    selected={scope.all ? null : scope.directory}
    root={directory}
    allAvailable={scope.allAvailable}
    onSelect={(repository) => setChoice(repositoryChoiceFromPicker(repository))}
    size="inline"
  />
) : null}
```

移动头部：在 `inPreview ? null :` 的 fragment 中，`{tabs}` 之前插入同一组件并传 `sheet`。

- [ ] **Step 4: 跨仓库说明、预览目录**

`ReferenceBrowserList` 增加：

```tsx
notice={browser.across && directory ? (
  <RepositoryAcrossNote leftOut={browser.leftOut} root={directory} askedProvider={browser.acrossProvider} />
) : null}
```

`ReferencePreview` 的 `directory` 改为 `itemDirectory(previewItem, browser.directory)`，`pullStatus` 改为 `browser.pullStatusOf(previewItem.reference, previewItem.directory)`（仅 repository 分支）。

- [ ] **Step 5: 会话框传参**

`renderComposerDialogs.tsx` 的 `<ReferencePickerDialog>` 增加 `nestedRepositories`（直接写在元素上，表示启用）。

- [ ] **Step 6: Lint 与类型**

Run: `bun run --cwd packages/ui lint`
Expected: 0 errors。

Run: `bun run --cwd packages/ui type-check`
Expected: PASS（`tsc -b` 无输出/成功退出）。

---

### Task 6: 附加按条目目录取上下文

**Files:**
- Modify: `packages/ui/src/components/references/resolveComposerReferences.ts`
- Modify: `packages/ui/src/components/references/useAttachReferences.ts`
- Modify: `packages/ui/src/components/references/referenceSources.ts`（导出 `firstByOrder`）
- Test: `packages/ui/src/components/references/resolveComposerReferences.test.ts`（扩展）

**Interfaces:**
- Produces:
  - `ReferenceResolveDeps` 增加 `contextFor?: (directory: string) => Promise<SourceControlReadContext | null>`
  - `referenceSources.ts` 导出 `firstByOrder<T extends { provider: string }>(entries: readonly T[], descriptors: readonly SourceControlProviderDescriptor[]): T | null`

- [ ] **Step 1: 写失败测试**

在 `resolveComposerReferences.test.ts` 顶部补导入：

```ts
import type { Issue } from '@/lib/api/types';
import { repositorySelection } from './referencePickerItems';
```

在文件内新增 helper 与常量（放在 `describe` 之前）：

```ts
const issueReference = {
    kind: 'issue' as const, provider: 'github', number: 7, title: 'Nested issue',
    url: 'https://github.com/acme/app/issues/7', state: 'open' as const,
    body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null,
    labels: [], commentCount: 0, sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' as const },
};
const repositoryItem = { source: 'repository' as const, reference: issueReference };
const issueFrom = (through: SourceControlReadContext): Issue => ({
    provider: through.provider, instance: through.instance, id: '7', number: 7,
    project: { id: 'repo', owner: 'acme', name: 'app', provider: through.provider, instance: through.instance, url: 'https://github.com/acme/app' },
    title: issueReference.title, url: issueReference.url, state: 'open',
});
```

在 `describe('resolveComposerReferences', ...)` 内新增：

```ts
test('a selection stamped with a folder reads through that folder context', async () => {
  const other: SourceControlReadContext = { ...context, directory: '/nested', repositoryId: 'nested' };
  const askedDirectories: string[] = [];
  const askedContexts: string[] = [];
  const sourceControl = {
    issueGet: async (through: SourceControlReadContext) => { askedContexts.push(through.directory); return issueFrom(through); },
    issueComments: async () => [],
    changeRequestContext: async () => { throw new Error('not a pull'); },
    referenceDetail: async () => { throw new Error('not a discussion'); },
  } as unknown as Pick<SourceControlAPI, 'issueGet' | 'issueComments' | 'changeRequestContext' | 'referenceDetail'>;
  const result = await resolveComposerReferences([repositorySelection(repositoryItem, false, '/nested')], {
    sourceControl, context,
    contextFor: async (dir) => { askedDirectories.push(dir); return other; },
    readTrackerDetail: async () => { throw new Error('unused'); },
    trackerName: () => 'Tracker',
  });
  expect(result.failures).toEqual([]);
  expect(askedDirectories).toEqual(['/nested']);
  expect(askedContexts).toEqual(['/nested']);
});

test('a stamped folder without a context fails instead of falling back', async () => {
  const result = await resolveComposerReferences([repositorySelection(repositoryItem, false, '/nested')], {
    sourceControl: {
      issueGet: async () => issueFrom(context), issueComments: async () => [],
      changeRequestContext: async () => { throw new Error('x'); }, referenceDetail: async () => { throw new Error('x'); },
    } as unknown as Pick<SourceControlAPI, 'issueGet' | 'issueComments' | 'changeRequestContext' | 'referenceDetail'>,
    context,
    contextFor: async () => null,
    readTrackerDetail: async () => { throw new Error('unused'); },
    trackerName: () => 'Tracker',
  });
  expect(result.failures[0]?.error).toContain('not available');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/ui && bun test src/components/references/resolveComposerReferences.test.ts`
Expected: FAIL（`contextFor` 未支持，仍用 `deps.context`）。

- [ ] **Step 3: 实现解析**

`resolveOne`：

```ts
const { sourceControl } = deps;
const context = selection.directory && deps.contextFor
  ? await deps.contextFor(selection.directory)
  : deps.context;
if (!context) throw new Error('The repository is not available here');
```

（tracker 分支在更早返回，不受影响。）`ReferenceResolveDeps` 加可选字段与注释。

- [ ] **Step 4: 接上 `contextFor`**

`referenceSources.ts` 给 `firstByOrder` 加 `export`。

`useAttachReferences.ts` 的 `useReferenceResolveDeps`：

```ts
const { sourceControl, trackers } = useRuntimeAPIs();
const descriptors = useSourceControlProviders();
const repositoryContext = useRepositoryReadContext(directory);
const contextFor = React.useCallback(async (target: string) => {
  const state = await repositoryBindingOwner.read(repositoryBindingOwner.scope(target), sourceControl);
  return firstByOrder(state.contexts, descriptors);
}, [descriptors, sourceControl]);
return React.useMemo(() => ({
  sourceControl,
  context: repositoryContext && repositoryContext !== 'missing' ? repositoryContext : null,
  contextFor,
  readTrackerDetail: ...,
  trackerName: ...,
}), [contextFor, repositoryContext, sourceControl, trackers]);
```

导入 `repositoryBindingOwner` 自 `@/lib/source-control/repository-binding`，`useSourceControlProviders` 自 providers registry，`firstByOrder` 自 `./referenceSources`。

- [ ] **Step 5: 写排序测试**

新建 `packages/ui/src/components/references/referenceSources.order.test.ts`：

```ts
import { expect, test } from 'bun:test';
import { githubLikeDescriptor, gitlabLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { firstByOrder } from './referenceSources';

test('contexts are ordered by descriptor order, not by array order', () => {
  const contexts = [{ provider: 'gitlab' }, { provider: 'github' }];
  expect(firstByOrder(contexts, [gitlabLikeDescriptor, githubLikeDescriptor])?.provider).toBe('gitlab');
  expect(firstByOrder(contexts, [githubLikeDescriptor, gitlabLikeDescriptor])?.provider).toBe('github');
});
```

若 `firstByOrder` 尚未导出，先导出再运行。

- [ ] **Step 6: 运行确认通过**

Run: `cd packages/ui && bun test src/components/references/resolveComposerReferences.test.ts src/components/references/referenceSources.order.test.ts`
Expected: PASS。

- [ ] **Step 7: 回归既有 references 测试**

Run: `cd packages/ui && bun test src/components/references/referencePickerItems.test.ts src/components/references/pickerRepositoryScope.test.ts src/components/references/referenceSources.order.test.ts src/components/chat/__tests__/ChatInput.references.test.tsx`
Expected: PASS。

---

### Task 7: 文档、全量验证与提交

**Files:**
- Modify: `packages/ui/src/components/references/DOCUMENTATION.md`
- Modify: `packages/ui/src/components/chat/composer/DOCUMENTATION.md`
- Modify: `packages/ui/src/components/sourceBoard/DOCUMENTATION.md`

- [ ] **Step 1: 更新文档**

- `references/DOCUMENTATION.md`：在 picker 章节写明 `nestedRepositories` 的三种范围（根是仓库 / 非仓库有子仓库 / 无子仓库）、勾选即盖章目录、附加按条目目录经 `firstByOrder` 取 context、tracker 不启用。
- `chat/composer/DOCUMENTATION.md`：加号里的「关联 Issue/PR」与板一致，会扫描子目录并按仓库切换。
- `sourceBoard/DOCUMENTATION.md`：注明仓库范围解析与选择器已下沉到 `lib/source-control/repositoryScope.ts` 和 `components/sourceControl/`，板以原名字 re-export。

- [ ] **Step 2: 全量验证**

Run: `cd packages/ui && bun test src/components/sourceBoard src/components/references`
Expected: PASS。

Run: `bun run --cwd packages/ui lint`
Expected: 0 errors。

Run: `bun run --cwd packages/ui type-check`
Expected: PASS。

Run（记录基线，不要求全绿）: `bun run --cwd packages/ui test`
Expected: 与既有基线一致；依据memory，UI 全量有约 16 个与本次无关的既有失败，只允许这些基线失败。

- [ ] **Step 3: 代码审查**

按 `superpowers:requesting-code-review` 对本次 diff 做一次独立审查；修掉审查提出的问题后重跑 Step 2。

- [ ] **Step 4: 创建分支并提交**

```bash
git switch -c feat/composer-reference-nested-repos
git add docs/superpowers/specs/2026-11-26-composer-reference-nested-repositories-design.md \
  docs/superpowers/plans/2026-11-26-composer-reference-nested-repositories.md \
  packages/ui/src/lib/source-control/repositoryScope.ts \
  packages/ui/src/components/sourceControl/RepositoryPicker.tsx \
  packages/ui/src/components/sourceControl/RepositoryAcrossNote.tsx \
  packages/ui/src/components/sourceBoard/boardRepository.ts \
  packages/ui/src/components/sourceBoard/SourceBoardPickers.tsx \
  packages/ui/src/components/sourceBoard/SourceBoardAcrossNote.tsx \
  packages/ui/src/components/references/referencePickerItems.ts \
  packages/ui/src/components/references/referencePickerItems.test.ts \
  packages/ui/src/components/references/pickerRepositoryScope.ts \
  packages/ui/src/components/references/pickerRepositoryScope.test.ts \
  packages/ui/src/components/references/ReferencePickerDialog.tsx \
  packages/ui/src/components/references/resolveComposerReferences.ts \
  packages/ui/src/components/references/resolveComposerReferences.test.ts \
  packages/ui/src/components/references/useAttachReferences.ts \
  packages/ui/src/components/references/referenceSources.ts \
  packages/ui/src/components/references/referenceSources.order.test.ts \
  packages/ui/src/components/chat/composer/input/renderComposerDialogs.tsx \
  packages/ui/src/components/references/DOCUMENTATION.md \
  packages/ui/src/components/chat/composer/DOCUMENTATION.md \
  packages/ui/src/components/sourceBoard/DOCUMENTATION.md
git commit -m "feat(references): link issues and PRs from nested repositories"
```

不要 `git add -A`；不要提交 `bun.lock`、根目录 zip、`.playwright-*`、`sessions-probe.json` 等无关文件。提交前用 `git status --short` 核对暂存清单。

- [ ] **Step 5: 报告**

输出：改动文件清单、测试/lint/类型结果、全量测试与基线的差异、提交哈希和分支名。
