# 内置数据库 Agent 重构方案：引擎直接使用 Claude Code（Agent SDK）

## Context（为什么做、目标是什么）

项目里现有一个内置 AI 助手（`ask_database_assistant`，OpenAI `/responses` 单次阻塞调用），几乎不可用：

- 无流式输出
- 过程全黑盒
- 无计划模式
- 无写能力
- 对话不持久化

经访谈澄清，真正的需求不是手写一个 agent loop，而是：**内置 Agent 的引擎就是 Claude Code 本身**——直接调用 Claude Code。它有什么能力（计划模式、扩展思考、工具调用、子 agent、权限系统、流式、会话恢复等），内置 Agent 就原样拥有。

因此，本项目的工作量集中在两件事：

1. **自定义前端 UI/UX**：在 Tauri/Vue app 里做一套自己的界面，驱动 Claude Code，并把它的流式输出（思考块、工具步骤、计划卡、权限批准）渲染成项目风格。
2. **喂足上下文 + 数据库能力**：把当前连接/库/表/schema 注入，并把现有 `db.rs` 的读/查/写能力封成 Claude Code 能调用的 MCP 工具。

底层数据访问能力已具备且安全，直接复用：

- `db::read_schema`
- `db::read_db_page`
- `db::search_value_matches_in_database`
- `db::list_*`
- `db::escape_ident`（参数化绑定）

## 已确认决策

| 维度 | 决策 |
|---|---|
| 引擎/调用方式 | Claude Code，经 Claude Agent SDK（TypeScript），跑在 Node sidecar |
| 依赖/认证 | 假设本机已装 Claude Code 并登录；端点/key/model 在 App 设置里可配，经 env 注入 |
| 模型端点 | 做成可配置（base URL / key / model），运行时填；不预置翻译代理（端点须为 Anthropic 格式，OpenAI 格式需用户自备 LiteLLM 类代理） |
| 数据库接入 | in-process MCP 工具（`createSdkMcpServer + tool()`），handler 回调 Rust 复用 `db.rs` |
| 工具范围 | 完整工具集（文件/Bash/Web 内置工具 + DB MCP 工具） |
| 计划模式 | Claude Code 原生 `permissionMode: 'plan'`：研究 → 出计划 → 批准 → 执行 |
| 写批准 | 原生 `canUseTool`：写工具弹批准卡；本会话“自动批准写”开关（开则自动 allow） |
| 流式/思考 | 原生：assistant 的 `text` / `thinking` blocks + `includePartialMessages` delta |
| 历史持久化 | 原生会话：`sessionId` / `resume` / `listSessions` / `getSessionMessages` |

## 关键 SDK 事实（已核实官方文档，方案据此设计）

- `query({ prompt, options })` → 异步生成器 `Query`。
  - `prompt` 传 `AsyncIterable<SDKUserMessage>` 进入流式输入模式。
  - 一个长生命周期 `query` = 一个会话，多轮。
  - `Query` 暴露：`interrupt()` / `setPermissionMode(mode)` / `setModel()` / `close()`。
- `Options` 用到：
  - `systemPrompt: { type: 'preset', preset: 'claude_code', append }`
  - `mcpServers`
  - `canUseTool`
  - `permissionMode`：`'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk'`
  - `allowedTools` / `disallowedTools`
  - `includePartialMessages`
  - `resume` / `sessionId` / `forkSession`
  - `model` / `fallbackModel`
  - `env`
  - `cwd`
  - `abortController`
  - `settingSources`
- 产出消息：
  - `system(init，含 session_id)`
  - `assistant(message.content blocks: { type: 'text' } / { type: 'thinking' } / { type: 'tool_use', id, name, input })`
  - `result(subtype, result, total_cost_usd, permission_denials)`
  - 开启 `includePartialMessages` 时有 partial delta。
- 自定义工具：
  - `tool(name, desc, zodSchema, handler, { annotations: { readOnlyHint } })`
  - `createSdkMcpServer({ name: 'dbscout', tools: [...] })`
  - 挂 `mcpServers: { dbscout: server }`
  - 工具全名：`mcp__dbscout__<tool>`
  - handler 返回：`{ content: [{ type: 'text', text }], structuredContent?, isError? }`（`isError: true` 不中断 loop）
