# dbscout-server

DB Scout Workbench 的中心服务（局域网内部署）。提供**共享用户账号**与**共享变更日志**，让所有客户端都能看到"是谁改了什么"。

- 单一 SQLite 文件存储，零运维。
- 仅用户名 + 不透明令牌登录，**不存密码**。安全假设：局域网可信、令牌不公开分发。
- HTTP/JSON 接口，Bearer token 鉴权。

## 运行

```sh
# 默认监听 0.0.0.0:8765，数据库 ./dbscout-server.sqlite
cargo run -p dbscout-server

# 自定义
DBSCOUT_SERVER_BIND=0.0.0.0:8765 \
DBSCOUT_SERVER_DB=/data/dbscout-server.sqlite \
cargo run -p dbscout-server
```

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/register` | 无 | `{username, displayName?}` → `{userId, username, displayName, token}`；用户名已存在返回 409 |
| POST | `/login` | 无 | `{username}` → 查到即返回 `{userId, username, displayName, token}`；不存在返回 404 |
| GET  | `/me` | Bearer | 校验令牌、返回当前用户 |
| GET  | `/audit` | Bearer | 全员可见全部变更日志，支持 `connectionId/database/tableName/userId/fromTs/toTs/limit/offset` 查询参数 |
| POST | `/audit` | Bearer | 批量推送审计摘要，按 `clientId` 幂等去重，返回 `{accepted, skipped}` |
| GET  | `/audit/since` | Bearer | 增量拉取（同 `/audit` 查询参数） |

## 安全说明

仅用户名登录意味着任何知道用户名的人都能登录该账号。本设计面向公司内部局域网、单用户机器场景。如需更强身份校验，后续可在 `users` 表增加密码哈希并扩展 `/login`。
