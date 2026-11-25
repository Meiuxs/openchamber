# 会话框「关联 Issue/PR」与 Issue/PR 板对齐 · 设计

日期：2026-11-26
状态：待用户批准

## 意图

加号菜单里的「关联 {provider} Issue 或 PR」打开的就是 Issue/PR 板所用的 `ReferencePickerDialog`，数据源却只认当前会话目录这一个仓库：目录不是 git 仓库时，`useRepositoryReadContext` 返回 `missing`，列表落到 `no-repo` 空状态；而板会通过 `ensureNestedRepos` 扫描子目录，根不是仓库时默认跨仓库列出。

目标：让会话框的关联选择器在「仓库识别与选择」上与板一致——

1. 根目录是 git 仓库、下面还有子仓库：提供仓库选择器（根 + 各子仓库），默认根。
2. 根目录不是 git 仓库：扫描子目录；provider 支持 `referencesAcross` 时默认「全部仓库」，也可选单个子仓库。
3. 讨论（Discussions）随 provider 能力自动出现，与板一致。
4. 从子仓库附加的条目，上下文读取走该子仓库的仓库绑定。

## 目标

- 与板共用同一套仓库范围解析、仓库选择器和跨仓库排除说明。
- 列表、搜索、预览、状态、讨论、分页行为与板一致。
- 选定条目的附加（生成 composer chip）使用条目所在目录的 read context。

## 非目标

- 不持久化所选仓库。每次打开对话框使用默认值（根为仓库→根；根非仓库→全部）。板按 project 持久化，本次不搬。
- 不改 `NewWorktreeDialog` 的选择器：它仍只读项目目录。
- 不改变 VS Code 行为：VS Code 没有加号下拉，也没有板。
- 不修复「根目录非仓库时粘贴 Issue 链接」的解析（`resolveReferenceLink` 仍只认会话目录），留作后续。
- 不新增 provider 能力，不改服务端。

## 约束

- `sourceBoard/boardRepository.ts` 已依赖 `components/references/referencePickerItems`；references 若反向 import sourceBoard 会形成循环。共享逻辑必须下沉到中性模块。
- `ReferencePickerSelection` 的 repository 变体需要携带 `directory`，Tracker 变体不变。
- 附件解析目前用单一 read context（会话目录）；必须支持按条目目录解析。
- UI 测试用 bun:test；服务端不涉及。
- references / composer / sourceBoard 三个目录的 `DOCUMENTATION.md` 需要同步。

## 方案

**选定方案 A：下沉共享模块，板与会话框共用。**

- 备选 B：references 直接 import `boardRepository`。否决——`boardRepository → references/referencePickerItems` 会造成循环依赖。
- 备选 C：在 references 里复制一份发现逻辑。否决——两处逻辑必然漂移，且现有大量板测试覆盖不到复制品。
- 备选 D：服务端扫描目录返回仓库列表。否决——超出本次范围，且服务端没有会话目录的发现职责。

## 设计

### 1. 下沉共享的仓库范围与选择器

新 `packages/ui/src/lib/source-control/repositoryScope.ts`，从 `sourceBoard/boardRepository.ts` 原样迁入：

- 类型 `RepositoryChoice`、`RepositoryScope`（原 `BoardRepository`）。
- `resolveRepositoryScope`（原 `resolveBoardRepository`）：探测结果、发现结果、`all`/`allAvailable`/`choosable` 的判定不变。
- `useFolderRepositories`（原私有函数）。
- `useRepositoryScope`（原 `useBoardRepository`）：返回 `retry`、`discoveryFailed`、`discoveryPending` 不变。
- `repositoryLabel`。

`sourceBoard/boardRepository.ts` 保留板专用部分（`choiceForFocus`、`shouldRememberAll`、`resolveBoardTab`、`useLinkRepository`、`resolvePullLinkTarget`、`folderOfRepository`），并以原名字 re-export 迁走的符号。`SourceBoardView` 和现有测试不改。

新 `packages/ui/src/components/sourceControl/RepositoryPicker.tsx`：把 `SourceBoardRepositoryPicker` 原样迁入，增加可选 `size`（默认 `toolbar`，对话框头部可用 `inline`）。`SourceBoardPickers.tsx` 以 `SourceBoardRepositoryPicker` 名字 re-export。

新 `packages/ui/src/components/sourceControl/RepositoryAcrossNote.tsx`：把 `SourceBoardAcrossNote` 迁入；`sourceBoard/SourceBoardAcrossNote.tsx` 改为 re-export，板的引用不动。

### 2. `ReferencePickerDialog` 接管范围（仅当调用方要求）

新增可选 prop `nestedRepositories?: boolean`，默认 `false`，保持 `NewWorktreeDialog` 现状。整套范围逻辑只在 `source === 'repository'` 时启用；tracker 选择器不显示仓库选择器，也不进入 across 状态（与板在 tracker 下显式传 `directory/directories = null` 一致）。

Surface 内：

- 本地状态 `choice = { path: string | null; all: boolean | undefined }`，初始 `{ path: null, all: undefined }`（即板的默认值）。
- `repositoryScoped = nestedRepositories && source === 'repository'`。
- `scope = useRepositoryScope(repositoryScoped ? directory : null, choice)`。
- `listDirectory = scope.directory ?? directory`。
- `directories = scope.all ? scope.repositories : null`。
- `useReferenceBrowser({ source, directory: listDirectory, directories, ... })`。
- 头部（桌面单行、移动端头部下方）在 `repositoryScoped && scope.choosable` 时渲染 `RepositoryPicker`：
  - `repositories = scope.repositories`
  - `selected = scope.all ? null : scope.directory`
  - `root = directory`
  - `allAvailable = scope.allAvailable`
  - `onSelect = (repo) => setChoice(repo === null ? { path: null, all: true } : { path: repo, all: false })`
  - `sheet = isMobile`
