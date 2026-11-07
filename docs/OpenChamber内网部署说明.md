# OpenChamber 内网部署说明

适用范围：OpenChamber Web 端（`packages/web` + `packages/ui` + `packages/sdk`），部署在完全隔离的内网：私有镜像源、自建 GitLab、无外网出口。

本文是《OpenChamber内网迁移分析与改造方案-复核修正版v2》的落地说明，覆盖三件事：这次改了什么代码、内网怎么部署、怎么验收和排障。

---

## 1. 先看结论

内网版 = **改版产物** + **一个 `policy.json`** + **一套环境变量** + **私有插件仓库** + **内网 MCP 服务**。

源码只改了三处，全部通过 `policy.json` 的可选键控制，**未配置时行为与上游完全一致**：

| 能力 | 策略键 | 状态 |
|---|---|---|
| 插件/技能安装放行内网 Git | `allowedInsecureGitOrigins`（复用既有键） | 新增消费点 |
| 模型元数据改读内网地址 | `modelsDevUrl` | 新键 |
| 技能目录换成内网仓库 | `skillsCatalogSources` | 新键 |

其余外网依赖（镜像源、OpenCode 安装、隧道、推送等）都是配置问题，见第 5 节。

---

## 2. 方案复核结果

用 codegraph 对方案逐条回到源码核对。方案的主要结论成立：

- 策略 schema 没有 `.strict()`，未知键被 zod 静默剥离（`enterprise-mode.js` 的 `policyFileSchema`）。
- 一个新键要过五处：schema、`parsePolicyFile` 解构、`parsePolicyFile` 返回、`readEnterprisePolicy` 的 invalid 早返回、`readEnterprisePolicy` 的正常返回。
- `isPublicHostname` 会拒绝 `localhost`、`.local`、`.internal`、私网与链路本地地址（`guests/clone.js`）。
- 模型元数据常量有硬编码；技能目录是模块级常量数组。
- `system-ca.js` 依赖 `tls.getCACertificates`，Bun 下 catch 后返回 false，即 no-op。
- Dockerfile 基础镜像是 `oven/bun:1.4.4`，入口是 `bun packages/web/bin/cli.js`。
- 策略的 `opencodeBinary` 会同时关闭 v2 自动安装与自动升级。

实现时发现方案有四处需要修正，已按下面的方式处理：

1. **`allowedInsecureGitOrigins` 只收 http 的精确 origin，覆盖不到内网 HTTPS GitLab。** 方案 4.1 说"命中白名单时允许私网解析、允许 http"，但该键的校验（`enterprise-mode.js`）只接受 `http:` origin。而 `isPublicHostname` 同样会拒绝 `https://gitlab.corp.internal`。如果照字面只放行精确 origin，内网 HTTPS GitLab 的插件仍然装不上。**处理：** 安装路径按"主机"信任——列表里出现的主机，HTTPS/SSH 任意端口可用，HTTP 只认列表里写明的精确 origin。
2. **模型元数据不止 `index.js` 一处常量。** `model-discovery.js` 调用 `getModelsMetadata()` 时不传 url，只改 `index.js` 的常量不够。**处理：** 让 `models-metadata.js` 自己读策略，路由和默认值都经过它。
3. **客户端回退用响应头判断，不靠策略加载时序。** 浏览器端 `useConfigStore.ts` 在代理失败时直连 models.dev。策略可能还没加载完，按策略判断会有时序窗口。**处理：** 服务端在地址被固定时给代理响应加头 `X-OpenChamber-Models-Source: pinned`，客户端看到就不再回退。
4. **`sourceType: 'gitlab'` 没有必要。** 下游没有任何服务端代码读 `sourceType`，只有 UI 的类型声明。**处理：** 自定义目录统一标 `'git'`，UI 类型放宽为 `'github' | 'git'`。

另外两点补充，方案里没有写：

