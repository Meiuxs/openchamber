# GitLab Issue 自动化需求与设计方案

状态：评审通过，待实现。日期：2026-11-12（设计评审同日定案）。2026-11-15 增补第 12 节「评论反馈修复」，同日评审定案。2026-11-16 增补第 13 节「问题判定门」，同日评审定案。

目标仓库：内网自建 GitLab，包含 12.7 这类低于 15.7 的实例。本方案只覆盖 GitLab，不改 GitHub 侧流程。

## 1. 目标

让 GitLab 项目从提交 bug 或特性 issue 开始，自动走到“有一条由触发者本人署名、可评审的 MR”，把人工工作压缩到授权、看方案和合并三处。

不做的事情：

- 不自动合并 MR。issue 只在 MR 合并后关闭。
- 不为 GitLab issue 提供新建界面，建单仍在 GitLab 完成。
- 不处理 MR 打开后的 CI 失败循环，那属于 `gitlab-mr-auto-fix` 技能。
- 不做 webhook、GitLab CI 作业、跨项目堆叠 MR、自动 rebase。
- 不支持 GitHub 的同款流程。

## 2. 已确定的决策

| 决策点 | 结论 |
| --- | --- |
| 运行位置 | OpenChamber 服务端轮询，10 秒一轮 |
| 授权信号 | 单一 `ai-ready` 标签 |
| 完成标准 | 产出 MR，人工合并 |
| 类型判定 | 模板 `类型:` 行，bug/feature，缺失或非法值阻塞 |
| 问题判定 | 认领后、写码或出方案前先做一次只读判定，三值判断，见第 13 节 |
| 特性类 issue | 先出方案评论，`/ai-approve` 后才写码 |
| bot 权限 | 只做评论、回复、标签、关闭被判为非问题的 issue，Reporter 角色 |
| 代码身份 | 触发者的 GitLab 账号兜底 push、开 MR，commit author 用触发者 |
| 推送执行点 | agent 只提交到本地，服务端校验后推送并建 MR |
| 评论发出方 | agent 输出结构化字段，服务端校验后用 bot 代发 |
| 凭据失效 | 标 `ai-blocked`，Developer 以上可用 `/ai-take` 接管 |
| 目标分支 | issue 模板字段，留空用项目默认分支 |
| 分支前缀 | 项目级配置，默认 `openchamber/` |
| 非默认分支合并 | bot 轮询发现合并后显式关单 |
| 并发模型 | 单实例部署；活跃 run 每项目 1 个、全局 3 个 |
| 运行中取消 | 人工改标签或关闭 issue 即中止 run |
| MR 后反馈修复 | 评论 `@bot 修复` 触发新一轮修复，上限 5 轮，见第 12 节 |
| 自动合并 | 不做 |

分支名固定为 `<前缀>issue-<iid>-<slug>`。前缀默认 `openchamber/`，配置值必须以 `/` 结尾，写入前做 Git ref 合法性校验。slug 取 issue 标题，小写、剥掉非 ASCII 字符、连字符、最长 40 字符，去掉首尾连字符；slug 为空时分支名退化为 `<前缀>issue-<iid>`。

## 3. 角色与身份

| 角色 | 权限 | 用途 |
| --- | --- | --- |
| bot 账号 | Reporter | 读 issue、写评论、加删标签、轮询审批评论 |
| 触发者 | Developer 及以上 | 推 feature 分支、建 MR、作为 commit 作者 |
| 审批者 | Developer 及以上 | 特性方案 `/ai-approve`、`/ai-reject`、`/ai-take` |

触发者定义：

- bug：最近一次把 `ai-ready` 加到 issue 上的人，从 resource label events 读取，排除 bot 自身的事件。
- 特性：回 `/ai-approve` 的人。
- 读不到标签事件时标 `ai-blocked`，等 Developer 用 `/ai-take` 指定。
- 认领时校验触发者是项目成员且 Developer 及以上，权限不足按 `missing-credential` 阻塞。

提交身份规则：

