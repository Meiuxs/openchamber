# OpenChamber 本地 Issue 管理 · 需求与设计方案（统一版）

> 版本：v2.2 · 日期：2026-11-01
> 本文件是唯一现行版本，取代《本地Issue管理需求规格.md》《本地Issue管理设计方案.md》（v1，server 级 JSON 存储，已废弃）与《本地Issue管理设计方案-v2-markdown.md》。
> v2.2 按已落地的实现（as-built）重写相关章节：v2.1 写于实现之前，本版与 shipped 代码一致，仍是唯一现行文档。
> 产品决策已于 2026-10-31/11-01 与维护者在会话中逐节确认；关键决策记录见 §14。

## 1. 背景

当前 OpenChamber 的 issue 查看与管理依赖外部系统：仓库类 issue 需连到项目绑定的 Git host（GitHub/GitLab/Gitea/Forgejo/Gerrit），Linear issue 需连接 Linear 云服务；Jira 无原生支持。内网、离线或独立工作场景下，缺少不依赖外部服务的"本地 issue"能力。

需求定位：issue 以 **markdown 文件形式存在项目仓库内**（grill-me 风格），人可直接编辑、可进 git、可跟代码一起提交；OpenChamber server 索引这些文件，board UI 提供完整浏览与 CRUD，agent 会话命令直接读写文件。同一份数据由 UI、agent 技能、手工编辑三方共用。

## 2. 现状要点（代码证据）

1. **Tracker 契约 provider-neutral**（`packages/web/server/lib/trackers/tracker-contract.d.ts`），能力位开放；新增 tracker 按文档路径 `server/lib/<id>/` + registry 一行注册，UI 主干零改动。
2. **契约的 create/edit 已随一期落地**（capabilities 与 `TrackerCreateItemInput`/`TrackerEditItemInput` 见 `tracker-contract.d.ts`）；Linear descriptor 显式声明 `create: false, edit: false`，扩展见 §7。
3. **tracker id `local` 可用**：命名规则 `^[a-z][a-z0-9-]{0,31}$`（`tracker-contract.d.ts:5`），保留 id 与内建 id 均不占用。
4. **server 没有项目根文件 watcher**（已验证 lib 内无 `fs.watch`/chokidar），索引走按需扫描。
5. **项目路径来源**：settings 的 `projects` 数组（`packages/web/server/index.js:2529-2532`，`sanitizeProjects` 清洗）。
6. **agent 命令**：OpenCode 从项目或用户目录的 `.opencode/commands/` 发现命令（`packages/web/server/lib/opencode/commands.js:36-49`）；agent 具备项目文件读写工具，命令只需教它操作 md 文件。

## 3. 已确认的产品决策

| # | 决策 | 日期 |
|---|---|---|
| 1 | 存储位置：项目仓库内 markdown 文件，不存 server 数据目录 | 10-31 |
| 2 | issues 目录每项目可配（settings 项目条目 `issuesDir`），默认 `.issues` | 10-31 |
| 3 | 文件布局：平铺 + frontmatter 表状态；否决状态子目录与 watcher（见 §13） | 10-31 |
| 4 | 建单入口：一期即 UI 完整建单/编辑（含契约扩展 create/edit） | 10-31 |
| 5 | agent 会话命令一期随 UI 一起提供 | 10-31 |
| 6 | identifier 前缀固定 `LOCAL`（文件名即恒定标识，不做前缀配置） | 10-31 |
| 7 | `authMethods: []` 恒 connected（首日验证 UI 渲染，退路 `['token']` 占位） | 10-31 |
| 8 | 导入（GitLab/Jira 等）后置 P2 | 10-31 |
| 9 | frontmatter 增加 `feature`、`blockedBy` 字段与 `<effort>-spec.md`/`<effort>-map.md` 命名，对齐 mattpocock agent 技能的本地 issue 约定（`docs/agents/issue-tracker.md` 为约定文档） | 11-01 |
| 10 | 编号竞态缓解：server 建单遇同名文件顺延重号重试；agent 模板写入前检查同号文件。不为零竞态引入锁或中央发号器 | 11-01 |
| 11 | 去掉 frontmatter `id`（uuid），identifier 即契约主键 | 11-01 |
| 12 | New issue 对话框带项目下拉，默认当前 UI 上下文的项目 | 11-01 |
| 13 | agent 命令仅文档引导安装，server 不写用户目录 | 11-01 |
| 14 | issue 内容随项目 git 离开本机属方案明示属性，文档说明即可，不加开关或脱敏 | 11-01 |
| 15 | frontmatter 序列化对会再解析为非字符串的标量（`[...]` 包裹或字面 `null`）加引号，保证往返一致；引号字符本身不转义（最小实现范围） | 11-01 |
| 16 | 会话链接与 posted-status 去重映射仅存内存（重启丢失链接，issue 文件上的评论已为人持久化）；去重 FIFO 上限 500，in-flight 按键合并 | 11-01 |
| 17 | scanner 的 container 映射按 projectId 键（每项目编号都从 LOCAL-1 起，按 identifier 键会跨项目冲突）；每个返回的 issue 携带 `containerId` | 11-01 |
| 18 | `issuesDir` 的 `..` 拒绝覆盖 Windows 可归一化变体（段级谓词，`.. ` 与 `.. .` 也拒绝；点串段如 `....` 合法），settings 归一化、UI projects store、scanner 回退三处镜像并同测 | 11-01 |

