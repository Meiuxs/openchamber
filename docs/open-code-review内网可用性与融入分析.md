# open-code-review 内网可用性与 GitLab issue 自动化融入分析

分析日期：2026-11-16。上游基准：`alibaba/open-code-review` 的 `main` 分支，最新提交 `7e5ce06`（2026-11-15）。本地基准：`docs/gitlab-issue-spec/` 下的基础规格与审核门规格，以及 `packages/web/server/lib/gitlab-issues/DOCUMENTATION.md` 记录的当前实现。

## 1. 结论

这个工具可以放到内网使用，需要三项前置条件：把发行版二进制和模型端点都固定在内网；给 OCR 单独准备 Git 2.41 或更高版本；在企业模式下为它的模型出口增加管理员钉死的策略。它不会开箱即用，也不需要改造成常驻服务。

与我们当前的 GitLab issue 自动化，最合适的融入位置是 `reviewing` 阶段。把 OCR 的 JSON 评审结果映射到我们已有的 `approve` / `request-changes` 契约，保留台账、状态机、bot 署名和推送边界，风险最小。第二个位置是目标仓库的 GitLab CI，让 OCR 在 MR 上直接发行级讨论，和现有流程并行，互不接管。委托模式适合先做验证，它只借用文件筛选和规则解析，评审推理仍由我们已有的 OpenCode 会话完成，不新增模型出口。

不建议让 OCR 替代实现会话、台账或推送逻辑。这些位置是现有流程的安全边界，OCR 没有对应的权限模型。

## 2. 主要功能点

### 2.1 产品定位

Open Code Review 是阿里内部孵化约两年的 AI 代码评审 CLI，官方说法是服务数万名开发者、发现数百万个缺陷。仓库当前约 51.8k star、4.0k fork、861 次提交、166 个 tag，许可证 Apache-2.0，带 OpenSSF Best Practices Gold 徽章。它是一个本地命令行程序，没有服务端、数据库或租户概念。

核心设计是把确定性的工程步骤和 Agent 的推理分开。文件是否进入评审、相关文件如何打包、每个文件适用哪条规则、评论落在哪一行、评论内容是否站得住，这些由代码和外部模块处理。模型只处理需要判断的部分。官方给出三个要解决的通用 Agent 问题：大变更集漏审、评论行号漂移、提示词微调导致质量抖动。

### 2.2 评审模式

| 模式 | 命令 | 输入范围 | 适用位置 |
| --- | --- | --- | --- |
| 工作区 | `ocr review` | 暂存、未暂存和未跟踪文件 | 开发提交前 |
| 分支范围 | `ocr review --from <base> --to <head>` | `merge-base(base, head)..head` | 分支合并前、服务端审核门 |
| 单提交 | `ocr review --commit <sha>` | 该提交的改动 | 补丁复核 |
| 断点续审 | `ocr review --resume <session-id>` | 上次中断的范围或提交 | 长任务恢复 |
| 全文件扫描 | `ocr scan [--path <dir>]` | 整个仓库、目录或指定文件，不依赖 Git 历史 | 陌生代码库审计 |
| 委托模式 | `ocr delegate preview` / `ocr delegate rule` | 输出文件清单和规则分组，由宿主 Agent 评审 | 已有编码 Agent 的订阅额度场景 |

`--preview` 只输出筛选结果，不消耗 token，可用于核对哪些文件会被评审。`--format json --audience agent` 把 stdout 收敛为单个 JSON 文档，给服务端消费。

### 2.3 流水线结构

官方文档 `architecture.md` 给出的顺序如下。

1. 引导：解析 LLM 端点，加载规则、模板和工具注册表。
2. diff 生成：三种模式对应三种 Git 调用，上下文行固定为 3 行，未跟踪文件按整文件新增处理。
3. 文件筛选：二进制、密钥路径、用户 `exclude`、用户 `include`、扩展名白名单、内置排除路径，共六道门。测试结果、生成代码和依赖目录默认排除。
4. 语义打包：一次只传文件路径、状态和增删行数的 LLM 调用，把相关文件合成一组，每组最多 10 个文件。调用失败时退化为每文件一组。
5. 分组子任务：每组一个 goroutine，默认并发 8。大改动先走 plan 阶段生成检查清单，再进入主循环。主循环通过 `task_done` 结束，工具调用上限默认 100 轮，连续 3 轮无有效结果会退出。
6. 后处理：独立的评论定位、反思和过滤模块重新校准位置与内容，最后按终端或 JSON 格式输出。

