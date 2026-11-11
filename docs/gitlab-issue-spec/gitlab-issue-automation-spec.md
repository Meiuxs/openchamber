# GitLab Issue 自动化需求与设计方案

状态：评审通过，待实现。日期：2026-11-12（设计评审同日定案）。

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
| 特性类 issue | 先出方案评论，`/ai-approve` 后才写码 |
| bot 权限 | 只做评论、回复、标签，Reporter 角色 |
| 代码身份 | 触发者的 GitLab 账号兜底 push、开 MR，commit author 用触发者 |
| 推送执行点 | agent 只提交到本地，服务端校验后推送并建 MR |
| 评论发出方 | agent 输出结构化字段，服务端校验后用 bot 代发 |
| 凭据失效 | 标 `ai-blocked`，Developer 以上可用 `/ai-take` 接管 |
| 目标分支 | issue 模板字段，留空用项目默认分支 |
| 分支前缀 | 项目级配置，默认 `openchamber/` |
| 非默认分支合并 | bot 轮询发现合并后显式关单 |
| 并发模型 | 单实例部署；活跃 run 每项目 1 个、全局 3 个 |
| 运行中取消 | 人工改标签或关闭 issue 即中止 run |
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
2. 派发实现会话：复现、修复、跑最窄检查、提交到本地。agent 不推送。
3. agent 输出结构化字段：根因、改动、验证命令和结果、风险。服务端校验必填字段后用 bot 代发证据评论，noteId 记入台账。
4. 服务端校验分支名前缀、分支存在、相对目标分支 diff 非空、台账已记录证据评论 noteId，然后用触发者凭据经一次性凭据租约推送。
5. 服务端用触发者凭据建 MR，目标为 `targetBranch`，标题为 `<issue 标题> (#<iid>)`，描述按 MR 模板填写，正文含 `Closes #<iid>`。
6. bot 评论 MR 链接，加 `ai-review`，台账进 `mr-open`。

### 4.3 特性路径

1. 同样建 worktree，agent 只读分析，输出结构化方案字段：改哪些文件、数据流、验证方式、风险、范围外。服务端校验后用 bot 代发方案评论。
2. bot 加 `ai-plan-review`，台账进 `waiting-approval`。
3. 轮询扫描该 issue 的新评论，只认 Developer 及以上、非 bot 账号发出的显式命令：`/ai-approve`、`/ai-reject`、`/ai-take`，其余评论一律忽略。允许触发者批准自己的方案。一人 `/ai-approve` 即可进入实现；`/ai-reject` 停止，标 `ai-blocked`，`blockedReason` 记 `rejected`。新需求走 `/ai-reject` 后人工重置重新出方案。
4. 同一 issue 的多条命令以最新一条为准；已进入实现后出现的 approve 忽略。
5. 实现阶段与 bug 相同。

### 4.4 合并与收尾

- 默认分支的 MR 合并后由 GitLab 按 `Closes` 自动关单。
- 非默认分支的 MR 合并后，轮询检测到 merged 状态，bot 显式关闭 issue。
- 两种路径都加 `ai-done`，清理 worktree。
- MR 被关闭但未合并：标 `ai-blocked`，`blockedReason` 记 `mr-closed`，bot 评论说明，走人工重置解除。
- issue 已被人手动关闭的，照常加 `ai-done` 并清理。
- 清理前先查 `git status --porcelain`：工作区脏时跳过删除，评论路径，台账保留 worktreePath。现有 `removeWorktree` 会强删脏工作区，必须先做这个检查。进入 `blocked` 时同样走这套清理。

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
| `gitlabIssueTimeoutMinutes` | number | 30 | implementing 阶段超时，超时中止会话并阻塞 |

校验失败时设置页显示错误，不启动该项目轮询。

## 7. 模块与代码接缝

新增 `packages/web/server/lib/gitlab-issues/`：

```text
dispatcher.js   定时器、项目开关、并发上限、租约、取消检查
ledger.js       运行台账，JSON 原子写，done 记录定期清理
machine.js      阶段定义与转移守卫
gitlab.js       bot/触发者账号解析、issue 读写、标签事件、审批权限、评论代发、MR 创建
workspace.js    worktree 创建与清理、脏检查、服务端推送
prompts.js      计划与实现两个阶段的提示词，定义结构化输出字段
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
      "approvalNoteId": null,
      "planNoteId": null,
      "evidenceNoteId": null
    }
  }
}
```

阶段与转移：

```text
claimed -> planning | preparing | blocked
planning -> waiting-approval | blocked
waiting-approval -> preparing | blocked
preparing -> implementing | blocked
implementing -> verifying | blocked
verifying -> mr-open | blocked
mr-open -> done | blocked
blocked -> claimed（仅 /ai-take 或人工重置）
done 终态
```

`blockedReason` 取值：`missing-credential`、`rejected`、`branch-missing`、`verification-failed`、`repeated-error`、`cancelled`、`mr-closed`、`timeout`。

解除阻塞的两条路径：

- `/ai-take`：只对 `missing-credential` 生效。Developer 以上接管后换绑触发者，回到 `claimed`，沿用已有分支和台账。
- 人工重置：人移除 `ai-blocked` 并保留或重新加回 `ai-ready`，轮询视为新的回合，`attempts` 归零。这是显式人工动作，不自动发生。

每个 issue 最多 2 次尝试。同一错误重复出现直接 `blocked`。

超时与租约：

- implementing 超过配置时长（默认 30 分钟）中止会话，标 `blocked`，`blockedReason` 记 `timeout`。
- 租约 5 分钟，会话存活期间每轮续租，过期走恢复规则。

分支复用：远端分支按 `<前缀>issue-<iid>-` 匹配。匹配就复用已有分支继续跑，标题改过导致旧分支名不同也不冲突；前缀不匹配才报错。复用时的 worktree 基于 `origin/<已有分支>`。

恢复规则：

- 台账存在、会话仍存活：续跑当前阶段。
- 会话 404 且未到 `mr-open`：检查远端分支。已有提交则回到 `implementing`，否则重建 worktree 重跑。
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
- bot 提权残余风险：12.7 上 Reporter 改不了标签时提权到 Developer。GitLab 服务端没有分支白名单，前缀限制只在本方案代码里，bot 令牌泄露时能推任何非保护分支。接受该风险：内网环境，令牌仅存账号存储、不进会话，日志脱敏。

## 10. 测试与验收

单元测试：

- 状态机全转移与非法转移。
- 台账原子写、损坏文件恢复、租约过期、done 记录清理。
- 类型行解析、目标分支解析与 ref 校验、前缀校验、slug 规则（中文标题、空 slug）。
- 触发者解析、审批权限判断、凭据缺失分支、Developer 权限不足。
- 取消检查（标签变化、issue 关闭）、implementing 超时。
- `/ai-take` 换绑和人工重置后的重新认领。

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

## 11. 上线步骤

1. 代码合并，功能默认关闭。
2. 在每个目标项目预建标签 `ai-ready`、`ai-working`、`ai-plan-review`、`ai-review`、`ai-blocked`、`ai-done`；12.7 不依赖接口自动建标签。
3. 在目标项目添加 bot 账号为 Reporter，确认 12.7 上能改标签；不能则提权到 Developer，但仍按前缀限制推送。
4. 复制三份模板到目标仓库。
5. 跑 bug 和特性两个 canary，核对统计归属。
6. 逐项目打开开关。
