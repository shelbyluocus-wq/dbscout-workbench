# dbx 项目调研与黑猫对比分析

> 调研对象：https://github.com/t8y2/dbx （本地克隆：`E:/project/dbx`，v0.5.71）
> 对比对象：黑猫 DB Scout Workbench（本仓库）
> 调研方式：四路代码级深挖（架构与驱动 / 前端 UX / AI·MCP·CLI·Web / 后端核心与工程实践），结论均有源码证据。

---

## 一、dbx 是什么

dbx 是一个开源的 DBeaver/TablePlus 替代品， slogan 是 "20 MB 驾驭 70+ 种数据库"。

- **技术栈与黑猫相同**：Tauri 2 + Vue 3 + Rust（前端 TypeScript + shadcn-vue + Tailwind）。
- **四种交付形态**：桌面端（Win/macOS/Linux，含 Win7 专项构建）、Web（Docker 自托管，axum 后端）、CLI（`dbx query local "select 1"`）、MCP Server（让 Claude Code/Cursor 直接用已配置的连接）。
- **20MB 的秘密**：主二进制只编译约 15 个原生 Rust 驱动（MySQL/PG/SQLite/SQLServer/Mongo/Redis + 一批 reqwest 手写 HTTP 客户端）；其余约 40 种数据库走**外挂 Agent 进程**（Java JDBC agent / Go 原生 agent），由"驱动商店"在运行时按需下载，含托管 JRE 21、离线包导入、版本治理。
- **单核心库架构**：所有数据库逻辑在 `crates/dbx-core`；Tauri 壳、Web 后端、CLI、MCP 都是薄入口，共享同一批 `*_core()` 业务函数和同一个 SQLite 存储 `dbx.db`。

规模体感：`dbx-core` 单 crate 100+ 模块；前端 DataGrid.vue 一个组件 1 万行；CI 528 行按变更域条件触发。是一个投入量远超黑猫的成熟开源项目。

---

## 二、功能维度：dbx 比黑猫多出了什么

按对黑猫的参考价值排序。

### 2.1 数据库引擎广度：驱动商店 + Agent 进程架构

- 黑猫：MySQL（sqlx）+ ClickHouse（HTTP）两种，编译期内置。
- dbx：**原生驱动**复用率高（Doris/StarRocks/TiDB/OceanBase 等 MySQL 兼容库共用同一个连接池 + catalog 方言层 `db/mysql_compatible.rs`）；**Agent 驱动**是独立进程，stdin/stdout 换行 JSON-RPC 2.0，启动先 `ready` 再 `handshake` 做能力协商（19 种 capability），协议 v2 支持单进程多会话（256 上限，最后会话关闭后 30 秒宽限再退出，防 tab 快速开关反复起进程）；取消走带外 `cancel_session` RPC 而不是 kill 进程。
- **方言是数据驱动的**：35 个 YAML 文件描述各库类型系统/别名/精度，插件目录扫描加载 + 热重载，新增数据库的大量"软知识"不改 Rust 代码。
- 驱动商店闭环：注册表 JSON（per-platform 产物 + min_app_version + 托管 JRE）→ 带进度事件下载 → jar 校验 → 离线 zip 导入（气隙环境）→ 本地构建产物回退 → 运行时进程观测（pid/内存/CPU/会话数，可 stop/restart）。

> 参考：`crates/dbx-core/src/agent_catalog.rs`、`db/agent_driver.rs`（3288 行）、`agents/docs/agent-protocol-v2.md`、`plugins/dialects/*.yaml`

### 2.2 四种交付形态：桌面 / Web / CLI / MCP Server

黑猫只有桌面端。dbx 的关键设计：