`--effort` 控制主循环轮次，`low` 为 1 轮，`medium` 默认 2 轮，`high` 为 3 轮。官方面试数据称在同一底层模型下 Precision 和 F1 高于通用 Agent，token 约为九分之一，Recall 有意压低以减少噪声。基准是 AACR-Bench：50 个仓库、200 个真实 PR、10 种语言、80 多名高级工程师交叉标注、1505 个缺陷。

### 2.4 规则体系

规则按四层优先级解析：`--rule` 指定的文件，仓库根 `.opencodereview/rule.json`，用户目录 `~/.opencodereview/rule.json`，二进制内置的 `system_rules.json`。规则文件是 JSON：

```json
{
  "include": ["src/**/*.{ts,tsx,js,jsx}"],
  "exclude": ["**/*.gen.ts", "**/generated/**"],
  "rules": [
    {
      "path": "src/api/**/*.go",
      "rule": "Every public handler must validate request bodies before use.",
      "merge_system_rule": true
    }
  ]
}
```

`include` 用来覆盖内置默认排除；未命中的文件仍会经过扩展名和内置路径检查。`merge_system_rule` 为 true 时用户规则与内置语言规则合并，默认 false 表示替换。内置规则覆盖 Java、Go、Python、TypeScript、C、C++、Rust、PHP、Ruby、Shell、SQL、YAML、Dockerfile、MyBatis mapper XML 等大量文件类型。`ocr rules check <path>` 可以直接查看某个文件最终命中哪一层规则。

### 2.5 模型与凭据

内置 provider 包括 Anthropic、OpenAI、OpenAI Responses、Gemini、DashScope、DeepSeek、火山、腾讯、讯飞、Kimi、智谱、MiniMax、百度千帆、硅基流动、OpenRouter、Bedrock 等。自定义 provider 至少给 `url` 和 `protocol`，协议可选 `openai`、`openai-responses`、`anthropic`、`anthropic-bedrock`。内置 provider 也能用 `providers.<name>.url` 改 Base URL，指向自建 LiteLLM 网关。本地 Ollama 就是一个指向 `http://127.0.0.1:11434/v1` 的自定义 provider。

服务端常用的环境变量三元组是 `OCR_LLM_URL`、`OCR_LLM_TOKEN`、`OCR_LLM_MODEL`。密钥也可以走 `api_key_cmd`，从密钥管理命令读取，不落在配置文件里。请求超时由 `--timeout`（分钟，默认 15）和 `OCR_LLM_TIMEOUT`（秒，默认 300）分别控制，两者互不覆盖。

一个硬约束：模型必须支持原生 function calling。只在文本里描述工具调用的模型无法工作，OCR 的评审循环完全依赖工具调用。官方 FAQ 明确点名 `deepseek-r1` 这类模型会失败，`qwen3` 可用。

### 2.6 输出、会话与可观测性

`--format json --audience agent` 的顶层字段有 `status`、`llm`、`summary`、`comments`、`warnings`、`session_id`。评论对象是 `path`、`content`、`start_line`、`end_line`、`existing_code`、`suggestion_code`、`thinking`。每轮会话以 JSONL 写入 `~/.opencodereview/sessions/`，`ocr viewer` 读本地文件回放。OpenTelemetry 默认关闭，打开后只导出调用形态、耗时、token 计数和事件，官方说明提示词与响应正文从不进入导出内容。OCR 还能作为 MCP 客户端，把外部工具接进评审 Agent，这一步需要单独审查工具权限和数据出口。

### 2.7 集成入口

