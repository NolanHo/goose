---
type: ChangeSpec
title: ACP Client Gateway — owns prompt lifecycle, survives browser disconnect
description: A Node gateway that is a persistent ACP client to goosed and an ACP server to browsers, so an in-flight prompt keeps running when the browser disconnects and is recoverable on reconnect.
tags: [goose-web, acp-gateway]
timestamp: 2026-07-26T09:45:00Z
supersedes: ui/web/spec.md@2026-07-25 (transparent relay)
---

# ACP Client Gateway Spec

## 背景

goosed 通过 ACP 协议（WebSocket）与客户端通信。ACP 是**请求-响应绑定连接**的协议：

- goosed 为**每条 WS 连接** `create_agent()` 一个独立 agent 实例，`active_prompt_runs` 是该实例的 per-connection 字段。
- `session/prompt` 在该连接的 agent task 里 **inline 执行**（`on_prompt` 里 `await stream.next()`），不 spawn、不 detach。
- 浏览器刷新/关闭 → WS 断开 → ACP SDK 的 `Connection::shutdown()` 调 `agent_handle.abort()` → **正在执行的 prompt 被立即终止**，goosed 不支持客户端断连后继续执行。
- 已落盘的消息经 `session_manager.add_message()` 持久化；重连后 `session/load` 能重放历史，但**断连时 in-flight 的 prompt 不会跑完**。

### 为什么旧的透明中继不够

旧网关（transparent relay）是原始 WS 帧转发：保活上游 WS、拦截 `initialize`、其余原样转发。它确实让上游 WS 不断（prompt 在 goosed 后台继续），但：

1. **不持有 prompt 生命周期**：浏览器断开时，中继没有自己的 `prompt()` 调用在等待——它只是转发帧。goosed 发出的 `session/update` 通知到达中继后**无浏览器可投递即丢弃**；重连后只能靠浏览器 `loadSession` 全量重放。
2. **无法 buffer/replay 结果流**：中继不解析消息、不按 session 路由、不缓存增量，因此丢失断连期间的实时进度。
3. **结果**：prompt 跑完了但实时过程全丢，UX 上几乎等于直连 + loadSession 兜底——"没有任何意义"。

本 spec 用**真正的 ACP client** 取代它：网关自己持有一条到 goosed 的 `GooseClient` 连接，prompt 由网关发起并 await；浏览器只是网关结果流的订阅者。

## 目标

一个 Node 网关进程，同时是 **goosed 的 ACP client** 和 **浏览器的 ACP server**：

```
浏览器 A (ws+deflate) ─┐                       ┌─ GooseClient (ACP client, 持久)
浏览器 B (ws+deflate) ─┼──→ 网关 (:39249) ─────┤   上游 WS → goosed (:39247, ?token=)
                       │   AgentSideConnection │   (undici 全局 WebSocket)
                       │   (ACP server, 每浏览器一条) │
                       └───────────────────────┘
```

### 核心需求

1. **in-flight prompt 断连存活（核心）**：浏览器在 prompt 执行中断开 WS，网关到 goosed 的上游连接不关闭，prompt 在 goosed 继续跑完并持久化。浏览器重连后能看到该 prompt 的完整结果。
2. **结果流 buffer + replay**：网关消费 goosed 的 `session/update` 流，断连期间按 session 缓存增量；浏览器重连后回放缓存的增量，再接续实时流。
3. **压缩**：下游（浏览器侧）WS 启用 `permessage-deflate`。
4. **fan-out**：同一 session 的 goosed 通知可投递给所有订阅该 session 的浏览器（多标签同看）。

## 契约

### 上游（网关 → goosed）

- 网关持有一条**持久** `GooseClient`（ACP client）连接到 goosed 的 `/acp?token=`。
- 上游 WebSocket 必须使用 Node 内置全局 `WebSocket`（undici），**不得**使用 `ws` 库的 `WebSocket` 客户端——`ws` 库的 `WSServer`（下游，启用 perMessageDeflate）与同进程 `ws` WebSocket 客户端存在 `on('message')` 不触发的冲突（已由旧网关验证）。
- 上游连接建立时发送一次 `initialize`，缓存响应。
- 上游断开（goosed 重启等）时自动重连，重连后重新 `initialize`。
- 上游 `GooseClientCallbacks` 实现：`sessionUpdate`、`requestPermission`、`unstable_createElicitation`、`unstable_sessionUpdate`、`unstable_sessionRecipeRequestParams`——这些回调把 goosed 侧的消息转发给下游浏览器（见"反向转发"）。

### 下游（浏览器 → 网关）