## 4. 功能需求

优先级：P0 一期必须；P1 一期应有；P2 后续。

| 编号 | 需求 | 说明 | 优先级 |
|---|---|---|---|
| FR-1 | UI 建单 | board New issue 按钮；title 必填，description/labels/priority 可选；自动分配 `LOCAL-<n>`，n 为目录内 max+1 | P0 |
| FR-2 | UI 编辑 | 编辑 title/description/labels/priority；契约能力位 `edit` | P0 |
| FR-3 | 列表与筛选 | 复用 `GET items/list`；筛选：状态（open/all/六分类）、优先级（`all`/缺省任意，`none` 为无优先级，其余按值相等） | P0 |
| FR-4 | 搜索与直达 | 按 title、identifier、描述匹配；粘贴编号或文件路径直达 | P0 |
| FR-5 | 详情预览 | description、labels、comments；沿用现有 board 预览布局 | P0 |
| FR-6 | 状态流转 | 六分类 triage/backlog/todo/in-progress/done/canceled；点状态 pill 切换 | P0 |
| FR-7 | 目录可配置 | per-project setting `issuesDir`，默认 `.issues`；创建时自动 mkdir | P0 |
| FR-8 | 外部修改拾取 | 手工/agent 编辑的文件在下次扫描生效；逐文件 `mtime+size` 缓存 | P0 |
| FR-9 | Session 联动 | 会话 started/completed/failure 自动写入该 issue 的 `## Comments` 节；默认开，可关 | P1 |
| FR-10 | Agent 会话命令 | `.opencode/commands/local-issues.md`：建单、查单、改状态、把改动代码位置写进正文 | P0 |
| FR-11 | 代码引用链接 | 正文 `path/to/file.ts:42` 在详情页渲染为可点击链接，打开对应位置 | P1 |
| FR-12 | feature 分组 | frontmatter `feature:` 软分组；spec/map 为普通 md 文件 | P1 |
| FR-13 | 阻塞边 | frontmatter `blockedBy:` 数组；全部 done/canceled 即解除 | P1 |
| FR-14 | 父子 issue | 子 issue 列表与进度 | P2 |
| FR-15 | 导入 | GitLab/Jira/其他格式一次性导入，保留原链接 | P2 |
| FR-16 | 自定义状态、导出 JSON | | P2 |

## 5. 存储与文件格式

### 5.1 目录与命名

