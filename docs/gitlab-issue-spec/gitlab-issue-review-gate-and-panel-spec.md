# GitLab Issue 审核门与工作面板需求与设计方案

状态：评审通过，待实现。日期：2026-11-15（与本仓库维护者在会话内逐项定案）。

本文档是 `gitlab-issue-automation-spec.md`（下称"基础规格"）的增量扩展，覆盖两块新能力：推送前的独立审核门，以及按工作状态展示自动化 run 的工作面板。基础规格已定义的内容不再重复；两处基础行为的修正（标签事件不可用、planning 超时）在本文档第 8 节作为需求一并覆盖。

UI 原稿：`work-panel-mockup.html`（维护者已过目）；实现稿必须遵循 `openchamber-ui-guidance` 与 `theme-system`，不复制原稿的手写样式。

## 1. 目标

两件事：

1. 推送到远程之前，改动必须先过一道独立审核：审核会话读 diff 和 issue 内容，结论回写为 issue 评论，只有 approve 放行。人审仍留在 MR，这层门的目标是拦住明显不合格的改动，减少废 MR。
2. 操作员在 OpenChamber 内看到每条 run 的工作状态、关联会话与阻塞原因，并能在面板内完成原本必须去 GitLab 网页做的处置动作（取消、重置、审批、接管），操作以操作员本人的 GitLab 身份落在 GitLab 上。

不做的事情：

- 不做自动合并，不改变"人审在 MR"的分工。
- 不新增 GitLab 标签，不改变基础规格的标签语义。
- 不做面板数据的推送通道，不做台账以外的实时遥测。
- 不支持把人工会话挂载到 run 上；run 的会话链只覆盖 dispatcher 创建的会话。
- 不改变"每次尝试新开会话"的行为。
- 面板不做 issue 新建（已有 dialog），不做 MR 评审操作（MR 归 GitLab）。

## 2. 已确定的决策

| 决策点 | 结论 |
| --- | --- |
| 审核者形态 | 独立的审核 OpenCode 会话，读 worktree diff；实现会话永不自审 |
| 审核结论落盘 | bot 代发 issue 评论，与方案/证据评论同通道 |
| 审核结论 | `approve` 放行进 `verifying`；`request-changes` 回灌实现 |
| 回路上限 | 3 轮回灌修（`REVIEW_MAX_REVISIONS = 3`），第 4 轮仍不通过则 `ai-blocked` |
| 全局尝试上限 | 基础规格的 `MAX_ATTEMPTS = 2` 不变，只约束基础设施重试；审核回路用它自己的常量 |
| 审核模型 | 项目级设置 `gitlabIssueReviewModel`（provider/id/variant），缺省回落 `defaultModel`；agent 沿用 `defaultAgent` |
| 面板形态 | 内置全屏页（非 SDK guest panel）；台账是服务端数据，guest 面板拿不到 `/api/*` |
| 面板数据 | 读本地台账，新只读 GET 路由；标签与评论仍是给人看的镜像 |
| 面板范围 | 单项目完整历史 + 全局活跃/blocked 汇总，同一路由族 |
| 刷新 | 页面可见时 10 秒轮询，与 dispatcher tick 同节奏；不可见即停 |
| 写操作身份 | 标签类用操作者的绑定 GitLab 账号，命令类以操作者身份发评论；永不以 bot 身份代办 |
| 会话关联 | run 链当前 `sessionId`，活跃 run 显示工作中/已完成，点击在主界面打开会话 |
| blocked 指引 | 以 `formatBlockedComment` 的原因到文案映射为准：面板按同一映射取中文原因名与下一步指引，不另编一套说法；run 的 `lastError`（dispatcher 写的 detail，与 bot 评论是同一段中文）原样展示；每个 `blockedReason` 在面板文案表里都要有一项 |
| 界面语言 | 面板文案以中文为主语言，phase、kind、blockedReason 都显示中文名，机器值不出现在界面上；文案表按 i18n 结构存放，其他语言以后补 |
| blocked 位置 | 常驻区，不折叠，处置按钮常驻；历史区只放 `done` |
| 写操作确认 | 写操作前弹确认层，预览要发的评论原文或标签增删与落款账号，确认后才发 |
| 手机与 VS Code | 本轮不做，面板只做内置全屏页 |
| 新标签 | 不加。`reviewing` 全程沿用 `ai-working` |