- 每个浏览器连接对应一条 `AgentSideConnection`（ACP server），讲完整 ACP-over-WebSocket 协议，JSON-RPC 2.0，每帧一个消息对象。
- 启用 `permessage-deflate`（threshold 1024 字节）。
- 网关实现 `Agent` 接口：标准方法（`initialize`/`newSession`/`loadSession`/`prompt`/`cancel`/`fork`/`list`/`close`/`resume`/`setSessionMode`/`setSessionConfigOption`/`setSessionModel`/`authenticate`）转发给上游 `GooseClient` 对应方法。
- goose 扩展方法（`goose/*`）走 `Agent.extMethod`/`extNotification` 通用路径，原样转发给上游 `GooseClient.extMethod`/`extNotification`（SDK 的 `default` 分支自动路由，无需逐个特判）。
- `initialize` 拦截：第一个浏览器的 `initialize` 触发上游 initialize 并缓存响应；后续浏览器直接返回缓存的响应（goosed 每 WS 连接只接受一次 `initialize`）。返回的 `InitializeResponse` 必须包含上游的真实能力位（`loadSession`/`session.fork`/`listSessions`/`session.resume` 等），否则前端对应功能被禁用。

### 反向转发（goosed → 浏览器）

上游 `GooseClient` 的回调把 goosed 侧的消息推给下游浏览器：

| 上游回调 | 下游动作 |
|---|---|
| `sessionUpdate(notification)` | `AgentSideConnection.sessionUpdate(params)`；同时写入该 session 的缓冲 |
| `unstable_sessionUpdate(notification)` | `AgentSideConnection.extNotification(method, params)` |
| `requestPermission(request)` | `AgentSideConnection.requestPermission(params)`——**await** 浏览器响应，原样返回给上游 |
| `unstable_createElicitation(request)` | `AgentSideConnection.unstable_createElicitation(params)`——**await** 浏览器响应 |
| `unstable_sessionRecipeRequestParams(request)` | `AgentSideConnection.extMethod(method, params)`——**await** 浏览器响应 |

- 通知按 `notification.params.sessionId` 路由到订阅该 session 的浏览器；无订阅者时写入该 session 缓冲（不丢弃）。
- `requestPermission`/`elicitation`/`recipeRequestParams` 是 agent→client 的 RPC 请求：网关 await 下游浏览器的响应后回传上游。这些请求带 session 上下文，路由到对应 session 的浏览器；若无浏览器在线，则返回 `cancelled`（与前端 `cancelAcpPermissionRequestsForSession` 语义一致）。

### 不变量

- **上游连接生命周期独立于任何浏览器连接**：浏览器全断开时上游 `GooseClient` 仍保持，正在跑的 prompt 继续到完成。
- **prompt 由网关持有**：浏览器发 `session/prompt` → 网关 `Agent.prompt()` → 网关调上游 `client.prompt()` 并 await。浏览器断开不影响该 await；prompt 完成后 goosed 已持久化。
- **权威恢复靠 loadSession**：浏览器重连后 re-initialize（取缓存响应）+ 对每个活跃 session `loadSession`，goosed 重放完整历史。网关的 buffer/replay 是对实时增量的补充，loadSession 是最终一致性的保证。

### 关键约束

- **运行环境**：Node 18+（提供全局 `ReadableStream`/`WritableStream`/`WebSocket`/`TextEncoder`/`AbortController`）。当前环境 Node v25.9.0。
- **上游 WS 用 undici 全局 WebSocket**，下游 WSServer 用 `ws` 库（perMessageDeflate）——避免同进程冲突（已验证）。
- **Stream 适配**：`GooseClient` 和 `AgentSideConnection` 都需要 `{ readable, writable }` 的 `Stream`。上游用 undici `WebSocket` 包出 Stream；下游用 `ws` 的 `WebSocket`（WSServer 的连接）包出 Stream。两者仿 `createWebSocketStream` 的结构，但用 Node 全局 `ReadableStream`/`WritableStream` 而非 `window.*`。
- **不修改 goosed 或 ACP SDK 的任何代码**。

### 排除项

- 不处理多客户端并发输入冲突（单用户不会同时操作两个客户端发 prompt 到同一 session）。
- 不做多用户/权限隔离（单用户，loopback，goosed token 鉴权已够）。
- 不发明自定义会话恢复协议（依赖前端既有的 loadSession replay）。
- 不做上游 perMessageDeflate（goosed 不支持）。
- 不改桌面（desktop）代码路径。

## 交付物

### 1. ACP client 网关进程

**可观察结果**：一个 Node 进程，监听 `GATEWAY_PORT`（默认 39249），对浏览器是 ACP server，对 goosed 是持久 ACP client。

**消费者**：浏览器（经 Vite dev proxy 同源 `/acp`）。