- **一份前端双后端**：`apps/desktop/src/lib/backend/api.ts` 的 `forward()` 懒解析——Tauri 环境走 invoke，否则走 HTTP fetch，函数签名集完全一致，stores/components 零修改复用。Web 化几乎零前端成本。
- **CLI 与 MCP 共享后端抽象**：`DbxBackend` trait 两个实现——`LocalBackend` 直接打开桌面端同一个 `dbx.db` 在本进程执行查询（桌面不用开着），`WebBackend` 走 Web API。
- **MCP 权限模型是教科书级的**：中央策略存应用内（设置→MCP 三档：只读/安全写/高危写 + 连接 allowlist），环境变量**只能收窄不能放宽**；每次工具调用重读策略；强制链为 全局策略 → 连接 read_only → 生产库名单 → AST 风险分类 → confirmed-SQL 精确绑定，任一层拒绝即败。
- **bridge 端口文件**：桌面端在 `127.0.0.1:0` 起本地 HTTP 服务，端口写入 `<data_dir>/mcp-bridge-port`，MCP 进程读文件后 `POST /open-table` 让桌面 UI 打开某张表——外部进程回连桌面的极简机制，且 bridge 端逐语句重检权限防 TOCTOU。

> 参考：`crates/dbx-mcp/`（rmcp，12 个工具）、`crates/dbx-cli/`、`crates/dbx-web/`（axum，路由与 Tauri commands 1:1）、`apps/desktop/src/lib/backend/api.ts`

### 2.3 SQL 编辑器深度

黑猫 SQL 控制台：执行/事务/历史/文件。dbx 在此基础上多出：

- **纯前端 SQL 语义层**（`lib/sql/semantic/`）：分词 → 方言适配器 → 活动语句语义模型 → **cursor intent 带置信度**（低置信度不打远程元数据请求）→ 七类补全作用域；诊断按视口可见语句分批计算。
- **语句槽运行按钮**：每条语句行头有独立运行按钮，执行后按钮角上盖成功/失败小圆点徽章。
- 19 种编辑器主题（含 IDEA/Cursor/Claude Code 手工复刻调色板）+ 可视化自定义；SQL 参数绑定（`:param` + 参数历史）；Vim 模式；拖拽移动选中文本；Ctrl+hover 跳表；"粘贴为 IN 条件"。
- **执行计划可视化**：tree / summary / raw / table 四视图。

### 2.4 Schema 工具族（黑猫全部没有）

| 工具 | 要点 |
|---|---|
| ER 关系图 | SVG 渲染、自动布局、工程图模式、导出 SVG |
| Schema 对比 | **跨连接**四步向导：config → compare → result → **deploy-review**（含回滚/前向 SQL 模式、OSC 状态） |
| 数据对比 | 选源/目标表 + 键映射，差异审查与同步输出 |
| 字段血缘 | 从某列出发分析来源，置信度三级可过滤，SQL 高亮展示血缘路径 |
| 数据库搜索 | 跨表内容搜索（逐表 LIKE），结果带匹配列可直接以该 WHERE 打开表 |
| 对象浏览 | 视图/过程/函数/触发器分组，**源码查看+编辑**（内嵌完整查询编辑器），过程执行对话框 |

黑猫的"数据库同步"是预览+覆盖式；dbx 的 Schema 对比是"差异审查 + 可部署"——这是黑猫同步功能的升级方向（见第五节 P2）。

### 2.5 数据网格深度

黑猫网格：虚拟滚动（DOM）、乐观编辑、查找替换、导入导出。dbx 多出：

- **Canvas 自绘网格**（可切回 DOM 模式）：固定行高只画可见行，"每帧零字符串分配"（搜索匹配 key 数值编码）、文本截断 LRU 缓存；CSS 变量 → canvas 安全色的完整转换管线（手工解析 oklch/color-mix）。
- **行号区即状态指示**：新增绿、编辑黄、删除红。
- **保存前 SQL 预览面板**：编辑操作即生成将执行的 SQL，500ms 防抖刷新，Shiki 高亮、可格式化、可撤销/重做。
- **复制提取器 17 种**：tsv/csv/自定义分隔符/json/json-lines/**IN 条件**/INSERT/UPDATE/WHERE 子句/markdown/html/xml…；**XLSX 导出可附带 SQL sheet**（把产生数据的 SQL 写进第二个工作表——自带出处的审计细节）。
- DataGrip 风格右键过滤（= / ≠ / LIKE / NOT LIKE / < / > / NULL…取当前单元格值拼 WHERE）+ 结构化多规则过滤构建器（AND/OR 翻转、单规则禁用）。
- 转置视图、冻结列、列布局弹窗（可见性/拖拽/宽度）、单元格详情三 Tab（详情/hex/编辑器，JSON 格式化、图片预览、几何数据地图预览、二进制下载）。