## 3. 审核门

### 3.1 时机与流程

`implementing` 的结构化证据校验通过后，run 进入新阶段 `reviewing`，实现会话结束，`sessionId` 清空。每轮审核：

1. 服务端在 worktree 上生成 `git diff <primaryRemote>/<targetBranch>..HEAD`，连同 issue 内容（标注为不可信数据）和证据字段一起交给审核会话。审核会话只读，不写文件、不跑修改性命令。
2. 审核会话输出结构化结论：`{ verdict: approve | request-changes, summary, findings: [{ file, line?, severity: blocker | minor, note }] }`。字段校验失败按 `AgentOutputError` 走 `failRun`，与实现路径同规则。
3. `approve`：bot 代发审核评论（结论、摘要、发现），台账记 `reviewVerdict`、`reviewNoteId`，进 `verifying`。后续推送、建 MR 与基础规格一致。
4. `request-changes`：bot 代发审核评论，`reviewRounds` 加一。超过 3 轮：`ai-blocked`，`blockedReason` 记 `review-rejected`，block 评论完整保留累计发现。未超限：回 `implementing` 开新实现会话，上一轮发现作为数据段嵌入实现提示词（重新包裹为不可信内容，不与指令位混排）。

审核会话与实现会话一样计入取消检查（`watchers` 含 `reviewing`）、租约续期、崩溃恢复（会话消失但分支已有提交时回到 `implementing` 走重审；无提交回到 `claimed`）。

### 3.2 超时

`reviewing` 与 `planning` 均纳入 `gitlabIssueTimeoutMinutes` 预算（基础规格原本只覆盖 implementing）。超时中止会话，`ai-blocked`，`blockedReason` 记 `timeout`。`waiting-approval` 维持无超时（等人的阶段不计时）。

### 3.3 对既有路径的影响

bug 与 feature 的实现阶段都过审核门；feature 的 `/ai-approve` 发生在审核门之前，不变。标签时间线无变化：`ai-working` 从认领保持到进 `verifying`，人从 issue 评论感知审核进行中。

## 4. 工作面板

### 4.1 定位与入口

内置全屏页，挂载方式与 SourceBoard 相同：`useUIStore` 互斥状态、`MainLayout` 懒加载分支、项目菜单入口（`onOpenSourceBoard` 旁）加命令面板项。页头一行放标题、实例与 bot 信息、轮询指示、本项目/全部切换；不设第二个头部行。本轮只做这一页，手机端与 VS Code 扩展不做。

### 4.2 读路由

`GET /api/gitlab-issues/runs?directory=<path>` 返回该项目 `origin|projectId` 下全部台账条目；不带 `directory` 时返回所有启用项目的条目并排除 `done`。每条 run 的字段：`key`、`iid`、`kind`、`phase`、`blockedReason`、`lastError`、`branch`、`targetBranch`、`mrIid`、`issueUrl`、`mrUrl`、`attempts`、`reviewRounds`、`reviewVerdict`、`since`、`updatedAt`、`sessionId`、`sessionStatus`。

`sessionStatus` 只对持有会话的 run 解析（复用 `readSessionResult` 的空闲判定，短超时），取值 `busy`、`idle`、`null`；解析失败一律 `null`，不编造状态。台账读取失败返回错误，不得表现为空成功列表；单条 enrich 失败降级为 `null` 字段，不影响整页。

### 4.3 写操作

单一路由 `POST /api/gitlab-issues/runs/action`，参数 `{ directory, key, action, accountId }`：

| 动作 | 落地 | 允许的 phase |
| --- | --- | --- |
| `cancel` | 加 `ai-blocked`，移除 `ai-working` | 全部活跃阶段 |
| `reset` | 移除 `ai-blocked`，确保 `ai-ready` | `blocked` |
| `approve` | 以操作者身份发 `/ai-approve` 评论 | `waiting-approval` |
| `reject` | 以操作者身份发 `/ai-reject` 评论 | `waiting-approval` |
| `take` | 以操作者身份发 `/ai-take` 评论 | `blocked` 且 `blockedReason = missing-credential` |