CLI 之外，仓库提供 Claude Code、Codex、Cursor、Kimi Code、OpenCode 的插件，ACP 接入，GitHub Actions 和 GitLab CI 的现成流水线。OpenCode 插件注册 `ocr_review` 和 `ocr_health` 两个工具，进程用参数数组启动，不做 shell 拼接，超时默认 30 分钟。Claude Code 的 `/open-code-review:review` 命令默认会应用 High 和 Medium 级别的修复，这一点与我们的推送边界冲突，直接复用时要关掉自动修复。

### 2.8 已知限制

Recall 低于通用 Agent，这是官方主动选择，意味着审核门通过不能等同于没有缺陷。没有内置密钥脱敏，含密钥的文件要靠 `exclude` 或 `git diff --no-textconv` 过滤。只支持 Git，不支持 SVN 或 Mercurial。OpenTelemetry 的 `content_logging` 配置项目前是预留字段，不控制任何代码路径。会话 JSONL 里保留完整提示词和工具结果，属于本地敏感数据。

## 3. 内网可用性评估

| 维度 | 结论 | 依据与处置 |
| --- | --- | --- |
| 许可证与代码审计 | 可用 | Apache-2.0，Go 源码公开，OpenSSF Gold。可自行构建并审计。 |
| 离线安装 | 可用，需准备 | 优先同步 Release 静态二进制 `opencodereview-linux-amd64` 或 `arm64` 和 `sha256sum.txt` 到内网。npm 安装方式默认每约 18 分钟后台检查更新，必须设 `OCR_NO_UPDATE=1`；静态二进制没有这个行为。 |
| 模型端点 | 可用，需钉死 | 自定义 provider 支持任意 OpenAI 兼容地址，内置 provider 也能改 Base URL。指向内网 OpenAI 兼容网关即可。模型必须通过原生 tool calling 验证。 |
| 凭据保管 | 可用 | 支持 `api_key_cmd` 从内网密钥系统读取，避免把密钥写进 `~/.opencodereview/config.json`。 |
| 数据外发 | 可控 | 只有 diff 和工具读取的代码片段发往配置的 LLM 端点。遥测默认关闭。MCP 服务器和插件若启用会引入新出口，内网保持不配置。 |
| Git 版本 | 主要阻塞点 | README 要求 Git >= 2.41。源码 `internal/diff/git.go` 使用 `--end-of-options` 等较新参数。我们当前的宿主 Git 调用必须兼容 2.20.x，两边不能共用同一个 git。给 OCR 单独放一个带新 Git 的容器或 sidecar。 |
| GitLab 12.7 兼容 | 需实测 | 官方 GitLab 配方读 `CI_SERVER_URL`，通过 `/discussions` 发行级评论，用 `merge_requests/<iid>/versions` 计算 `base_sha` / `start_sha` / `head_sha`。这些接口在 12.7 是否存在、内联定位是否成功，需要在内网实例验证；失败时官方脚本会退回普通 MR 评论。 |
| Runner 与镜像 | 需准备 | 官方示例用 `node:20` 镜像并在运行时 `npm install -g`。内网要替换为 Harbor 中的镜像和私有 npm 源，固定 OCR 版本，设置 `GIT_DEPTH: 0` 避免浅克隆导致找不到 merge-base。 |
| 企业模式边界 | 主要阻塞点 | `enterprise-boundary` 规则禁止用户侧新增 provider、key 或 endpoint。OCR 自带一套配置，等于新出口。要么由管理员在策略里钉死内网网关并把 OCR 的端点从策略注入，要么用委托模式让评审推理走 OpenCode 已有 provider。 |
| 本地落盘 | 需治理 | `~/.opencodereview/sessions/` 保存完整评审会话。需要设置保留期和清理任务，避免长期留存代码正文。 |
| 信创终端 | 需实测 | Go 静态二进制对 glibc 依赖少，linux amd64 和 arm64 都有发行包。Git 2.41 在 UOS 软件源里通常没有，仍需自带新 Git。 |

总判断：可以内网化，属于需要部署改造的配置级项目；阻塞点集中在 Git 版本和企业模式的模型出口，不在 OCR 本身的功能或许可证。

