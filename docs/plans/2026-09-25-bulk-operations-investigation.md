# 批量操作源码与历史调查

## 范围与证据等级

- 调查日期：2026-09-25。
- 源码基线：`1170250ff29888a431b2425750e4962c7a3737fc`。开始及写文档前工作区均干净；本地仓库不是 shallow clone。历史结论限于本地可见 Git 历史，没有 fetch。
- 本支调查范围：批量删行 `delete_rows`、批量删表 `drop_tables` / `drop_tables_mysql`、首页 `deleteHomeTables`，以及直接依赖的审计和测试。
- 授权边界：没有连接真实数据库、操作真实数据、修改程序或测试、提交 Git。主线运行了本地模拟应用、临时验证脚本及已有测试；删除分支的模拟验证不涉及真实数据库。唯一持久化写入是本文。
- **源码确定**：可以从控制流、返回契约、源码比较或历史补丁直接确认；不等于完成运行验证。
- **未实测推断**：性能幅度、故障实际发生率、真实数据库的锁和恢复表现，不能由源码直接确认。
- **执行验证**：复制、分页及 357 项测试由主线执行；删除逻辑和历史由并行研究核对。下面区分浏览器复现、故障注入和源码结论。

## 结论

1. **删表存在确定的结果误报**：后端返回 `dropped` / `failed`，首页丢弃返回值，按全部请求对象关闭标签、清空选择并显示全部成功。后端即便全部单表操作失败，也可以正常返回 `Ok`，不会进入首页的异常分支。
2. **删表成功后的刷新异常会被误报为删除失败**：执行删除和刷新列表处在同一个 `try/catch`，用户无法区分“未删除”和“已删除但列表没刷新”。这两个结果处理问题可以先修，不需要改变删除 SQL 或放宽安全要求。
3. **批量删行的串行成本确定，实际慢多少未测**：MySQL 成功路径为 N 次锁定前镜像读取、N 次 DELETE、N 次独立审计 INSERT、N 次独立审计状态 UPDATE，加事务和准备成本。当前没有使用已有的批量审计辅助函数。
4. **批量删表也是串行**：每表依次准备审计、执行 DROP、更新审计状态，完成整批后才返回。它是允许部分成功的操作，不是删行那种整批 MySQL 事务。
5. **不是 `366875a` 新增的这几处删除逻辑**：三段函数区域在该提交前后相同，并与当前 HEAD 相同。逐行 DELETE 最早见于 2026-05-24；逐表 DROP 和首页丢弃结果最早见于 2026-07-07。不能把这一结论扩张成“该提交绝不影响任何端到端体验”，共享依赖和真实耗时没有历史 A/B 实测。
6. **安全约束有现存缺口**：删行有事务和强制本地审计，但没有跨 MySQL/SQLite 的原子提交；删表仍是 best-effort 审计，且此调用链没有主动创建保护快照。另发现删行整批复用共享审计幂等键的源码契约冲突，见下文。

## 批量删行

### 当前流程：源码确定

- 前端先确认并准备待删行，然后只发一次 `delete_rows`，身份由所选已保存行生成；本地未保存草稿另行移除。完成后读取列表，刷新失败有单独提示。见 [useRowSelection.js](../../src/workbench/composables/useRowSelection.js:294)，294-350 行。这里只确认删除入口边界，不研究分页实现。
- 后端取得表会话、拒绝只读连接，MongoDB 提前分流，MySQL 空请求返回 0。见 [commands.rs](../../src-tauri/src/commands.rs:6192)，6192-6225 行。以下成本与事务结论只针对 MySQL，不能套用到 MongoDB。
- MySQL 先确保本地审计库可用、取得当前表结构，排除生成列，生成删除计划，再开启一笔事务。见 [commands.rs](../../src-tauri/src/commands.rs:6227)，6227-6265 行。
- 循环读取每行前镜像并逐条写 pending 审计。前镜像 SQL 是 `SELECT ... LIMIT 1 FOR UPDATE`，与 DELETE 使用同一 MySQL 事务；字段转成字符串并保留 NULL。见 [commands.rs](../../src-tauri/src/commands.rs:573)，573-620、6267-6327 行。
- 再循环执行每行 DELETE，要求每条恰好影响 1 行；否则回滚整批并尝试将审计标记 aborted。全部删除成功后逐条完成 committed 审计，最后提交 MySQL。见 [commands.rs](../../src-tauri/src/commands.rs:6329)，6329-6386 行。
- DELETE 是带身份条件的 `LIMIT 1`，不是一个批量 IN 语句。空身份被拒绝，NULL 与空字符串区分，标识符转义、值绑定。见 [audit.rs](../../src-tauri/src/audit.rs:900)，900-911 行；[db.rs](../../src-tauri/src/db.rs:322)，322-343 行。