**契约属性**：
- 上游 `GooseClient` 常驻，浏览器全断开时仍活；上游断开自动重连 + re-initialize。
- 下游每浏览器一条 `AgentSideConnection`，perMessageDeflate。
- 双向转发覆盖：标准 ACP 方法 + goose 扩展 + 反向 RPC（permission/elicitation/recipeParams）。
- `initialize` 响应缓存复用。

**验收标准 + 验证方法**：

1. **握手**：Node 脚本用 `@aaif/goose-sdk` 的 `GooseClient` 连网关 `:39249`，发 `initialize`，收到含上游能力位的 `InitializeResponse`（`loadSession` 等为 true）。→ 验证：脚本断言 `response.capabilities.loadSession === true`。
2. **E2E 聊天**：脚本 `newSession` → `prompt("say hi")` → 收到 `session/update` 通知流 → `prompt` resolve 且 `stopReason` 非错误。→ 验证：脚本打印最终消息，含模型回复。
3. **goose 扩展透传**：脚本发一个 `goose/sessionInfo_unstable`（经 `client.goose.*` 或 `extMethod`），收到上游真实响应。→ 验证：返回值含 session 元数据。
4. **in-flight prompt 断连存活（核心）**：脚本 `prompt` 一个耗时请求（如让 agent 写文件/多轮工具调用）；在 prompt resolve 前断开脚本到网关的 WS；等待 prompt 在网关侧完成（网关日志/上游 `closed` 不触发）；脚本重连 → re-initialize → `loadSession` → 历史中**包含该已完成的 prompt 及其结果**。→ 验证：重连后 `loadSession` 回放的 messages 里能找到断连时发起的那条 prompt 和 agent 的完整回复。
5. **断连期间 buffer/replay**：脚本断连期间网关持续收到 `session/update` 并缓存；重连后回放这些增量（在 `loadSession` 全量重放之前或之后均可见，最终一致）。→ 验证：重连后能观察到断连期间产生的增量消息。
6. **上游断开重连**：重启 goosed（或 kill 上游 WS）→ 网关自动重连 + re-initialize → 新 prompt 正常。→ 验证：网关日志显示重连，脚本发新 prompt 成功。
7. **fan-out**：两个脚本连网关、订阅同一 session；其中一个 `loadSession` 该 session；**两个**都收到 goosed 的 `session/update` 通知。→ 验证：两个脚本的 sessionUpdate 计数均 > 0。

### 2. 前端接入

**可观察结果**：浏览器 ACP WS 经 Vite proxy 同源 `/acp` 到达网关 39249，而非直连 goosed 39247。

**消费者**：web 渲染层（`GooseClient` 实例化点不变）。

**契约属性**：
- `shim.ts` 的 `acpWebSocketUrl()` 返回同源 `/acp?token=`（与直连版一致，不改）。
- `vite.config.ts` 的 `/acp` proxy target 从 goosed 39247 改为网关 39249（`ws: true`）；`/health`、`/status` 仍走 goosed 39247（网关不处理 HTTP）。

**验收标准 + 验证方法**：
- 浏览器 console 中 ACP WS URL 为同源 `/acp`，经 Vite proxy 到 39249。→ 验证：DevTools Network/WS 面板。
- 浏览器通过网关完成 initialize + 聊天，消息正常渲染。→ 验证：agent-browser 加载页面，发消息，确认渲染。
- 浏览器刷新页面（断连+重连）后，会话历史恢复，进行中的 prompt（若有）结果可见。→ 验证：刷新前后对比。

### 3. 运维

- 网关在 tmux session `goose-gw` 中运行（`node gateway.mjs`）。
- `.env` 复用既有 `VITE_GOOSE_TOKEN`（网关→goosed 鉴权）；`GATEWAY_PORT` 默认 39249。
- 网关依赖 `@aaif/goose-sdk`（workspace 已有）+ `@agentclientprotocol/sdk`（goose-sdk 的 peer，已装）+ `ws`（已有）。不新增运行时依赖。

## 依赖与门

- **前提**：goosed（39247）运行中，token 可用。
- **前提**：`@agentclientprotocol/sdk` 已安装（`ui/node_modules/@agentclientprotocol/sdk`，提供 `AgentSideConnection` + `GooseClient` 转发所需 API）。
- **人类门**：本 spec review 通过后再实现。
- **排序**：实现网关 → 调整 vite.config → 浏览器验证 → subagent 独立审查。

## 待解决

无。所有关键决策已由代码证据解决：
- 上游 WS 用 undici 全局 WebSocket（已由旧网关验证）。
- `AgentSideConnection` 的 `default` 分支路由 goose 扩展（SDK 源码 acp.js:140/195 确认）。
- `GooseClient` 可在 Node 运行（零 `window` 依赖，Stream 纯结构类型）。
- 前端已有重连 + loadSession replay（acpConnection.ts / ChatSessionsContainer.tsx 确认）。