### 2.6 专项浏览器（黑猫没有对应引擎，暂不具备）

Redis（模式搜索/key 树/批量操作/命令安全分级/pubsub/slowlog/dashboard/全类型 TTL 编辑）、MongoDB（文档 CRUD/shell 补全 19 种光标上下文/GridFS）、Kafka/RocketMQ/RabbitMQ/Pulsar 管理台、etcd/ZooKeeper/Nacos/向量库——全部走同一个标签页 mode 体系（26 种）。

### 2.7 连接与安全

- **SSH 隧道**（russh）：密码/私钥/ssh-agent 三认证、**多跳链式隧道**；主机密钥分层 fail-closed（系统 known_hosts → 自管 known_hosts → UI 显式 TOFU，**密钥变更硬拒绝**防 MITM）。黑猫完全没有隧道能力。
- **SOCKS/HTTP 代理**、PHP 隧道，统一"传输层"抽象可堆叠。
- **连接导入**：解析 DBeaver data-sources.json（含内置 AES key 解密其凭证）/ Navicat / DataGrip 导出文件，导入后重建侧栏文件夹布局。
- **生产库标记模型**：连接可标 `is_production` 或按库名，约 20 个正则判断 SQL 是否触及生产范围（DML/DDL/TRUNCATE/GRANT/多目标 DROP/跨库限定名/Mongo `$out`/`$merge`）；连接颜色标记（6 预设 + 自定义），标签页继承连接色。黑猫只有引擎级只读（ClickHouse），没有连接级生产标记/只读。
- **凭据剥离存储**：密码/密钥从连接 JSON 剥离到独立 SQLite 表（写时剥离、读时注水）；配置导出用 PBKDF2(10 万次)+AES-256-GCM 口令加密。

### 2.8 AI 助手（黑猫有，但形态不同）

- **Provider 广度**：13 种 provider 归一化为 3 种 API 风格（OpenAI Completions/Responses、Anthropic Messages），端点自动补全；支持 Ollama 本地模型与任意 OpenAI 兼容端点；**可复用本机已登录的 Claude Code/Codex CLI**（用用户自己的订阅，还自动挂 dbx 自家 MCP server 给它）。黑猫绑死 Claude Agent SDK 一路。
- **Ask / Agent 双模式**：Ask 只产 SQL 绝不执行；Agent 驱动工具调用（list_tables/get_columns/execute_query/get_sample_data/explain_query），max turns 钳制、上下文压缩、工具结果截断、最终答案"任务契约"校验（不含 SQL 交付物最多自动返工 2 次）、不支持 function calling 自动降级 text-only。
- **@表提及**注入 schema 上下文（上限 50 表/40 列），表/列注释当"语义别名"写进 system prompt（中文业务名 → 真实表名）。
- **AI SQL 多层安全**（详见 3.3）。

### 2.9 其他

- **文件预览**：拖入 Parquet/CSV/JSON 即时预览（DuckDB sidecar 进程，防崩溃拖垮主进程）。
- **i18n**：8 种语言，非默认语言全部懒加载；**后端错误码 → locale key 映射层**（`backend-errors.ts`），前后端 i18n 解耦。
- 定时备份设置 + WebDAV 自动上传（仅导出文件层面）。
- Quick Open（Ctrl+P 模糊搜索表/文件）；快捷键 40+ 动作全可配。

---

## 三、工程质量维度：dbx 做得更好的地方

这些不是"有没有"的功能差距，而是同等功能下的工艺差距。

### 3.1 架构：核心库 + 多薄壳

所有逻辑进 `dbx-core`，Tauri commands（约 400 个）/ axum 路由 / CLI / MCP 都是薄壳，业务函数以 `*_core()` 命名共享，`AppState` 只有一份。黑猫目前是 src-tauri 单壳 + Node sidecar，`commands.rs` 直接承载业务。黑猫模块化纪律（"加新模块而不是撑大 commands.rs"）方向正确，但**crate 级拆分**是给未来 Web/CLI/MCP 形态铺路的关键一步。