### 串行成本

设 N 为请求中待删行数，正常成功路径、不计元数据初始化和后台审计同步：

| 环节 | 确定的串行工作量 |
| --- | --- |
| MySQL 读取删除前数据 | N 次 SELECT，逐次 await |
| 本地审计准备 | N 次独立 INSERT，逐次 await |
| MySQL 删除 | N 次 DELETE，逐次 await |
| 本地审计完成 | N 次独立 UPDATE，逐次 await |
| 事务 | 一次 MySQL begin / commit；失败另有回滚及审计清理 |

证据：[commands.rs](../../src-tauri/src/commands.rs:6267)，6267-6377 行；[audit.rs](../../src-tauri/src/audit.rs:254)，254-295、386-390、431-440 行。审计连接池最多一个连接并开启 WAL，见同文件 108-143 行。

**未实测推断**：可用 `准备 + Σ(读前镜像 + pending写入) + ΣDELETE + Σ审计完成 + 提交` 描述关键路径。网络延迟、磁盘持久化、数据库锁等待均可能放大逐条成本；1000 行意味着约 2000 条 MySQL 业务语句和 2000 条 SQLite 写语句，不意味着已经测得 2000 次网络 RTT 或特定 fsync 次数。不能据此承诺耗时或提速倍数。较早锁定的行会持续等待后续串行工作，是锁持有时间的潜在放大项。

已有批量审计能力：[audit.rs](../../src-tauri/src/audit.rs:297)，297-357 行的 `record_pending_batch` 将多个 INSERT 放进一个 SQLite 事务；394-428 行提供批量强制状态更新。它们仍逐条执行 SQL，但减少独立提交边界。删行当前未调用这些函数，属于确定的可优化点，不等于已有速度回归证据。

### 安全边界

- 必须保留整批 MySQL 事务、事务内前镜像锁定、先保存可恢复内容再删除、审计失败不提交、逐行身份与影响行数校验。不能为了速度分批提交或把必要审计改成异步 best-effort。
- “整批回滚”是当前代码的设计路径，不是对所有数据库条件的实测保证：该函数没有检查表存储引擎；异常分支忽略了 rollback 自身和 aborted 状态写入的错误。非事务表、连接中断等边界仍待隔离测试。见 [commands.rs](../../src-tauri/src/commands.rs:6283)，6283-6295、6319-6324、6353-6375 行。
- committed 审计在 MySQL commit 之前完成，因此两套存储并不是共同原子事务。此窗口崩溃、提交响应不确定或补偿失败时的状态一致性仍待验证；不能把“有审计记录”说成“崩溃时也必定和业务库一致”。源码也明确未采用跨库 2PC，见 [audit.rs](../../src-tauri/src/audit.rs:9)，9-12 行。
- FULL 持久性应保留，不能靠改 NORMAL 提速。[既有性能报告](../../docs/plans/2026-09-20-grid-performance-results.md:43)，43-45 行写明保持 FULL。当前 `ensure_audit_pool` 没显式设置 synchronous，使用依赖默认值；本机 sqlx-sqlite 0.8.6 的 [options/mod.rs](<CARGO_HOME>/registry/src/index.crates.io-1949cf8c6b5b557f/sqlx-sqlite-0.8.6/src/options/mod.rs:187)，187-189、325-330 行说明默认 FULL。这是本地依赖源码说明，未读取运行中数据库 PRAGMA，也未验证已安装包的实际依赖版本。
- 合并 SQL 的后续方案需要覆盖复合键、NULL、无主键重复行、生成列、二进制前镜像、外键/触发器及每行结果核验。当前两个 `LIMIT 1` 并不能单独证明身份条件唯一，不能贸然替换为宽泛 IN/OR 条件。