前置校验按序执行，任一失败返回 4xx 与原因：动作与 phase 不匹配返回 409（响应带当前 phase）；`accountId` 必须解析到该 `origin` 上有效的绑定账号，且不是该项目的 bot 账号；`accessLevelOf` 必须 ≥ 30。校验通过后路由只改 GitLab 侧（标签或评论），不写台账——状态转移由 dispatcher 下一轮 tick 观察 GitLab 变化自行完成，动作路径始终在状态机之外。

面板在发请求前弹确认层：评论类动作预览要发的评论原文，标签类动作预览要增删的标签，确认层写明落款账号（操作者本人）。取消不发请求。

操作者没有可用的绑定账号时，UI 置灰按钮并给设置跳转（复用 dialog 的 bot 账号行样板）。

### 4.4 会话关联

活跃 run 显示 `sessionStatus`：`busy` 为蓝点隔秒变暗（`useWaitingBlink` 节奏），`idle` 为静止绿点，`null` 不显示。链接用 `setCurrentSession` 在主界面打开会话。每轮尝试新会话后链接指向新会话；历史尝试的会话不进面板，靠 `#iid:` 标题前缀在会话列表可查。

### 4.5 状态呈现

- 每条 run 一条 phase 轨道：`claimed → (planning → waiting-approval) → preparing → implementing → reviewing → verifying → mr-open → done`，feature 才显示 planning 与 waiting-approval 两站。
- 轨道点遵循状态色语义：进行中（preparing/implementing/reviewing/verifying）蓝，等待人（waiting-approval）黄，阻塞红，完成绿；非状态的 kind 标签是灰字。
- blocked run 显示指引条，三段：中文原因名（映射表）、run 的 `lastError` 细节（与 bot 评论同一段文字）、下一步指引（映射表），后面跟面板内可点的动作按钮（上表允许的）。
- `reviewing` 显示"审核第 N 轮 / 共 3 轮"和上一轮 verdict；`request-changes` 的发现列表进评论链接，不在面板内展开。
- 活跃 run 的常驻操作只有 Issue 链接和 `···` 菜单（内含取消）；等待人与阻塞的动作按钮常驻，因为那是"需要用户"的状态。
- `blocked` 在常驻区，与等待人、运行中并列，不折叠；处置完成后由 dispatcher 的状态转移把它移出本区。历史区默认折叠，只含 `done` 条目，行内字段：标题、iid、结果（merged）、时间、MR 链接。
- 全局视图按项目分组，只列活跃与 blocked，`done` 不进全局列表；空态说明全局视图不构成卡点。
- 写操作先弹确认，确认文案写明动作、issue 和落款账号（如"将以 @meiuxs 的身份发表评论"），确认后按钮进入提交态。

### 4.6 刷新

页面 `visibilityState === 'visible'` 时每 10 秒拉一次读路由；不可见停止，恢复可见或重新挂载时立即拉。写操作成功后立即重拉一次。

## 5. 配置增量

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `gitlabIssueReviewModel` | `string`（`provider/model`） | 空 | 审核会话模型；空则回落项目 `defaultModel`。存储形态沿用 `defaultModel` 的字符串惯例，校验必须匹配 `provider/model`，非法值丢弃并回落 |
| `gitlabIssueReviewVariant` | `string` | 空 | 审核模型变体；空则回落 `defaultVariant` |

设置页在项目 GitLab 自动化区加一行模型选择。该配置不参与 `enabled` 判定：未配置时审核照常运行。

## 6. 模块与代码接缝

```text
machine.js      + REVIEWING 阶段、转移、REVIEW_REJECTED / LABEL_EVENTS_UNAVAILABLE
ledger.js       + reviewRounds / reviewNoteId / reviewVerdict 字段，认领时归零
prompts.js      + buildReviewPrompt、formatReviewComment、review 类 parseAgentOutput、
                  buildImplementPrompt 的审核发现段
dispatcher.js   + handleReviewing、回路、超时扩展到 planning/reviewing、
                  claim() 的标签事件失败阻塞
routes.js       + GET runs（两个形态）、POST runs/action
packages/ui     + gitlab-runs 面板组件、UIStore 状态、MainLayout/入口、
                  gitlab-runs.i18n.ts（全部语言，含按 blockedReason 的指引文案表）、
                  设置页审核模型行
```