- 目录：`<项目根>/<issuesDir>/`，`issuesDir` 为 settings 项目条目新字段，默认 `.issues`。
- 文件名：`LOCAL-<n>-<slug>.md`（如 `LOCAL-7-fix-login.md`）。编号扫描现有文件取 max+1；`<slug>` 限定 `[a-z0-9-]`，空串降级为 `issue`，并处理 Windows 保留名（CON、NUL 等）。
- **编号竞态**（agent 与 UI 同时建单）：server 建单时目标文件已存在则顺延重号重试；agent 命令模板要求写入前检查同号文件，存在则顺延。竞态窗口缩到毫秒级但不为零，接受，不引入锁或中央发号器。
- **不变量**：identifier 恒定；重命名文件视为用户操作，UI 不提供改名。spec/map 文件命名为 `<effort>-spec.md`、`<effort>-map.md`。
- **数据边界**：`.issues/` 随项目 git push 离开本机，属方案明示属性，文档说明即可，不加开关或脱敏。

### 5.2 文件结构

```markdown
---
identifier: LOCAL-7
title: 登录页在窄屏下溢出
state: todo            # triage | backlog | todo | in-progress | done | canceled
priority: high         # urgent | high | medium | low | null
labels: [bug, ui]
assignee: null         # v1 单用户，可空
createdAt: 2026-11-01T08:00:00Z
updatedAt: 2026-11-01T08:00:00Z
feature: null          # 可选，功能分组 slug
blockedBy: []          # 可选，阻塞它的 identifier 数组
---

（正文即描述）

## Comments

### 2026-11-01T09:00:00Z · session a1b2

completed in 12m
```

- frontmatter 解析自写（零依赖 yaml 子集：标量、字符串、数组）；单文件解析失败跳过并日志，不阻塞目录。
- **序列化加固**：会再解析为非字符串的标量（`[...]` 包裹、字面 `null`）写入时加引号，解析时去引号；引号字符本身不转义（最小实现范围）。
- **单行约束**：title 与 labels 经 API 到达时先把空白串折叠为单空格再落盘——frontmatter 是单行 `key: value`，一个换行会让 `parseIssueFile` 永久拒绝整个文件；`description` 保持多行。
- **priority `'none'`**：经 API 的 `'none'` 在 tracker 边界归一为 null——create 写 `priority: null`，edit 移除该键（读回 null）。手写 `priority: none` 字符串值是已知遗留边缘，UI 下次编辑该 issue 时自愈。
- `## Comments` 节固定格式（`### <ISO时间> · <来源>` + 正文），server 追加时重写该节、保留其余正文。
- 状态集合固定六分类，自定义状态后置。

### 5.3 写入与并发

- server 写文件走 tmp + `fs.rename` 原子写，写前重读、只改自己认识的字段与 Comments 节。
- 手工编辑、agent 编辑、UI 编辑并发：单文件 last-write-wins，不建 merge；下次扫描拾取外部修改。
- 增删 issue 即增删文件；备份、迁移退化为文件操作，数据随项目 git。

## 6. server 模块与索引

新增 `packages/web/server/lib/local/`（对照 `linear/` 裁剪）：

| 文件 | 职责 |
|---|---|
| `files.js` | frontmatter 解析/序列化、原子写、Comments 节追加 |
| `scanner.js` | 扫描各项目 issuesDir；逐文件 `mtime+size` 缓存（目录 mtime 不反映文件内容修改，不可用）；list/get/liveSummaries 一律过它 |
| `tracker.js` | descriptor + 实现（list/get/states/updateState/create/edit/liveSummaries/matchUrl/preferences/sessionStatus）；id 即 identifier |
| `preferences.js` | `sessionComments` 开关持久化（数据目录 `local-tracker.json`，默认开） |
| `status-runtime.js` | OpenCode 事件 → session 评论落盘 |
| `index.js` | registry 入口；`configureLocalTracker({ readSettings })` 注入 settings 读取器，`load()` 未配置即抛错 |
| `DOCUMENTATION.md` + `*.test.js` | 所有权、路由、不变量；测试同目录 |

- 不建 watcher：列表请求时扫描，mtime 未变用缓存；项目增删或 `issuesDir` 变更时缓存失效。
- container = 项目本身（containerId 从项目路径派生）；v1 不做 `projectMapping`。list 结果的 container 映射按 projectId 键（编号每项目从 LOCAL-1 重排，identifier 键会跨项目冲突），每个 issue 携带 `containerId` 供消费方回查。
- 注册：`trackers/registry.js` 的 `BUILT_IN_TRACKERS` 追加一行；settings-runtime 实例属于 `server/index.js`，故 `server/index.js` 在 registry 构建前调用 `configureLocalTracker({ readSettings })` 注入读取器（保持惰性加载，避免第二个 settings runtime 抢写）。

