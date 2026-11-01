# 本地 Issue 自动修复决策 · 需求与设计方案

> 版本：v2.0（as-built）· 日期：2026-11-01
> 本文件是本地 issue「分配后自动化修复决策」工作流的唯一现行需求与设计文档。
> **实现落点**：工作流命令 `.opencode/commands/issue-work.md`（§4 的六步流程即其行为），创建契约进 `.opencode/commands/local-issues.md` rule 9，自动派发 watcher 见 §9（v2.0 新增，`packages/web/server/lib/local/dispatcher.js`）。本文描述与实现一致，后续改实现先改本文。
> 数据格式、frontmatter、状态机沿用《本地Issue管理需求与设计方案.md》（v2.8）已落地实现，本文不重复定义，只新增工作流层约定。
> v1.2 记一处实现现状：`assignee` 原先没有写入口（scanner 建单硬写 `null`、编辑不接、读也恒为 `null`），派工信号只能靠手改 frontmatter；现由 board 预览的「指派给」一行写入，契约加 `capabilities.assignee`（见《本地Issue管理需求与设计方案》v2.7 决策 26、FR-19）。
> v1.3 跟两条产品决策改口径：优先级不再可空（本地 issue 必有一档，缺省与旧文件的 `null` 都读作 `low`，菜单排序因此没有「无」这一档，决策 27）；issue 可删除（编辑弹窗二次确认即删掉文件，被它阻塞的 issue 随即解除阻塞，删掉的候选按「修复」处理而不是留在菜单里，决策 28）。
> v2.0：维护者拍板上 watcher（原 §7 后置项提前），新增 §9 设计与决策 6–9；`assignee` 有了写入口后派工信号可全链路 UI 操作，watcher 因此成立。

## 1. 背景

本地 issue（`.issues/` 下的 markdown 文件）已经有完整的看板 CRUD、会话评论（status-runtime 自动追加）、代码引用跳转。但 issue 被分配之后，"怎么修、谁决定修不修" 仍然全靠人驱动会话。上游仓库对 GitHub issue 已有成熟节奏（`.opencode/commands/bug-work.md`：菜单 → 查在途 → 验证锚点 → 修 → 闭环），本地 issue 缺一个对应的命令把这条链路接到 `.issues/` 数据源上。

目标：一条 `issue-work` agent 命令，让被分配的本地 issue 产生自动化程度可预期的修复决策流——agent 自主处理一类问题（有根因的 bug），其余分流到诊断或人工。

## 2. 已确认的产品决策

| # | 决策 | 日期 |
|---|---|---|
| 1 | 根因信号复用现有字段：约定标签 `root-cause:found`（进 `labels` 数组），机制描述写在 body（含 `file:line`）。不新增 frontmatter 字段——local-issues.md 规定 frontmatter 键集固定，加字段要动 scanner、tracker、UI 三处 | 11-01 |
| 2 | 自主度先做**菜单确认式**（对齐 bug-work.md）：agent 列候选，人挑选，人确认后才 commit。自主循环式（逐个修、自验、commit、推 done）后置，放开前置条件见 §7 | 11-01 |
| 3 | 派工信号 = `state: todo` 且 `assignee` 非空。不给 `assignee` 加语义（不区分 agent 名/人名），字段语义不加码 | 11-01 |
| 4 | 收口：agent 自验通过（复现转绿 + 回归测试过）即可推 `done`，评论写明验证覆盖了什么、没覆盖什么；人工 review 发现问题直接重开 | 11-01 |
| 5 | 创建契约：body 固定小节模板（Symptom/Reproduce/Environment/Evidence/Mechanism，见 §3.1），`root-cause:found` 与 `## Mechanism` 小节绑死；agent 创建时模板是硬约束，人从看板建单不加 UI 校验，规范化由派工前分流兜住。Environment 记 surface/OS/发现时 branch+commit，分支会漂、commit 是锚 | 11-01 |
| 6 | watcher 只派**自主修复**候选（`root-cause:found` + `## Mechanism` 齐备）；仅诊断与产品决策类不派会话，留在菜单等人——无人值守的会话不该只会诊断烧钱 | 11-01 |
| 7 | watcher 是 per-project 开关 `autoDispatchIssues`（默认关），Settings → Projects 里开；派工信号 + 开关同时成立才派发 | 11-01 |
| 8 | 去重与恢复：派发时经 session-status 链路落持久标记（`Session started — auto-dispatch` 评论，含 sessionId）；tick 对 todo 且带标记的 issue 检查该会话存活——存活跳过，已消失（崩溃/超时）重派并补新标记。被否掉的备选：纯内存去重（重启即重派）与"有标记永不重派"（死会话锁死 issue） | 11-01 |
| 9 | commit 仍人工：watcher 派的会话跑单 issue 自主版 issue-work，结束于自验通过、`state: done`、等维护者 review + commit；不自动 commit、不 push | 11-01 |