- 插件**更新检查**（`guests/updates.js`）与安装共用 `prepareGuestGitNetwork`，所以放行对更新同样生效。
- 使用**托管 HTTPS Git 身份**（`skills-catalog/git.js` 里 `GIT_ALLOW_PROTOCOL=https`）的技能来源仍然只能是 HTTPS。纯 HTTP 内网 GitLab 请用系统 Git 身份。

---

## 3. 代码改动清单

| 文件 | 改动 |
|---|---|
| `packages/web/server/lib/enterprise-mode.js` / `.d.ts` | 新增 `modelsDevUrl`、`skillsCatalogSources`（五处同步）；导出 `readPinnedModelsDevUrl()` |
| `packages/web/server/lib/guests/clone.js` | 新增 `installTrust`、`isInstallHostname`、`isInstallableUrl`、`isInstallableZipUrl`；`publicAddressesOf`、`gitNetworkArgs`、`parseGitInstallUrl`、`prepareGuestGitNetwork` 接入信任判定；`isHttpsZipUrl` 更名为 `isInstallableZipUrl` |
| `packages/web/server/lib/guests/install.js` | zip 下载支持列表内 http origin；重定向逐跳复核；`requestHttpsPinned` 更名 `requestPinned` |
| `packages/web/server/lib/skills-catalog/source.js` | 列表内的 `http://` 技能源可解析 |
| `packages/web/server/lib/skills-catalog/curated-sources.js` | `skillsCatalogSources` 非空时替换内置目录 |
| `packages/web/server/lib/opencode/models-metadata.js` | 默认 URL 走策略；导出 `resolveModelsDevUrl`、`isModelsDevUrlPinned` |
| `packages/web/server/lib/opencode/openchamber-routes.js` | 路由用策略地址；固定时加 `X-OpenChamber-Models-Source` 头 |
| `packages/ui/src/stores/useConfigStore.ts` | 看到 pinned 头后不再直连 models.dev |
| `packages/ui/src/lib/guests/install.ts` | 安装输入框放行 `http://`，由服务端判定 |
| `packages/ui/src/lib/api/types.ts` | `SkillsCatalogSourceType` 增加 `'git'` |
| `packages/docs/content/docs/security.mdx`、`zh-cn/security.mdx` | 补充新键说明 |

测试：`guests/internal-hosts.test.js`（新）、`opencode/models-metadata-url.test.js`（新）、`enterprise-mode.test.js`、`curated-sources.test.js`、`source.test.js`、`ui/.../install.test.ts`。

### 安装信任的判定规则

设 `L` = `allowedInsecureGitOrigins`（策略文件；企业模式关闭时再并入 Settings → Git 里用户自己的列表）。

| 目标 | 结果 |
|---|---|
| 公网主机，https / ssh | 允许（与上游一致） |
| `L` 中某主机，https / ssh，任意端口 | 允许，可解析到私网 |
| `L` 中的精确 origin，http | 允许 |
| `L` 之外的内网主机、或 `L` 之外的 http | 拒绝（与上游一致） |
| 回环（`127/8`、`::1`、`localhost`）、链路本地（`169.254/16`、`fe80:`） | **始终拒绝**，写进 `L` 也无效 |
| 解析结果含回环/链路本地 | 拒绝（防 DNS 重绑定） |
| 重定向 | 每一跳重新判定，且连接钉死在刚校验过的地址上 |

---

## 4. 部署步骤

### 4.1 构建（阶段一）

1. **镜像源**：在仓库根新建 `bunfig.toml`（仓库原本没有，**不要提交回上游**）：

   ```toml
   [install]
   registry = "https://nexus.corp.internal/repository/npm-group/"
   ```

   `bun.lock` 里没有 registry URL，换源不需要重生成。镜像必须保留同版本 tarball 与 integrity，5 个 `patchedDependencies`（`@codemirror/view`、`@legendapp/list`、`@tanstack/virtual-core`、`bun-pty`、`happy-dom`）版本必须精确一致。
