# -*- coding: utf-8 -*-
"""Content: part 2 (plugin vs source boundary, the source changes)."""
from build_report import *  # noqa
from build_report import _para, _rich, _run, _set_cell_shading, _set_cell_margins
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK


def build_part2(doc):
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    # ---------- 3. 判定边界 ----------
    heading(doc, "插件还是改源码：一条判定线（本版重画）", 1, "3")
    _rich(doc, [
        ("插件（SDK guest）的运行时是一个 sandbox iframe + 一个可选的本地服务进程（loopback，无沙箱），"
         "通过 postMessage 与宿主通信。它能读项目与会话、能发起会话与提示词、能读写自己的存储、能请求宿主代发 HTTP、"
         "能声明 skills 之外的命令与动作。", {}),
    ])
    _rich(doc, [
        ("上一版说它「只能在右侧栏、状态区、文件编辑器挂载」，这与代码不符。实测可用的宿主位置有六种：", {"bold": True}),
    ])
    bullets(doc, [
        ("rail 图标面板：contributes.panel.entry，图标出现在上下文面板的 rail（GuestRailIcon / ContextPanelRail），与「聊天、文件、Diff」同级；"),
        ("全屏页面：contributes.page，从侧边菜单打开，是独立的一级页面，与会话互斥；"),
        ("状态区：contributes.statusSection，挂在 Work Status 面板内；也可以只声明 source，由宿主自己画（16 行以内的表格、图表、开关）；"),
        ("文件编辑器：contributes.fileEditors，按文件名 glob 接管某种文件的编辑；"),
        ("停靠画布：contributes.service.surface，把页面 dock 到某个面板的一侧，直接收服务端渲染的帧；"),
        ("浮层：openPopover，可挂在 DOM 锚点上做轻量交互。"),
    ])
    _rich(doc, [
        ("它仍然拿不到三样东西：", {"bold": True}),
        ("① 不能改变宿主既有路由的接受/拒绝判定（例如让 install 路由接受内网地址）；"
         "② 不能替换宿主后端模块的取数来源（例如 models-metadata）；"
         "③ 不能改写既有页面的布局与主导航分组，也不能给 agent 注册新工具——contributes.tools 只决定"
         "「已经存在的工具调用在聊天里长什么样」，不产生可调用能力。", {}),
    ])

    callout(doc, "判定线（重画后）", [
        ("新增一个界面、新增一类展示、新增一个外部系统对接、把内部能力包成 agent 工具 → 插件（工具走 MCP，界面走 guest）。",
         {"bold": True}),
        ("改变「某个请求是否被接受」、改变「某个接口从哪取数」、改变「某个常量的值」 → 源码。", {"bold": True}),
        ("这条线要这么画才有用：插件是运行时可装卸、与上游版本无关的；源码补丁必须随上游演进。"
         "把需求往左侧推，是降低长期维护成本的唯一办法。", {"size": 9.5, "color": MUTED}),
    ])

    heading(doc, "3.1 适合用插件实现的（C 类）", 2)
    table(doc,
          ["能力", "插件形态", "为什么插件够用", "工作量"],
          [
              ["内网技能市场", "panel + service；服务端读内网 GitLab 仓库，前端展示与安装",
               "技能本质是目录里放 SKILL.md，宿主已支持从任意本地路径加载；插件只负责发现与落盘", "中，5–8 人日"],
              ["内网模型目录展示", "statusSection（source 形态，宿主自画表格）或 panel",
               "纯读展示，不动宿主模型调用链；source 形态连 iframe 都不需要", "小，2–3 人日"],
              ["内网集成 / 工具入口", "panel 或 statusSection；列出内网 MCP、内部系统",
               "官方集成目录在 Enterprise 下本就隐藏，插件是替代入口", "小，2 人日"],
              ["内部知识库检索（agent 可用）", "MCP 服务器（必需）+ 可选插件面板做管理",
               "SDK 不提供工具注册；能被 agent 调用的只有 MCP / OpenCode 侧声明。插件负责配置与结果展示", "中，5 人日"],
              ["代码评审 / 流水线看板", "source-control 服务角色，或独立 panel + service",
               "SDK 已定义 source-control 契约（含 change-based 字段：revisions、submit requirements）", "大，10+ 人日，按需"],
              ["内网 IM 通知通道", "notifications 服务角色",
               "标准服务角色；Enterprise 下宿主只给通用标题、不带正文与目录", "中，3–5 人日"],
              ["会话事件回调（推进度、发评论）", "sessionEvents 服务角色（turn-finished / permission-asked 等）",
               "宿主按事件推送，不需要开窗口；content:true 才要 transcript 授权", "小，2 人日"],
          ],
          widths=[2.9, 4.0, 6.3, 2.6], font_size=8.2)

    heading(doc, "3.2 只能用源码改的（D / E 类）", 2)
    _para(doc, "三处的共同特征：它们决定「宿主接不接受某个输入」「宿主从哪里取数据」，属于边界判定与依赖注入，"
               "插件架构在原理上无法介入。", first_line=0, space_after=6)
    table(doc,
          ["改造点", "为什么插件做不到", "改动性质", "行数估计"],
          [
              ["插件 / 技能安装放行", "私网判定与 https-only 都在服务端安装前校验；这是安全边界，必须在此判定",
               "扩展既有 policy 键到安装路径 + 协议判定分支", "约 90–120 行"],
              ["模型元数据源可替换", "四处常量 + 客户端回退，被配额、路由、UI 多处复用",
               "常量改为策略解析（含客户端注入）", "约 80–120 行"],
              ["技能目录可注入", "curated-sources.js 是模块级常量数组，无读取渠道",
               "改为 policy 注入 + 保留默认值", "约 50 行"],
          ],
          widths=[3.4, 6.0, 4.5, 1.9], font_size=8.4)

    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    # ---------- 4. 改造点 ----------
    heading(doc, "关键改造点设计", 1, "4")
    _para(doc, "每一处都遵循同一原则：只在既有结构上「加一个可选键」或「替换一个常量」，不改默认行为、不改既有分支语义。"
               "这样上游即使重构周边代码，我们的改动也只是几行孤立代码，冲突可手工解决。", first_line=0)

    heading(doc, "4.1 Git 主机放行：扩展现有键，不新开键", 2)
    _rich(doc, [("现状。", {"bold": True}),
                ("安装侧有两道闸：guests/clone.js 的 isPublicHostname 拒绝 localhost、*.local、*.internal、"
                 "10/8、192.168/16、172.16/12、100.64/10、169.254/16 及解析到私网的域名；"
                 "isHttpsGitUrl 只接受 https，因此纯 HTTP 的内网 GitLab 连协议这一关都过不去。"
                 "ZIP 安装同样走 https，并把连接钉死在校验过的地址上（install.js 的 requestHttpsPinned），HTTP 一样不可用。"
                 "这是一条有意的安全设计：安装动作由服务端自己发起，不校验就能把请求打到本机或内网。", {})])
    _rich(doc, [("关键判断。", {"bold": True}),
                ("本分支已经落地了 allowedInsecureGitOrigins（policy 键 + 用户设置，6 个服务端消费点，codegraph 统计 13 处引用）。"
                 "它的语义正是「精确 http origin 白名单」，而安装侧缺的也正是同一件事。因此不要新开 allowedPrivateOrigins，"
                 "而是把这个键的判定复用到 guests/clone.js 与 guests/install.js——一个概念、一套语义、一处维护。", {})])
    _rich(doc, [("方案。", {"bold": True}),
                ("把「是否放行」收敛成一个函数（输入：URL 与请求方向），供三处共用：Git 传输（既有）、插件 git/zip 安装（新增）、"
                 "技能 git 克隆（既有 normalizeGitRemoteEndpoint 已覆盖）。命中白名单时：允许私网解析、允许 http 协议、"
                 "仍然禁止 loopback 与链路本地地址；未配置时行为与上游完全一致。", {})])

    callout(doc, "设计要点：为什么必须是精确 origin 列表", [
        ("一个 allowPrivateNetwork: true 的布尔开关会让放行变成全有或全无，而内网里往往既有可信 GitLab，也有不该被访问的运维网段。",
         {"size": 9.5}),
        ("精确 origin 与既有键完全同构：只认 http://host[:port] 形态、不带凭据/路径/查询、格式错即视为未设置（fail-closed）。",
         {"size": 9.5}),
        ("失败关闭：策略文件损坏时列表为空，恢复为「一律拒绝私网」，不会因配置错误放大风险。注意 readEnterprisePolicy 的 "
         "invalid 早返回分支也要列出该键，否则消费方拿到 undefined。", {"size": 9.5}),
        ("重定向与 DNS 复核不能被白名单跳过：放行 origin 后，一个 302 就能把安装请求带到任意内网网段。"
         "现状的「解析 IP 再连接」不能丢——放行只是把允许的地址集合从「公网」换成「白名单 origin 解析出的地址」。"
         "这是上游 review 必问的 SSRF 面，必须在设计文档里写明。", {"size": 9.5}),
        ("协议放行要有独立开关的语义：origin 里的 scheme 就是开关，不需要再引入 allowInsecureProtocol 之类的第二个键。",
         {"size": 9.5}),
    ])

    _rich(doc, [("policy.json 片段（内网最小集）：", {"bold": True})])
    mono(doc, [
        '{',
        '  "enterpriseMode": true,',
        '  "allowNetworkAccess": true,',
        '  "organization": "内网平台部",',
        '  "opencodeBinary": "/home/openchamber/.npm-global/bin/opencode",',
        '  "allowedInsecureGitOrigins": [',
        '    "http://gitlab.corp.internal:8080"',
        '  ],',
        '  "allowedExtensions": ["https://gitlab.corp.internal/platform/"]',
        '}',
    ])
    _para(doc, "注意 allowedExtensions 是「仓库 URL 前缀」，不是包 id：带 service / network / origins / transcript 能力的插件，"
               "在 Enterprise 下只从这些仓库装载，ZIP 恒关，本地文件夹要另开 allowLocalExtensions。"
               "所以内网插件的正规分发路径是「内网 Git 仓库 + 白名单」，这条与 4.1 是绑定关系。",
          size=9.5, color=MUTED, space_after=8)

    heading(doc, "4.2 模型元数据源可替换", 2)
    _rich(doc, [("现状（上一版只找到两处，实际四处 + 一处客户端回退）。", {"bold": True}),
                ("models-metadata.js:1 与 server/index.js:211 各有一份常量；ui/stores/useConfigStore.ts:38 有第三份，"
                 "并在第 826 行把 [代理地址, 公网地址] 依次尝试——服务端代理失败时浏览器会自己直连 models.dev，再等 8 秒；"
                 "vscode/src/bridge-fs-helpers-runtime.ts:531 是第四份（本方案不使用 VS Code，可忽略）。"
                 "此外 provider 图标走 https://models.dev/logos/<id>.svg。", {})])
    _rich(doc, [("方案。", {"bold": True}),
                ("新增 policy 键 modelsDevUrl，服务端解析一次后注入两处常量；并通过既有的 /api/openchamber/models-metadata "
                 "路由把地址下发给客户端，客户端不再保留公网回退（拿不到地址就只用代理）。"
                 "内网侧只需一个静态 JSON（models.dev 的镜像，或自制最小集合），放在内网 nginx 上。", {})])

    _rich(doc, [("建议的最小 JSON 结构（只保留 UI 真实读取的字段）：", {"bold": True})])
    mono(doc, [
        '{',
        '  "openai-compatible": {',
        '    "id": "openai-compatible",',
        '    "name": "内网模型网关",',
        '    "models": {',
        '      "qwen3-32b": {',
        '        "id": "qwen3-32b",',
        '        "name": "Qwen3 32B",',
        '        "limit": { "context": 131072, "output": 8192 },',
        '        "modalities": { "input": ["text"], "output": ["text"] },',
        '        "cost": { "input": 0, "output": 0 }',
        '      }',
        '    }',
        '  }',
        '}',
    ])
    _para(doc, "这是「展示与路由辅助」用的元数据，不参与鉴权与计费；完全缺失时会话本身仍可正常进行。"
               "因此这一项优先级低于 4.1，但它决定了用户能否看到上下文长度与价格，属于体验门槛。",
          size=9.5, color=MUTED, space_after=8)

    heading(doc, "4.3 技能目录可注入", 2)
    _rich(doc, [("现状。", {"bold": True}),
                ("curated-sources.js 的 CURATED_SKILLS_SOURCES 是模块级常量，指向 anthropics/skills、openai/skills、"
                 "cursor/plugins、mattpocock/skills 四个仓库；policy 只有一个 hideBuiltinSkillCatalogs 布尔键「全部隐藏」，"
                 "没有「换成自己的」这条路。", {})])
    _rich(doc, [("方案。", {"bold": True}),
                ("新增 policy 键 skillsCatalogSources，结构与内置常量同形（id / label / description / source / "
                 "defaultSubpath / sourceType / excludedSkills），配置后替换内置列表；provider 字段名不变，"
                 "下游的扫描、安装、来源标记逻辑零改动。sourceType 需扩展 'gitlab'，复用 GitLab 的项目路径语义。", {})])
    _para(doc, "这一项与 4.1 是组合关系：4.1 放行地址，4.3 提供目录。两者缺一，内网技能市场都无法闭环。"
               "另外注意技能源的解析只认 https:// 与 git@：内网 GitLab 若是纯 HTTP，4.1 的协议放行要一并作用到这条解析上。",
          size=9.5, color=MUTED, space_after=8)

    heading(doc, "4.4 内网 HTTPS 与自签证书（本版结论有变化）", 2)
    _rich(doc, [("上一版结论不准确。", {"bold": True}),
                ("system-ca.js 确实会在启动时调用 applySystemCertificates()，但它依赖 Node 的 tls.getCACertificates——"
                 "Bun 没有这个 API，函数内部 catch 后返回 false。而容器入口执行的是 bun，因此默认部署下系统证书库根本没有被加载。"
                 "「把根证书装进容器信任库就一切正常」这句判断在 curl/git 上成立，在服务端 fetch 上不成立。", {})])
    _rich(doc, [("正确做法（按推荐顺序）。", {"bold": True}),
                ("① 用 NODE_EXTRA_CA_CERTS 指向企业根证书（Node 与 Bun 都识别这个变量，服务器启动即生效，无需改代码）；"
                 "② 或者改用 Node 24 运行（bin/cli.js 支持，但需要镜像里装 Node 24，Bun 也应保留给终端 PTY）；"
                 "③ 一定要在阶段一用实际的内网 HTTPS 地址验证「git 能 clone」与「UI 能列出仓库」两件事，"
                 "两者走的不是同一条 TLS 路径——这正是历史上最容易误判的地方。", {})])
    _rich(doc, [("另外三点。", {"bold": True}),
                ("① 纯 HTTP 内网 GitLab 必须配 allowedInsecureGitOrigins，且镜像必须是改版产物（上游没有这个键）；"
                 "② 不要用 GIT_SSL_NO_VERIFY：它只影响 git 子进程，服务端 fetch 仍会失败，表现为「git 通、UI 空」；"
                 "③ 扩展提供的 source-control 端点按设计只接受 HTTPS 与 loopback HTTP，不吃这个白名单——"
                 "内网 GitLab 集成应走内置 provider + origin 白名单，而不是自写扩展。", {})])

    callout(doc, "推荐做法", [
        ("统一走自签 CA 而非关闭校验：内部 CA 给 gitlab.corp.internal 签证书，根证书进镜像 /etc/ssl/certs 并 "
         "update-ca-certificates，同时设置 NODE_EXTRA_CA_CERTS 指向同一文件。一次配置，git、服务端 fetch、OpenCode 三方同时生效。",
         {"size": 9.5}),
    ], fill="F0F6F0", bar="2E6B3E", title_color=OK)

    heading(doc, "4.5 OpenCode 供应链：用策略锁死，不改代码", 2)
    _rich(doc, [("现状。", {"bold": True}),
                ("应用有两条接触 OpenCode 的路径：镜像构建期的 npm install -g @opencode/cli@2.2.3；"
                 "运行期的 v2 自动安装（v2-install.js：先拉 opencode.ai/v2/install 脚本，再从 registry.npmjs.org 取包，"
                 "并强校验 tarball 必须来自 npmjs）与升级（/api/opencode/upgrade）。两处都写死公网地址，且没有配置入口。", {})])
    _rich(doc, [("关键发现。", {"bold": True}),
                ("policy 的 opencodeBinary 不只是「锁路径」——它同时让 getOpenCodeCompatibility 返回 canInstall=false、"
                 "让升级路由直接返回 409「Your administrator manages this OpenCode installation」。"
                 "也就是说，一个键把自动安装与自动升级两条公网出口同时关掉，这是内网最省事的落点，不需要打补丁。", {})])
    _rich(doc, [("落地要求。", {"bold": True}),
                ("镜像内预装与 policy 指向同一个路径（注意 npm 全局前缀：容器里是 /home/openchamber/.npm-global/bin/opencode）；"
                 "OPENCODE_BINARY 环境变量是等价替代，但 policy 优先级更高、且用户不可覆盖，内网应选 policy。"
                 "验收要覆盖：断网启动、新会话可用、设置页不出现「可升级到 x.y.z」的提示。", {})])

    return doc


def mono(doc, lines):
    """A monospaced block with light background."""
    t = doc.add_table(rows=1, cols=1)
    t.autofit = False
    tbl_pr = t._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), "4")
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), "D8DEE4")
        borders.append(el)
    tbl_pr.append(borders)
    cell = t.rows[0].cells[0]
    cell.width = Cm(15.5)
    _set_cell_shading(cell, "F7F8FA")
    _set_cell_margins(cell, top=120, bottom=120, left=180, right=140)
    first = True
    for line in lines:
        p = cell.paragraphs[0] if first else cell.add_paragraph()
        first = False
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.line_spacing = 1.25
        r = p.add_run(line)
        r.font.size = Pt(8.4)
        r.font.name = "Consolas"
        r._element.rPr.rFonts.set(qn("w:eastAsia"), "Consolas")
        r.font.color.rgb = RGBColor(0x24, 0x2C, 0x35)
    _para(doc, "", size=6, space_after=2)