- 列表 `notice`：`browser.across ? <RepositoryAcrossNote leftOut={browser.leftOut} root={directory ?? ''} askedProvider={browser.acrossProvider} /> : null`。
- 预览目录改为条目自己的目录：`directory={itemDirectory(previewItem, browser.directory)}`，`pullStatusOf(reference, previewItem.directory)`。
- **勾选时盖章**：`toggleChecked(item)` 写入 `{ ...item, directory: item.directory ?? browser.directory ?? undefined }`（仅 repository 变体）。`checked` 是跨筛选/跨仓库保留的 Map，盖章必须在勾选瞬间完成，否则切换仓库后再确认会用当前仓库的绑定去读旧仓库的条目。
- `toSelection` 不再覆盖已盖章的 `directory`，只作缺省回填：`directory: item.directory ?? browser.directory ?? undefined`。因此允许一次跨多个仓库勾选并附加；底部「已选 N 项」沿用现有 retained-items 语义，切仓库不显示已勾选条目但计数保留。
- 切换仓库或「全部」不清空 `checked`（与现有搜索/筛选切换的行为一致）。

`chat/composer/input/renderComposerDialogs.tsx` 给关联选择器传 `nestedRepositories`。

### 3. 按条目目录附加

- `components/references/referencePickerItems.ts`：repository 选择变体增加可选 `directory`。
- `components/references/resolveComposerReferences.ts`：`ReferenceResolveDeps` 增加可选 `contextFor(directory): Promise<SourceControlReadContext | null>`。`resolveOne` 在 `selection.directory` 与 `deps.contextFor` 都存在时用它们取 context，否则回退 `deps.context`。
- `components/references/useAttachReferences.ts`：`useReferenceResolveDeps` 提供 `contextFor`，通过 `repositoryBindingOwner.read(repositoryBindingOwner.scope(directory), sourceControl)` 读取该目录的绑定，再按 `firstByOrder(binding.contexts, descriptors)` 选 context（与 `pickReadContext`、列表、预览完全一致，按 provider descriptor 的 `order`，不是数组第 0 个）。`descriptors` 取自 `useSourceControlProviders()`。读不到绑定或没有 context 时返回 `null`，由 `resolveOne` 报原有错误。
- `NewWorktreeDialog` 不传 `contextFor`，行为不变（其选择即便带 `directory` 也回退到 `deps.context`）。

### 4. 行为对照（与板一致）

| 根目录 | 可选 | 默认 | 列表数据源 |
| --- | --- | --- | --- |
| 是仓库 | 根 + 子仓库 | 根 | 单仓库列表 |
| 非仓库、有子仓库 | 全部 + 各子仓库 | 全部（`referencesAcross` 可用时；否则第一个子仓库） | 跨仓库列表 |
| 非仓库、无子仓库 | 无选择器 | — | `no-repo` 空状态 |

- `allAvailable` 取自运行时能力 `sourceControl.referencesAcross`（不是 provider 的 `features`）；不可用时 `allAvailable = false`，`all` 不成立，退回第一个子仓库；被排除的仓库出现在 `RepositoryAcrossNote`。
- 讨论标签沿用 `descriptor.features.discussions`，跨仓库时取跨仓库 provider 的能力。

### 5. 已知取舍

- 加号菜单文案仍由 `useRepositoryReferenceProvider(会话目录)` 决定；根非仓库时可能显示默认 provider 名称，点开后的对话框标题按实际 provider 显示。记为已知小瑕疵，本次不修。
- 选择不持久化，每次打开回到默认值。

## 测试

- `resolveComposerReferences.test.ts`：带 `directory` 的选择走 `contextFor`；`contextFor` 返回 `null` 时报错；无 `directory` 时仍用 `deps.context`；多 provider 绑定时按 descriptor order 取 context。
- `referencePickerItems.test.ts`（新增）：勾选盖章构造器把条目目录写入 selection，已有目录不被覆盖，缺省回退传入目录。
- `ReferencePickerDialog.nested.test.tsx`（新增，mock `useRepositoryScope` 与 `useReferenceBrowser`）：`all` 时把 `repositories` 作为 `directories` 传入；`choosable` 时渲染仓库选择器；确认的选择携带勾选时盖的 `directory`；tracker source 不渲染仓库选择器、`directories` 为 `null`。
- 既有 `boardRepository` 测试经 re-export 继续通过；`ReferenceBrowser` 的跨仓库测试不动。

## 文档

- `components/references/DOCUMENTATION.md`：选择器的目录范围、跨仓库说明、附件按条目目录解析。
- `components/chat/composer/DOCUMENTATION.md`：加号里的关联行为与板一致。
- `components/sourceBoard/DOCUMENTATION.md`：说明共享模块已下沉到 `lib/source-control/repositoryScope.ts` 与 `components/sourceControl/`。

## 留给实现者

- 共享模块的具体文件命名与 re-export 顺序。
- `RepositoryPicker` 在对话框头部的排版细节（桌面单行、移动端底部弹出）。
- 纯函数测试与接线测试的拆分粒度。