反面教训也值得记：dbx 用大 enum（`PoolKind` 17 变体）+ `match` 派发，驱动多了以后 `query.rs` 5063 行、`connection.rs` 6352 行——黑猫应引以为戒，在引擎还少的时候确立边界。

### 3.2 连接韧性与超时/取消工程

- **DbOperationBudget**：把"用户 SQL 超时"（可配，0=不限）与"基础设施超时"（checkout/ping/cancel 5s/cleanup 3s，**永远有硬上限且不可禁用**）分离。
- **错误分类驱动恢复**：连接错误识别（含中英文关键词 + Windows OS 错误码）→ Keep/Discard/ReconnectAndRetry；**写 SQL 遇连接错误不重试只清池**（防服务端已接收写入被重放）。
- **keepalive 三层**：应用层 30s ping（失败即移除池）+ PG URL 自动注入 keepalive 参数 + MySQL tcp_keepalive + 空闲 TTL。
- **RunningQueries 取消注册表**：execution_id + registration_id 代际（防同 id 重注册误删）+ 按连接/tab/owner 批量取消 + 驱动级 interrupt（MySQL `KILL QUERY`、PG 重建 TLS connector 发 cancel）；测试覆盖 panic unwind 泄漏。
- 连接尝试代际机制防并发重连时旧连接覆盖新池；session-scoped 池按前端 tab 派生（保留临时表/会话变量），tab 关闭 Drop 兜底清理。

黑猫有取消执行和 session 自动重开，但预算分层、写不重试、keepalive、批量取消这些工程细节是空白。

### 3.3 AI SQL 安全的多层纵深（对照黑猫的审批门）

黑猫：canUseTool 审批门（只读自动批准，写操作用户批准）+ sql_guard 只读校验 + LIMIT 注入。dbx 的层次更细：

1. **前端三级分类器**：`auto_execute / confirm / block`——无 WHERE 的 UPDATE、非 CREATE 的 DDL、事务直接 block；带等值条件的 UPDATE 仅在推断为非生产环境才可能自动执行。
2. **环境启发式**：连接名/host/库名匹配 `prod|生产|正式` → 生产；localhost/`dev|test|本地` → 非生产。
3. **确认绑定**：用户确认时的 connection/database 快照与当前不一致则授权作废；执行的 SQL 规范化后与确认的 SQL **精确匹配**（防"确认 A 执行 B"）；授权要求消息恰好只有一个 SQL 代码块（防用读操作提议偷渡写授权）；"短肯定回复"（≤24 字符整句匹配）才算确认。
4. **后端 AST 风险分类**：sqlparser 真解析（按库选方言），`ReadOnly/Write/Ddl/Transaction` 四级；禁 USE 逃逸。
5. **生产库写永远拒绝**（非交互路径后端直接拒，交互路径前端确认队列——并发写请求排队而不是静默拒绝）。

### 3.4 前端工程文化：lib 纯函数分离 + 测试

- 组织范式：`components/<域>/` 只放 .vue，逻辑全部抽到 `lib/<域>/*.ts` 纯函数（可单测，vitest）+ `composables/use*.ts` 装配。DataGrid 一个域 60+ 纯函数模块——这是它能撑住 70+ 数据库功能面的根本。
- 黑猫已有 composable/组件分解，但**纯函数层和测试密度**有差距（黑猫 JS 测试用 node:test 覆盖了部分 composable，dbx 的 __tests__ 遍布每个域）。
- 偏好持久化：单 key 存全部 ~60 项偏好 + **版本化默认值迁移**（升级不丢设置）。
- 前后端安全规则**共享语料测试**：`tests/fixtures/production-safety-corpus.json` 一份语料喂 Rust 正则和 TS 镜像实现，保证两端行为一致——非常聪明的契约测试手法。

### 3.5 性能测量文化

`docs/performance/` 三份审计报告是"审计→优化→复测"闭环范本：测量方法（CDP Performance.getMetrics + ps RSS，3 次取中位数）→ 基线表 → 代码证据（文件:行）→ 优化 → 同口径复测（Data Compare 峰值 RSS 降 53%，且响应字节数不变作为正确性验收）。DOM 密度审计把网格操作按钮改为 hover 才挂载（DOM -51000）。导入基准用真实数据库（PG COPY 7.3x、SQL Server Bulk 4.7x），可复现。