- worktree 内用仓库级 git 配置写入触发者的 `user.name` 和 `user.email`，不改全局配置。
- 邮箱取触发者凭据调用 `/user` 返回的邮箱。为空时停下并评论，要求设置可见邮箱，不猜地址。
- 推送和创建 MR 由服务端在会话结束后用触发者凭据执行。bot 不参与代码写入，agent 会话内没有推送凭据。
- 目标仓库强制签名提交且服务端拿不到触发者签名密钥时，标 `ai-blocked`，不生成未签名提交。
- commit message 遵循目标仓库自己的约定，末尾追加 `Requested-by: @<触发者用户名>`，方便追溯需求来源。
- bot 的 PAT 使用 `api` scope；它同时用于读 issue、写评论和改标签。

## 4. 端到端流程

### 4.1 发现与认领

每 10 秒一轮 tick，扫描已绑定 GitLab 且开启 `autoDispatchGitlabIssues` 的项目，启动后延迟 30 秒开始首轮。issue 列表每 3 轮扫一次（30 秒发现延迟），请求带 `labels=ai-ready` 过滤，只读 `opened` 状态，每页 100 条，每项目每次最多扫描 3 页。活跃 run 的标签、issue 状态、审批评论和 MR 状态检查每轮都做。

派发速率每项目每轮最多 1 个，全局每轮最多 3 个。活跃 run 并发上限每项目 1 个、全局 3 个。

候选条件：`state=opened`、带 `ai-ready`、不带 `ai-working`、`ai-plan-review`、`ai-review`、`ai-blocked`、`ai-done`。

认领步骤：

1. 重读 issue，确认标签没有变化。
2. 解析类型和目标分支。`类型:` 行缺失或值不是 bug/feature，标 `ai-blocked` 并评论。目标分支显式写了但分支不存在，标 `ai-blocked` 并评论，不降级到默认分支。
3. 校验触发者凭据有效、是项目成员且 Developer 及以上。
4. bot 加 `ai-working`，评论“已认领”，台账写入 `claimed`。

台账是阶段权威来源，标签是给人看的镜像。认领带租约，租约 5 分钟，会话存活期间每轮续租。部署假设为单实例：租约用于进程内 tick 重叠和崩溃恢复，不防跨机器重复派发。

运行中的取消检查：每轮重读活跃 run 的 issue。台账仍活跃但出现 `ai-blocked`、`ai-working` 被移除或 issue 被关闭时，判定为人工取消（bot 改标签会先写台账，不会走到这个分支），中止会话、清理 worktree、台账进 `blocked`，`blockedReason` 记 `cancelled`。

### 4.2 bug 路径

1. 建 worktree，基准 `origin/<targetBranch>`，分支 `<prefix>issue-<iid>-<slug>`。远端已有同一 issue 的分支时基于 `origin/<已有分支>` 创建。worktree 不继承持久凭据助手，会话内没有推送凭据；fetch 由服务端用 bot 凭据经一次性凭据租约执行。
2. 派发只读判定会话（第 13 节）：读代码判断这份报告是否成立。结论为「非问题」时 bot 关单并结束本次运行；「信息不足」时阻塞等报告人补充；「成立」才继续。
3. 派发实现会话：复现、修复、跑最窄检查、提交到本地。agent 不推送。
4. agent 输出结构化字段：根因、改动、验证命令和结果、风险。服务端校验必填字段后用 bot 代发证据评论，noteId 记入台账。
5. 服务端校验分支名前缀、分支存在、相对目标分支 diff 非空、台账已记录证据评论 noteId，然后用触发者凭据经一次性凭据租约推送。
6. 服务端用触发者凭据建 MR，目标为 `targetBranch`，标题为 `<issue 标题> (#<iid>)`，描述按 MR 模板填写，正文含 `Closes #<iid>`。
7. bot 评论 MR 链接，加 `ai-review`，台账进 `mr-open`。

### 4.3 特性路径

1. 同样建 worktree 并先做只读判定（第 13 节），流程与 bug 相同。
2. agent 只读分析，输出结构化方案字段：改哪些文件、数据流、验证方式、风险、范围外。服务端校验后用 bot 代发方案评论。
3. bot 加 `ai-plan-review`，台账进 `waiting-approval`。
4. 轮询扫描该 issue 的新评论，只认 Developer 及以上、非 bot 账号发出的显式命令：`/ai-approve`、`/ai-reject`、`/ai-take`，其余评论一律忽略。允许触发者批准自己的方案。一人 `/ai-approve` 即可进入实现；`/ai-reject` 停止，标 `ai-blocked`，`blockedReason` 记 `rejected`。新需求走 `/ai-reject` 后人工重置重新出方案。批准后直接进入实现会话，不再经过判定。
5. 同一 issue 的多条命令以最新一条为准；已进入实现后出现的 approve 忽略。
6. 实现阶段与 bug 相同。

