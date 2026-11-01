# -*- coding: utf-8 -*-
"""Content: part 1 (cover, review verdict, structure, external dependencies)."""
from build_report import *  # noqa
from build_report import _para, _rich, _run, _set_cell_shading, _set_cell_margins
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.enum.section import WD_SECTION


def build_cover(doc):
    # ---------- cover ----------
    for _ in range(3):
        _para(doc, "", space_after=10)
    _para(doc, "OpenChamber", size=13, bold=True, color=MUTED, space_after=4)
    _para(doc, "内网迁移分析与改造方案", size=30, bold=True, color=ACCENT, space_after=6, line=1.2)
    _para(doc, "复核修正版 v2", size=15, bold=True, color=MUTED, space_after=10, line=1.2)
    _para(doc, "本地仓库  D:\\Code\\openchamber   ·   v2.5.3（上游 d4a5a0e）+ 本地未提交的 Git 放行补丁",
          size=10.5, color=MUTED, space_after=36)

    cover_rows = [
        ("分析对象", "OpenChamber Web 端（packages/web + packages/ui + packages/sdk），对外仅暴露纯 Web 能力"),
        ("目标环境", "完全隔离内网：私有镜像源、自建 GitLab、无外网出口"),
        ("核心诉求", "插件化优先、最小改源码、与上游主仓可持续合并"),
        ("复核口径", "对上一版全部结论逐条回到源码核对；codegraph 索引 5,189 文件 / 106,055 符号，行号与引用面均取自当前工作树"),
        ("本次改动", "修正 13 处、补充 5 项遗漏依赖、重排外网依赖表；核心结论由「四处阻塞 + 四个 PR」收敛为「三处源码阻塞 + 三个 PR」，另有两项部署侧必须处理"),
        ("报告日期", "2026-10-31"),
    ]
    t = doc.add_table(rows=0, cols=2)
    t.autofit = False
    for k, v in cover_rows:
        cells = t.add_row().cells
        cells[0].width = Cm(3.2)
        cells[1].width = Cm(12.4)
        _set_cell_margins(cells[0], top=90, bottom=90)
        _set_cell_margins(cells[1], top=90, bottom=90)
        p0 = cells[0].paragraphs[0]
        p0.paragraph_format.line_spacing = 1.35
        _run(p0, k, size=9.5, bold=True, color=MUTED)
        p1 = cells[1].paragraphs[0]
        p1.paragraph_format.line_spacing = 1.35
        _run(p1, v, size=10)
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def build_part1(doc):
    # ---------- 0. 复核结论 ----------
    heading(doc, "复核结论：上一版哪些站得住，哪些必须改", 1, "0")
    _rich(doc, [
        ("这份文档是对上一版的复核，不是重写。上一版的方向（配置优先、插件优先、源码改动收敛成可上游的键）成立，"
         "且有三条判断经复核仍然准确：policy schema 未用 .strict()、未知键被 zod 静默剥离；"
         "isPublicHostname 确实在内网域名上 fail-closed；内置技能目录确实是四个 GitHub 仓库的模块级常量。"
         "问题集中在", {}),
        ("「部署形态的事实」与「插件能力的边界」两类", {"bold": True}),
        ("：上一版把运行时假设成了 Node 24（实际容器跑 Bun），并对插件能做的事情做了过度保守的描述。"
         "下表是全部修正项，每条都能回到文件与行号。", {}),
    ])

    heading(doc, "0.1 修正清单", 2)
    table(doc,
          ["上一版说法", "复核结果", "证据", "对方案的影响"],
          [
              ["runtime 阶段仅需 node 24，不需要 bun",
               "错。runtime 基镜像是 oven/bun:1.4.4，入口脚本执行 bun packages/web/bin/cli.js；apt 装的 nodejs 是发行版包，不是 24",
               "Dockerfile:26,80 · scripts/docker-entrypoint.sh 末段",
               "阶段一的镜像同步清单要改；「用 Node 24 跑」只是一个可选项（bin/cli.js 在无 bun 时才降级到 node），不是默认"],
              ["system-ca 是既有能力，装根证书即可，无需改代码",
               "半错。applySystemCertificates 用 tls.getCACertificates，Bun 没有该 API，函数体内 catch 后返回 false——在默认容器里是 no-op",
               "packages/web/server/lib/system-ca.js:7-38",
               "自签 CA 必须走 NODE_EXTRA_CA_CERTS，或显式改用 Node 24 运行；否则表现为「git 通、UI 拉不到数据」"],
              ["models.dev 只有两处常量，改动约 40 行",
               "错。四处常量，且浏览器端还会直连公网回退",
               "server/index.js:211 · opencode/models-metadata.js:1 · ui/stores/useConfigStore.ts:38,826 · vscode/src/bridge-fs-helpers-runtime.ts:531",
               "4.2 的改动面翻倍；漏掉客户端那处，服务端改完仍会多等 8 秒超时"],
              ["插件只能在右侧栏、状态区、文件编辑器挂载，不能新增一级导航",
               "错（过度保守）。插件拥有 rail 图标、全屏 page、status section、文件编辑器、docked surface、popover 六种位置",
               "sdk/DOCUMENTATION.md:31-55 · ui/components/layout/GuestRailIcon.tsx",
               "判定线要重画：可放入插件的需求比上一版认为的多"],
              ["SDK 支持声明 tools 贡献，agent 可直接调用",
               "错。contributes.tools 只决定「已存在的工具调用在聊天里长什么样」，不注册工具",
               "sdk/DOCUMENTATION.md:55",
               "「内网知识库检索」不能靠插件给 agent 加工具，必须走 MCP 服务器；插件只能做管理面板"],
              ["新增一个 policy 键，冲突通常只在 schema 与 readEnterprisePolicy 两处",
               "偏少。一个键要过 5 处：schema、parse 解构、parse 返回、invalid 早返回、消费点",
               "enterprise-mode.js:134-182,239-293",
               "漏掉 invalid 早返回会把 undefined 传给消费方——策略文件写坏时行为不可预期，正是 fail-closed 设计要避免的"],
              ["Git 放行补丁约 41 个文件",
               "实测 31 个文件（12 语文档、10 个服务端文件、其余为设置注册表/测试/文档）",
               "grep -rl allowedInsecureGitOrigins packages → 31",
               "rebase 成本下调，但仍是本分支最大携带物"],
              ["新增 allowedPrivateOrigins 键，与既有 allowedInsecureGitOrigins 同构",
               "不必要。既有键已在树内、已有 6 个服务端消费点，安装路径（clone.js / install.js）才是缺口",
               "enterprise-mode.js:336 · codegraph callers = 13",
               "合并成一个键：PR 从 4 个降到 3 个，心智模型只留一套"],
              ["技能安装走 https 无公网校验，内网域名即可 → B",
               "只对 https/ssh 成立。parseSkillRepoBase 只认 https:// 与 git@，纯 http 内网 GitLab 直接 invalidSource",
               "skills-catalog/source.js:47-80",
               "HTTP-only 内网下，技能安装与插件安装是同一个洞，归入 4.1"],
              ["内网插件安装补丁约 60 行",
               "偏少。除私网判定还要处理 https-only（isHttpsGitUrl）与 zip 的 pinned https 下载",
               "guests/clone.js:95-102 · guests/install.js:160-205",
               "HTTP-only 内网连 .zip 安装也不通；补丁必须一次覆盖 git/zip 两条路径"],
              ["插件可放独立仓库，用「从 URL 安装」或预置文件夹分发",
               "Enterprise 模式下带 service/network 能力的插件只认 allowedExtensions 里的 Git 仓库；ZIP 恒关；文件夹要 allowLocalExtensions",
               "guests/enterprise.js:13-20,67-68",
               "分发方式要按能力分类：无能力的纯面板可以放开，带 service 的必须走内网 Git + 白名单"],
              ["web 包单独发布需把根依赖合并进 web 包",
               "错。web / ui 各自声明了 express、zod、react；根只是工作区重复声明",
               "packages/web/package.json · packages/ui/package.json",
               "抽包发布不需要改依赖结构，这条风险可以删掉"],
              ["外网依赖共 23 项，A+B 占 78%",
               "补 5 项漏项后为 27 项（OpenCode v2 自安装、扩展市场外链、隔离空间镜像、oh-my-opencode、provider logo）",
               "v2-install.js:10,64 · apps/ui ExtensionsPage.tsx:80 · spaces/DOCUMENTATION.md",
               "阶段一的验收清单要加「供应链锁定」与「隔离空间关闭」两项"],
          ],
          widths=[3.6, 5.0, 4.2, 3.0], font_size=7.6)

    heading(doc, "0.2 复核后仍然成立的三条判断", 2)
    bullets(doc, [
        ("policy 文件不是 .strict()：未知键被静默剥离。好处是新键可以先于代码部署（旧版本读到新键只忽略），"
         "代价是键名拼错同样静默失效——内网排障第一件事是核对键名，而不是怀疑代码。"),
        ("内网安装被两道闸挡住：私网判定（isPublicHostname）与协议判定（isHttpsGitUrl 只收 https）。"
         "上一版只写了前者，实际上仅放行私网而不放行 http，内网 GitLab 仍然装不上。"),
        ("可合并性的关键仍是「定制只加在配置面」。两个新键（modelsDevUrl、skillsCatalogSources）+ 一个扩展既有键"
         "（allowedInsecureGitOrigins 扩到安装路径），全部 optional，未配置时行为与上游逐字节一致。"),
    ])

    heading(doc, "0.3 修正后的一句话方案", 2)
    callout(doc, "一句话方案", [
        ("内网版 = 改版产物（含 Git 放行补丁）+ 一个 policy.json + 一套环境变量 + 两个私有插件包（内网技能目录、内网模型元数据）+ 一个内网 MCP 服务器。",
         {"bold": True, "size": 10}),
        ("源码改动收敛为三个键：扩展 allowedInsecureGitOrigins 到安装路径（本分支已有基础）、新增 modelsDevUrl、新增 skillsCatalogSources；"
         "每个键约 200–400 行（含测试与 12 语文档，按本仓库惯例）。OpenCode 供应链用 policy 锁死二进制即可，不需要改代码。", {"size": 9.5}),
    ])

    # ---------- 1. 项目结构 ----------
    heading(doc, "项目结构：Web 端能力到底在哪", 1, "1")
    _para(doc, "Web 端任务实际只涉及三个包，其余（electron / mobile / vscode）可以整包不打包、不发布。", first_line=0)
    table(doc,
          ["包", "职责", "内网是否必需", "说明"],
          [
              ["packages/web", "HTTP 服务、OpenCode 生命周期、Git/源码托管、终端、通知、插件宿主", "必需", "全部服务端逻辑；入口 bin/cli.js 支持 bun 与 node 两种运行时"],
              ["packages/ui", "共享 React UI、状态、i18n（12 种语言）、设置项注册表", "必需", "与 web 一起构建出静态资源"],
              ["packages/sdk", "插件契约（manifest 解析、iframe 协议、connectHost、ui 绘制套件）", "必需", "宿主与插件唯一共同的依赖，服务端运行时也要加载 dist/"],
              ["packages/extensions", "官方内置插件目录（registry.json 当前为空数组）", "可选", "命名空间 openchamber-builtin- 保留；私有插件不放这里"],
              ["packages/electron / mobile / vscode", "桌面壳、Capacitor 移动壳、VS Code 扩展", "不需要", "内网 Web 化后完全排除，构建时间可省一半"],
          ],
          widths=[3.2, 5.4, 1.9, 5.3])

    _rich(doc, [("构建与运行链路（复核后的准确版本）：", {"bold": True}),
                ("根 package.json 的 build 是 bun 工作区顺序构建 + mobile 资源；build:web 由 vite 直接输出静态文件。"
                 "Dockerfile 三段式：deps（bun install --frozen-lockfile --ignore-scripts）→ builder（先单独构建 sdk，再 build:web）"
                 "→ runtime（oven/bun:1.4.4，apt 装 git/openssh-client/npm/python3，npm 全局装 @opencode/cli@2.2.3，"
                 "并拷入 cloudflared 二进制）。入口脚本最终执行 bun packages/web/bin/cli.js。", {})])

    callout(doc, "两个容易踩的坑（上一版此处有误，已更正）", [
        ("① 运行时是 Bun，不是 Node 24。 bin/cli.js 的 getPreferredServerRuntime 只在检测不到 bun 时才降级到 node；"
         "容器里 bun 一定存在，所以永远走 bun。凡是依赖 Node 专有 API 的能力（系统证书库是典型）在默认部署下都不生效。",
         {"size": 9.5}),
        ("② 依赖声明是「各包自足 + 根重复」。 react/react-dom 在 ui 包、express/zod 在 web 与 ui 包各自声明，"
         "根 package.json 再声明一遍供工作区提升。把 @openchamber/web 单独抽出来发布不需要合并根依赖。", {"size": 9.5}),
    ])

    _rich(doc, [("上一版未提及、但内网必须知道的一个子系统：", {"bold": True}),
                ("packages/web/server/lib/spaces 是「隔离空间」——在容器里跑 agent、结束后把改动 apply 回仓库。"
                 "它由 settings.json 的 isolatedSpacesEnabled 控制、默认关闭，开启需要 Docker 与约 1.6 GB 镜像。"
                 "内网默认保持关闭即可，功能完全不加载（不探测运行时、不执行 docker）；若要启用，镜像必须先同步进内网 Harbor，"
                 "并注意其 gatekeeper 会拦截私网与 cloud metadata 地址。", {})])

    # ---------- 2. 外网依赖全景 ----------
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
    heading(doc, "外网依赖全景：逐项定级与处置", 1, "2")
    _para(doc,
           "下表按「内网环境下的实际表现」而非「代码里有没有 URL」定级。分级含义：A 零改动；B 配置或策略即可；"
           "C 建议用插件（SDK guest）实现；D 建议打补丁并推上游；E 必须改源码。上一版 23 项，本次补 5 项后共 27 项。",
           first_line=0, space_after=8)

    rows = [
        ["依赖 / 触点", "代码位置", "内网表现", "分级", "处置要点"],
        ["npm 依赖安装", "bun.lock · bun install", "仓库内没有 bunfig.toml / .npmrc，默认走 registry.npmjs.org", "B",
         "新建 bunfig.toml 指向私有源。好消息：bun.lock 里 0 处 registry URL，换源不需要重生成 lock"],
        ["patchedDependencies 5 个补丁", "根 package.json · bun-patches/", "按精确版本匹配，镜像换版本即失效", "B",
         "镜像必须保留同版本 tarball 与 integrity；5 个包：@codemirror/view、@legendapp/list、@tanstack/virtual-core、bun-pty、happy-dom"],
        ["OpenCode CLI 预装", "Dockerfile:56", "npm install -g @opencode/cli@2.2.3 直连公网", "B",
         "构建期改私有源；运行期不需要联网"],
        ["OpenCode v2 自动安装 / 升级", "lib/opencode/v2-install.js", "拉 opencode.ai/v2/install 与 registry.npmjs.org，且校验 tarball 必须来自 npmjs", "B",
         "policy 的 opencodeBinary 会令 canInstall=false、升级路由返回 409「由管理员管理」，无需改代码"],
        ["更新检查", "package-manager.js:27", "失败但静默，不阻断", "B",
         "OPENCHAMBER_UPDATE_API_URL 指向内网地址，或保持默认让它失败"],
        ["模型目录元数据", "models-metadata.js:1 · server/index.js:211 · useConfigStore.ts:38,826", "服务端 8 秒超时后为空；浏览器端再直连公网一次", "D",
         "新增 policy 键 modelsDevUrl，四处常量统一；否则即使服务端改好，客户端仍会多等一轮超时"],
        ["Provider logo（models.dev/logos）", "ui/hooks/useProviderLogo.ts:78", "未知 provider 无图标，请求静默失败", "B",
         "常用 provider 已内置 SVG；内网自建 provider 只是没图标，不影响功能"],
        ["隧道（Cloudflare / ngrok / Tailscale）", "tunnels/", "内网无法建立，页面空转", "B",
         "Enterprise 模式默认全关；设置页自动隐藏"],
        ["私有中继（跨设备配对）", "relay/service.js:20", "连不上，移动端配对不可用", "B",
         "Web 内网部署可不启用；要有则 policy.relayUrl 钉内网地址"],
        ["推送通知中继 / APNs", "notifications/apns-runtime.js:25", "Web Push 订阅失败", "B",
         "关闭推送，改用内网 IM 通道（插件 notifications 服务角色）"],
        ["Linear 认证中转", "linear/auth.js:8", "OAuth 失败", "B",
         "Enterprise 已隐藏集成入口，无需改逻辑"],
        ["Jev 意图分类", "routing/defaults.js:40", "无外网则 Auto 路由失效，其余正常", "B",
         "policy.jev 钉内网 OpenAI 兼容端点（如 vLLM）"],
        ["Web 字体 CDN（jsdelivr）", "ui/src/lib/fontLoader.ts", "字体回退系统字体，无报错", "B",
         "Enterprise 模式已内置回退（useFontPreferences），无需插件"],
        ["工具市场 / 集成目录", "ui/lib/integrations-catalog/registry.ts", "内置静态表，仅外链失效", "B",
         "Enterprise 已隐藏；可整表替换为内网条目"],
        ["扩展市场外链", "ui/components/sections/extensions/ExtensionsPage.tsx:80", "点「浏览社区」打开公网页面", "B",
         "Enterprise 下由管理员从内网 Git 安装；外链可后续替换为内网地址"],
        ["JSON Schema 外链（$schema）", "opencode 配置写入（含 spaces/space-opencode.js:62）", "编辑器无补全，运行不受影响", "C",
         "内网放 schema 副本，改写 $schema 指向"],
        ["隔离空间镜像", "spaces/（默认关闭）", "开启时拉 ~1.6 GB 镜像 + 需要 Docker", "B",
         "内网保持关闭；要启用则镜像先同步进 Harbor"],
        ["oh-my-opencode 运行时安装", "docker-entrypoint.sh（OH_MY_OPENCODE=true）", "容器启动时 npm install -g，内网必失败", "B",
         "生产镜像不设该变量；需要则预装进镜像"],
        ["插件 / 技能目录（GitHub 4 仓库）", "skills-catalog/curated-sources.js:3", "克隆失败，目录为空", "D",
         "模块级常量，无配置入口；新增 policy 键 skillsCatalogSources"],
        ["插件安装（URL / Git / ZIP）", "guests/clone.js:19 · guests/install.js:160", "私网域名被拒；协议只收 https，ZIP 下载也钉 https", "E",
         "把安装路径纳入 allowedInsecureGitOrigins（与 Git 传输共用一个键）"],
        ["技能安装（Git 仓库）", "skills-catalog/source.js:47", "https/ssh 可直接用（无公网校验）；http 直接解析失败", "B",
         "内网 GitLab 有 TLS → 无需改动；纯 HTTP → 与上一行同一个补丁，归入 4.1"],
        ["git clone / push", "git/network-operations.js · credential-resolver.js", "继承进程 env，走系统 git 配置", "A",
         "无需改代码；.gitconfig、SSH、CA 在内网侧统一配置"],
        ["模型 API 调用", "经 OpenCode 转发", "取决于内网模型网关", "B",
         "OpenCode 支持 OpenAI 兼容自定义 provider，指向 vLLM / 内网网关"],
        ["MCP 服务器", "OpenCode 配置", "取决于内网 MCP 服务", "B",
         "写入 opencode.json；远程 MCP 走内网地址。这也是给 agent 加内部工具的唯一正确方式"],
        ["TTS / STT", "tts/ · dictation/", "默认 127.0.0.1:8880", "B",
         "指向内网 OpenAI 兼容语音服务；或启用本地 sherpa-onnx"],
        ["Claude Code 订阅认证", "claude-cli-auth.js", "需公网浏览器回调", "B",
         "不启用该 provider 即无影响；Enterprise 已隐藏其安装卡片"],
        ["Docker 基础镜像", "Dockerfile · oven/bun:1.4.4 + cloudflared", "docker hub / ghcr 不可拉取", "B",
         "镜像同步到内网 Harbor；cloudflared 在内网版中可整段删除"],
    ]
    table(doc,
          ["依赖 / 触点", "代码位置", "内网表现", "分级", "处置要点"],
          rows[1:],
          widths=[2.9, 3.6, 3.4, 1.1, 4.7],
          tag_col=3, font_size=7.8, aligns=["left", "left", "left", "center", "left"])

    _rich(doc, [("统计：", {"bold": True}),
                ("27 项中，A 1 项、B 22 项、C 1 项、D 2 项、E 1 项。即 23 项（85%）零代码或仅配置；"
                 "真正要碰源码的是 3 处：插件/技能安装放行、模型元数据源、技能目录注入。"
                 "其中安装放行所需要的 Git 传输侧能力已在本分支以未提交补丁落地。", {"bold": True})])
    return doc