黑猫把"用户感知性能"写进 AGENTS.md 最高优先级，但缺**可复现的测量与报告制度**——这是把口号变成工程的最后一步。

### 3.6 测试与发布工程

- **Docker 数据库实验室**（`deploy/database/`，14 产品 × 版本）：每配方 `recipe.json`（钉死镜像 tag、端口、smoke 验证步骤）+ `make db-verify DB=mysql@8.4` 起容器跑断言，`db-check` CI 守门。黑猫目前没有真实库测试设施（JS 测试全靠 mock）。
- CI：`paths-filter` 按变更域分 7 个条件 job；Rust fast/full 两档 feature；sccache + rust-cache 多层缓存；clippy `-D warnings`。
- 发布：npm 平台包模式（超薄 Node 启动器 + optionalDependencies per-platform 原生二进制 + SHA256SUMS 离线包）；桌面更新双 endpoint（自建 CDN + GitHub Releases）+ minisign 签名 + 国内 CNB 镜像源可选 + Windows 便携版单独通道。

---

## 四、黑猫的差异化优势（dbx 完全没有的）

这一点必须先讲清楚：**dbx 在数据安全纵深上只有"事前拦截"，没有任何"事后可恢复"体系**——没有快照备份、没有独立审计追踪、没有一键回滚闭环（只有查询历史里存一段 rollback SQL 文本，手动逐条执行，无事务包装、无执行追踪）。

黑猫独有的：

1. **层1 全库逻辑快照**：GFS 保留策略 + 恢复向导 + 恢复前自动再快照 + 同步失败从本地保护快照精确恢复 + 外部 .sql 导入快照库。
2. **层2 变更审计 + 回滚**：before-image + 逆向 SQL 存隔离 SQLite，**一键回滚且回滚本身被审计**——任何成功变更都有已提交的审计行。
3. **中心服务器聚合多工作站共享审计日志** + 账号体系——这是团队合规场景，dbx 完全没有对应物。
4. **Agent 产物生成**：批准后的 XLSX/文本产物输出到专用目录（dbx 的 AI 只产 SQL）。
5. **企业内网适配**：SVN 更新器（内网无外网场景）、中文优先。

**定位结论**：dbx 是"广度优先的通用工具"（70+ 引擎 × 4 种形态），黑猫是"**安全可信的企业数据工作台**"。黑猫不应全盘照抄 dbx 的广度路线（养不起 40 个驱动），而应：**把安全纵深这个护城河继续挖深，同时有选择地吸收 dbx 的工程工艺和高性价比功能**。

---

## 五、黑猫后续设计更新建议（路线图）

### P0 —— 近期版本，低成本高收益（强化现有体验）

1. **保存前 SQL 预览面板**（网格编辑）。黑猫已有乐观编辑 + 审计逆向 SQL，加预览是天然互补——而且可以做得比 dbx 更好：**预览面板同时展示将执行的 SQL 和对应的回滚 SQL**，把黑猫的审计基因显性化成用户可感知的安全感。参考 dbx `SqlPreviewPanel.vue` + `api.prepareDataGridSave`。
2. **复制/导出格式扩充**：从 CSV/XLSX 扩到 JSON / Markdown / SQL INSERT / **IN 条件** / WHERE 子句（纯前端提取器，成本极低，DataGrip 级体验）；**XLSX 导出附 SQL sheet**（与黑猫审计基因契合，让导出文件自带出处）。参考 dbx `dataGridCopyExtractor.ts`（17 种）、`xlsxSqlSheet.ts`。
3. **DataGrip 风格右键过滤**：取当前单元格值拼 WHERE（= / ≠ / LIKE / NOT LIKE / NULL…），纯前端 + 复用现有过滤链路。参考 dbx `dataGridContextMenu.ts`。
4. **超时与取消加固**：引入 DbOperationBudget 概念——基础设施超时（连接检出/ping/取消/清理）永远有硬上限且与用户 SQL 超时分层；`update_cells` 等写路径遇连接错误**只清 session 不重试**（黑猫目前 session 重开逻辑对读写一视同仁，需确认写路径不会重放）。
5. **生产连接标记 + 颜色**：连接配置加"生产"标记和颜色，标签页继承连接色；生产连接上的写操作强制确认文案升级（黑猫已有 useConfirm 基础设施）。这是把 dbx 生产安全模型接到黑猫审计体系上的第一步。

