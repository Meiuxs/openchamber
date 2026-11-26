# 项目级数据库绑定(dbhub)设计文档

日期:2026-11-26
状态:设计已定稿(方案 A)
范围:会话中的 AI 通过 MCP 工具查询项目绑定的 MySQL / PostgreSQL 数据库

## 1. 目标与场景

在 OpenChamber 会话中增加"绑定数据库"能力:

- **每个项目**可配置自己的数据库连接(主要 MySQL、PostgreSQL);
- **会话里的 AI** 通过 MCP 工具(`execute_sql`、`search_objects`)直接查库、探索 schema,辅助开发;
- 用户不直接在 UI 里查库(那是另一期的事,不在本设计范围)。

## 2. 现状分析(本仓库已具备的链路)

- `packages/ui/src/stores/useMcpConfigStore.ts` 已有完整的 per-directory MCP 配置体系:
  - `McpDraft.scope: 'user' | 'project'`;
  - `createMcp / updateMcp / deleteMcp` 走 `/api/config/mcp/:name?directory=…`(`x-opencode-directory` 头);
  - `scope='project'` 时写入**项目目录下的 opencode 配置文件**(`packages/vscode/src/opencodeConfig.ts` 的 `ensureProjectMcpConfigPath`);
  - 本地 stdio 服务器(`type:'local'`,command + environment + timeout)由 opencode server 统一拉起,会话自动获得其工具;写操作后已有 `requiresReload → refreshAfterOpenCodeRestart` 的实例重启链路。
- `packages/ui/src/components/views/IntegrationsCatalogView.tsx` 已有"集成目录":表单值 → `buildCatalogMcpDraft` → `createMcp`,但目录条目目前固定 `scope:'user'`。
- MCP 权限体系(`AgentPermissionsEditor`)按 MCP 服务器粒度控制工具可见性,自动覆盖新增条目。

结论:**"某项目绑定若干 MCP 服务器、会话内 AI 使用其工具"这条链路已全部存在**。缺的只是一个面向数据库的、低门槛的配置入口。

## 3. dbhub 调研结论

bytebase/dbhub(MIT,~4k stars):

- 一个轻量 MCP 数据库网关,支持 PostgreSQL、MySQL、MariaDB、MSSQL、Oracle、ClickHouse、SQLite;
- 默认仅 2 个工具 `execute_sql` + `search_objects`(合计 ~261 tokens,对上下文友好);
- 支持 `--transport stdio`、`--dsn` / `DSN` 环境变量、`--readonly`、行数限制、查询超时、SSH 隧道、SSL;
- `npx @bytebase/dbhub@<version> --transport stdio` 即可作为本地 MCP 进程运行。

与本项目"local stdio MCP"模型完全吻合,无需任何协议适配。

## 4. 方案对比

### 方案 A(推荐):dbhub 作为项目级 MCP 预设条目

新增一个"项目数据库"配置 UI,用户填表单,系统组装成一个 `scope='project'` 的 dbhub stdio MCP 条目,其余全部复用现有链路(存储、进程管理、工具注入、权限、实例重启)。

- 优点:改动集中在 UI + 一个测试连接端点;零新增运行时组件;权限/多运行时(web、electron、vscode)自动兼容;dbhub 的 SQL 安全控制(只读、行数、超时)直接继承。
- 缺点:引入 dbhub(npx)外部依赖;能力上限受 dbhub 约束(对本场景足够)。

### 方案 B:自研原生数据库工具

在 server 内用 `pg` / `mysql2` 驱动自写 tool,直接注册进会话。

- 优点:控制力最强,可做结果分页等深度定制。
- 缺点:需要自建连接生命周期、多数据库方言适配、schema 内省、安全控制(只读判定远比想象难)、以及每个运行时的注入点;重复造 dbhub 已造好的轮子。**否决**,除非 dbhub 出现硬伤。

### 方案 C:共享远程 dbhub HTTP 网关

 centrally 部署 dbhub HTTP 服务,项目配置指向它。

- 适合多用户 web 部署,但需要自建鉴权与 per-project DSN 管理面;对本地/桌面用户是多余的运维负担。**作为 V2 演进方向**(见 §8)。

## 5. 方案 A 详细设计

### 5.1 数据模型

每个绑定 = 项目配置文件中的一条 MCP 记录:

```
name: dbhub-<alias>            // alias 由用户命名,如 dbhub-orders
type: local
command: ["npx","-y","@bytebase/dbhub@<锁定版本>","--transport","stdio","--readonly"]
environment: { DSN: "mysql://user:<password>@host:3306/dbname" }
timeout: { startup: 15000, execution: 30000 }
```

要点:

- **DSN 走 environment 而非 argv**,避免密码出现在进程列表中;
- dbhub 版本锁定到具体版本,避免 `@latest` 漂移;
- 只读模式默认开启(`--readonly`),用户显式关闭时 UI 提示风险;
- 一个项目可绑定多个库(多个条目);
- 表单字段:别名、类型(MySQL / PostgreSQL)、host、port(默认 3306 / 5432)、database、用户名、密码、SSL(`sslmode=disable/require`)、只读开关、可选高级项(行数上限、执行超时)。

