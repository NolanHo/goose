---
type: ChangeSpec
title: ACP Gateway — compression, disconnect tolerance, and multi-client fan-out
description: A proxy between ACP clients (Web/桌面) and goosed that adds WebSocket compression, keeps the goosed connection alive when clients disconnect, and broadcasts goosed output to all connected clients.
tags: [goose-web, acp-gateway]
timestamp: 2026-07-25T17:00:00Z
---

# ACP Gateway Spec

## 背景

goosed 通过 ACP 协议（WebSocket）与客户端通信。当前存在三个问题：

1. **断连打断**：浏览器刷新/关闭时 WS 断开，ACP SDK 的 `Connection::shutdown()` 调用 `agent_handle.abort()`，直接杀掉正在执行的 `reply()` stream，prompt 被终止。goosed **不**支持客户端断连后继续执行。
2. **无压缩**：goosed 的 WS 不支持 `permessage-deflate`。9 MB 的 session replay 全量传输。
3. **单连接单客户端**：ACP 的通知（`session/update`）只发给发起请求的那条 WS 连接的 `cx`。多个客户端无法同时看到同一个 session 的实时输出。

## 目标

一个 ACP 网关进程，位于客户端和 goosed 之间：

```
客户端 A (Web, ws+deflate) ─┐
客户端 B (桌面, ws+deflate) ─┼──→ 网关 (:39249) ──→ goosed (:39247, ws 无压缩)
                            │     (1 条上游 WS)       (持久不断开)
```

### 三个需求

1. **断连不打断**：客户端断开时，网关到 goosed 的上游 WS 保持不断。prompt 继续执行。客户端重连后自行 `session/load` 重放恢复。
2. **压缩**：网关的下游（客户端侧）WS 启用 `permessage-deflate`。
3. **fan-out**：goosed 的消息广播给所有连着的下游客户端。单个客户端发消息时转发给 goosed。

## 契约

### 上游连接（网关 → goosed）

- 一条持久的 WebSocket 连接到 goosed 的 `/acp` 端点。
- 不支持 permessage-deflate（goosed 不支持）。
- 连接建立时发送一次 `initialize`，缓存响应。
- 客户端断连时**不关闭**上游 WS。
- 上游 WS 断开时（goosed 重启等）自动重连，重连后重新 `initialize`。
- 网关收到上游消息时，转发（fan-out）给所有活跃的下游客户端。

### 下游连接（客户端 → 网关）

- 多个客户端可同时连接。
- 启用 `permessage-deflate`（threshold 1024 字节）。
- 客户端发来的 JSON-RPC 消息原样转发给 goosed 上游，**不解析不修改**，但 `initialize` 除外（见下）。
- `initialize` 拦截：第一个客户端的 `initialize` 转发给 goosed 并缓存响应；后续客户端的 `initialize` 直接返回缓存的响应（因为 goosed 每个 WS 连接只接受一次 `initialize`）。

### fan-out 行为

- goosed 发来的每条消息，广播给**所有**活跃的下游客户端。
- 如果没有客户端连着，消息**丢弃**（不缓冲）。客户端重连后通过 `session/load` 从 goosed 数据库重放恢复，不依赖缓冲。
- 客户端发来的消息只转发给 goosed，**不**回传给其他客户端（避免 echo）。

### 不变量

- 网关无状态：不缓冲消息，不维护 session 状态，不做消息去重。
- 网关是透明代理：除了 `initialize` 拦截外，不解析、不修改、不重排 JSON-RPC 消息。
- 上游 WS 生命周期独立于任何下游客户端的生命周期。

### 关键约束：ws 库 perMessageDeflate 冲突

`ws` 库 8.19.0 在同一个 Node 进程中，当 `WebSocketServer`（下游，启用 perMessageDeflate）有活跃连接时，在同一进程内创建的 `WebSocket` 客户端（上游，连 goosed）的 `on('message')` 回调**不触发**。已确认：不启用 perMessageDeflate 时正常；启用后即使 WSServer 空闲也可能复现。

**解决方案**：上游 WS 客户端不使用 `ws` 库，改用 Node.js 内置的 `WebSocket`（undici/global）。Node 25 的全局 `WebSocket` 不受 `ws` 库的 WSServer 影响。下游 WSServer 继续用 `ws` 库（支持 perMessageDeflate）。

### 排除项

- 不缓冲断连期间的消息（客户端靠 `session/load` 重放恢复）。
- 不处理多客户端并发输入冲突（用户不会同时操作两个客户端）。
- 不做权限/认证/多用户隔离（单用户，goosed 的 token 鉴权已够）。
- 不做 HTTP 路由代理（`/health`、`/status` 等辅助路由仍由 Vite proxy 或直接访问 goosed 处理）。
- 不修改 goosed 或 ACP SDK 的任何代码。

## 交付物

### 1. 网关进程 `gateway.mjs`

**位置**：`ui/web/gateway.mjs`（git-excluded，web 专用）