### 审计附带发现：整批复用 client_id

**源码确定的契约冲突，未连中心服务复现**：删行只在循环外生成一次 `client_id`，每行审计均绑定相同值。中心服务以它为审计表主键，并用 `INSERT OR IGNORE` 去重；如果部署的是仓库内这套服务且启用同步，一批多行记录会被当作重复推送，无法保证逐行出现在共享日志中。本地 SQLite 的自增 id 不受这一去重逻辑影响，不能说成本地回滚记录丢失。

证据：[commands.rs](../../src-tauri/src/commands.rs:6240)，6240-6249、6317 行；[audit.rs](../../src-tauri/src/audit.rs:289)，289-291 行；[account.rs](../../src-tauri/src/account.rs:82)，82-90 行；[server/src/db.rs](../../server/src/db.rs:18)，18-19 行；[server/src/handlers.rs](../../server/src/handlers.rs:99)，99-109、134-140 行。历史 `817732a` 的 `commands.rs:2232-2248` 已是循环外创建该上下文。

这一点应进入审计优化验收：每行有稳定且独立的幂等键，重试同一行不制造重复。现有 `record_pending_batch` 同样绑定共享上下文的 client_id（audit.rs:338），不能只替换函数就宣称共享审计安全完整。删表目前每表生成独立 UUID，见 commands.rs:1694，优化时也不要错误地把整套上下文挪到循环外复用。

## 批量删表

### 当前流程与成本：源码确定

- 请求结构为 `request: { connectionId, database, tables }`；响应为 `{ dropped: [{ tableName }], failed: [{ tableName, reason }] }`。见 [types.rs](../../src-tauri/src/types.rs:812)，812-833 行。
- 后端仅修剪表名并过滤空值，没有去重；拒绝只读连接及 MongoDB。MySQL 处理完后只失效成功对象的表结构和计数缓存。见 [commands.rs](../../src-tauri/src/commands.rs:1572)，1572-1619 行。
- 每表顺序执行“生成身份及 pending 审计 -> `DROP TABLE IF EXISTS` -> committed/aborted 审计”。失败写入 failed 后继续下一表，最终一律 `Ok(DropTablesResponse)`，不因 failed 非空而返回 Err。见 [commands.rs](../../src-tauri/src/commands.rs:1677)，1677-1735 行。
- T 张表通常有 T 次 DROP、T 次 pending INSERT、T 次审计状态 UPDATE，均在该循环中 await；审计不可用时写入数量会更少。函数没有整批事务或逐表进度事件。首页 busy 直到删除、关标签、刷新全部走完才解除，见 [MySqlWorkbench.vue](../../src/workbench/MySqlWorkbench.vue:3109)，3109-3133 行。
- `mark_audit` 每次成功都会触发同步信号，但信号使用 `try_send`，不是等待中心 HTTP 返回。不能把 T 次同步通知写成 T 次阻塞的远程同步。见 [commands.rs](../../src-tauri/src/commands.rs:557)，557-568 行；[audit_sync.rs](../../src-tauri/src/audit_sync.rs:267)，267-273 行。

**未实测推断**：远程 DROP 往返、数据库内部 DDL/锁等待、本地审计以及最后刷新都可能贡献用户等待时间。必须分段采样才能确认主瓶颈，不能仅因看到 for/await 就认定数据库执行本身很快或前端完全卡死。

### 可以先修的确定问题

1. **结果误报与错误关标签**。`deleteHomeTables` 未接收后端结果，以原 tableNames 关闭所有标签、清理最近记录、清空选中，并显示原请求数量成功。失败表可能依然存在，其标签却被关闭。见 [MySqlWorkbench.vue](../../src/workbench/MySqlWorkbench.vue:3111)，3111-3128 行；对照 commands.rs:1723-1735。
2. **刷新错误覆盖真实删除结果**。`loadTables` 抛错进入同一个“删除表失败”提示；此前成功的 DROP 不会因此撤回。见 [MySqlWorkbench.vue](../../src/workbench/MySqlWorkbench.vue:3124)，3124-3130 行。改进应把删除结果和刷新结果分开表达，不能通过重试整次 DROP 来修复列表刷新。
3. **重复请求计数边界**。后端不去重，加上 IF EXISTS 和“执行 Ok 即放进 dropped”，重复表名或已不存在的表不能被当成“确实移除了这么多不同对象”的证明。见 commands.rs:1578-1583、1688-1693、1723-1726。可做保持输入顺序的精确去重；不要未经确认就按大小写合并 MySQL 表名。主线正常选择是否会产生重复值未验证，此项是请求边界加固，不认定正常 UI 必现。