### 4.4 合并与收尾

- 默认分支的 MR 合并后由 GitLab 按 `Closes` 自动关单。
- 非默认分支的 MR 合并后，轮询检测到 merged 状态，bot 显式关闭 issue。
- 两种路径都加 `ai-done`，清理 worktree。
- MR 被关闭但未合并：标 `ai-blocked`，`blockedReason` 记 `mr-closed`，bot 评论说明，走人工重置解除。
- issue 已被人手动关闭的，照常加 `ai-done` 并清理。
- 清理前先查 `git status --porcelain`：工作区脏时跳过删除，评论路径，台账保留 worktreePath。现有 `removeWorktree` 会强删脏工作区，必须先做这个检查。进入 `blocked` 时同样走这套清理。

### 4.5 评论反馈修复

MR 打开后，人可以在 issue 或 MR 里评论 `@<bot 用户名> 修复`（或 `fix`）触发新一轮修复，修完回到 `mr-open` 继续等人评审。完整设计见第 12 节。

## 5. 模板

模板放在目标仓库：

```text
.gitlab/issue_templates/Bug.md
.gitlab/issue_templates/Feature.md
.gitlab/merge_request_templates/AI.md
```

两份 issue 模板开头是供自动化读取的固定头：

```text
<!--
下面两行供自动化读取，请保持格式。
目标分支用反引号包住；留空表示项目默认分支。
-->

类型: bug
目标分支: ``
```

Feature 模板同格式，`类型: feature`。

Bug 字段：现象、复现步骤、期望结果、实际结果、环境、证据、影响范围、可能根因（可选）。

Feature 字段：背景、期望行为、验收标准、不做的范围、依赖与风险。

MR 字段：关联 issue、根因、改动、验证命令与结果、风险与回滚、生成阶段。

解析规则：

- `类型:` 只认 trim 后的 `bug` 和 `feature`，行缺失或其他值标 `ai-blocked` 并评论请补模板。不用模板的 issue 不能派发。
- `目标分支:` 行缺失视同留空，用项目默认分支；行存在但值不是合法 ref 时标 `ai-blocked`，不猜。
- 12.7 没有 issue forms，只能解析 Markdown。

实现时在本仓库 `docs/gitlab-issue-templates/` 提供这三份可复制模板，由使用方复制到目标仓库。

## 6. 配置

项目级设置，默认关闭：

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `autoDispatchGitlabIssues` | boolean | false | 项目开关，和本地议题开关独立 |
| `gitlabIssueBranchPrefix` | string | `openchamber/` | 必须以 `/` 结尾，按 Git ref 规则校验 |
| `gitlabIssueBotAccountId` | string | 空 | 项目绑定实例上的 bot 账号，空则流程不启动 |
| `gitlabIssueTimeoutMinutes` | number | 30 | 各会话阶段与 worktree setup（`preparing`）的超时，超时中止并阻塞 |

校验失败时设置页显示错误，不启动该项目轮询。

## 7. 模块与代码接缝

新增 `packages/web/server/lib/gitlab-issues/`：

```text
dispatcher.js   定时器、项目开关、并发上限、租约、取消检查
ledger.js       运行台账，JSON 原子写，done 记录定期清理
machine.js      阶段定义与转移守卫
gitlab.js       bot/触发者账号解析、issue 读写、标签事件、审批权限、评论代发、MR 创建
workspace.js    worktree 创建与清理、脏检查、服务端推送
prompts.js      方案、实现、内审与反馈修复的提示词，定义结构化输出字段
DOCUMENTATION.md
```

复用点：