- 权限求值顺序：`hooks → deny → ask → permissionMode → allow → canUseTool`。
  - plan 模式下写工具一定走 `canUseTool`（即使在 allow 里）。
  - `canUseTool(toolName, input, { signal, suggestions, toolUseID }) => { behavior: 'allow', updatedInput } | { behavior: 'deny', message }`。
- 自定义端点：
  - `env: { ...ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL }`
  - 进程启动读一次。

## 架构总览（三层）

```text
Vue 前端（自定义 UI）
  ⇄ Rust（Tauri, broker + DB）
  ⇄ Node sidecar（Agent SDK + DB MCP 工具）
  ⇄ Claude Code / 模型

Vue ⇄ Rust: invokeWorkbench / window.emit("agent-event")
Rust ⇄ sidecar: stdio JSON-lines
sidecar ⇄ Claude Code: SDK
```

- **Node sidecar** 持有 Agent SDK：
  - 跑 `query()` 流式输入模式。
  - 定义 DB MCP 工具。
  - 实现 `canUseTool`，把批准请求经 Rust 上抛前端并 await 决定。
  - 把 SDK 消息（`text` / `thinking` / `tool_use` / `result` / `partial`）转成 JSON 行写 stdout。
- **Rust** 作 broker：
  - spawn/kill sidecar 并注入 env（`ANTHROPIC_*` + 会话配置）。
  - 把 sidecar stdout 事件经现有 `window.emit("agent-event", …)` 转给前端（复用 `search_values` 同款模式）。
  - 把前端动作（发消息/批准/切模式/中断）经 stdin 下发。
  - 响应 sidecar 的 `db_request`（用 `reqId` 关联）→ 调现有 `db.rs` 针对当前连接池执行 → 回 `db_response`。
  - 全程仅走 stdio，不开任何监听端口。
- **Vue 前端**：
  - 渲染 transcript（思考/工具步骤/计划卡/批准卡/答案 markdown）。
  - composer（计划/执行模式开关 + 自动批准写开关 + 发送/停止）。
  - 会话历史。
  - 设置（端点/key/model）。

## sidecar ⇄ Rust 协议（stdio JSON-lines）

### Rust → sidecar

```json
{ "op": "start", "context": {}, "env": {}, "resumeSessionId": "...", "permissionMode": "plan" }
{ "op": "user_message", "text": "..." }
{ "op": "approval_response", "approvalId": "...", "decision": "allow" }
{ "op": "set_mode", "mode": "default" }
{ "op": "set_auto_approve", "on": true }
{ "op": "interrupt" }
{ "op": "db_response", "reqId": "...", "ok": true, "data": {} }
{ "op": "shutdown" }
```

### sidecar → Rust

```json
{ "ev": "system_init", "sessionId": "..." }
{ "ev": "thinking_delta", "text": "..." }
{ "ev": "text_delta", "text": "..." }
{ "ev": "tool_use", "id": "...", "name": "...", "input": {} }
{ "ev": "tool_result", "id": "...", "summary": "...", "isError": false }
{ "ev": "plan", "text": "..." }
{ "ev": "approval_request", "approvalId": "...", "toolName": "...", "input": {} }
{ "ev": "result", "subtype": "...", "costUsd": 0.01 }
{ "ev": "error", "message": "..." }
{ "ev": "db_request", "reqId": "...", "fn": "...", "args": {} }
```

Rust 把 `ev:*` 直接 `window.emit("agent-event", payload)` 给前端；`db_request` 例外，由 Rust 本地处理。

## 权限与计划流程

- 读类 MCP 工具自动放行、可并行：
  - `list_databases`
  - `list_tables`
  - `describe_table`
  - `sample_rows`
  - `search_schema`
  - `search_values`
  - `run_read_query`
  - 配置：放进 `allowedTools` + `readOnlyHint: true`
- 写工具走批准门：
  - `mcp__dbscout__run_write_query`
  - 内置 `Write` / `Edit` / `Bash` 等
  - 配置：不在 `allowedTools` → 走 `canUseTool` → sidecar 发 `approval_request`（含 SQL/命令）→ 前端弹批准卡 → 决定回传。
  - 开启“自动批准写”时，sidecar 直接 allow。