文档义务：`gitlab-issues/DOCUMENTATION.md` 的 ownership 段补面板路由与审核回路；基础规格补 `reviewing` 阶段与标签时间线说明。

## 7. 台账与状态机增量

转移图增量（其余同基础规格）：

```text
implementing -> reviewing | blocked          （原：implementing -> verifying）
reviewing    -> implementing | verifying | blocked
```

`SLOT_PHASES` 增加 `reviewing`。`blockedReason` 新增取值：`review-rejected`、`label-events-unavailable`。台账字段新增 `reviewRounds`（认领归零）、`reviewNoteId`、`reviewVerdict`、`reviewFindings`、`blockedFrom`（阻塞前所处阶段，供面板画轨道）、`title`、`projectPath`（供面板拼链接，免再查 API）；`sessionId` 语义不变，始终是当前活跃会话（实现或审核）。`attempts` 只计基础设施重试：进入 `reviewing` 时归零，审核轮次不计入。

## 8. 基础行为修正（同批交付）

1. **标签事件不可用必须阻塞。** `claim()` 读 `resource_label_events` 失败（端点不存在或非鉴权类失败）时，不得让 issue 无限期停留在 `ai-ready` 反复重试：标 `ai-blocked`，评论说明 `label-events-unavailable`，台账落 `blocked`。人工重置后按既有路径重新认领。这把基础规格 canary 第 0 条"不可用就停下回报"落成代码行为。
2. **planning 超时。** 见 3.2。修复"挂死的方案会话永久占用项目槽与全局槽、只能人工取消"的缺口。

## 9. 安全边界增量

- 审核提示词把 issue 内容与实现会话的产出都视为不可信数据，重新定界；发现列表进入下一轮实现提示词时再次作为数据包裹，字段逐项校验。
- 面板写操作永不以 bot 身份执行，bot 账号作为 `accountId` 直接拒绝；权限不足（< 30）拒绝。操作归属由 GitLab 自身的标签事件与评论作者记录，面板不维护第二套审计。
- 面板路由不暴露台账之外的数据（凭据、token、worktree 绝对路径保留在服务端，路径不出现在响应里）。
- 动作路由不写台账，避免绕过状态机转移守卫的路径。

## 10. 测试与验收

单元测试：

- 状态机含 `reviewing` 的全转移与非法转移矩阵。
- 审核输出的字段校验：verdict 枚举、findings 结构、空 summary 拒绝。
- 回路：第 3 轮 request-changes 回灌，第 4 轮进 `review-rejected` 且 block 评论含累计发现。
- `planning`、`reviewing` 超时各自中止会话并阻塞。
- 标签事件失败：`ai-blocked`、评论、无重试churn。
- 动作路由：phase 不匹配 409、bot 账号拒绝、权限不足拒绝、未绑定账号拒绝。
- 读路由：台账损坏返回错误而非空列表，enrich 失败降级 `null`。
- 面板中文文案表覆盖全部 `blockedReason`，缺一项即失败。

集成测试：

- 假 GitLab 模式下 bug 全程含一次 request-changes 回灌后 approve 推送，评论顺序与作者正确。
- 动作触发后 dispatcher 在下一 tick 完成对应转移（cancel → blocked，reset → 重认领）。

UI 测试：

- 页面不可见时停止轮询，恢复可见立即拉取。
- 无绑定账号时动作按钮置灰且给设置入口。
- blocked 指引文案与 `formatBlockedComment` 的映射一致。
- 写操作确认层：预览的评论原文或标签增删与落款账号正确，取消不发请求。

canary（追加到基础规格清单）：

7. 构造一次 request-changes：确认审核评论由 bot 代发、回灌实现会话收到发现、第 2 轮 approve 后推送，MR 描述与证据完整。
8. 面板全程开着：每个 phase 变化在 10 秒内可见，会话点状态正确，cancel 与 take over 操作的 GitLab 归属落在操作者账号。

## 11. 上线步骤

1. 基础规格第 11 节步骤全部完成后：本增量随同一次部署交付，面板默认可用（只读）。
2. 审核模型设置可选；未配置回落默认模型。
3. 不需要预建任何新标签。
4. 跑 canary 第 7、8 条后逐项目放量。
