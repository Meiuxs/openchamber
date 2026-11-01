# -*- coding: utf-8 -*-
"""Content: part 3 (merge strategy, rollout, risks, appendix)."""
from build_report import *  # noqa
from build_report import _para, _rich, _run, _set_cell_shading, _set_cell_margins
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK


def build_part3(doc):
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    # ---------- 5. 可合并性 ----------
    heading(doc, "与主仓可持续合并的四条设计原则", 1, "5")
    _para(doc, "「内网能跑」和「以后还能跟上上游」是两件事。前者靠改得对，后者靠改得少、改得断点清晰。", first_line=0)

    heading(doc, "原则一：定制只加在 policy 文件这一层", 2)
    _para(doc, "policy 文件的 schema 没有用 .strict()，未知键被 zod 静默剥离，不会 safeParse 报错。好处是新键可以先于代码部署——"
               "旧版本读到新键只是忽略它；代价是键名拼错同样被静默忽略，功能默默不生效。原则不变：每个新键必须 optional，"
               "未配置时行为与上游逐字节一致。", first_line=0)
    table(doc,
          ["做法", "可合并性", "评价"],
          [
              ["新增可选 policy 键", "高", "推荐。schema 一行 + 解析三处 + 消费点，冲突面很小"],
              ["扩展既有键的适用范围", "高", "推荐用于 4.1：同一个语义，只是多一个消费者，比新造同义词更容易被接受"],
              ["改既有键语义", "低", "避免。上游测试与文档会同时失配，review 也难通过"],
              ["fork 后长期不分叉", "低", "内网改动越多，后续每个版本的手工 rebase 成本线性上升"],
              ["插件 + 运行时配置", "最高", "不产生 diff，升级上游只是替换镜像"],
          ],
          widths=[4.2, 2.2, 9.4], font_size=8.6)

    _rich(doc, [("一个键的完整改动面（上一版低估了，这里给出清单）：", {"bold": True}),
                ("policyFileSchema 加一行 → parsePolicyFile 的解构行 → parsePolicyFile 的返回对象 → "
                 "readEnterprisePolicy 的 invalid 早返回分支 → readEnterprisePolicy 的返回对象 → 消费点。"
                 "前五处任何一处漏掉，都会得到「键在某些路径下是 undefined」的隐蔽 bug；"
                 "其中 invalid 分支最容易被忘，而它恰恰是 fail-closed 语义所在。", {})])
    _rich(doc, [("消费点的真实规模：", {"bold": True}),
                ("readEnterprisePolicy 当前有 14 个直接调用方（codegraph 统计），其中 getCuratedSkillsSources、"
                 "createOpenCodeEnvRuntime、withEnterprisePolicy 分别在技能目录、OpenCode 环境、插件目录三处；"
                 "allowedInsecureGitOrigins 有 13 处引用、分布在 6 个服务端消费者上。新增键应尽量复用这些既有入口，"
                 "而不是新增调用方。", {})])

    heading(doc, "原则二：每处改动都是可独立推上游的 PR（三个，不是四个）", 2)
    _para(doc, "三处改动的共同点是「企业 / 受限网络场景的能力缺口」，而不是「我们公司的特殊需求」，因此具备推回上游的条件：", first_line=0)
    bullets(doc, [
        ("Git 主机放行（扩展现有键）——任何部署在自建 GitLab 上的企业都有同样问题：装插件、装技能、连仓库是三件不同的事，"
         "却在同一个白名单语义下。既有键已经进了树（虽然还没进上游 release），扩展它比新造 allowedPrivateOrigins 更容易被接受，"
         "因为不需要上游理解两个近义键的区别。"),
        ("modelsDevUrl —— 上游把「对话内容不外发」做成了 Enterprise Mode 的承诺，但元数据仍硬编码公网地址，"
         "在严格隔离网络中静默失效，属可论证的缺陷；客户端还保留公网回退，会让「已隔离」的承诺在事实上不成立。"),
        ("skillsCatalogSources —— 上游已有 hideBuiltinSkillCatalogs，只能隐藏不能替换，是半成品状态。"),
    ])
    _rich(doc, [("关于 HTTP 放行本身：", {"bold": True}),
                ("维护方对内网明文 HTTP 的定论是「Nginx TLS 反代 + 内部 CA」，并曾逐一验证关死其他绕路。"
                 "因此这一项要按「推翻既有立场」的强度准备论证与测试，接受概率低。规划上按季度 rebase 的 patch series 自持，"
                 "TLS 反代始终保留为兜底路线——这也是为什么 4.4 的 CA 结论必须准确：反代路线能否成立，取决于服务端 fetch 是否信任内部 CA。",
                {})])

    heading(doc, "原则三：私有插件放在独立仓库，按分发约束选择安装方式", 2)
    bullets(doc, [
        ("插件依赖 @openchamber/sdk 的 apiVersion=1 契约，manifest 中 engines.openchamber 声明最低宿主版本；"
         "宿主过旧会明确拒绝安装（host-too-old），不会静默出错。"),
        ("插件不进 packages/extensions（官方内置包白名单，openchamber-builtin- 前缀保留，不可删除、不可 Git 更新），"
         "而是发布到内网 GitLab。"),
        ("分发方式受 Enterprise 能力门控约束：不带 service/network/origins/transcript 的纯面板插件可自由安装；"
         "带这些能力的必须来自 allowedExtensions 列出的仓库。ZIP 在 Enterprise 下一律关闭，"
         "本地文件夹需要 allowLocalExtensions（只建议开发期使用）。因此「从 URL 安装」+ 仓库白名单是唯一的正规路径。"),
        ("升级上游时插件无需重新构建；只有 apiVersion 抬升时才需要跟进。"),
    ])

    heading(doc, "原则四：把差异做成「可开关的部署变体」", 2)
    _para(doc, "生产只构建一套镜像，差异全部在挂载的 policy.json、环境变量与插件目录里：标准版关掉内网键，内网版打开。"
               "任何人可以通过替换 policy.json 在两者间切换，这同时也是回滚手段——出问题时拔掉 policy 就回到上游原版行为。"
               "唯一不能靠配置切回的是 Git 放行补丁：它是代码，必须随镜像走（但未配置白名单时行为等价于上游）。",
          first_line=0)

    # ---------- 6. 实施路线 ----------
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
    heading(doc, "实施路线", 1, "6")
    _para(doc, "按「先能跑、再好用、后补齐」三段推进。每一段结束都有一个可交付、可回退的里程碑。", first_line=0)

    phases = [
        ("阶段一 · 跑起来（约 3–5 人日）", [
            "镜像源：新建 bunfig.toml 指向私有 registry（仓库里原本没有这个文件），确认 bun install --frozen-lockfile 一次通过；"
            "bun.lock 不含 registry URL，换源不需要重生成。",
            "同步基础镜像进内网 Harbor：oven/bun:1.4.4（构建与运行都用它）。注意运行期不需要 Node 24，"
            "但镜像里 apt 装的 nodejs 是发行版版本，别指望它满足 engines。",
            "构建期把 npm install -g @opencode/cli@2.2.3 指向私有源；镜像内预装完成后，用 policy 的 opencodeBinary 锁死路径"
            "（同时关掉 v2 自动安装与自动升级两条公网出口）。",
            "写入第一版 policy.json：enterpriseMode、allowNetworkAccess（内网必须显式放开，否则只监听 127.0.0.1）、"
            "allowedInsecureGitOrigins、opencodeBinary。策略文件是部署物，路径固定且不在仓库里"
            "（Windows C:\\ProgramData\\OpenChamber\\policy.json，Linux /etc/openchamber/policy.json，"
            "macOS /Library/Application Support/OpenChamber/policy.json），要进镜像或挂载卷。",
            "CA：根证书进 /etc/ssl/certs + update-ca-certificates，并设置 NODE_EXTRA_CA_CERTS；"
            "用「git clone 成功」和「UI 列出仓库成功」两件事分别验证（两者不走同一条 TLS 路径）。",
            "确认隔离空间开关（isolatedSpacesEnabled）为关闭，且生产镜像不设 OH_MY_OPENCODE。",
            "验收：打开 Web 端能登录、能建会话、能选内网模型、能对内网仓库执行 git 状态与提交；"
            "断网启动无报错；设置页没有「可升级 OpenCode」提示；跑一遍分支补丁的护栏套件"
            "（enterprise-mode、origin-instance/binding-contract、provider-descriptors 相关测试）作为回归基线。",
        ]),
        ("阶段二 · 用起来（约 6–9 人日）", [
            "应用 4.1 补丁：把 allowedInsecureGitOrigins 扩展到插件 git/zip 安装与技能克隆；先用手工构造的内网地址验证拒绝/放行两侧。",
            "搭建内网技能仓库（一个 GitLab 项目，skills/ 下每个子目录一个 SKILL.md），应用 4.3 补丁并接入目录。",
            "按需接入内网 MCP 服务器（内部检索、工单、流水线）：这是让 agent 拥有内部能力的唯一路径，插件只做配置界面。",
            "配置内网 TTS / STT（OpenAI 兼容端点），或启用本地 sherpa-onnx 离线语音。",
            "关闭并隐藏不可用项：隧道、推送、Linear、外部集成目录（Enterprise 已自动处理大部分）。",
            "验收：内网用户能从统一入口安装内部技能与内部插件，语音可用，设置页无「点了没反应」的入口。",
        ]),
        ("阶段三 · 长期收敛（持续）", [
            "应用 4.2 补丁，发布内网模型元数据 JSON，补齐上下文长度与价格展示，并去掉客户端公网回退。",
            "把三个改动分别整理成 PR 推上游，附内网场景的最小复现与测试；Git 放行按低接受概率规划，长期自持 patch series。",
            "建立升级流程：每季度拉上游 tag，先 rebase Git 放行补丁（保持少量独立提交），跑内网回归清单"
            "（登录、会话、Git、插件安装、技能安装、语音、断网启动）+ 补丁护栏套件。",
            "上游接受后删除对应本地补丁；HTTP 键若被拒则长期自持，或整体切到「内网 TLS 反代」方案后拔掉该补丁。",
        ]),
    ]
    for title, items in phases:
        _para(doc, title, size=11, bold=True, color=ACCENT, space_before=10, space_after=4)
        bullets(doc, items, size=10)

    # ---------- 7. 风险 ----------
    heading(doc, "风险与边界", 1, "7")
    table(doc,
          ["风险", "影响", "应对"],
          [
              ["默认容器跑 Bun，Node 专有 API 静默失效",
               "系统证书库不加载（表现为「git 通、UI 拉不到数据」），其他 Node 24 API 也可能缺失",
               "CA 走 NODE_EXTRA_CA_CERTS；阶段一必须分别验证 git 与 UI 两条链路；新增功能避免依赖 Node 专有 API"],
              ["OpenCode v2 自动安装 / 升级指向公网",
               "断网时安装失败、升级提示干扰用户判断", "policy 的 opencodeBinary 同时关掉两条路径；验收看设置页无升级提示"],
              ["镜像源的包哈希与官方不一致", "bun.lock 校验失败，安装中断", "镜像保留原 tarball 与 integrity；5 个 patchedDependencies 的版本必须精确一致"],
              ["Git 放行补丁不被上游接受", "每季度 rebase 约 31 个文件的补丁，随版本间隔拉大漂移风险",
               "补丁保持为少量独立提交；每次 rebase 先跑护栏套件；保留内网 TLS 反代 + 内部 CA 作为可整体替换的兜底路线"],
              ["bunx 运行一次性工具会重写根 bun.lock", "构建不可复现，frozen-lockfile 随机失败",
               "内网构建只用仓库本地安装的 lint/测试工具，不 bunx 外部包；CI 前检查 git status"],
              ["放开 allowNetworkAccess 等于对内网暴露服务", "任何能访问该端口的人都可操作 agent 与终端",
               "强制 OPENCHAMBER_UI_PASSWORD / OIDC；前置反向代理做 IP 白名单与审计"],
              ["Enterprise Mode 与内网需求方向相反", "默认关闭网络访问与插件安装，容易误判为「项目不支持内网」",
               "必须显式 allowNetworkAccess: true 并配置白名单；这是管理员承诺，不是缺陷"],
              ["Enterprise 下 ZIP 恒关、能力插件只认白名单仓库", "「打个 zip 发下去」这条最省事的分发路径走不通",
               "插件放内网 Git 仓库并列入 allowedExtensions；开发期用 allowLocalExtensions"],
              ["插件白名单只防投放，不防能力", "任何能访问内网 GitLab 的人都能投放插件并被安装",
               "allowedExtensions 只列可信组织路径；service 类能力仍需人工确认授权"],
              ["git 走代理、fetch 不走代理（或反之）", "表现为部分功能可用，排查困难", "统一用 NO_PROXY 放行内网域名；服务器启动时会自动把 loopback 加入 bypass"],
              ["原生模块（node-pty / sherpa-onnx / @xenova/transformers）", "跨平台二进制不匹配导致终端或语音启动失败",
               "内网构建统一在 Linux x64 容器内完成，不做跨平台产物"],
              ["隔离空间被误开", "需要 Docker + ~1.6 GB 外网镜像，内网直接失败",
               "保持 isolatedSpacesEnabled 关闭；要启用则镜像先同步进 Harbor 并验证 gatekeeper 的私网拦截"],
              ["技能与模型元数据长期不更新", "模型能力标注过时，技能陈旧", "纳入季度升级例程，与上游版本一并回归"],
          ],
          widths=[4.0, 5.2, 6.6], font_size=8.2)

    heading(doc, "本文未覆盖的部分", 2)
    bullets(doc, [
        "移动端与桌面端：按需求已排除。若后续接回，Enterprise 下移动端只能经自建 relay 配对，需要额外评估。",
        "SSO / OIDC 对接：项目内有 UI 密码与 WebAuthn 能力，企业 SSO 接入方式取决于内网身份体系，需单独勘察。",
        "数据落盘与审计：会话、终端输出、Git 审计日志均落在数据目录，内网合规要求（留存周期、脱敏）需结合安全部门口径另议。",
        "模型服务侧的容量与并发：本文只讨论客户端可达性，未涉及内网 GPU 资源规划。",
        "扩展提供者的 source-control 端点按设计只接受 HTTPS 与 loopback HTTP，不吃 Git 放行白名单；"
        "若内网 GitLab 适配要走扩展而非内置 provider，需上 HTTPS 或扩展该判定的边界（属产品决策）。",
        "Bun 与上游版本的一致性：本文假设内网镜像使用与上游相同的 bun 1.4.4。升级 bun 会改变 guest bundle 的压缩输出，"
        "需要同步重建示例产物（上游 examples.test.ts 对此有断言）。",
    ], size=10)

    # ---------- appendix ----------
    heading(doc, "附：关键文件索引", 1, "A")
    table(doc,
          ["路径", "作用"],
          [
              ["packages/web/server/lib/enterprise-mode.js", "策略读取、schema、allowNetworkAccess / opencodeBinary / allowedInsecureGitOrigins 的唯一来源（改动主战场）"],
              ["packages/web/server/lib/guests/clone.js", "插件安装的地址与协议校验：isPublicHostname、publicAddressesOf、gitNetworkArgs（4.1 必改）"],
              ["packages/web/server/lib/guests/install.js", "git / zip 两条安装路径与 pinned https 下载（4.1 必改）"],
              ["packages/web/server/lib/guests/enterprise.js", "Enterprise 对插件能力的门控：allowedExtensions / allowLocalExtensions / ZIP 恒关"],
              ["packages/web/server/lib/git/credential-resolver.js", "Git 端点协议与端口规范化（技能克隆也走这里）"],
              ["packages/web/server/lib/source-control/origin-instance.js", "origin 型实例的统一校验入口（HTTPS / loopback / 白名单）"],
              ["packages/web/server/lib/opencode/models-metadata.js", "模型元数据取数（4.2 必改，常量在首行）"],
              ["packages/ui/src/stores/useConfigStore.ts", "客户端元数据取数：第三份常量 + 公网回退（4.2 必改）"],
              ["packages/web/server/lib/opencode/v2-install.js", "OpenCode v2 自动安装：opencode.ai 脚本 + npmjs 包 + origin 强校验（4.5 的规避对象）"],
              ["packages/web/server/lib/skills-catalog/curated-sources.js", "内置技能目录常量（4.3 必改）"],
              ["packages/web/server/lib/skills-catalog/source.js", "技能源解析：只认 https:// 与 git@"],
              ["packages/web/server/lib/opencode/npm-registry-config.js", "读取 ~/.npmrc（含作用域源与鉴权），内网镜像无需改动"],
              ["packages/web/server/lib/outbound-proxy.js", "服务端出站代理，遵循 HTTP_PROXY / NO_PROXY，loopback 直连"],
              ["packages/web/server/lib/system-ca.js", "系统证书加载；Bun 下是 no-op（4.4 的结论依据）"],
              ["packages/web/bin/cli.js", "启动入口：bun / node 运行时选择、OPENCODE_BINARY 解析"],
              ["packages/web/server/lib/spaces/", "隔离空间子系统，默认关闭，需要 Docker 与约 1.6 GB 镜像"],
              ["packages/sdk/DOCUMENTATION.md", "插件契约总览：六种挂载位置、capability、service 角色、版本兼容规则"],
              ["packages/web/server/lib/source-control/DOCUMENTATION.md", "GitLab / Gitea / Gerrit / Forgejo 自部署支持的完整设计说明"],
              ["packages/extensions/DOCUMENTATION.md", "内置插件白名单机制与新增流程"],
          ],
          widths=[7.2, 8.6], font_size=8.0)

    _para(doc, "", space_after=10)
    _para(doc, "本版全部结论基于仓库 v2.5.3（上游 d4a5a0e）加本地未提交的 Git 放行补丁逐文件核对，"
               "引用面由 codegraph 索引（5,189 文件 / 106,055 符号）交叉验证；行号取自当前工作树，上游后续版本可能有偏移。",
          size=8.8, color=MUTED, italic=True)
    return doc