## 7. 契约扩展与路由

- `tracker-contract.d.ts`：capabilities 新增 `create`、`edit` 布尔位；`TrackerImplementation` 新增 `create(input)`、`edit(input)`。
- UI 端 descriptor 用 `z.boolean().catch(false)`（仓库 `flag` 约定）解析 `create`/`edit`，不是 optional：老 server 描述符缺这两个键即解析为 off；消费方判 `=== true`。
- `trackers/routes.js`：新增 `POST /api/tracker/:provider/items/create`、`POST .../items/edit`，走现有 `handle()` 能力位门禁，未声明即 404 `UNSUPPORTED`；Linear 与扩展 tracker 零感知。线上载荷固定为 `{containerId,title,description,priority,labels}` / `{id,title,description,priority,labels}`；`feature`/`blockedBy` 仅存在于文件格式层（scanner.create 接受，路由与 UI 不发送），M2 候选。
- local descriptor：

```js
{
  id: 'local',
  name: 'Local',
  authMethods: [],
  capabilities: {
    multipleAccounts: false, stateUpdate: true, children: false,
    labels: true, priority: true,
    filters: { people: false, priority: true },
    projectMapping: false, sessionComments: true, hostAccess: false,
    create: true, edit: true,
  },
  stateFilters: ['open', 'all', 'triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled'],
  urlPatterns: [{ host: 'openchamber.local', path: '^/tracker/local/([A-Za-z][A-Za-z0-9]*-\\d+)(?:/|$)' }],
  identifierPattern: '^[A-Za-z][A-Za-z0-9]*-\\d+$',
}
```

- `auth.status()` 恒 `{connected: true, account: {id:'local', name:'Local', current:true}}`。
- **老客户端兼容**（照搬既有 tracker 决策）：会话链接写入 `kind: 'tracker'`；`liveSummaries` 返回的 state 附带 `type` 字段（老手机 UI alias 窗口期）。

## 8. UI

- `packages/ui/src/lib/trackers/presentation.ts` 加 `local` 条目（icon、copy、branchName、settingsSearch）；board 页签、picker、状态颜色由 descriptor 自动绘制。
- board 以 `capabilities.create === true` 条件渲染 New issue，编辑入口独立以 `capabilities.edit === true` 门禁（server 两路由各自校验，一个 tracker 可只许编辑）；New issue 对话框带项目（container）下拉，默认当前 UI 上下文的项目。
- Settings 卡片：无 auth 表单，展示连接账号名（`account?.name` 回退，其后为 Unknown user 文案）、issuesDir 说明与 sessionComments 开关。
- i18n：新增 local key，15 个 locale 覆盖（en, nl, de, fr, es, ja, ko, pl, uk, tr, ar, he, pt-BR, zh-CN, zh-TW），parity 测试保障翻译。
- 详情页识别正文代码引用（相对路径 + `:行号`），解析器（`lib/trackers/codeReferences.ts`）+ remark 插件（`chat/markdown/remarkCodeReferences.ts`）作用于所有预览面的 issue 正文；链接携带解析出的绝对路径与行号，经 store action 打开对应位置；解析出项目目录外的路径保持纯文本（链接构建时检查）；引用按预览面板当前项目解析（已接受的取舍，代码注释记录）。不建代码索引，符号级关联后置。

## 9. agent 会话命令

- 命令文件 `.opencode/commands/local-issues.md`，frontmatter 仅 `description`，正文含 `$ARGUMENTS`：按 §5.2 模板建单（编号 max+1）、按 identifier 查单、改 `state`、把改动涉及的代码位置写进正文。模板共 6 条规则，第 6 条要求编辑正文时保留 `## Comments` 节及其条目不变。
- agent 直接用自己的文件工具读写，不经 server API。
- **发现约束**：OpenChamber 自身仓库的命令对用户会话不可见。模板随 `packages/docs` 提供，文档引导复制到自己项目的 `.opencode/commands/`；server 不写用户目录。
- 约定文档 `docs/agents/issue-tracker.md`（mattpocock 技能体系）与本方案同一套格式：triage 五角色映射 state/label（needs-triage→triage、needs-info→label、ready-for-agent→todo、ready-for-human→backlog、wontfix→canceled+wontfix）；wayfinder 的 map/child/blockedBy/frontier/claim/resolve 语义按该文档执行。