- 计划模式：
  - `permissionMode: 'plan'` 启动。
  - Claude 只读调研（读工具自动放行）→ `ExitPlanMode` 经 `canUseTool` 上抛计划文本 → 前端计划卡。
  - 批准：`q.setPermissionMode('default')` 并 allow，进入执行。
  - 拒绝：保持 plan，并把用户反馈作为新消息。
  - 纯分析问题：计划即分析思路，批准后直接产出答案。
  - 含写问题：执行阶段每条写仍走写批准门（除非自动批准）。
- 执行模式：
  - `permissionMode: 'default'`。
  - 读直接流式作答，仅写走批准门。

## 上下文注入

- `systemPrompt.append` 写入：
  - 当前连接 label
  - 活动数据库
  - 活动表
  - 紧凑 schema 摘要（表清单 + 活动表列）
  - 可跨库说明
  - DB 工具用法约定（先 `search_schema` 再 `describe` / `sample`，写前必须用 `run_write_query` 走批准）
- 另提供 `get_context` MCP 工具供 Agent 主动拉取。
- 活动表/库切换时，下一条 `user_message` 前附一行上下文变更说明。

## DB MCP 工具

sidecar 定义，handler 经 `db_request` 回调 Rust 复用 `db.rs`。

### 工具列表

- `list_databases`
- `list_tables`
- `describe_table`
- `sample_rows`
- `search_schema`
- `search_values`
- `run_read_query(sql)`
- `run_write_query(sql)`

### 约束

- `run_read_query(sql)`：Rust 侧 `sql_guard` 强制只读 + 注入 `LIMIT`。
- `run_write_query(sql)`：Rust 侧事务执行，仅在 `canUseTool` 放行后执行。
- 读工具：`readOnlyHint: true`。
- 写工具：`readOnlyHint: false`，`destructiveHint: true`。

## 关键文件

### 新增 sidecar

- `sidecar/agent-runner.mjs`
  - Agent SDK 驱动
  - DB MCP 工具
  - stdio 协议
- `sidecar/package.json`
  - 依赖 `@anthropic-ai/claude-agent-sdk`、`zod`
- 打包方式：
  - 用 esbuild 打包到 `src-tauri/resources/`
  - Tauri 作 resource 随包分发
  - Node 运行时复用本机（Claude Code 依赖 Node）

### 新增 Rust

- `src-tauri/src/agent/mod.rs`：sidecar 生命周期 + broker
- `src-tauri/src/agent/protocol.rs`：协议结构 `serde`
- `src-tauri/src/agent/db_bridge.rs`：`db_request` 分发到 `db.rs`
- `src-tauri/src/agent/sql_guard.rs`：只读校验 + `LIMIT` 注入，含单测
- `src-tauri/src/agent/store.rs`：端点/key/model 配置持久化；会话列表代理 SDK

### 修改 Rust

- `lib.rs`：注册 `agent_*` 命令 + `AppState` 持有 sidecar 句柄
- `types.rs`：新结构
- `commands.rs`：删除旧 `ask_database_assistant` 及相关约 1300 行

### 复用 Rust

- `db.rs`
  - `read_schema`
  - `read_db_page`
  - `search_value_matches_in_database`
  - `list_*`
  - `escape_ident`

### 新增前端

- `composables/useAgent.js`
  - `listenWorkbenchEvent("agent-event")` 拼装 transcript
  - `invokeWorkbench("agent_*")` 动作
- 组件：
  - `AgentPanel.vue`
  - `AgentMessage.vue`
  - `AgentThinkingBlock.vue`
  - `AgentToolStep.vue`
  - `AgentPlanCard.vue`
  - `AgentApprovalCard.vue`
  - `AgentComposer.vue`
  - `AgentSessionList.vue`
  - `AgentSettings.vue`
- 轻量 markdown 渲染答案。

### 修改前端

- `MySqlWorkbench.vue`
  - 集成入 inspector 槽
  - 传富上下文
- `mock/mockBackend.js`
  - 模拟 `agent-event` 流
  - 保浏览器开发可用
- 复用 `utils/tauriBridge.js` 的 `listenWorkbenchEvent`。

### 删除前端