- 会话创建沿用 `packages/web/server/index.js` 中 `issueDispatcher` 的 `createOpenCodeClient`、项目默认模型和 agent。
- worktree 用 `packages/web/server/lib/git/service.js` 的 `createWorktree`、`removeWorktree`。`removeWorktree` 强删脏工作区，清理前必须先做脏检查；复用分支时基于 `origin/<已有分支>` 创建，避免 `-B` 重置已有提交。
- GitLab 读写用 `createGitLabClient`、`createGitLabResourceService`；MR 用 `MergeRequests.create`，评论用 `IssueNotes.create`。resource service 没有暴露 resource label events，gitbeaker 43.8 自带 `IssueLabelEvents`，补一个端点。
- 推送走一次性凭据租约（credential broker）：fetch 用 bot 凭据，push 用触发者凭据。自动化 worktree 不继承持久凭据助手，agent 会话内没有可用推送凭据。令牌不进 URL、argv 或日志。
- 前缀校验是新代码：服务端推送前校验分支名以配置前缀开头、禁 force push，不匹配就拒绝。现有 git 层只有 ref 格式校验，没有分支白名单。
- 不改变现有本地 `dispatcher.js` 的语义。两个派发器暂时各自维护 tick 循环，重复逻辑超过一屏再抽公共层。

服务启动处在 `issueDispatcher.start()` 旁注册新的派发器，并在设置页加开关、前缀输入、超时输入和账号选择。

## 8. 台账与状态机

路径：数据目录下 `gitlab-issue-runs.json`。写入先写临时文件再 rename。键为 `origin|projectId|iid`。写入时顺带清理 30 天前的 `done` 记录；`blocked` 记录保留到解除。

```json
{
  "version": 1,
  "runs": {
    "https://gitlab.example.com|42|17": {
      "origin": "https://gitlab.example.com",
      "projectId": 42,
      "iid": 17,
      "kind": "bug",
      "phase": "implementing",
      "targetBranch": "release/2.8",
      "branch": "openchamber/issue-17-fix-login",
      "actorUserId": 7,
      "actorAccountId": "gitlab-account-7",
      "sessionId": "ses_...",
      "worktreePath": "/srv/...",
      "mrIid": null,
      "attempts": 1,
      "leaseUntil": "2026-11-12T10:00:00.000Z",
      "since": "2026-11-12T09:40:00.000Z",
      "updatedAt": "2026-11-12T09:50:00.000Z",
      "lastError": null,
      "blockedReason": null,
      "triageVerdict": null,
      "triageNoteId": null,
      "outcome": null,
      "approvalNoteId": null,
      "planNoteId": null,
      "evidenceNoteId": null,
      "feedbackRounds": 0,
      "lastFeedbackActor": null,
      "noteWatermarks": { "issue": 0, "mergeRequest": 0 }
    }
  }
}
```

阶段与转移：

```text
claimed -> preparing | blocked
preparing -> triaging | blocked
triaging -> planning | implementing | done | blocked
planning -> waiting-approval | blocked
waiting-approval -> implementing | blocked
implementing -> reviewing | blocked
reviewing -> implementing | verifying | blocked
verifying -> mr-open | blocked
mr-open -> addressing | done | blocked
addressing -> reviewing | blocked
blocked -> claimed（仅 /ai-take 或人工重置）
done 终态
```

（`reviewing` 为实现阶段的内审环节，修复后回到 `reviewing` 逐条核对再走 `verifying`。`triaging` 是第 13 节的问题判定门，两种类型都在它之后才分岔；批准特性方案后直接进 `implementing`，不回到 `preparing`，避免把刚批准的方案再判一遍。）

`blockedReason` 取值：`invalid-template`、`missing-credential`、`branch-missing`、`verification-failed`、`session-failed`、`repeated-error`、`cancelled`、`mr-closed`、`timeout`、`review-rejected`、`label-events-unavailable`、`notes-limit`、`worktree-missing`、`feedback-limit`、`insufficient-info`、`not-an-issue`。

解除阻塞的两条路径：

- `/ai-take`：只对 `missing-credential` 生效。Developer 以上接管后换绑触发者，回到 `claimed`，沿用已有分支和台账。
- 人工重置：人移除 `ai-blocked` 并保留或重新加回 `ai-ready`，轮询视为新的回合，`attempts` 归零。这是显式人工动作，不自动发生。

每个 issue 最多 2 次尝试。同一错误重复出现直接 `blocked`。

超时与租约：

- `preparing`、`triaging`、`planning`、`implementing`、`reviewing`、`addressing` 超过配置时长（默认 30 分钟）中止会话或 setup，标 `blocked`，`blockedReason` 记 `timeout`。
- 租约 5 分钟，会话存活期间每轮续租，过期走恢复规则。

分支复用：远端分支按 `<前缀>issue-<iid>-` 匹配。匹配就复用已有分支继续跑，标题改过导致旧分支名不同也不冲突；前缀不匹配才报错。复用时的 worktree 基于 `origin/<已有分支>`。