## 10. 测试

| 层 | 内容 |
|---|---|
| `files.test.js` | frontmatter 往返、原子写、Comments 追加不丢正文、解析失败跳过 |
| `scanner.test.js` | 扫描、逐文件 mtime+size 缓存命中与失效、编号 max+1 与重号顺延、非法文件名跳过 |
| `tracker.test.js` | descriptor 冻结、neutral 映射、create/edit/updateState 落盘、matchUrl fixture |
| `status-runtime.test.js` | started/completed/failure → Comments 落盘；preferences 关闭跳过 |
| routes | create/edit 能力位门禁（未声明 404 UNSUPPORTED） |
| registry | `local` 注册与校验 |
| UI | presentation `local` 夹具、代码引用识别、i18n parity（15 locale） |
| 全局 | `bun run check:changed` 通过 |

## 11. 里程碑

| 期 | 范围 |
|---|---|
| M1 | files + scanner + tracker（含 create/edit）+ 契约扩展 + 路由 + registry + presentation + i18n + Settings 卡片 + 空 authMethods UI 验证 + 代码引用链接 + agent 命令模板与文档 + `feature`/`blockedBy` 字段 |
| M2 | projectMapping（从 issue 起会话/worktree）、children、自定义状态、people 筛选、导入 |

## 12. 验收标准

1. 无外部服务可达环境下，board 的 local 页签完整完成 FR-1~FR-8。
2. 本地 issue 可链接到会话（`kind: 'tracker'`），session 评论按 FR-9 落盘为 Comments 节。
3. 数据在项目 git 内：重启即恢复，identifier 与文件名一致且恒定。
4. agent 按 `/local-issues` 命令建的文件能被 board 列出与编辑；UI 建的文件能被手工编辑拾取。
5. registry 启动校验通过；`bun run check:changed` 通过；新增模块 tests + DOCUMENTATION.md 齐备。

## 13. 备选方案否决记录

- **状态子目录（`.issues/todo/`，状态=文件移动）**：状态存两份（目录名+frontmatter），手工移动与 frontmatter 歧义；git rename 收益不值得。
- **fs.watch/chokidar watcher + 内存索引**：fs.watch 在 Windows/网络盘不可靠，chokidar 违反零新依赖；毫秒级收益不值得 watcher 生命周期复杂度。
- **server 数据目录 JSON（v1 方案）**：人不可直接编辑、不进 git、丢失 grill-me 风格核心价值；其"单写者"优点由单文件 last-write-wins 替代。
- **Git-host 扩展（source-control 路径）**：repo issue 强绑定 git remote 与 PR 管线，本地 issue 无 Git 绑定，语义不符。

## 14. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 空 `authMethods` 的 Settings 卡片渲染未验证 | M1 首日验证；退路 `['token']` 占位表单 |
| `issuesDir` 指向不存在目录 | 创建时自动 mkdir；列表对不存在目录返回空 |
| 项目目录不在本机/不可读 | 扫描失败记日志、该 container 返回空，不影响其他项目 |
| 契约扩展涉及四端回归 | 扩展按能力位条件渲染，Linear 路径回归覆盖 |
| identifier 与文件名漂移（手工改名） | 扫描时校验一致，不一致项标记 ignored 并日志 |
| 多端同时编辑同一 issue | 单文件 last-write-wins，写前重读；不引入锁 |
| 会话链接与去重映射仅存内存，重启丢失 | issue 文件上的 `started` 评论已为人持久化链接；映射随下次 `started` 重建；去重 FIFO 上限 500；若实践中出现重复评论，持久化留作 M2 决策（`local/DOCUMENTATION.md` 记录） |

## 15. 范围外

多人协同/权限模型、跨机实时同步、与 GitLab/Jira 双向同步、Git host 扩展路径、符号级代码图谱关联。