2. **基础镜像**：把 `oven/bun:1.4.4` 同步进内网 Harbor，并把 `Dockerfile` 的 `FROM` 指向它。运行期**不需要 Node 24**。
3. **OpenCode CLI**：`Dockerfile` 里 `npm install -g @opencode/cli@2.2.3` 前加 `ENV npm_config_registry=<内网 npm 源>`。
4. **cloudflared**：内网版可整段删除 `COPY --from=cloudflare/cloudflared…` 那一行。
5. 不要在构建里 `bunx` 外部包（会改写根 `bun.lock`，`--frozen-lockfile` 会随机失败）。构建在 Linux x64 容器内完成，不做跨平台产物。

以上 1–4 属于部署侧 fork 的改动，刻意不放进主线，这样升级上游只需要重放这几行。

### 4.2 `policy.json`

查找顺序（优先读取用户数据目录，便于普通用户维护；不存在时回退到系统路径）：
1. **用户目录（推荐，无需管理员/root）**：`~/.config/openchamber/policy.json`（Windows 为 `%USERPROFILE%\.config\openchamber\policy.json`；若设置了 `OPENCHAMBER_DATA_DIR` 则为该目录下的 `policy.json`）。
2. **系统目录（可选）**：Linux `/etc/openchamber/policy.json`，Windows `C:\ProgramData\OpenChamber\policy.json`，macOS `/Library/Application Support/OpenChamber/policy.json`。容器里可直接将配置文件挂载到上述任一路径。

内网最小集：

```json
{
  "enterpriseMode": true,
  "allowNetworkAccess": true,
  "organization": "内网平台部",
  "opencodeBinary": "/home/openchamber/.npm-global/bin/opencode",
  "allowedInsecureGitOrigins": [
    "http://gitlab.corp.internal:8080"
  ],
  "allowedExtensions": [
    "https://gitlab.corp.internal/platform/"
  ],
  "modelsDevUrl": "http://nginx.corp.internal/models/api.json",
  "skillsCatalogSources": [
    {
      "id": "corp",
      "label": "公司技能库",
      "source": "https://gitlab.corp.internal/platform/skills.git",
      "defaultSubpath": "skills"
    }
  ]
}
```

逐键说明：

- `allowNetworkAccess`：内网必须显式放开，否则只监听 `127.0.0.1`。同时务必配置 `OPENCHAMBER_UI_PASSWORD` 或 OIDC，并在前面放一层带 IP 白名单的反向代理。
- `opencodeBinary`：必须与镜像里预装的路径一致。设置后同时关闭 v2 自动安装与自动升级两条公网出口。
- `allowedInsecureGitOrigins`：每项是精确 origin，无路径、无凭据。**只有 HTTPS 的内网 GitLab 也要把它的主机写进来**（例如 `http://gitlab.corp.internal`，主机名部分才是信任依据），这是为了让安装路径放行内网域名。已有 TLS 且主机是公网可解析名的，不需要。
- `allowedExtensions`：仓库 URL **前缀**（不是包 id）。带 `service`、`network`、`origins`、`transcript` 能力的插件，在企业模式下只从这些仓库安装；ZIP 恒关；本地文件夹需 `allowLocalExtensions`。
- `modelsDevUrl`：见 4.4。
- `skillsCatalogSources`：见 4.5。

> 策略 schema 不是 strict：**键名拼错会被静默忽略**，功能默默不生效。排障第一步先核对键名。文件整体不是合法 JSON、或某个已知键类型不对时，企业模式保持开启，网络访问关闭，白名单清空，内置技能目录隐藏，日志里有 `[enterprise]` 警告。

### 4.3 环境变量与证书

| 变量 | 用途 |
|---|---|
| `NODE_EXTRA_CA_CERTS` | 指向企业根证书。**默认容器跑 Bun，`system-ca.js` 在 Bun 下是 no-op，系统证书库不会被服务端 fetch 加载**，所以必须设这个变量 |
| `OPENCHAMBER_UI_PASSWORD` | UI 登录口令 |
| `NO_PROXY` | 放行内网域名；git 与服务端 fetch 必须口径一致 |
| `OPENCHAMBER_UPDATE_API_URL` | 更新检查指向内网地址，或不设（失败但静默） |
| `OH_MY_OPENCODE` | **不要设**，否则容器启动时会 `npm install -g` 外网包 |