## 3. 派工与根因信号

**派工信号**：`state: todo` 且 `assignee` 非空的 issue 进入工作菜单。`triage`/`backlog` 不进（未验收），`canceled` 明确排除，`in-progress` 视为在途（见下）。`assignee` 在 board 预览的「指派给」一行设置，写进 frontmatter 的就是一个名字；派工读的是文件本身，所以看板显示与命令判定永远一致。

**根因信号**：`labels` 含 `root-cause:found`，且 body 有 `## Mechanism` 小节——用户可见症状 + 根因机制（带 `file:line`）。两者齐备，issue 才属于 agent 可自主修复的一类；只有标签没有机制小节，按根因不明处理。

**在途信号（硬信号，命中即剔除菜单）**：

1. `state: in-progress`；
2. `git log --grep "fixes LOCAL-<n\>"` 命中已有提交——必须带词边界（`\>`），否则 `LOCAL-1` 会命中 `LOCAL-11` 的提交，在途检查自己先误报。

会话评论**不是**硬信号：agent 上一轮的决策评论本身也是 `## Comments` 里的会话条目，单凭"评论里有会话注释"会把上次 issue-work 自己的输出误判成别人在修。会话评论只作上下文随候选一并呈报；仅当评论显示一个活跃的修复会话（仍在产出修复内容）时才按在途剔除。

### 3.1 body 模板（创建契约）

```markdown
## Symptom    ← 用户可见现象，一句话
## Reproduce  ← 复现步骤；无法复现就写为什么无法
## Environment ← surface（web/desktop/vscode/mobile）、OS、发现时的 branch+commit
## Evidence   ← 报错串、file:line、来源（哪个会话/哪条日志）
## Mechanism  ← 根因机制（已知才写；写了才有资格打 root-cause:found）
```

- `Mechanism` 可选，其余必填；与环境无关的纯代码行为问题 Environment 可写 `n/a`。
- 目录用项目配置的 `issuesDir`（Settings → Projects，默认 `.issues`）——scanner 按项目设置读目录（scanner.js `issuesDirOf`），写错目录的 issue 板上不可见。`identifier` 必须与文件名 `LOCAL-<n>` 一致，不一致同样整文件跳过；会再解析为非字符串的标量加双引号（沿用 v2.5 决策 15 的规则，agent 手写时也遵守）。
- 没有 `## Mechanism` 小节就不能带 `root-cause:found`——标签和证据绑死，堵住"打了标签但没根因"的漏洞。
- 小节标题固定为上述英文 slug，`## Comments` 仍由看板追加并保持原样（沿用 local-issues.md rule 6）。

**按创建方分责任**：

| 创建方 | 约束 |
|---|---|
| agent（调查会话中发现问题、顺手建单，走 local-issues 命令） | 模板是硬约束：Symptom/Reproduce/Evidence 必填，Evidence 注明来源会话；根因查到才填 Mechanism 并打 `root-cause:found`，查不到就不打，留给后续诊断 |
| 人从看板建单（TrackerIssueDialog 表单） | 表单不加校验；建完由 triage 或下一次 issue-work 分流时规范化，规范化时机是派工前 |