### P1 —— 中期演进（1-2 个里程碑）

6. **AI provider 抽象 + OpenAI 兼容端点**。黑猫 AI 绑死 Claude Agent SDK；企业内网常有私有部署模型（vLLM/Ollama/国产模型网关），支持任意 OpenAI 兼容端点是企业落地的硬需求。学 dbx 的归一化：provider 再多也收敛到 OpenAI/Anthropic 两种 API 风格 + 端点自动补全。保留 Claude Agent SDK 作为"Agent 模式"的高级路径。
7. **AI SQL 安全升级**：把 dbx 的四层模型接到黑猫现有审批门上——执行 SQL 与批准 SQL 规范化精确匹配（防"批 A 执 B"）、环境启发式（连接名含 prod/生产 自动升级审批级别）、sqlparser AST 风险分级替代/补充现有 sql_guard 正则。
8. **MCP Server 化**：把黑猫的连接暴露为 stdio MCP server（Rust 薄壳直接读写现有存储），让 Claude Code/Cursor/ Codex 直接查黑猫配置的连接。黑猫已经在 Claude Agent 生态投入了 sidecar，这是同一战略的"反向输出"——且 dbx 的权限三档 + allowlist + env 只收窄模型可直接照搬。差异化点：黑猫的 MCP server 可以让所有 AI 写操作也走层2 审计——"AI 操作也留痕可回滚"，这是 dbx 给不了的卖点。
9. **SQL 编辑器语义补全**：在现有 CodeMirror 6 基础上加分词 → 活动语句模型 → cursor intent 置信度（低置信度不打元数据请求）→ 视口分批诊断。参考 dbx `lib/sql/semantic/README.md` 的分层设计。
10. **执行计划可视化**（MySQL EXPLAIN 树形视图）——对优化查询的用户高感知价值，实现集中在解析 + 树组件。

### P2 —— 长期方向（架构级投入）

11. **数据库同步升级为"差异审查 + 部署"**：现有同步是预览+覆盖式；升级为 dbx Schema 对比的四步向导（config → compare → result → deploy-review，含回滚 SQL 模式）。黑猫的层1 保护快照天然是部署前的安全网——把"同步前自动快照"从幕后提到部署审查界面里，形成"审查差异 → 确认部署 → 自动快照 → 可回滚"的完整叙事。
12. **核心库 crate 拆分**：把 `src-tauri/src` 的业务模块（db/clickhouse/audit/backup/sql_console…）下沉为 `crates/workbench-core`，src-tauri 只剩命令薄壳。为将来可能的 Web 版/CLI/MCP server 铺路（P1#8 若做，自然会逼出这一步，可合并实施）。
13. **ER 关系图**：SVG 渲染 + 自动布局 + 导出，作为 schema 浏览的高级形态。
14. **SSH 隧道**（russh）+ 连接导入（DBeaver/Navicat）：企业用户从旧工具迁移的润滑剂；host key 用 TOFU 分层验证。
15. **引擎扩展决策点**：若目标用户有 PostgreSQL 需求，sqlx 已具备 PG 能力，成本主要在 schema/方言层；建议届时学 dbx 的"方言数据驱动"（YAML 描述类型系统），避免方言知识散落 Rust 代码。**不建议**跟进 dbx 的 70+ 引擎广度路线。

### 工程文化吸收（任何版本都可做）

16. **真实库测试设施**：照 dbx `deploy/database/` 做声明式 Docker 配方（recipe.json + smoke 断言），至少覆盖 MySQL 5.7/8.x + ClickHouse 目标版本；CI 守门。黑猫目前写路径（update_cells/audit/rollback）全靠 mock 测试，风险最高处恰恰没有真实库验证。
17. **性能审计制度**：把 AGENTS.md 的"用户感知性能最高优先级"落成 `docs/performance/` 式审计报告（测量方法 → 基线 → 证据 → 优化 → 同口径复测），每个大版本至少一次网格/侧栏审计。
18. **前后端共享安全语料测试**：黑猫前端（valueValidation/sql_guard 相关）与 Rust 后端的安全校验规则，用一份 JSON 语料双向喂测试，防两端漂移。
19. **偏好持久化版本化迁移**：单 key + 默认值迁移版本号，升级不丢用户设置。

