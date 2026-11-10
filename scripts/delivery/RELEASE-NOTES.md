OpenChamber 2.8.0（2026-11-10）

新功能
  - 扩展：扩展可声明 contributes.links，把智能体回复和用户消息里的标识符、链接变成可点标签，
    点击可打开扩展或作为引用送入输入框。links 是独立能力，有单独授权行，范围变化会重新征求同意
  - 模型提供方：设置 > 模型提供方新增 Logo 区，任意提供方可上传 PNG、JPEG、WebP 或 SVG
    图片（≤1 MB）；扩展也可随包提供提供方 logo（contributes.providerLogos），
    展示优先级为上传的 logo、选定的图标、扩展提供的、内置与 models.dev
  - 聊天：粘贴 issue 或 PR 链接会变成消息里的标签，链接详情随消息一起交给智能体
  - SDK：会话记录新增运行中的工具、上下文占用、In work 状态与未读数；
    仅有整页面的扩展不再必须附带侧栏面板；manifest 解析失败时安装错误带上解析器给出的原因
  - 会话：问 Jev 前先读本轮改动过的文件与仍在跑的后台工作，只描述未改动的回合不再给出审查提议；
    「看起来完成」提示改为回合结束后静默 10 分钟才出现，新消息或新回合会取消它

改进
  - 桌面端：一次往返才算一次 ping
  - 项目：链接到已添加项目的文件夹，在 Add project 里显示为已添加
  - Nix：内置 OpenCode 恢复启动，会话与模型可加载
  - 文档：项目知识从 agent memory 迁到 skills 与模块文档

修复（节选）
  - 启动：被拒绝信任的文件夹不再阻塞启动，并可在之后再次请求信任
  - 扩展：manifest 非法时说明具体原因
  - 聊天：子代理的界面块按块绘制，不再显示源码
  - Web：空闲服务端 socket 保留时间调到高于反向代理连接池，反代后连接不再被提前断开
  - 模型：同一家族的模型按最新版本发布
  - CLI：OpenCode 从当前登录 shell 的 PATH 解析，登录后新装的版本能被找到
  - 测试：workflows 的四个运行时测试在机器繁忙时不再失败

内网与低版本 Git 适配（本包定制）
  - range-file-versions 接口去掉 Git 2.24 才引入的 --end-of-options；
    CentOS 7 自带 Git 2.20.1 下该接口不再报错
  - 从 Git 仓库安装技能时，若 sparse-checkout 子命令不存在（Git 2.25 之前）则退到全量检出，
    选中的技能目录仍能安装；扫描路径保持原有的 ls-tree 降级
  - GIT_CONFIG_GLOBAL 需要 Git 2.32，旧版会忽略该变量：HTTPS 与匿名传输靠隐藏 HOME 兜底，
    SSH 保留 HOME 供 known_hosts 使用，此时本机 ~/.gitconfig 仍会被读取，
    url.*.insteadOf 之类的配置可能生效

说明
  - 内置 OpenCode 仍为 2.2.6；以上为上游 2.7.0 之后累积的 27 个提交
  - 本包同时包含内网定制能力：本地议题系统、企业模式与用户目录 policy.json、
    内网 Git HTTP 白名单、模型元数据内网地址、企业技能目录与隐藏内置技能库、
    内网 npm 镜像、Git 2.20.x 低版本兼容、GitLab 老实例探测，
    以及带中文注释的 policy.example.json 样例
  - 本包安装脚本（install.ps1 / install.sh）全程无需管理员/root：策略文件与环境变量都写在
    当前用户目录；npm 全局前缀若指向不可写的系统目录，脚本只复用已有的用户级 npm 目录，
    不改写 .npmrc 等 npm 配置
  - 安装、配置与启动命令见 INSTALL.txt。更新后需重启 OpenChamber 服务，旧进程仍运行旧代码