## 4. 与当前 GitLab issue 自动化的能力映射

当前流程从 `ai-ready` 标签开始：服务端轮询认领，bug 直接实现，feature 先出方案等 `/ai-approve`；实现会话在隔离 worktree 内提交；独立的审核会话读 `git diff <base>..HEAD` 输出 `{ verdict, summary, findings: [{ file, line?, severity, note }] }`；审核通过后由服务端校验 diff 并用触发者凭据推送、建 MR；MR 打开后支持 `@bot 修复` 触发最多 5 轮反馈修复。台账是权威状态，标签和评论是给人看的镜像，agent 永不推送。

| 环节 | 现状 | OCR 能提供什么 | 判断 |
| --- | --- | --- | --- |
| 文件选择与覆盖 | 审核 prompt 让模型自己读 diff | 六道筛选门、`--preview` 可核对覆盖、语义打包 | 有价值，可单独借用 |
| 独立审核门 | OpenCode 审核会话，3 轮回灌上限 | `ocr review` 结构化 JSON，行级定位和反思模块 | 最合适的替换点 |
| 规则匹配 | 项目 prompt 中的文字要求 | 四层规则链，按文件类型匹配，可在目标仓库提交规则文件 | 有价值，配置成本低 |
| 实现与修复 | 实现会话按 issue 和审核发现改代码 | Claude Code 命令默认自动修复，但会直接改工作区 | 不接入，保持 agent 推送边界 |
| 推送与建 MR | 服务端用触发者凭据，前缀和 diff 校验 | 无对应能力 | 不接入 |
| 台账与面板 | 本地 JSON 台账，10 秒轮询，中文指引 | 无对应能力，OCR 会话是另一套 JSONL | 不接入 |
| MR 后评论修复 | 双通道水位线，`addressing` 阶段 | 无命令解析能力 | 不接入 |
| CI 失败修复 | `gitlab-mr-auto-fix` 技能，一次熔断 | OCR 不分析 CI 日志 | 不接入 |
| MR 行级评审 | 人工在 GitLab 评审 | 官方 GitLab CI 配方直接发行级 discussion | 并行增量，适合试点 |
| 会话可观测 | 面板链接 OpenCode 会话 | `ocr viewer` 是本地独立查看器 | 保持两套，不强行合并 |

## 5. 三种融入方案

### 5.1 方案一：委托模式做审核门输入

在现有审核会话里调用 `ocr delegate preview` 和 `ocr delegate rule`，拿到确定性的文件清单和规则分组，再由会话自己读 diff 并输出原来的 `approve` / `request-changes` 结构。

优点是不新增模型端点，推理仍走 OpenCode 已配置的 provider，企业模式的 provider entry 边界不被突破。改动集中在 prompt 和工具注册，台账、状态机、评论和推送路径完全不动。

代价是 OCR 的独立定位模块、反思模块和专用主循环不参与，收益主要落在覆盖率和规则匹配上。官方 Benchmark 的优势来自完整 `ocr review` 流水线，委托模式拿不到这部分。适合作为第一步验证，不适合作为最终形态。

### 5.2 方案二：服务端 CLI 替换审核引擎

在 `reviewing` 阶段由服务端启动一次 OCR，替代当前的审核 OpenCode 会话：

```bash
ocr review \
  --from <primaryRemote>/<targetBranch> \
  --to HEAD \
  --format json \
  --audience agent \
  --timeout <gitlabIssueTimeoutMinutes> \
  --rule <projectRuleFile>
```

结果按以下规则适配到现有契约：

| OCR 输出 | 我们的审核契约 |
| --- | --- |
| `status: complete` 或 `success`，`comments` 为空 | `approve`，`findings: []` |
| 有 `comments` | `request-changes`，每条映射为一个 finding，`path` 到 `file`，`start_line` 到 `line`，`content` 到 `note` |
| severity 高或 critical | `blocker` |
| severity 中或低 | `minor`，低级别可按项目设置丢弃 |
| `status: partial` / `failed`，或 `warnings` 非空 | 失败处理，进入 `blocked`，不自动放行 |
| 退出码 1，或 JSON 解析失败 | `failRun`，与现有 `AgentOutputError` 同路径 |