---

## 六、总结

- dbx 赢在**广度**（引擎、形态、provider）和**工艺**（取消/超时/连接韧性、测试与发布工程、性能测量文化），每一项都有代码级落地。
- 黑猫赢在**纵深**（快照/审计/回滚/中心审计聚合），这是 dbx 完全没有的差异化护城河，也是企业客户真正付费的理由。
- 更新策略一句话：**护城河继续挖深（P0#1、P1#8 把审计显性化、P2#11 同步升级），选择性吸收 dbx 的高性价比 UX（P0#2/#3、P1#9/#10）与工程工艺（P0#4、P1#7、工程文化 #16-#19），不跟进引擎广度军备竞赛。**

---

## 附：dbx 关键实现索引（深入研究时按图索骥）

| 主题 | 位置（`E:/project/dbx/` 下） |
|---|---|
| 核心库 + 薄壳约定 | `crates/dbx-core/`；`src-tauri/src/commands/`（56 模块薄壳）；`crates/dbx-web/src/routes/`（1:1 镜像） |
| 驱动统一表示 | `crates/dbx-core/src/connection.rs:90`（`PoolKind`）、`models/connection.rs:444`（`DatabaseType`） |
| Agent 协议 v2 | `agents/docs/agent-protocol-v2.md`；`crates/dbx-core/src/db/agent_driver.rs` |
| 驱动商店 | `crates/dbx-core/src/agent_service.rs`、`agent_catalog.rs`、`agent_manager.rs` |
| 方言 YAML | `plugins/dialects/*.yaml`；`crates/dbx-core/src/sql_dialect/` |
| Canvas 网格 | `apps/desktop/src/lib/dataGrid/canvasDataGridRenderer.ts`；`composables/useDataGridCanvasRuntime.ts` |
| SQL 预览面板 | `apps/desktop/src/components/editor/SqlPreviewPanel.vue`；`useDataGridEditor.ts` |
| 复制提取器 | `apps/desktop/src/lib/dataGrid/dataGridCopyExtractor.ts` |
| SQL 语义层 | `apps/desktop/src/lib/sql/semantic/`（README 值得先读） |
| Schema 对比 | `apps/desktop/src/components/diff/SchemaDiffDialog.vue`；`crates/dbx-core/src/schema_diff.rs` |
| AI 安全 | `apps/desktop/src/lib/ai/aiSqlExecutionPolicy.ts`；`crates/dbx-core/src/agent_tools.rs`、`sql_risk.rs` |
| AI provider 归一 | `crates/dbx-core/src/ai.rs`（`AiApiStyle`） |
| MCP server | `crates/dbx-mcp/`（`server.rs` 权限链、`backend.rs` 双后端）；`src-tauri/src/commands/mcp_bridge.rs` |
| 生产安全 | `crates/dbx-core/src/production_safety.rs`；`tests/fixtures/production-safety-corpus.json` |
| 取消注册表 | `crates/dbx-core/src/query_cancel.rs` |
| 超时预算 | `crates/dbx-core/src/query.rs:135`（`DbOperationBudget`） |
| SSH 隧道 | `crates/dbx-core/src/db/ssh_tunnel.rs`、`ssh_host_key.rs`（文件头安全设计注释） |
| 凭据剥离 | `crates/dbx-core/src/connection_secrets.rs`；前端加密 `apps/desktop/src/lib/backend/configCrypto.ts` |
| 性能审计 | `docs/performance/`（三份报告范本） |
| 数据库实验室 | `deploy/database/`（recipe.json 模式）；`scripts/database-env.mjs` |
| 连接导入 | `apps/desktop/src/lib/imports/`（dbeaver/navicat/datagrip） |
| 双后端前端抽象 | `apps/desktop/src/lib/backend/api.ts`（`forward()`） |