第一项的修复原则：按 dropped 清理成功对象，保留失败对象的标签与可重试选择；部分成功、全失败分别显示数量和原因。即便没有异常，也必须检查 failed。第二项单独报告“已删除，但列表刷新失败”。这些建议均未实施。

### 不可越过的安全边界

- 当前不是整批 all-or-nothing。逐表执行后会保留前面已经成功的结果；不能用一个事务包装或多连接并发的表面改写来宣称跨表原子性。改变为多表一条 DDL 或并行执行前，需单独确认外键依赖、锁行为、错误归属和部分成功语义。
- **审计失败目前不阻止 DROP**：`best_effort_audit` 把错误转换成 None；`mark_audit` 没有向调用者返回状态写入错误。见 [commands.rs](../../src-tauri/src/commands.rs:488)，488-568、1694-1730 行。因此“所有成功写入必有已提交审计”的项目原则不能当作这个入口已经满足的事实。
- 审计只保存 DDL、表名及“请通过快照恢复”说明，无 inverse SQL；`drop_tables` / `drop_tables_mysql` 调用链本身不创建删除前保护快照。已有定时快照是否存在、是否足够新、能否恢复所删表均未确认。见 commands.rs:1572-1735，特别是 1716-1719 行。
- 安全改进可先考虑审计准备失败时拒绝破坏性操作、显式区分“DROP 成功但审计落定失败”。但后者不能谎称数据库已回滚；自动快照会改变耗时与恢复承诺，需要明确产品策略和隔离验证。

## Git 证据

时间均为提交记录中的 `+08:00`；下列主要提交的 author/commit 时间一致。

| 提交 | 时间 | 本次相关事实 |
| --- | --- | --- |
| `cf665c5` | 2026-05-24 23:09:53 | 初始 delete_rows 已逐行 await DELETE；当时无整批事务 |
| `cad0d5a` | 2026-06-20 18:54:16 | 引入逐行前镜像及审计，DELETE 放入同一 MySQL 事务 |
| `817732a` | 2026-06-24 23:17:05 | 删除整批共用含 client_id 的审计上下文 |
| `6e88360` | 2026-07-07 23:04:40 | 首次 drop_tables，串行逐表、best-effort 审计、dropped/failed |
| `b35c8c7` | 2026-07-07 23:38:10 | 首次 deleteHomeTables，已忽略结果并按请求数报成功 |
| `83cb58e` | 2026-07-18 19:35:40 | 前镜像移入事务加锁、强制审计、逐行影响数校验、提交前审计落定 |
| `50722d7` | 2026-07-19 08:07:43 | 已有批量强制审计状态函数；删行仍逐条完成状态 |
| `c3e7c52` | 2026-07-27 21:23:03 | 增加 record_pending_batch；删行未接入 |
| `22b28151` | 2026-08-17 22:38:40 | 首页函数大段移动/换行使 blame 显示较新日期，不是最早误报来源 |
| `366875a` | 2026-09-20 09:35:54 | 三段删除区域不变；审计变化是批量状态函数的单 id 快路 |

精确历史定位：

- `git show cf665c5:src-tauri/src/commands.rs`：250-286 行的 delete_rows；262-273 行为逐行 DELETE。
- `git show cad0d5a:src-tauri/src/commands.rs`：2176-2322 行；2214-2258 行逐条前镜像/审计，2261-2293 行整批事务。
- `git show 6e88360:src-tauri/src/commands.rs`：1165-1222 行的 drop_tables_mysql；1175 行开始循环，1221 行返回两份结果。
- `git show b35c8c7:src/workbench/MySqlWorkbench.vue`：2019-2057 行；2036-2051 行忽略结果、关闭请求对象、按原数量报成功。当时请求还是扁平结构，不能据这段源码推断当时桌面实际已可走通整个删除流程；后来修复的请求包装问题与当前结果误报是不同问题。
- `git show 83cb58e -- src-tauri/src/commands.rs`：显示事务前移、前镜像锁定、从 best-effort 改为 required，以及 committed 审计先于 MySQL commit。
- `git show 22b28151 -- src/workbench/MySqlWorkbench.vue`：同一 deleteHomeTables 的删除块与新增块同时存在，需结合旧版本而非单看当前 blame。
- `git show 366875a -- src-tauri/src/commands.rs src-tauri/src/audit.rs`：没有更改删除函数；audit.rs 仅在 `mark_status_required_batch` 加入 `if let [id] = ids { return mark_status_required(...) }`。删行直接调用单 id required 函数，删表调用非 required mark_committed/mark_aborted，均不是新增快路的直接调用者。