恢复规则：

- 台账存在、会话仍存活：续跑当前阶段。
- 会话 404 且未到 `mr-open`：检查远端分支。已有提交则回到 `implementing`，否则重建 worktree 重跑。`triaging`、`reviewing`、`addressing` 例外：只清 `sessionId`，下一轮在同一阶段重开会话，因为分支上有没有提交说明不了这三件事的结论。
- `mr-open` 阶段的会话消失不影响，继续轮询 MR 状态。
- 拉取 issue 失败不等于“没有任务”，本项目本轮跳过并记日志，下轮重试。
- bot 凭据失效时无法评论或打标签：暂停该项目的派发，记录日志，并在设置页把账号标为失效，等运维更新。

## 9. 安全边界

- issue 正文是不可信输入。提示词声明它只作为数据，不覆盖系统指令。
- agent 只在分配的 worktree 内工作，不读取账号存储，不访问外网。
- 推送由服务端执行：agent 会话内没有推送凭据（worktree 不继承持久凭据助手），推送前服务端校验分支名前缀、禁 force push。校验由服务端代码强制执行。
- 令牌只走账号存储和一次性凭据租约，不进入提示词、日志、commit 或 MR 描述。错误统一脱敏。
- 分支名从 iid 和 slug 生成，所有 Git 调用使用参数数组，不拼接 shell 字符串。
- 只推 `<prefix>` 开头的分支；远端同名分支按 `issue-<iid>-` 匹配复用，前缀不匹配就拒绝，不覆盖远端。
- 不碰默认分支和保护分支，不 force push，不自动合并。
- `/ai-take` 由 Developer 以上触发，台账换绑触发者，bot 留交接评论。
- 只有判定为非问题时 bot 才关单，且结论与依据先写进评论；`insufficient-info` 只阻塞，不关单。误判后人工重开 issue，并删除台账里那条 `done` 记录再重新打 `ai-ready`，否则认领会因台账已有记录而跳过。
- bot 提权残余风险：12.7 上 Reporter 改不了标签时提权到 Developer。GitLab 服务端没有分支白名单，前缀限制只在本方案代码里，bot 令牌泄露时能推任何非保护分支。接受该风险：内网环境，令牌仅存账号存储、不进会话，日志脱敏。

## 10. 测试与验收

单元测试：

- 状态机全转移与非法转移。
- 台账原子写、损坏文件恢复、租约过期、done 记录清理。
- 类型行解析、目标分支解析与 ref 校验、前缀校验、slug 规则（中文标题、空 slug）。
- 触发者解析、审批权限判断、凭据缺失分支、Developer 权限不足。
- 取消检查（标签变化、issue 关闭）、implementing 超时、`preparing` 的 setup 永不就绪时按超时阻塞。
- `/ai-take` 换绑和人工重置后的重新认领。
- 反馈命令解析（大小写、冒号并入正文、命令首行之后的多行正文、裸 @ 忽略、非成员、bot 自评、system note）。
- 双水位线推进、同 tick 多条反馈合并、MR merged/closed 不触发。
- `addressing` 转移、worktree 丢失阻塞、5 轮上限进入 `feedback-limit`、反馈轮自己的 3 轮审核预算。
- 判定输出契约：三值枚举、`not-an-issue` 缺 `evidence` 拒绝、`insufficient-info` 缺 `missing` 拒绝、空 summary 拒绝。
- 判定结果分流：`valid` 进对应轨道、`insufficient-info` 阻塞且 issue 保持打开、`not-an-issue` 关单加 `ai-done` 进 `done`、bot 无权关单时落 `not-an-issue` 阻塞。
- `triaging` 会话丢失后留在原阶段重开，不按分支提交推断。

集成测试：

- 用现有 `resources.test.js` 的假 GitLab 模式覆盖列表、认领、方案评论、审批、MR 创建参数。
- 12.7 回退路径：diff 列表 404 时走 `/changes`。
- 推送用注入的 git 执行器，测试里不产生真实推送；覆盖前缀校验拒绝路径。

canary（内网 12.7）：

