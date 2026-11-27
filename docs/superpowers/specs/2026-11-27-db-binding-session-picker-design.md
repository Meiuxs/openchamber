# 数据库绑定的会话主选与选项说明(增量设计)

日期:2026-11-27
状态:已确认(方案 A 二期增量)
前序:`docs/superpowers/specs/2026-11-26-project-db-binding-design.md`

## 1. 目标

在已上线的「项目级数据库绑定」基础上补两块:

1. **选项可读**:表单里的专业选项(尤其 SSL 模式)不再只显示英文裸值,每个选项有中文名和一行说明,用户不需要懂 TLS 术语就能选。
2. **主选 + 会话选择**:一个项目可绑定多个环境的库;**项目设置里标记一个主选**;**会话输入框旁可选择本次会话用哪个库**。用户不选 → 用主选;用户选了 → 用所选。

## 2. 非目标

- **不做硬隔离**:会话仍能看到全部绑定的工具。选择只影响 AI 的默认指向,通过会话上下文注入表达。opencode 目前没有按会话关闭工具的能力(工具开关是 agent 级、项目配置级),硬隔离需要为每个绑定生成带 `tools` 过滤的 agent 并重建会话,成本高一个量级,留待将来评估。
- 不做 SSH 隧道(现在也没有该选项;用户最初提到的「SSH 模式」实际是 **SSL 模式**)。
- 不做按会话关闭整个 MCP 服务器。

## 3. 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 主选存哪 | `.opencode/dbhub/primary.json`(`{"alias":"orders"}`) | 与绑定 TOML 同目录;不改 MCP 条目 → **切换主选不触发实例重启** |
| 主选 API | `GET /api/db/primary`、`PUT /api/db/primary` | 与既有 `/api/db/*` 路由同层,复用 `x-opencode-directory` |
| 只有一个绑定 | 自动视为主选,不落文件 | 减少无意义写盘 |
| 会话选择存哪 | 客户端 zustand store,按 sessionID,localStorage 持久化 | 会话 update 接口只接受 title/permissions,没有 metadata 通道 |
| 注入方式 | 发送消息时的 synthetic context(`buildOutgoingMessage` 的 `syntheticTexts`) | 已有成熟通道,可与技能/引用上下文并列 |
| 注入时机 | 会话内首次发送 + 用户切换选择后 | 避免每条消息重复消耗 token |
| 选择器位置 | 输入框底部控制条左侧按钮组(附件/权限旁) | 与模型/代理选择器同一水平带;仅本项目 ≥1 个绑定时出现 |

## 4. 服务端

`packages/web/server/lib/db/binding-config.ts` 增加:

- `primaryConfigPathOf(directory)` → `<dir>/.opencode/dbhub/primary.json`
- `readPrimaryBinding(directory)` → `string | null`(文件缺失/损坏一律 null)
- `writePrimaryBinding(directory, alias | null)` → 写 `{"alias":...}` 或删除文件(传 null)

`packages/web/server/lib/db/db-test-routes.ts` 增加:

- `GET /api/db/primary` → `{ ok: true, alias: string | null }`
- `PUT /api/db/primary` body `{ alias: string | null }` → 校验 slug(`^[a-z0-9][a-z0-9-]*$`)与对应 `dbhub-<slug>.toml` 是否存在,返回 `{ ok: true, alias }`
- 删除绑定(`DELETE /api/db/binding`)时,若被删的是当前主选,一并清空 primary 文件

## 5. UI 库层

`packages/ui/src/lib/db-bindings/dsn.ts`:

- 新增 `PRIMARY_FILE_NAME`、`readPrimaryAlias`(客户端解析)、`buildDbBindingPrompt(spec)`:
  `本会话数据库:orders(dbhub-orders,db.local:3306/orders,只读)。未明确指定其它库时请使用它;查库优先调用 dbhub-orders_execute_sql / search_objects。`
- `DbSslMode` 的展示名/说明放在 i18n,不放在 dsn.ts。

## 6. 设置页

`DatabasePage.tsx`:

- 打开设置页时读 `GET /api/db/primary`,得到主选;只有 1 个绑定时视作主选。
- 卡片徽标区增加「主选」chip;右键菜单增加「设为主选」(已是主选时显示「取消主选」)。
- 设为主选 → `PUT /api/db/primary`;失败 toast。
- 删除绑定成功后,若它是主选,清空本地主选态。

表单文案:

- SSL 模式:下拉项显示「中文名 — 一行说明」,选中项下方补充当前含义;
  - 默认:由驱动自行协商,一般本地或内网够用
  - 禁用:明文传输,仅本机或完全可信内网
  - 优先(prefer):服务器支持就加密,不支持退回明文
  - 强制(require):必须加密,不校验证书
  - 校验证书(verify-ca):加密并校验 CA,不校验主机名
  - 严格校验(verify-full):加密 + 校验 CA + 主机名,最安全
- 只读、dbhub 版本各补一行 hint;别名保留「最终条目名」提示。

## 7. 会话选择器

新增 `packages/ui/src/stores/useSessionDbBindingStore.ts`:

- `selectionBySession: Record<sessionId, alias | null>`
- `announcedBySession: Record<sessionId, string | null>`(已注入过的条目名,避免重复注入)
- `setSelection(sessionId, alias | null)`、`markAnnounced(sessionId, name)`
- `persist` 到 localStorage(读取失败静默降级为空)

新增 `SessionDbBindingPicker.tsx`:

- 左侧按钮组里的图标按钮(`database-2`) + 当前库名,下拉列出全部绑定:第一项「主选(默认)」,其余按名称列出;显示只读/读写标记。
- 无绑定时不渲染;`isBtw`/并行模式下不渲染。
- 当前会话选择缺失时显示主选名,并标注「默认」。

注入接线:

- `useComposerSubmission` 组装 `syntheticTexts` 时追加 `dbBindingPromptFor({directory, sessionId, selection})`:
  - 计算生效绑定(选择优先,否则主选);
  - 若与 `announcedBySession[sessionId]` 相同则跳过;
  - 否则生成提示文本并 `markAnnounced`。
- 提示文本只包含库名、条目名、host:port/db、读写模式,不含密码。

## 8. i18n

`db-bindings.i18n.ts` 15 个 locale 新增:

- `settings.db.grid.primaryBadge`、`settings.db.grid.action.makePrimary`、`settings.db.grid.action.clearPrimary`
- `settings.db.dialog.sslOption.default|disable|prefer|require|verify-ca|verify-full`(名称 + 说明)
- `settings.db.dialog.versionHint`
- `settings.db.picker.label`、`settings.db.picker.defaultOption`、`settings.db.picker.aria`
- `settings.db.prompt.binding`(注入模板,带 `{name} {entry} {target} {mode}` 占位)

## 9. 测试

- 单测:`readPrimaryAlias`、`buildDbBindingPrompt`、主选回退(单绑定/无主选)、`announced` 去重。
- 服务端:primary 读写与删除联动(可用临时目录)。
- E2E(Playwright,本地 5180 + WSL MySQL):
  1. 两个绑定 → 设其中一个为主选 → 卡片显示主选徽标;
  2. 新会话显示主选名 → 发一条消息 → 转录中出现绑定提示;
  3. 切换选择 → 再发一条 → 出现切换后的提示,不再出现旧提示;
  4. 删除主选 → 主选态清空,选择器回退到剩余绑定。
- 既有 UI 全量测试按约 16 个基线失败判断,不引入新失败。

## 10. 风险

- **软约束**:AI 仍可能选错库。提示文本尽量明确;后续若需要硬隔离,升级为按绑定生成 agent。
- 主选文件与 MCP 条目可能短暂不一致(条目被手工删除)→ 读取时以“条目存在”为准,不存在则视为无主选。
- 多客户端同时改主选 → 后写覆盖,下一轮刷新可见。

## 11. 实现记录(2026-11-27)

- 服务端:`binding-config.ts` 增加 `primaryConfigPathOf/readPrimaryBinding/writePrimaryBinding`;`db-test-routes.ts` 增加 `GET/PUT /api/db/primary`,并在删除绑定时清空指向它的主选。
- 客户端:`dsn.ts` 增加 `listDbBindings/resolveEffectiveBinding/buildDbBindingPrompt/dbBindingPromptFor`;提示模板默认中文,调用方传入 i18n 模板(`settings.db.prompt.binding`)与只读/读写标签。
- 状态:`stores/useDbBindingStore.ts`(zustand persist),主选与会话选择都存条目名;切换选择会清除已公告标记,确保重新注入。
- 设置页:主选徽标 + 右键「设为主选 / 取消主选」;SSL 六项改为「中文名 + 说明」两行下拉,选中项下方显示完整说明;dbhub 版本补一行 hint。
- 会话:输入框底部左侧新增数据库选择器(`SessionDbBindingPicker`),仅在已有会话且项目有绑定时出现;发送时通过 synthetic context 注入一次。
- 已知取舍:新会话草稿阶段(session 尚未创建)不显示选择器,首条消息按主选注入;会话创建后可切换。

### 11.1 端到端验证(2026-11-27,Playwright + 本地 MySQL)

- 单绑定自动主选徽标;新增绑定粘贴 DSN 后自动填充、别名派生、主选开关默认不抢已有主选。
- 勾选主选保存 → 徽标转移,`primary.json` 写入对应 alias;右键「设为主选 / 取消主选」即时生效,文件同步。
- 多绑定无主选 → 列表出现「尚未设置主选,会话将默认使用第一个:X」提示。
- 会话选择器显示主选、菜单列出各绑定(host:port/db + 只读/读写);选择后实际发出的 synthetic context 为所选库,模型回答与之相符。
- 注入只发生一次:同会话第二条消息只发 `/prompt`,不再调 `/synthetic`;切换选择后重新注入新库。
- 删除主选绑定 → `primary.json` 清除、剔除选择回退到剩余绑定、单绑定自动接任主选。
- 新会话草稿首条消息即按主选注入(创建会话前的发送也命中)。
- 控制台仅有既有的 `received-pages` 403 / `guests` 404 轮询噪声,无 React 报错。