本支另用只读 Node 脚本对 `git show` 内容统一 CRLF 后精确比较：`delete_rows` 到下个 tauri command；`drop_tables` 到下个 tauri command（包含 drop_tables_mysql）；`deleteHomeTables` 到 refreshHome。三组均满足 `366875a^ == 366875a == HEAD`。这比只看文件是否出现在提交清单中更有针对性。

关键完整提交 ID：`366875a45429334972f45a9b236821d207ac2097`；`cf665c566281aa1e03d3e7f734ca275697d63215`；`cad0d5aa21f22a3956af9abeae77a26fb82a3d55`；`6e8836093e71f39beccf0f9ca8d54b92024cc457`；`b35c8c70f817a191c122025c077e1fa8151ae1cc`；`83cb58e332bc6a898b63b876730601a64b980785`。

## 验证覆盖与缺口

**只读检查到的现有覆盖，未在本支运行：**

- [useRowSelection.test.js](../../src/workbench/useRowSelection.test.js:458)，458-491、543-596 行：删除身份传递、准备取消、列表刷新重试与删除成功/刷新失败的区别。调用使用 harness，不验证真实 MySQL 删除事务。
- [homepageInteraction.test.js](../../src/workbench/homepageInteraction.test.js:181)，181-197 行，以及 [workbenchShell.test.js](../../src/workbench/workbenchShell.test.js:511)，511-515 行：源码正则检查确认框、多选与请求包装，不能证明首页正确处理 failed。
- [mockBackend.test.js](../../src/workbench/mockBackend.test.js:2016)，2016-2048 行：mock 删两表的全部成功。mock 对不存在的表返回 failed，而 MySQL 使用 IF EXISTS，存在语义差异，见 [mockBackend.js](../../src/workbench/mock/mockBackend.js:2304)，2304-2329 行。
- [commands.rs](../../src-tauri/src/commands.rs:7465)，7465-7501 行：通过 include_str 检查 required audit、rollback/commit 文字，未实际注入事务故障，也没有验证其执行顺序。
- [audit.rs](../../src-tauri/src/audit.rs:1252)，1252-1318 行：批量审计写入及中途失败回滚的 SQLite 辅助函数测试；不能替代整个删除命令与业务库的联合验证。
- [9 月 20 日性能报告](../../docs/plans/2026-09-20-grid-performance-results.md:5)，5-8、26-27、62-65 行：原有测量使用 mock，明确没有真实 MySQL 执行计划和端到端验证。不能拿网格指标当成批量删除基线。

**后续需要补齐，但本次不执行：**

1. 首页结果组合：全成功、部分成功、全失败、执行异常、删除成功后刷新异常；失败表保留标签与选择，成功表只清理一次，重试刷新不得再调用 DROP。
2. 删行阶段故障：第 k 行前镜像/审计写入/DELETE/审计落定失败，MySQL commit 响应异常、rollback 失败、进程崩溃；核验实际数据、本地审计与共享审计。
3. 身份与恢复：复合主键、NULL、无主键重复行、重复输入、并发改删、生成列/二进制、外键/触发器、非事务引擎；验证恢复内容与真实被删除内容一致。
4. 性能分段：冷/热连接与审计库，立即导航后删除，1/10/100/1000 行及多表规模；分别测前镜像、审计准备、DELETE/DROP、审计完成、提交和刷新，记录锁等待、UI 可用时间、p50/p95。只能在另获授权的隔离实例或故障模拟中执行。
5. 审计优化必须保留持久性与每行记录，覆盖独立幂等键、重试去重、批量状态写入失败；不能用“减少等待”代替数据安全验收。

