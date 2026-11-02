新功能
  - 侧边栏自定义：可重排 Chats/Pinned/In work/Projects 分区，还能按状态、类型、
    关联 PR/议题、标题或项目新建过滤分区（显示菜单 > Customize sections）
  - 聊天富组件：agent 直接在回复里画表格、图表、步骤和表单，表单选择作为回答回传
  - Canary 更新通道：Settings > About 选 Stable/Canary，每晚构建，含 Android/iOS 包
  - Agent memory：跨会话记忆工具，记录显示在项目知识的 Memory 页
  - Workflows：agent 可执行带计划审批的多步任务
  - Secrets 卡片：agent 索要 API key/密码时走聊天里的私密卡片，值不进对话记录
  - 计划任务可在指定分支的独立 worktree 运行、可移到其他项目
  - 设置 > Sessions 新增 Compaction 区：自动压缩、剩余空间、保留上下文、后台压缩
  - Git：子模块/嵌套仓库项目可在 Git 和 Changes 视图切换选择
  - Composer：Ctrl+Up 打开历史提示词搜索；Header 布局常驻上下文环与项目操作

改进
  - iOS 键盘联动重做，点击/抽屉/面板即时响应；手机侧边栏采用桌面外观
  - 界面降噪：更少边框、状态色、统一阴影、弹簧动画；消息底栏显示模型/agent/耗时
  - 长会话打开更快，长回答只绘制可见区域，iOS 上滚不再抖动

修复（节选）
  - Windows 网络共享路径在 OpenCode 下正常工作
  - Files 的 CSV 预览只渲染可见行
  - macOS arm64 按需 ad hoc 重签名；Intel 构建改用无 AVX 的 runner

说明
  - 上述为上游 v2.6.0 内容；内网定制功能（本地议题、企业模式 Git http 白名单
    环境变量、git 低版本兼容、GitLab 老实例探测）随本包一同交付