- `useAiAssistant.js`
- `AiAssistantPanel.vue`

## Rust `agent_*` 命令

- `agent_start_session(context, config)`
- `agent_send(text)`
- `agent_approve(approvalId, decision)`
- `agent_set_mode(mode)`
- `agent_set_auto_approve(on)`
- `agent_abort()`
- `agent_list_sessions()`
- `agent_load_session(id)`
- `agent_delete_session(id)`
- `agent_get_config()`
- `agent_set_config(cfg)`

## 实施顺序（建议分阶段提交）

1. **sidecar 骨架**：`agent-runner.mjs` 用 SDK 跑通“一句话 → 流式 assistant text”，stdio 协议最小集；Rust spawn + `window.emit` 把 `text_delta` 透传前端；前端最小渲染。
2. **思考 + 工具步骤**：开 `includePartialMessages`，接 `thinking_delta` / `tool_use` / `tool_result` 渲染。
3. **DB MCP 工具 + db_bridge**：sidecar 定义读工具 → `db_request` 回调 Rust → `db.rs`；`run_read_query` + `sql_guard`（单测）；上下文注入。
4. **计划模式 + 批准**：`permissionMode: 'plan'` + `canUseTool` + `ExitPlanMode` 计划卡 + `agent_approve` + `setPermissionMode` 执行；abort。
5. **写能力**：`run_write_query`（事务）+ 写批准门 + 自动批准开关。
6. **持久化 + 配置**：会话 resume/list/load/delete + 端点/key/model 设置落盘。
7. **前端组件化打磨 + mock 事件流 + 完整工具集放开**：文件/Bash/Web。
8. **删旧实现，补测试**。

## 验证

- Rust：
  - `cd src-tauri && cargo check`
  - `cargo test`
  - 覆盖：`sql_guard` 只读 / `LIMIT` / 多语句拒绝、协议序列化、`db_bridge` 分发。
- JS：
  - `node --test src/workbench`
  - 覆盖：`useAgent` 事件流拼装 transcript、计划/写批准、abort、会话恢复。
  - 可参考现有 `useAiAssistant.test.js`。
- sidecar：
  - node 单测协议/工具装配，或最小冒烟。
- 浏览器：
  - `npm run dev` + mock `agent-event` 流。
  - 验证思考/工具/计划/批准/答案 UI。
- 真实端到端：
  - `export DBSCOUT_MYSQL_URL=...`
  - `npm run tauri -- dev`
  - 前置：本机已装并登录 Claude Code；设置里按需填自定义端点/key/model。
  - 测试问题：“某玩家干了什么”。观察流式思考 → 工具步骤（`search_schema` / `run_read_query`）→ 计划卡 → 批准 → 带依据的分析答案。
  - 再测写场景（改某玩家字段）：确认走写批准门 + 事务 + 自动批准开关。
  - 关 app 重开验证会话 resume。

## 风险 / 注意

- **新增 Node sidecar 运行时**：给 Tauri + Rust + Vue 引入 Node 进程与 SDK 依赖；需打包 sidecar（esbuild 单文件 + 随包 `node_modules` 或捆绑）并解析运行时路径。
  - 前置依赖：本机 Node + Claude Code 已装并登录。
- **端点须 Anthropic 格式**：
  - OpenAI 格式需用户自备 LiteLLM / claude-code-proxy。
  - 非 Claude 模型可能掉计划 / 思考 / 工具能力。
  - 自签名 TLS 需 `NODE_EXTRA_CA_CERTS`。
- **完整工具集风险**：
  - 文件/Bash/Web 全开。
  - 给 Claude Code 设 `cwd` 到受控目录。
  - 写类与 Bash 经 `canUseTool` 批准门兜底。
  - 必要时用 `disallowedTools` 收敛高危项。
- **API key 本地明文存储**：桌面工具可接受，后续可迁 OS keychain。

## 假设（如需调整请在审批时说明）

- Agent 仍位于右侧 inspector 面板（增强 + 可展开），不另建独立全屏视图。
- sidecar 用 TypeScript + esbuild 打包；Rust 经 stdio 作唯一 broker（不开 TCP 端口）。
- 答案用一个轻量 markdown 渲染（必要时新增极小依赖）。
