# 黑猫 MCP 服务器（只读查询 + 界面控制 + 受控 XLSX 导入导出）

## 总体架构

```
AI 客户端 (Codex / Claude Code / Cursor ...)
   │ MCP stdio
   ▼
mcp-server.mjs（Node，随应用打包，用内置 Node 运行时启动）
   │ JSON-lines over 127.0.0.1 TCP + token 鉴权
   ▼
Rust 控制端点（应用进程内；应用未运行时由 MCP 隐藏启动）
   ├─ 只读 DB 请求 → 复用 agent/db_bridge.rs + sql_guard.rs
   └─ UI 动作 → 发窗口事件 → 前端复用现有 workbench_action 处理逻辑
```

数据库层默认只读，不开放任意写 SQL、单元格编辑、删表或 DDL。唯一写入例外是两阶段 XLSX 整表导入，并由 Rust 在真正修改数据库前强制生成原表 XLSX 备份。

## Rust 侧：本地控制端点

新模块 `src-tauri/src/control_server.rs`：

- 应用启动时（`lib.rs` setup 中 spawn）监听 `127.0.0.1` 随机空闲端口，协议为 JSON-lines over TCP（与 sidecar stdio 协议同风格，不引入 HTTP 框架依赖）。
- 每次启动生成随机 token，连接后首条消息必须携带 token，否则断开。
- 把 `{ port, token, pid, version, protocolVersion }` 写入应用数据目录下的发现文件（如 `control-endpoint.json`），应用退出时清理；配置与发现文件只允许当前用户访问（Unix 为 `0600`）。
- 外部 MCP 默认开启，用户仍可在黑猫 AI 设置中关闭；状态页显示控制服务和已连接客户端数量。
- 请求分两类：
  - `db_tool`（list_databases / list_tables / describe_table / sample_rows / search_schema / search_values / run_read_query）：直接调用 `agent/db_bridge.rs` 的分发逻辑；`run_read_query` 沿用 `agent/sql_guard.rs` 的只读校验 + LIMIT 上限。白名单硬编码，写类工具名一律拒绝。
  - `ui_action`（open_table / focus_column / focus_row / focus_cell / reveal_window）：`reveal_window` 直接调 `window_reveal`；其余向主窗口 emit 新事件 `control-workbench-action`，payload 与现有 `workbench_action` 事件一致，并顺带唤起主窗口。
  - `export_table`：通过表会话分页读取整表，在 `Documents/DB Scout Workbench/Agent Files` 新建 XLSX，不覆盖已有文件。
  - `import_table`：只接受已解析、已确认的整表替换请求；固定传入 `requireXlsxBackup=true`，备份失败立即取消导入。
- `get_context` 同时合并 Rust 当前连接/数据库与前端实际活动标签页、页码、已加载行和字段。
- UI 动作不是“事件发出即成功”：Rust 等待前端完成回执，只有首屏数据可用或定位完成后才向 MCP 返回成功；30 秒超时返回失败。

## 前端：复用 UI 动作处理

- `useAgent.js` 同时接收内置 Agent 与外部控制事件，外部事件额外维护完成回执，不改变内置 Agent 的消息结构。
- 前端 ready 后接收启动阶段排队的 UI 动作；卸载时主动标记 unready。
- workbench 持续上报真实活动上下文。打开表以首屏加载完成为成功点，不等待后台总数和预取；定位不到字段/当前已加载行时返回明确失败，不伪报成功。

## MCP 服务器（Node）

新文件 `sidecar/mcp-server.mjs`（+ 拆出的 `sidecar/controlClient.mjs` 负责发现文件读取、TCP 连接、token 握手、请求-响应配对）：

- 依赖 `@modelcontextprotocol/sdk`（stdio transport），在 `sidecar/package.json` 新增。
- 工具集：
  - UI：`open_table`、`focus_column`、`focus_row`、`focus_cell`、`reveal_window`
  - 只读：数据库知识概览、`list_databases`、`list_tables`、`describe_table`、`sample_rows`、`search_schema`、`search_values`、`run_read_query`
  - 上下文：`get_workbench_context`
  - 文件：`export_table_xlsx`、`preview_import_xlsx`、`import_table_xlsx`
- 导入是两阶段协议：先预览并校验文件大小、行数、字段映射和主键，生成 15 分钟有效的 `previewId`；执行时必须再次传 `confirmReplace=true`，且文件摘要必须与预览时一致。
- MCP 单次导入上限：20 MB XLSX、5 万行、200 万单元格；超限时提示使用黑猫内置批量导入。
- 应用未运行或发现文件过期时，MCP 使用注册配置中的 `--app-executable` 路径，以 `--mcp-headless` 参数启动隐藏后台实例并等待控制端点就绪。隐藏启动不弹窗；调用打开表、定位或显示窗口工具时才显示主界面。
- `sidecar/scripts/build.mjs` 增加第二个 esbuild 入口，把 `mcp-server.mjs` 打包进 `src-tauri/resources/`，用户用安装目录里的内置 Node 启动：
  `codex mcp add blackcat -- <安装目录>/resources/node/node.exe <安装目录>/resources/mcp-server.mjs --app-executable <黑猫程序路径>`

## 安全边界

- 仅 loopback 监听 + 每次启动随机 token，发现文件放用户数据目录（同用户可读）。
- Rust 端白名单是最终裁决：即使 MCP 层被篡改，写类工具名到达控制端点也会被拒绝。
- `run_read_query` 复用现有 sql_guard 只读校验与行数上限，不新开口子。
- 导入是唯一数据库写入口，必须显式确认。MySQL 在事务中锁定并读取原表，原表数据的 XLSX 备份落盘成功后才计算和执行变更；任何备份错误都会回滚事务。
- XLSX 无法无损表达的超长单元格（超过 32767 字符）会让备份失败并取消导入，不能静默截断。

## 测试计划

- Rust（`cargo test`）：非白名单写工具被拒；协议/发现信息完整；UI 参数校验；XLSX 路径与单元格限制。
- Node（`node --test`，node:test 风格）：`controlClient` 的发现文件解析、token 握手、请求-响应配对；MCP 工具注册表没有 `run_write_query`；导入必须预览、确认并传递映射数据。
- 前端（现有 workbench 测试体系）：`applyWorkbenchAction` 抽取后 useAgent 原有 workbench_action 测试保持通过；新增 control 事件监听触发打开表的用例。
- 手工验收：黑猫完全退出后，真实挂到 Codex 并读取表时仅启动隐藏后台实例；说“打开 player 表”后应用窗口前置且首屏可用；SELECT 能返回结果；UPDATE 无工具可调用；导出产生 XLSX；导入先产生原表备份，随后界面刷新。

## 假设

- 第一版不开放通用写能力；XLSX 整表导入是经过预览、显式确认和强制备份的唯一例外。
- MCP 服务器进程生命周期由 AI 客户端管理（stdio 模式），应用侧不感知它的存活。
- 发现文件里的 token 明文存放在当前用户数据目录，视同本机同用户可信边界（与浏览器 devtools 端口同级别假设）。