需要配套的工程改动：在 `gitlab-issues/` 下增加一个 OCR 调用与结果适配模块，注入命令执行器以便测试，不新增依赖；保持 3 轮审核回灌和 `REVIEW_MAX_REVISIONS = 3` 不变；审核会话的不可信数据定界继续生效，OCR 的 JSON 输出同样要逐字段校验后才能进入评论和下一轮 prompt；模型端点由管理员策略注入到环境变量，不落在项目设置里；OCR 进程运行在带 Git 2.41 的独立容器中，工作区只读挂载，服务端仍然执行 `verifying` 的 `git diff --quiet base..HEAD` 校验。

这条路径能拿到 OCR 的行级定位、反思和规则体系，对现有流程的语义改变最小。主要成本是 Git 容器和企业模式策略。

### 5.3 方案三：在目标仓库接入 GitLab CI

把官方 `examples/gitlab_ci/.gitlab-ci.yml` 改成内网版本，放到目标仓库。MR 创建或更新时触发，Runner 在内网，只读 diff，把 OCR 的 comments 通过 Discussion API 写成行级评论，无法定位的写成普通 MR 评论，最后附一条汇总。

配置项：`OCR_LLM_URL` / `OCR_LLM_TOKEN` / `OCR_LLM_MODEL` 指向内网网关，专用服务账号 token 带 `api` scope，`GIT_DEPTH: 0`，固定 OCR 版本，npm 源指向私有镜像，关闭自动更新和遥测。

这条路径不动 OpenChamber 任何代码，放在 MR 打开之后，与人工评审和 `@bot 修复` 反馈轮并存。需要注意两处：OCR 的评论和 bot 的审核评论会出现在同一个 MR 上，要在机器人命名和路由上区分；官方配方每次 MR 更新都全量评审，长生命周期 MR 的 token 成本要先用“已有 OCR 评论则跳过”的包装控制。

### 5.4 不建议的做法

不要让 OCR 自动应用修复并推送。Claude Code 命令默认会改文件，与“agent 不推送、服务端校验后推送”的边界冲突。

不要把 OCR 会话写回我们的台账。两个系统各自有权威状态，写回会产生第二条状态机。

不要在用户侧设置页开放 OCR provider 配置。企业模式把 provider entry 视为需要管理员同意的边界，放开就等于绕开策略。

## 6. 落地步骤与验收

### 阶段一：离线验证

1. 从 Release 下载固定版本的 linux amd64 二进制和校验文件，导入内网，核对 sha256。
2. 准备一个带 Git 2.41 以上的容器，把二进制放进去，设置 `OCR_NO_UPDATE=1`，不配置 telemetry。
3. 用内网 OpenAI 兼容网关配置自定义 provider，`ocr llm test` 通过后，对一段真实 MR diff 跑 `ocr review --format json --audience agent --preview` 和正式评审。
4. 用 FAQ 里的 function calling 探针验证模型，模型必须返回结构化 `tool_calls`。
5. 记录 JSON 的 `status`、`comments` 字段形态和 token 消耗，确认与第 5.2 节的适配假设一致。

### 阶段二：审核门适配

1. 在 `packages/web/server/lib/gitlab-issues/` 增加 OCR 执行与映射模块，默认关闭，项目级开关控制。
2. 测试覆盖 `status` 各分支、severity 映射、非法 JSON、超时、空 diff、部分失败、3 轮回灌上限。测试替换依赖走真实注入点，沿用仓库的 `gitRunner` 模式。
3. 保留 `buildReviewPrompt` 作为回退，灰度时可按项目切换。
4. 跑 `bun run check:changed -- --base HEAD`，按仓库门禁修复新增问题。
5. 在内网 12.7 实例跑 canary：一次 `request-changes` 回灌后 approve，确认 bot 评论由 bot 账号发出、推送仍由触发者账号执行、面板显示审核轮次。