## 4. 命令流程（issue-work.md，六步，与命令实现逐条对齐）

以对话进行，不产出报告：

1. **收集菜单**：扫 `.issues/`，取派工信号命中的 issue（明确排除 `canceled`）。排序绑定数据：先按 frontmatter `priority`（urgent → high → medium → low；本地 issue 必有一档，缺省与旧文件的 `null` 都读作 `low`），同档再看症状，数据丢失和回归排最前。每个候选一行：症状、机制（`file:line`）、粗略体量。问人挑哪个。
2. **查在途**（在提出候选之前剔除，不先呈报再撤回）：对每个候选按 §3 硬信号检查，命中的剔除菜单并说明归属；会话评论作为上下文一并呈报（§3 的限定条件）。
3. **分流判定**（§5）：只看标签 + `## Mechanism` 小节，此时不依赖锚点状态。
4. **验证锚点**：`## Environment` 里的发现时 commit 先给出报告的陈旧度，再确认 body 引用的 `file:line` 在当前 main 仍存在、机制仍成立。锚点失效 → 说清现状，issue 退回 `triage` 并追加诊断评论，不修空气。这一步对任何分流生效，是独立退回分支。
5. **修复循环**：按 AGENTS.md 指令序（匹配技能先读；同步类 `sync-state-invariants`，热路径 `performance-engineering`），最小修复 + 本地先例风格的回归测试 + 聚焦验证。
6. **闭环**：touched 文件路径（带 `:line`）追加进 issue body；**每次 state 变更同时 bump `updatedAt`**；自验通过推 `state: done`，评论写明验证覆盖与未覆盖；commit 等维护者确认后提交，message 带 `fixes LOCAL-<n>`；不主动 push。

**评论的两条落盘链路，不得混用**：

- agent 的决策与诊断评论（分流理由、退回原因、验证覆盖说明）由 agent 手写进 `## Comments`，格式沿用 local-issues.md rule 6 的 `### <ISO> · <source>` 小节；
- 会话过程评论由 status-runtime 在会话链接存在时自动追加，agent 不要手工复制 status-runtime 会产出的内容，否则同一件事在 issue 文件里落两遍。

## 5. 决策分流规则

| 分流 | 条件 | agent 行为 |
|---|---|---|
| 自主修复 | `root-cause:found` + body 有 `## Mechanism` 小节（含 `file:line`） | 走 §4 第 5/6 步完整循环；锚点失效在第 4 步单独退回，不属于分流判定 |
| 仅诊断 | 复现失败 / 根因不明 / 缺 `## Mechanism` 小节 | 只做诊断，结论写进评论，state 退回 `triage`（bump `updatedAt`），不写代码 |
| 停下提问 | 产品决策类（改默认值、加按钮、两人会有分歧的改动） | 停止，向维护者提问；不越过 AGENTS.md 产品决策边界 |

分流的判定理由写进 issue 评论，让看板上能看到 agent 为什么这样走。

## 6. 收口与重开

- `done` 的依据是自验：复现路径转绿 + 回归测试通过。评论必须写明验证覆盖了什么、没覆盖什么（对齐 AGENTS.md *Proof* 纪律）。
- 人工 review 发现问题：直接把 state 改回 `todo` 或 `triage`（bump `updatedAt`）并在评论说明，无需额外机制；看板 `blocked`/状态展示自动反映。
- `fixes LOCAL-<n>` 是 git log 侧的反查约定（本地 issue 没有 GitHub 关键字自动关闭，闭环靠 state 字段）。反查必须带词边界：`git log --grep "fixes LOCAL-<n\>"`，避免 `LOCAL-1` 命中 `LOCAL-11`。

## 7. 演进：自主式的放开（已按 §9 落地）

v1.x 时期本节列的三个前置条件，v2.0 按 maintainer 决策一次性满足：

1. 自验判定的 track record → 由 §9 的两道兜底替代：修复不 commit（最坏情况是浪费一轮会话）+ done 后人工 review 可直接重开；
2. agent 自主 commit → 不放开，watcher 会话止于"等 review + commit"（决策 9）；
3. 定时触发 → §9 的 watcher 本体。