建议先后顺序：先修首页两处确定的结果处理问题；随后处理审计幂等键与删表审计失效策略；删行批量审计作为受安全回归保护的性能改进。不要先引入多连接并行删行、分段提交或大范围 SQL 合并。

## 复制与分页：已执行验证

本节由主线执行临时 Node 集成脚本与 Playwright 浏览器验证，并直接核对当前源码。模拟数据不用于推断真实 MySQL 删除速度。浏览器与本次启动的临时 Vite 服务均已关闭，未保存截图或测试脚本文件；以下为执行输出摘要与重现步骤。

- 集成复现：`useTableSession.loadPreviousPage` + `useGridEditor`，矩形选中 2001..2005，前插 1000 行后复制变为 1001..1005；按 key 的整行选择仍复制 2001..2005；普通 append 不改变选区。
- 实际 Playwright / Chromium / mock 浏览器复现：`rows-10k-20-pk` fixture，跳到末行，点击 9997 ID，再 Shift 点击 9999 ID，Cmd+C 为 `9997\n9998\n9999`；滚动到 `9000*28` 触发向上读取，再 Cmd+C 为 `8997\n8998\n8999`。无 pageerror。仅模拟数据，未连接真实数据库。
- 主线定位：`src/workbench/composables/useGridEditor.js:2156-2183` 的 `getSelectedClipboardData` 直接按 `model.at(bounds.top + rowOffset)` 相对下标取值；该范围 blame 为 `72c10a355ee0b710e82602e7d6e2cb8d47862e25`，2026-08-18 07:44:19 +08:00。
- 主线定位：[WorkbenchPane.vue](../../src/workbench/components/WorkbenchPane.vue:1127) 的 `maybeLoadPreviousRows` 只执行 loadPrevious 与记录 scroll，未重映射选区；1561 附近 watch 仅涉及 tab/view revision 恢复，其他所查 watch 为 emit/search。前插改变加载窗口内相对下标，复制仍按旧下标取值，导致已复现的错行。
- 向前加载功能历史：`f357a961f381ea852e86500bf5304801138f42ca`，2026-07-30 07:27:21 +08:00。主线判断 `366875a` 未改分页/复制取值，仅加列窗口坐标判断。**功能首次出现与当前 blame 不是缺陷首次可复现的证明**，不直接宣称自 7 月起已有该 bug；仍需历史基线。
- 主线已运行：useTableSession/useRowSelection/useGridEditor 共 354 项通过，另 utils/gridClipboardStore.test.js 3 项通过，合计 **357 项通过**。主线指出该“前插加载 + 矩形复制”组合未被现有测试覆盖。此数字不是本支执行结果。

### 复制失败反馈与删除结果的故障注入

- 在真实 `useGridEditor` 逻辑的测试环境中，注入 `clipboard.writeText` 拒绝，复制调用抛出错误，但状态文本为空、反馈列表为空。这证明复制写入失败缺少提示，不证明用户当时就是权限拒绝。见 [useGridEditor.js](../../src/workbench/composables/useGridEditor.js:4302)。
- 提取真实 `deleteHomeTables` 函数，在模拟后端返回成功 a、失败 b 时，实际显示“已删除 2 张表”，并关闭 a、b 两个标签。期望保留失败对象的断言失败，证明结果误报。
- 既有测试执行：`node --test src/workbench/useTableSession.test.js src/workbench/useRowSelection.test.js src/workbench/useGridEditor.test.js` 对应 354 项通过；`node --test src/workbench/utils/gridClipboardStore.test.js` 为 3 项通过。已有测试全通过并不能覆盖新复现的前插错位和故障提示缺口。

### 修复边界与准备度

可以开始针对性修改，不需要用户先提供精确行数：先固定向前加载后的选区身份，并补复制失败反馈和删表真实结果处理。普通向下追加、按行号整行选择作为对照保留，不能笼统改为每次加载都清空选区。

选区被复制、粘贴、剪切清空、批量修改和拖拽填充共享。修复必须覆盖这些入口，并验证冷/热加载、切换表后立即操作、复合主键、无主键及插入草稿。只修改复制文本生成可能掩盖其他入口仍使用旧下标的问题。