**行为**：
- 监听 `GATEWAY_PORT`（默认 39249）的 WebSocket 服务，启用 perMessageDeflate。
- 维护一条到 goosed 的上游 WS（全局 `WebSocket`，非 `ws` 库），持久不断开，自动重连。
- 下游客户端消息原样转发上游（`initialize` 拦截并缓存）。
- 上游消息 fan-out 给所有活跃下游客户端。
- 可配置 goosed host/port/token（从 `.env` 读取）。

**验收标准**：
- 浏览器通过网关能完成 `initialize` 握手并收到 goosed 的响应。
- 浏览器通过网关能收发消息（prompt → reply）。
- 浏览器断开 WS 后，网关上游 WS 不关闭（tmux 日志显示 "keeping goosed alive"）。
- 浏览器重连后能重新 `initialize`（收到缓存的响应）并 `session/load`。
- 两个浏览器标签同时连接，都能收到 goosed 的消息（fan-out）。

**验证方法**：
- Node 脚本模拟客户端连网关，发 `initialize` + `session/load`，确认收到响应。
- 两个 Node 脚本同时连网关，一个发消息，确认两个都收到 goosed 的通知。
- 浏览器（agent-browser）通过网关加载 GLM session，确认消息渲染正常。

### 2. 前端 shim 调整

**位置**：`ui/web/src/shim.ts`

**行为**：
- `getAcpUrl()` 返回网关地址（`ws://host:39249/acp`），而非直连 goosed 或 Vite proxy。
- 可通过环境变量配置网关端口。

**验收标准**：
- 浏览器的 ACP WebSocket 连接到网关（39249），不是 goosed（39247）或 Vite proxy。
- 通过网关的连接能正常收发消息。

**验证方法**：
- 浏览器 console 检查 WS 连接 URL。
- 端到端聊天测试。

### 3. 运维

- 网关在 tmux session `goose-gw` 中运行。
- `.env` 增加 `GATEWAY_PORT` 和 `VITE_GATEWAY_PORT` 配置。

### 4. Git 提交策略

`ui/web/` 目录当前被 `.git/info/exclude` 整体排除。提交到 fork 前需调整：

- 从 `.git/info/exclude` 移除 `ui/web/` 行（恢复 git 跟踪）。
- 新增 `ui/web/.gitignore`，排除敏感和生成文件：
  ```
  node_modules/
  .vite/
  .env
  ```
- `.env` 含 goosed token（`VITE_GOOSE_TOKEN`），**不提交**。提交 `.env.example` 作为模板。
- `package.json` 的 `dependencies` 只含 `ws`（运行时依赖），devDependencies 含 vite 等（开发时已装）。

**提交的文件**：
- `ui/web/gateway.mjs` — 网关主程序
- `ui/web/spec.md` — 本 spec
- `ui/web/.gitignore` — 排除规则
- `ui/web/.env.example` — 配置模板（不含真实 token）
- `ui/web/package.json` — 依赖声明
- `ui/web/vite.config.ts` — Vite 配置（含 /acp proxy → 网关）
- `ui/web/index.html` — HTML 入口
- `ui/web/src/shim.ts` — Web preload shim
- `ui/web/src/main.tsx` — 入口
- `ui/web/src/electron-stub.ts` — electron 模块桩

**不提交的文件**：
- `ui/web/.env` — 含真实 token
- `ui/web/node_modules/` — 依赖
- `ui/web/dist/` — 构建产物（如存在）

## 依赖与门

- **前提**：goosed（39247）运行中，token 可用。
- **前提**：P0+P1 性能修复已就位（cherry-pick PR #10665），大 session 加载不卡顿。
- **人类门**：spec review 通过后再实现。
- **排序**：实现网关 → 调整 shim → 浏览器验证 → 部署。

## 待解决

1. **~~上游 WS 用 undici `WebSocket` 是否兼容 ACP？~~** — ✅ 已验证。
2. **~~`acp-connection-id` header~~** — ✅ 已确认。前端 `createWebSocketStream.ts` 用原生 `window.WebSocket`，不读取任何响应头。SDK 的 `GooseClient` 构造也不依赖 connection_id。**网关无需处理此 header。**
3. **多客户端 `session/load` 重复 replay** — ⚠️ 可接受。`register_acp_session` 用 `HashMap::insert` 覆盖写入，不会 panic。`replay_conversation_to_client` 通过 `cx.send_notification` 发送——通知只发给发起 load 的那条连接。两个客户端各 load 各收自己的 replay，不交叉不混乱。

## Rust vs Node 决策

### 已有依赖
- workspace 根有 `axum 0.8`（未启用 `ws` feature）和 `tokio`。
- ACP SDK 用 `axum`（启用 `ws` feature）+ `async-tungstenite 0.34`。
- workspace 根**没有** `tungstenite`/`async-tungstenite`。

### 推荐：Node（已确认）

用户确认使用 Node 实现。理由：permessage-deflate 是核心需求，`ws` 库原生支持；网关逻辑极简无性能瓶颈；Web 前端已是 Node 生态。如果未来需要生产单二进制部署，再考虑 Rust 重写。
