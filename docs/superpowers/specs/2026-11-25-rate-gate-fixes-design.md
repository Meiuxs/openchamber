# 请求速率网关修复 · 设计

日期：2026-11-25
状态：已由用户确认（对话内批准）

## 意图

用户看到工作状态面板在限流时显示 `OpenCode Go 100/100 · 限流至 0:38 · 1 个排队`，误以为本地发了 100 个请求。日志证明上游 OpenCode Go 对 `hungerg-free` 真实返回 429，本地网关只是被动响应。目标：

1. 限流时显示真实放行数，不再出现误导性的 `used/limit = 100/100`。
2. 上游 429 不带任何时间信息时，按连续轮次指数退避，而不是每个窗口重撞一次。
3. 评估（而非实现）按模型隔离 429。

## 非目标

- 不按模型拆分限流状态（结论：429 基本是凭证级，拆分只会增加对被限账号的并发；report 也不带 modelID）。
- 不改上游插件协议、不新增依赖、不动设置项。
- 不提交、不推送（用户未授权）。

## 约束

- `MAX_BACKOFF_MS` 上限 5 分钟，低于插件 `MAX_WAIT_MS = 600000`（10 分钟），避免插件超时后强行放行。
- 网关明确给出 `retry-after` / reset 头时，完全尊重网关时间，不参与退避升级。
- 同一次冷却期内到达的多条 429（OpenCode 会重试同一请求）不得叠加退避。
- 非 4xx 成功响应清零退避轮次。
- 服务器测试用 vitest：`packages/web` 下 `bunx vitest run server/lib/rate-gate/runtime.test.js`。
- UI 测试用 bun:test：`packages/ui` 下 `bun test src/components/chat/work-status/WorkStatusRateLimitSection.test.tsx`。

## 方案

### 1. 真实放行数

`runtime.ts` 的 `usageOf()` 当前 `used = total - remaining`，而限流时 `remaining` 被强制 0。改为 `used = Math.min(state.grants.length, total)`。非限流时该值与现状等价（已推导：无权威数据时 `remaining = limit - grants.length`；有权威数据时 `used` 本来就等于 `grants.length`）。

UI 折叠摘要（`WorkStatusRateLimitSection.tsx`）：账号处于限流时显示 `限流至 {countdown}`，否则显示 `used/limit`；排队计数保持不变。

### 2. 无时间信息的连续 429 退避

`AccountState` 新增 `consecutive429: number`。

- 429 且有网关时间：`limitedUntil = gatewayNext`，`consecutive429 = 0`。
- 429 且无网关时间：
  - 只有先前冷却已过期（或首次）才 `consecutive429 += 1`；冷却期内的重复 429 不增加。
  - `base = grants.length > 0 ? windowMs : FALLBACK_COOLDOWN_MS`。
  - `cooldown = min(base * 2^(consecutive429-1), MAX_BACKOFF_MS)`。
  - `limitedUntil = max(localNext, at + cooldown)`，保留原有“窗口结束时间”下界。
- 成功响应（`status < 400` 且非 429）清零 `consecutive429`。
- `retryAtFor()`：`limitedUntil` 有效时直接返回它，避免被更早的本地窗口结束时间提前唤醒。

### 3. 按模型隔离——结论：不做

保留账号级冷却。后续可单独做的只是“在面板标注触发限流的 provider/model”，不影响限流范围。

## 测试

- `runtime.test.js`：限流时 `used=1`；连续 429 退避 60s→120s；同一冷却内重复 429 不叠加；成功响应清零；网关 retry-after 不升级；退避期间 `retryAt` 不被窗口提前。
- `WorkStatusRateLimitSection.test.tsx`：限流账户的折叠摘要包含 `limited until`/`0:38` 与 `1 queued`，且不含 `1/100`。