当前未在 Tauri 原生 WebView、用户实际数据库或历史完整应用版本上重现用户原始的偶发“完全没复制成功”；不宣称已经定位全部触发条件。先保留现有虚拟渲染性能设计，不建议回退整轮优化。删除提速应先在隔离环境分段测量，再采用保留事务与审计的局部优化，不承诺具体倍数。

## 研究阶段交付状态

仅新增 `docs/plans/2026-09-25-bulk-operations-investigation.md`。以上修复与性能方案均为建议，尚未实施；运行了模拟验证及已有测试，没有真实数据库操作，也没有修改程序、测试、依赖与版本号。

## 获准修复后的实施结果

用户随后授权“开始修复，尽量不要影响性能”。以下状态取代上一节的研究阶段状态。

- 向前补数据时修正矩形和离散选区的相对位置；切换表保存及恢复选区时也保留偏移。普通向下追加和滚动不扫描全表，不改变虚拟渲染。
- 复制写入剪贴板失败时显示明确错误，不再无提示地结束。
- 删行增加同表重复请求保护与等待提示。MySQL 删除仍在同一个事务内，每行身份、受影响行数及删除前镜像检查保留；仅将 SQLite 审计准备按 256 条落盘，完成状态批量落盘，持久性仍为 FULL。
- 批量审计的每条记录获得独立的同步幂等键，避免中央服务把同批其他记录当成重复记录。审计状态批量失败会整体回滚；中止清理保留逐条兜底。
- 删表每 32 张顺序处理并显示批次进度，只关闭确认删除成功的标签；失败或未知结果保留选择。请求异常不自动重试 DROP，后续批次停止；列表刷新失败与删除结果分开显示，列表只刷新一次。
- 为执行 macOS Rust 测试，补上原有 Windows 快捷方式分支缺少的编译条件。未改变 Windows 快捷方式处理逻辑。

### 修复后验证

| 检查 | 结果 |
| --- | --- |
| 全部 workbench JS 测试 | 1867 通过，0 失败 |
| 前端生产构建 | 通过；保留原有体积警告 |
| 批量复制浏览器回归 | 通过；9997..9999 选区前插后不变，一次复制 2000 行成功，模拟剪贴板拒绝有提示 |
| 宽表浏览器回归 | 通过；导航、编辑撤销、冻结列、跨窗口复制 |
| 插入行浏览器回归 | 通过；拖拽、Excel 粘贴、保存和撤销 |
| Rust 审计专项 | 18 通过，0 失败；磁盘基准默认忽略，另行显式执行 |
| Rust 全量，去除宿主 AI 授权环境变量后 | 492 通过，2 失败，2 忽略；失败为已有 Windows 路径预期在 macOS 的断言，不属于本次业务逻辑 |

Rust 全量失败测试为 `svn_updater::tests::tortoise_svn_path_is_under_program_files` 和 `table_transfer::tests::assets_dir_accepts_both_project_root_and_assets_layer`。最初继承宿主环境的测试另有 3 项授权配置失败；去除进程环境变量后这 3 项通过，没有修改持久化环境或授权配置。不能将 Rust 全量报告为全部通过。

### 性能对照与限制

生产预览、相同 `schema-800x60` 模拟场景各跑一轮，前后都只渲染 52 行、572 个单元格。选格阻塞中位数 6.5 -> 6.5 ms，编辑打开 2.8 -> 2.7 ms，切表阻塞 18.3 -> 17.6 ms；切表显示 p95 有 36.6 -> 44.3 ms 的波动。单轮样本没有显示日常交互明显变慢，但不足以保证所有环境零回归。

独立临时 SQLite 文件、WAL/FULL 的 1000 条审计准备加落定基准：逐条 196 ms，批量 28 ms。这只代表审计部分，不是数据库删除总耗时。基准不访问用户数据库，结束后清理临时文件。

未进行真实 MySQL 删除、故障恢复联合验证或 Tauri 原生剪贴板实测；MySQL 逐行 SELECT/DELETE、顺序 DROP 与锁等待仍然存在。删表本轮修复的是进度和结果准确性，没有承诺数据库实际执行明显提速。保留原有事务提交响应不确定性处理，不宣称解决跨 MySQL/SQLite 的分布式提交或崩溃恢复问题。尚未打包、安装、提交或发布。