证书的正确做法：内部 CA 给 GitLab 签证书 → 根证书放进镜像 `/etc/ssl/certs` 并 `update-ca-certificates` → 同时设置 `NODE_EXTRA_CA_CERTS` 指向同一份文件。git、服务端 fetch、OpenCode 三方一次生效。不要用 `GIT_SSL_NO_VERIFY`：它只管 git 子进程，服务端 fetch 仍会失败，表现为"git 通、UI 空"。

### 4.4 模型元数据

在内网 nginx 放一个静态 JSON，格式同 models.dev。UI 实际读取的字段只有 `id`、`name`、`tool_call`、`reasoning`、`temperature`、`attachment`、`structured_output`、`modalities`、`cost`、`limit`、`knowledge`、`release_date`、`last_updated`。最小示例：

```json
{
  "openai-compatible": {
    "id": "openai-compatible",
    "name": "内网模型网关",
    "models": {
      "qwen3-32b": {
        "id": "qwen3-32b",
        "name": "Qwen3 32B",
        "limit": { "context": 131072, "output": 8192 },
        "modalities": { "input": ["text"], "output": ["text"] },
        "cost": { "input": 0, "output": 0 }
      }
    }
  }
}
```

`openai-compatible` 这个 provider id 要与 OpenCode 配置里自定义 provider 的 id 一致，才能对上。元数据只影响展示（上下文长度、价格）与路由提示，缺失时会话照常工作。

### 4.5 技能目录与插件分发

- **技能库**：在内网 GitLab 建一个项目，`skills/` 下每个子目录放一个 `SKILL.md`，然后用 `skillsCatalogSources` 接入。非空时它替换内置的四个 GitHub 目录。
- **私有插件**：放独立 GitLab 仓库，不要放进 `packages/extensions`（那是官方内置白名单，`openchamber-builtin-` 前缀保留）。分发路径是"设置里从 URL 安装 + `allowedExtensions` 白名单"。只声明纯面板、没有上述四种能力的插件可以更自由地安装。
- **给 agent 加内部工具**：插件做不到（`contributes.tools` 只改变已有工具调用的展示，不注册工具）。必须走 **MCP 服务器**，写入 `opencode.json`，插件只做管理面板。

### 4.6 保持关闭的项

| 项 | 做法 |
|---|---|
| 隔离空间（`isolatedSpacesEnabled`） | 保持默认关闭；要开必须先把约 1.6 GB 镜像同步进 Harbor，且需要 Docker |
| 隧道（Cloudflare/ngrok/Tailscale） | 企业模式默认全关 |
| 推送、Linear、集成目录 | 企业模式默认隐藏 |
| 私有中继 | 不启用；要用则 `relayUrl` 钉内网地址 |
| Jev 意图路由 | 无外网则 Auto 路由失效；用 `jev` 钉内网 OpenAI 兼容端点 |
| TTS / STT | 指向内网 OpenAI 兼容语音服务，或启用本地 sherpa-onnx |

---

## 5. 验收清单

**阶段一（能跑）**

- [ ] 断网启动无报错，能登录、建会话、选内网模型。
- [ ] 设置页**没有**"可升级 OpenCode"提示。
- [ ] 对内网仓库执行 git 状态与提交成功。
- [ ] 分别验证两件事（走的是不同的 TLS 路径）：**git clone 成功**；**UI 能列出仓库**。

**阶段二（好用）**

- [ ] 从 URL 安装一个内网插件，三种形态各试一次：`https://gitlab.corp.internal/...git`、`.../x.zip`、（若是纯 HTTP）`http://gitlab.corp.internal:8080/...git`。
- [ ] 安装 `localhost`、`127.0.0.1`、`169.254.169.254` 的地址**必须被拒绝**。
- [ ] 技能目录里只出现公司技能库，能安装一个技能。

