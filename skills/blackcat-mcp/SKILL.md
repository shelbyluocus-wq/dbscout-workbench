---
name: blackcat-mcp
description: 使用 243 上的黑猫 MCP 查看授权的 MySQL 表、改单元格或查询本账号的操作记录。用户提到服务端黑猫、表结构、按主键改值或 SVN 操作审计时使用。
---

使用 Codex 中名为 `blackcat` 的服务端 MCP，内网地址为 `http://192.168.1.243:8767/mcp`。未配置的电脑可使用管理员发放的个人令牌，将它设为 Codex 启动环境中的 `BLACKCAT_MCP_TOKEN`，再运行以下命令并打开新会话。

```sh
codex mcp add blackcat --url http://192.168.1.243:8767/mcp --bearer-token-env-var BLACKCAT_MCP_TOKEN
```

- 用 `get_identity` 核对黑猫账号和 SVN 用户名，用 `list_connections` 获取授权的连接 ID。连接列表为空时，请用户指定要授权的数据库与范围。
- 243 上的 MySQL 验收只使用已运行的 `192.168.1.243:8306` 实例，测试写入限定在已授权的测试表。
- 用 `list_tables` 和 `describe_table` 核对表与主键。用 `read_table_page` 读取数据并按 `nextOffset` 翻页。字段值以字符串或 `null` 返回。
- 改值前读回目标、完整主键和旧值，确认用户已授权这项修改。用 `update_cell` 传入 `connectionId`、`table`、`primaryKey`、`column`、`expectedValue`、`newValue`、`confirmed: true` 和本次操作的 UUID `requestId`。
- 用 `list_operation_records` 核对写入记录，报告操作账号、SVN 用户名、旧值、新值和状态。遇到 `mcp_pending` 或提交结果不明时，先读当前值并核对原审计 ID，再决定后续操作。
