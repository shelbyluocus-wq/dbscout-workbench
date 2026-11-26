# dbscout-server

DB Scout Workbench（黑猫）的中心服务（局域网内部署）。提供**共享用户账号**与**共享变更日志**，让所有客户端都能看到“是谁改了什么”。

- 单一 SQLite 文件存储（WAL 模式），零外部依赖。
- **每张表默认只保留最近 20 次改动**（启动时与每次写入后自动清理更早记录；同一次批量导入/多行保存按 2.5 秒窗口算作 1 次改动完整保留，避免打断历史对比；可通过环境变量 `DBSCOUT_SERVER_MAX_REVISIONS_PER_TABLE` 调整，设为 `0` 不清理）。
- **只读读取 243 定时备份目录**（默认检测 `/home/servbin/dbback`，可通过 `DBSCOUT_SERVER_GM_BACKUP_DIR` 覆盖或设为 `off` 关闭）：扫描 MySQL 备份 `.zip` 列表、列出包内表清单、按表或整库提取 SQL，供黑猫客户端「备份中心 → 快照 → 243 服务器备份」一键还原；全程只读，绝不修改或删除原备份文件。
- 仅用户名 + 不透明令牌登录，**不存密码**。安全假设：仅限公司局域网内使用，不对外网开放。
- HTTP/JSON 接口，Bearer token 鉴权。
- 独立部署在 `192.168.1.243:8766`（`/home/blackcat-server`），与 GM 服务端（`/home/gmserv`）完全隔离，互不干扰。

## 本地运行

```sh
# 默认监听 0.0.0.0:8765，数据库 ./dbscout-server.sqlite
cargo run -p dbscout-server

# 自定义
DBSCOUT_SERVER_BIND=0.0.0.0:8765 \
DBSCOUT_SERVER_DB=/data/dbscout-server.sqlite \
cargo run -p dbscout-server
```

## 部署到 192.168.1.243（推荐，与 GM 完全隔离）

所有文件和进程均独立位于 `/home/blackcat-server`，绝不修改 `/home/gmserv` 或 GM 进程：

```text
/home/blackcat-server/
├── bin/dbscout-server        # Linux 可执行程序（升级自动保留 .prev 失败回滚）
├── data/dbscout-server.sqlite # 中心库（更新程序时绝不覆盖）
├── backups/                  # 每日 04:00 自动在线热备份（保留 30 天，至少留 7 份）
├── scripts/                  # 启停与备份脚本
└── logs/                     # 兼容非 systemd 环境的运行日志
```

### 1. 首次部署或后续升级服务

```sh
# 方式 A：上传源码在 243 上编译、安装开机自启与每日备份并做健康检查
npm run server:deploy

# 方式 B：如果 243 未安装 Rust，可先在其他 Linux 环境编好二进制再直接上传
npm run server:deploy -- --binary /path/to/linux/dbscout-server

# 先演练检查（不连接 243）
npm run server:deploy -- --dry-run
```

> 首次开放内网访问前，请确认 243 防火墙已对局域网放行 `8766/tcp`。

### 2. 从旧机 `192.168.1.193` 无损迁移账号与历史记录

在旧 Windows 机（`192.168.1.193`）的项目目录执行，停止旧服务并导出干净的 SQLite 单文件：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/export-dbscout-server-db.ps1
```

然后将导出的 `dbscout-server.sqlite` 上传迁移到 `243`（默认拒绝覆盖已有非空库，且迁移前会自动备份）：

```sh
npm run server:deploy -- --migrate-db /path/to/dbscout-server.sqlite
```

升级后的黑猫客户端会将保存的旧默认地址 `http://192.168.1.193:8765` 或 `http://192.168.1.243:8765` 更新为 `http://192.168.1.243:8766`。旧库迁移完成后，原账号和登录态可继续使用。

### 3. 日常运维命令

```sh
# 查看 243 服务状态、健康检查、用户/日志数与最近备份
npm run server:deploy -- --status

# 立即触发一次在线热备份
npm run server:deploy -- --backup
```

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
| :--- | :--- | :--- | :--- |
| GET  | `/health` | 无 | 数据库连通性探活，返回 `{"status":"ok"}` |
| POST | `/register` | 无 | `{username, displayName?}` → `{userId, username, displayName, token}`；用户名已存在返回 409 |
| POST | `/login` | 无 | `{username}` → 查到即返回 `{userId, username, displayName, token}`；不存在返回 404 |
| GET  | `/me` | Bearer | 校验令牌、返回当前用户 |
| GET  | `/audit` | Bearer | 全员可见全部变更日志，支持 `connectionId/database/tableName/userId/fromTs/toTs/limit/offset` 查询参数 |
| POST | `/audit` | Bearer | 批量推送审计摘要，按 `clientId` 幂等去重，返回 `{accepted, skipped}` |
| GET  | `/audit/since` | Bearer | 增量拉取（同 `/audit` 查询参数） |
| GET  | `/audit/table-latest` | Bearer | 按表聚合最新修改时间，支持 `database` + `serverKey` / `connectionId`（跨电脑不同本地连接 ID 也能按服务器匹配） |
| GET  | `/external-changes` | Bearer | 查询单表的共享外部（非黑猫）变动节点，支持 `database`/`tableName`/`serverKey`/`limit`/`offset` |
| POST | `/external-changes` | Bearer | 批量推送工作站检测到的非黑猫表变动，自动跨工作站去重并与黑猫审计日志互相核销 |
| GET  | `/backups/gm` | Bearer | 只读扫描 243 定时备份目录（`/home/servbin/dbback`）下的 MySQL `.zip` 备份清单，支持 `database`/`date`/`limit` |
| GET  | `/backups/gm/tables` | Bearer | 解析指定备份 `.zip` 内的全部数据表列表（带元数据缓存） |
| POST | `/backups/gm/extract` | Bearer | 从指定备份 `.zip` 按表（`tables` 非空）或整库（`tables` 为空）提取 SQL 供客户端安全还原 |

## 安全说明

仅用户名登录意味着任何知道用户名的人都能登录该账号。本设计面向公司内部局域网、单用户机器场景，请勿暴露到公网。如需更强身份校验，后续可在 `users` 表增加密码哈希并扩展 `/login`。