### 5.2 UI 入口

1. **项目设置 → 数据库**(主入口):绑定列表(名称、类型、host/db、只读徽标、状态)+ "绑定数据库"表单(如上字段),保存调用现有 `createMcp(scope:'project')`。
2. 集成目录中增加 dbhub 条目作为辅助入口(需将目录 draft 的 scope 扩展为可选 'project')。

会话侧不加新概念:绑定的库就是该目录下的 MCP 服务器,出现在现有 MCP 列表与权限编辑器中,可逐会话启停。

### 5.3 连接测试

新增 server 端点 `POST /api/db/test`(带 `x-opencode-directory`):

- 服务端按表单组装 DSN,一次性拉起 `dbhub --transport stdio`,完成 MCP `initialize` + `tools/list` 握手后即退出;
- 成功 → 返回数据库版本/表数量提示;失败 → 透传 dbhub 报错(host 不可达 / 认证失败 / 库不存在);
- 不落盘任何配置,纯探测。

### 5.4 错误处理

- npx 不可用(离线/内网无 registry):启动失败会走现有 MCP status 的 error 展示;表单保存时提示"运行时需可执行 npx @bytebase/dbhub";内网用户可预置 dbhub 到全局 npm 缓存或改 command 为本地安装路径(高级编辑始终开放,因为条目就是普通 MCP 条目)。
- DSN 组装失败 / 端口占用等,表单即时校验。
- opencode 实例重启失败:沿用 `requiresManualRestart` 现有提示链路。

### 5.5 安全

- 密码明文存于项目 opencode 配置文件 —— 与现有 MCP secret(environment)存储一致;一期不做额外加密,文档中注明,后续可接 safeStorage。
- 默认只读;写模式需显式开启。
- `x-opencode-directory` 权限模型不变,只有能写该项目配置的用户能改绑定。

### 5.6 测试

- DSN 组装函数:单测(MySQL/Postgres、含密码特殊字符的 URL 编码、sslmode);
- `POST /api/db/test`:集成测试 mock dbhub 子进程;
- UI:参照 `McpGrid.test.tsx` / `useMcpConfigStore.test.ts` 的既有模式,测表单 → draft → createMcp 调用参数。

## 6. 涉及文件(预估)

| 层 | 文件 | 改动 |
|---|---|---|
| UI | `packages/ui/src/components/sections/` 新增 `DatabaseBinding*`(项目设置 section) | 新 |
| UI store | 复用 `useMcpConfigStore`(不新做 DB 专用 store) | 无改动 |
| server | `packages/web/server/` 新增 db 测试端点 + dbhub 探测模块 | 新 |
| server | `/api/config/mcp` 写入路径 | 无改动 |
| 目录 | `packages/ui/src/lib/integrations-catalog/registry.ts` 增加 dbhub 条目(可选,scope 可选) | 小 |

## 7. 风险

- dbhub 上游版本演进(锁定版本 + 定期升级);
- npx 网络依赖(内网环境,见 5.4 缓解);
- 密码明文(一期接受,注明,后续接 safeStorage)。

## 8. 实现记录(2026-11-27,方案 A 第一期落地)

- **UI**:`packages/ui/src/components/sections/database/DatabasePage.tsx` 新设置页(slug `databases`,opencode 分组),复用 `SettingsCard*` / `SettingsProjectSelector` / `useMcpConfigStore` 全套既有模式;支持粘贴连接串(`mysql://` / `mariadb://` / `postgres://` / `postgresql://`,含 `jdbc:` 前缀)自动填充表单。
- **DSN 工具**:`packages/ui/src/lib/db-bindings/dsn.ts`(+ 16 个单测):解析/构建 DSN、识别 dbhub 条目、组装 `McpDraft`。
- **内网镜像**:DSN 走 `DSN` env;同时注入 `npm_config_registry`(取自全局 npm 镜像设置 `sessions.npm-registry`),npx 从内网镜像解析 dbhub;测试端点侧则用 server 的 `readNpmRegistry()`(策略文件 / 环境变量 / .npmrc)。
- **版本策略**:默认不锁版本(npx 拉 latest);表单"高级"区可填精确版本(如 `0.9.0`)写入 command 实现锁定;因条目就是普通 MCP 记录,后续升级即改版本号或清空回 latest。
- **测试连接**:`POST /api/db/test`(server 一次性拉起 dbhub stdio,完成 MCP initialize + tools/list 握手后立即杀进程,不落盘)。
- **i18n**:15 个 locale 全量翻译(`db-bindings.i18n.ts` + 各 locale 主字典 spread)。
- 遗留(后续迭代):测试连接的集成测试、密码接入 safeStorage、共享远程 dbhub 网关(V2)。

## 9. V2 演进方向(不在本期)

- 共享远程 dbhub 网关(方案 C),配合内网 web 部署;
- dbhub Custom Tools(把常用参数化查询固化为工具);
- 面向用户的 SQL Workbench(dbhub 内置 Web 界面)。