命令层的菜单确认式（§4）保留不动：watcher 是"分配即修复"的自动通道，`/issue-work` 是人工巡场的通道，两者共存。

## 8. 不做的事

- 不加 frontmatter 字段（watcher 也只用既有字段 + body 约定判定）。
- 不自动 commit、不自动 push、不自动开 PR（watcher 会话同样止于 review 前一刻）。
- 不动产品决策边界：分流到"停下提问"的 issue 永远等人，watcher 对这类 issue 根本不派会话。
- watcher 不做跨项目并发上限之外的排队/重试策略：失败留给下个 tick，不引入任务队列。

## 9. 自动派发 watcher（v2.0）

**定位**：server 侧定时器，把"分配了但没人管"的自主修复候选自动变成一个托管 OpenCode 会话。命令层语义不变，只是把"人开 /issue-work"换成"server 代开"。

**触发**：web server 起一个定时 tick（10 秒，启动后延迟首跑，模式同 index.js 的既有 interval）。每个 tick：

1. 读项目设置，取 `autoDispatchIssues === true` 的项目；
2. 对每个项目跑 local scanner `list({ state: 'todo' })`（mtime 缓存，扫得便宜）；
3. 过滤派工信号：`assignee` 非空 + `labels` 含 `root-cause:found` + body 有 `## Mechanism` 小节（决策 6）；
4. 去重过滤（决策 8，下述）；
5. 每个项目每 tick 最多派 1 个（priority 最高者；防积压一次性炸出多个会话），全部项目单 tick 上限 3。

**派发**：复用 scheduled-tasks 的会话创建先例——`client.session.create({ directory: project.path })`（项目配了 `defaultAgent`/`defaultModel` 则随 create 传入，会话属性在 v2 归会话所有）→ `client.session.prompt` 播种单 issue 自主提示词（`buildAutoDispatchPrompt`）。提示词要求 agent：

- 只处理指定的这一个 issue，跳过菜单与人工确认步骤，锚点验证照旧（先核对 `## Mechanism` 与当前代码，失配先改文档再动手）；
- 开工即把 `state` 改 `in-progress`（bump `updatedAt`），收口按 §4 第 6 步；
- 结束输出一句话总结，请维护者 review 并 commit——绝不自行 commit；
- 发现是产品决策时无法"停下提问"：把问题写成 issue 评论，state 退回 `triage`（回 `todo` 会重新命中派发信号形成死循环），结束并等维护者。

**链接与标记**：会话创建后立即调 local tracker 的 session-status（`kind: 'started'`，`sessionOrigin: 'auto-dispatch'`）——`sessionLinks` 注册 + issue 文件落一条持久标记评论；后续 `completed`/`failure` 事件由 status-runtime 自动追加评论，看板全程可见。

**去重与恢复**（决策 8）：内存 dispatched 集合（issue key → sessionId）挡住重复派发；对 todo 且带 `auto-dispatch` 标记评论的 issue，用标记评论里的短 session id（12 位前缀）在会话列表里前缀匹配查存活：存活跳过，404 已消失重派，其他错误视为未知跳过本轮（不冒险重派）。`started` 标记先于 prompt 落盘：prompt 失败也会留下标记与链接，下个 tick 不会重复建会话。人工重派 = 把 state 拉出 todo 再推回（或删掉标记评论）。

**失败与边界**：

- OpenCode 未就绪 / 会话创建失败 → 记日志，留待下个 tick；单项目失败不影响其他项目；
- scanner 读失败 → 跳过该项目本轮；
- 全程本机（读本地文件、创建本机托管会话），不越企业边界，无需门控；web-server-only，VS Code/Electron/mobile 不触及；
- watcher 不改 issue 文件的解析与写入路径，复用 scanner/tracker 既有 API。

**设置**：`autoDispatchIssues` per-project 布尔，进 `sanitizeProjects` 归一（默认 false）+ UI Projects store 镜像 + Settings → Projects 编辑器开关（全部 locale 翻译）。