### 阶段三：CI 增量

1. 在目标项目引入内网版 `.gitlab-ci.yml`，先以手动作业运行。
2. 验证 12.7 的 `/discussions` 和 `versions` 接口；内联失败时确认退回普通评论。
3. 确认机器人身份、评论去重、token 权限和成本，再决定是否设为自动触发。

验收底线：断网环境下除钉死的内网模型网关外无外部请求；Git 调用分别落在 2.20 宿主和 2.41 以上的 OCR 容器；企业模式打开时无法从用户侧新增 OCR 端点；任何 OCR 失败都不会产生推送；审核通过不替代人工 MR 评审。

## 7. 风险清单

| 风险 | 等级 | 处置 |
| --- | --- | --- |
| OCR 要求 Git >= 2.41，宿主要求 2.20 兼容 | 高 | 独立容器或 sidecar，禁止替换宿主 git |
| 企业模式禁止新增 provider 和 endpoint | 高 | 管理员策略钉死内网网关，或先用委托模式 |
| 内网模型不支持原生 function calling | 高 | 选型验证，先用 qwen3 类模型，失败则不接入 |
| Recall 偏低，审核通过仍有漏报 | 高 | 明确定位为减少废 MR 的门，人审留在 MR |
| diff 和代码片段发往模型网关 | 中 | 网关在内网，排除密钥路径，保留审计 |
| 会话 JSONL 留存代码正文 | 中 | 设置保留期和清理任务，容器临时目录优先 |
| `status: partial` 被误当作通过 | 中 | 适配层 fail closed，测试固定该分支 |
| CI 全量评审带来 token 成本和重复评论 | 中 | 先手动触发，加去重包装，限项目范围 |
| npm wrapper 自动升级 | 中 | 使用静态二进制，或设 `OCR_NO_UPDATE=1` |
| 项目迭代快，JSON 形态可能变化 | 中 | 固定版本，升级前跑适配层契约测试 |
| 插件与 MCP 引入额外数据出口 | 中 | 内网只启用 CLI，不配置 MCP 和三方插件 |

## 8. 资料来源

- 项目主页与 README：https://github.com/alibaba/open-code-review
- 中文 README：https://github.com/alibaba/open-code-review/blob/main/docs/i18n/README.zh-CN.md
- 安装：https://github.com/alibaba/open-code-review/blob/main/pages/src/content/docs/en/installation.md
- 配置与 provider：https://github.com/alibaba/open-code-review/blob/main/pages/src/content/docs/en/configuration.md
- 架构：https://github.com/alibaba/open-code-review/blob/main/pages/src/content/docs/en/architecture.md
- 规则：https://github.com/alibaba/open-code-review/blob/main/pages/src/content/docs/en/review-rules.md
- CLI 与 JSON 输出：https://github.com/alibaba/open-code-review/blob/main/pages/src/content/docs/en/cli-reference.md
- CI/CD 与 GitLab 配方：https://github.com/alibaba/open-code-review/blob/main/pages/src/content/docs/en/integrations/ci.md
- 委托模式：https://github.com/alibaba/open-code-review/blob/main/pages/src/content/docs/en/integrations/delegate.md
- OpenCode 插件：https://github.com/alibaba/open-code-review/blob/main/plugins/open-code-review/opencode/README.md
- 遥测：https://github.com/alibaba/open-code-review/blob/main/pages/src/content/docs/en/telemetry.md
- FAQ：https://github.com/alibaba/open-code-review/blob/main/pages/src/content/docs/en/faq.md
- Git 调用源码：https://github.com/alibaba/open-code-review/blob/main/internal/diff/git.go
- 本地基础规格：`docs/gitlab-issue-spec/gitlab-issue-automation-spec.md`
- 本地审核门规格：`docs/gitlab-issue-spec/gitlab-issue-review-gate-and-panel-spec.md`
- 本地模块现状：`packages/web/server/lib/gitlab-issues/DOCUMENTATION.md`
- 内网部署说明：`docs/OpenChamber内网部署说明.md`