**阶段三（收敛）**

- [ ] 模型选择器里能看到上下文长度；浏览器开发者工具里**没有**对 `models.dev` 的请求。
- [ ] 把 `modelsDevUrl` 临时指向一个不存在的地址：服务端报错，浏览器**不**回退直连公网。
- [ ] 拔掉 `policy.json` 后行为回到上游原版（回滚手段）。

回归基线：`enterprise-mode`、`guests/internal-hosts`、`skills-catalog`、`models-metadata-url` 相关测试。

---

## 6. 排障

| 现象 | 先查 |
|---|---|
| 配置的键完全没效果 | 键名拼写（schema 不是 strict，拼错静默失效） |
| 企业模式开着但所有白名单都空 | 看日志 `[enterprise]`，策略文件是否 JSON 非法或类型错误 |
| git 能 clone，UI 却拉不到数据 | `NODE_EXTRA_CA_CERTS` 是否设置（Bun 下系统证书库不生效） |
| 插件 URL 安装提示 invalid-url | 该主机是否写进 `allowedInsecureGitOrigins`；HTTP 是否是**精确** origin（端口要一致） |
| 插件能装但启动被拒（`enterprise-mode`） | 带 service/network 等能力的插件，仓库 URL 是否在 `allowedExtensions` 前缀内 |
| 内网域名解析到 `127.x` / `169.254.x` 被拒 | 设计如此，回环与链路本地始终拒绝；检查内网 DNS |
| 技能目录是空的 | 策略文件整体非法会隐藏所有目录；其次检查 `source` 能否从服务器 clone |
| 使用托管 HTTPS Git 身份后技能克隆失败 | 该路径只允许 HTTPS，纯 HTTP 用系统 Git 身份 |
| 模型没有上下文长度 | `modelsDevUrl` 是否可达、JSON 格式、provider id 是否对应 |

---

## 7. 已知边界与未做事项

- **HTTP 放行与上游立场相反。** 上游对内网明文 HTTP 的定论是"Nginx TLS 反代 + 内部 CA"。把 `allowedInsecureGitOrigins` 扩到安装路径，被上游接受的概率低；`modelsDevUrl`、`skillsCatalogSources` 可独立推上游。TLS 反代始终是兜底路线，且无需此补丁。
- **扩展提供的 source-control 端点**只收 HTTPS 与回环 HTTP，不吃这份名单。内网 GitLab 请用内置 provider 加 origin 白名单。
- **VS Code 运行时未改。** `packages/vscode` 有自己的技能目录解析和一份 models.dev 常量，`modelsDevUrl` 与 `skillsCatalogSources` 在那里不生效；本方案不使用 VS Code，故未处理。只有镜像文件 `packages/vscode/src/settings-registry.json` 加了 `allowedInsecureGitOrigins` 的 scope 条目，与 web 端注册表保持一致。
- **`security.mdx` 的 12 种语言已补齐**（英文、简体中文之外的一次性机翻草稿，按仓库惯例提交上游前建议人工校订）。
- **`bun check` 在 Bun 1.4.2 上不可用**（Bun 1.4.4 才有），本地用 `tsc -b` 与 `vitest` 代替。
- **仓库既有问题，非本次引入：** `packages/ui/src/lib/settings/parsers.ts:123` 有一个 TS2554 类型错误；Windows 下 `guests`、`skills-catalog`、`openchamber-routes` 若干测试因符号链接权限、`NUL` 路径、临时目录而失败，在改动前的基线上同样失败。

## 8. 升级上游的流程

1. 每季度拉上游 tag，先 rebase 本分支的少量独立提交。
2. 跑护栏套件，再跑内网回归清单（登录、会话、Git、插件安装、技能安装、语音、断网启动）。
3. 上游接受某个键后，删除对应本地补丁。
4. 升级 Bun 会改变 guest bundle 压缩输出，需同步重建示例产物（上游 `examples.test.ts` 有断言）。