0. 实测 `resource_label_events` 端点可用。不可用就停下 bug 路径回报，不做系统备注解析回退。
1. 建一个 bug issue（用模板），打 `ai-ready`，确认 MR 作者和 commit 邮箱都是触发者，统计页能看到贡献。
2. 建一个特性 issue，确认停在方案评论，`/ai-approve` 后才开始写码。
3. 让触发者账号失效，确认 `ai-blocked`，另一个 Developer `/ai-take` 后继续。
4. 实现中途重启服务，确认不产生重复会话，并从同一分支恢复。
5. 目标写 `release/*` 的分支合并后，确认 issue 被显式关闭。
6. 实现中途人工关闭 issue，确认 run 中止、worktree 清理。
7. 建一个明显不是问题的 issue（例如要求的行为代码里已经实现），打 `ai-ready`，确认 bot 发判定评论并关单，分支上没有任何提交。

## 11. 上线步骤

1. 代码合并，功能默认关闭。
2. 在每个目标项目预建标签 `ai-ready`、`ai-working`、`ai-plan-review`、`ai-review`、`ai-blocked`、`ai-done`；12.7 不依赖接口自动建标签。
3. 在目标项目添加 bot 账号为 Reporter，确认 12.7 上能改标签；不能则提权到 Developer，但仍按前缀限制推送。
4. 复制三份模板到目标仓库。
5. 跑 bug 和特性两个 canary，核对统计归属。
6. 逐项目打开开关。

## 12. 评论反馈修复

mr-open 之后由评论驱动的新一轮修复。2026-11-15 评审定案，本期实现；CI 失败触发不做（那属于 `gitlab-mr-auto-fix` 技能）。

### 12.1 触发与命令解析

- 双通道轮询：issue notes 与 MR notes 都查，各自水位线用 note id（台账 `noteWatermarks.issue` / `noteWatermarks.mergeRequest`），每轮处理完推进水位线。
- 命令形态：首行 `@<bot 用户名> 修复` 或 `@<bot 用户名> fix`，大小写不敏感。bot 用户名动态取项目绑定的 bot 账号，不硬编码。命令行后接冒号（中英文均可）的内容，以及命令行之后的其余评论内容，都并入反馈正文，如 `@ai-bot 修复: 登录页样式塌了`，或 `@ai-bot 修复:` 后换行列出多条问题。
- 仅 @ bot 不带指令的评论忽略；触发者的评论回复里说明"裸 @ 不会触发，请用 `@<bot> 修复`"。
- 门槛与过滤：只认 Developer 及以上、非 bot 账号发出的；system notes 与 bot 代发的评论一律过滤。issue 侧复用 `latestCommand`，MR 侧补 `MergeRequestNotes` 封装。
- 同一 tick 内的多条反馈合并为一批，共用一轮 addressing。
- 反馈评论正文与 issue 正文同等对待，是不可信输入，提示词声明它只作为数据。

### 12.2 状态与标签

- 新阶段 `addressing`：`mr-open -> addressing`，修完经 `reviewing`（内审 prompt 带反馈清单逐条核对）→ `verifying` → `mr-open`。
- 进入 `addressing` 加 `ai-working`，回 `mr-open` 恢复 `ai-review`。
- MR 已 merged 或 closed 时不触发，闭环优先于反馈。
- worktree 与分支复用 `mr-open` 时台账记录的路径和分支名；丢失时标 `blocked`，`blockedReason` 记 `worktree-missing`，bot 评论请人工重置。

### 12.3 会话与输出

- 第 4 个 prompt 模板：输入含 issue 描述、MR diff、批内反馈清单（带每条作者）、既往修复轮次摘要；输出复用实现阶段的 evidence JSON 契约，服务端校验后代发证据评论。
- 会话超时沿用 `gitlabIssueTimeoutMinutes`（默认 30 分钟）。
- push 与 MR 更新仍用触发者凭据（`actorUserId`），与首轮一致；不新增台账事件类型。
- 轮次上限 5（`feedbackRounds`）；超过标 `blocked`，`blockedReason` 记 `feedback-limit`，bot 评论说明需人工重置后重新认领。
- 台账记 `lastFeedbackActor`（最后一条触发反馈的人，用于归属展示）。
- bot 确认回复两条：触发时引用反馈要点并说明开始修复；推送后给出新 commit sha。

### 12.4 展示

- run rail 与 source board 卡片在 `feedbackRounds > 0` 时显示「第 N 轮反馈修复」。

## 13. 问题判定门

认领之后、写码或出方案之前，先判一次这份报告到底是不是问题。2026-11-16 评审定案。

