---
identifier: LOCAL-6
title: 创建 issue 的语言没有遵循设置的语言
state: todo
priority: medium
labels: [i18n]
createdAt: 2026-11-02T00:00:00.000Z
updatedAt: 2026-11-01T17:13:44.750Z
feature: null
blockedBy: []
assignee: assistant
---
## Symptom
创建本地 issue 时，生成的 issue（标题、正文）所用语言没有根据应用设置里选择的语言来写。

## Reproduce
1. 在 设置 中选择界面语言（例如英文或中文）。
2. 通过本地 issue 创建流程（让会话按 `.issues/` 规则新建 issue）创建一个 issue。
3. 观察生成的 issue 文件语言，与设置的语言不一致，而是跟随请求文本的语言。
未在运行时复现，以上基于用户报告。

## Environment
n/a（创建 issue 的提示词/流程行为），main 分支

## Evidence
- 用户报告：「建立issue的语言为什么没有根据设置的语言来写」。
- 创建 issue 的指令（Manage local issues … Rules 1-9）没有包含任何语言要求；在 `packages/` 下未找到该提示词的源码位置（搜索 `Manage local issues`、`Body template` 无匹配），需要先定位其生成位置。
- 来源：当前会话。