### 13.1 为什么需要

原流程没有这一步：bug 认领后直接派实现会话，非问题只有两种结局，agent 硬凑一个改动开一条废 MR，或者诚实报告什么也没改，被 diff 校验判成 `verification-failed` 进 `ai-blocked`，issue 一直开着等人手动关。判定门让非问题在产生任何提交之前就收口。

### 13.2 时机与阶段

`claimed -> preparing -> triaging`。worktree 在 `claimed` 就建好，判定在同一个 worktree 上只读进行，需要紧接着看代码的方案阶段也复用这份 checkout。

判定之后按结论分岔：

```text
triaging -> planning       （feature，报告成立）
triaging -> implementing   （bug，报告成立）
triaging -> done           （not-an-issue，bot 关单）
triaging -> blocked        （insufficient-info / 关单失败 / 会话或输出异常）
```

批准特性方案后为 `waiting-approval -> implementing`。不再经过 `preparing`，否则刚被批准的 feature 会被重判一遍。

### 13.3 输出契约

只读会话，issue 正文照旧作为不可信数据包裹。输出：

```json
{"verdict":"valid","summary":"...","evidence":"...","missing":"..."}
```

| 字段 | 规则 |
| --- | --- |
| `verdict` | `valid`、`not-an-issue`、`insufficient-info`，其他值按 `AgentOutputError` 处理 |
| `summary` | 必填，一句话说明判据 |
| `evidence` | `not-an-issue` 必填，必须点名文件、符号、测试或文档行 |
| `missing` | `insufficient-info` 必填，列出报告人需要补什么 |

三值语义写死在提示词里：

- `valid` 是默认值。代码与报告矛盾，或者无法从代码证明该行为是有意为之，都算成立。
- `not-an-issue` 仅当代码、测试或文档明确显示这是有意行为、已经实现，或报告与代码事实相反。麻烦、改动大、判断人不认同，都不构成这个结论。
- `insufficient-info` 是报告本身不可核验：没有复现步骤、没有版本或环境、或者没写期望结果。能对着代码核验的一律先核验。

### 13.4 三种结果的动作

- `valid`：bot 发一行确认评论；台账记 `triageVerdict`、`triageNoteId`；`attempts` 归零后按类型进 `planning` 或 `implementing`。
- `insufficient-info`：标 `ai-blocked`，`blockedReason` 记 `insufficient-info`，评论列出缺失项。issue 保持打开，报告人补齐后走既有人工重置。
- `not-an-issue`：bot 先发评论（结论加依据），再用 bot 身份关闭 issue，移除 `ai-working`、`ai-plan-review`、`ai-review`，加 `ai-done`，清理 worktree，台账 `phase: done`、`outcome: not-an-issue`。
- 关闭失败（12.7 上 bot 权限不足）：不得把状态标成 `done`。落 `blocked`，`blockedReason` 记 `not-an-issue`，评论写明请人工关闭，issue 保持打开。

### 13.5 与既有机制的关系

- `triaging` 计入槽位（`SLOT_PHASES`）、超时（`TIMED_PHASES`）与取消检查的观察列表。
- 判定会话不消耗 `MAX_ATTEMPTS`，与审核轮次同处理；它会话语义与 `reviewing` 一致（会话丢失只清 `sessionId` 原地重开）。
- 会话超时沿用 `gitlabIssueTimeoutMinutes`。
- 判定会话使用项目默认模型，不读 `gitlabIssueReviewModel`。

### 13.6 展示

- run rail 在 `claimed` 之后、`planning`/`implementing` 之前画 `triaging` 一站，两种类型都有。
- 历史区条目在 `outcome === 'not-an-issue'` 时显示「非问题」，否则它与合并完成的 run 都只显示 Done。
- `blockedReason` 的中文文案表补 `insufficient-info` 与 `not-an-issue` 两项，缺一项面板就没有指引文案。

### 13.7 误判处置

判定由模型给出，可能把真问题判成非问题并关单。缓解：`valid` 是默认值；`not-an-issue` 强制点名代码依据；关单前先把结论和依据写进评论。人工发现误判后重开 issue，并删除台账中该条 `done` 记录再重新打 `ai-ready`，否则认领会被「台账已有记录」挡住。这一条写进 `gitlab-issues/DOCUMENTATION.md`。
