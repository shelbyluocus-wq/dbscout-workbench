# Dev Stress Demo Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Tauri development-only stress Demo profile for performance measurement, while release builds expose no built-in Demo data.

**Architecture:** Rust owns the demo profile boundary: debug builds default to a lazily generated stress profile, while release builds initialize with no demo connections when no MySQL URL is configured. The frontend keeps using the same command contract and adds development-only performance marks through one shared utility.

**Tech Stack:** Tauri 2, Rust 2021, Vue 3 Composition API, Vite, Node `node:test`, Rust `cargo test`.

---

## File Structure

- Modify `src-tauri/src/demo.rs`
  - Add deterministic stress database/table/page generation.
  - Keep row generation lazy for normal page reads.
  - Add helpers for materializing a single stress table only when demo mutations need it.
- Modify `src-tauri/src/types.rs`
  - Add `DemoProfile`, `RuntimeOptions`, and `RuntimeState::new`.
  - Make `AppState::new()` use debug/release compile-time defaults.
  - Ensure release-like runtime initialization has no demo connections.
- Modify `src-tauri/src/commands.rs`
  - Route no-MySQL command paths through the optional demo profile.
  - Return no demo data in release-like mode.
  - Avoid cloning/materializing all demo rows for stress reads.
- Modify `src/workbench/composables/useConnection.js`
  - Update no-connection empty status to real-connection language.
  - Add lightweight performance marks for connection/database loading.
- Modify `src/workbench/useConnection.test.js`
  - Cover frontend behavior when the backend returns no connections.
- Create `src/workbench/utils/performanceMarks.js`
  - Shared development-only performance logging utility.
- Create `src/workbench/utils/performanceMarks.test.js`
  - Unit coverage for performance logging and async measurement.
- Modify `src/workbench/utils/tauriBridge.js`
  - Measure Tauri command round trips in development.
- Modify `src/workbench/composables/useTableSession.js`
  - Mark table open/fetch page phases and frontend page replacement.
- Modify `src/workbench/components/DataGrid.vue`
  - Sample scroll frame delay in development.
- Modify `src/workbench/MySqlWorkbench.vue`
  - Mark workbench boot milestones.
- Modify `src/workbench/workbenchShell.test.js`
  - Static coverage that performance instrumentation stays routed through the shared utility.

---

### Task 1: Add deterministic stress demo generation

**Files:**
- Modify: `src-tauri/src/demo.rs`
- Test: `src-tauri/src/demo.rs`

- [ ] **Step 1: Write failing Rust tests for stress schema and lazy page generation**

Append these tests inside the existing `#[cfg(test)] mod tests` in `src-tauri/src/demo.rs`:

```rust
    #[test]
    fn stress_demo_databases_match_requested_scale() {
        let databases = stress_databases("demo-stress");

        assert_eq!(databases.len(), 12);
        assert_eq!(databases.first().map(String::as_str), Some("game_db_01"));
        assert_eq!(databases.last().map(String::as_str), Some("game_db_12"));
    }

    #[test]
    fn stress_schema_has_800_tables_with_large_and_wide_tables() {
        let schema = stress_schema_for("game_db_01");

        assert_eq!(schema.len(), 800);
        assert!(schema.iter().any(|table| stress_total_rows(&table.table_name) >= 5000));
        assert!(schema.iter().any(|table| table.columns.len() >= 30));
        assert!(schema.iter().all(|table| table.table_name.starts_with("db01_")));
    }

    #[test]
    fn stress_page_generation_returns_only_requested_page_and_is_deterministic() {
        let schema = stress_schema_for("game_db_01");
        let table = schema
            .iter()
            .find(|table| table.table_name.ends_with("_0020"))
            .expect("stress table 20 exists");
        let request = TablePageRequest {
            page: Some(2),
            page_size: Some(25),
            filter: None,
            sort: None,
        };

        let first = read_stress_demo_page(table, "stress-session", &request);
        let second = read_stress_demo_page(table, "stress-session", &request);

        assert_eq!(first.total_rows, 5000);
        assert_eq!(first.rows.len(), 25);
        assert_eq!(first.rows, second.rows);
        assert_eq!(first.rows[0].get("id").map(String::as_str), Some("26"));
    }
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
cd src-tauri && cargo test demo::tests::stress_demo -- --nocapture
```

Expected: FAIL to compile with missing functions such as `stress_databases`, `stress_schema_for`, `stress_total_rows`, and `read_stress_demo_page`.

- [ ] **Step 3: Implement the stress demo generator**

In `src-tauri/src/demo.rs`, add this code after the imports and before `pub fn demo_schema()`:

```rust
const STRESS_DB_COUNT: usize = 12;
const STRESS_TABLES_PER_DATABASE: usize = 800;
const STRESS_DEFAULT_CONNECTION_ID: &str = "demo-stress";
const STRESS_DEFAULT_DATABASE: &str = "game_db_01";

pub fn stress_connection_id() -> &'static str {
    STRESS_DEFAULT_CONNECTION_ID
}

pub fn stress_default_database() -> &'static str {
    STRESS_DEFAULT_DATABASE
}

pub fn stress_databases(_connection_id: &str) -> Vec<String> {
    (1..=STRESS_DB_COUNT)
        .map(|index| format!("game_db_{index:02}"))
        .collect()
}

fn stress_database_index(database: &str) -> usize {
    database
        .rsplit('_')
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1)
}

fn stress_table_index(table_name: &str) -> usize {
    table_name
        .rsplit('_')
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1)
}

fn stress_domain(table_index: usize) -> (&'static str, &'static str) {
    const DOMAINS: [(&str, &str); 10] = [
        ("config", "配置"),
        ("activity", "活动"),
        ("inventory", "库存"),
        ("economy", "经济"),
        ("localization", "多语言"),
        ("quest", "任务"),
        ("analytics", "分析"),
        ("mail", "邮件"),
        ("combat", "战斗"),
        ("audit", "审计"),
    ];
    DOMAINS[(table_index - 1) % DOMAINS.len()]
}

fn stress_table_name(database: &str, table_index: usize) -> String {
    let database_index = stress_database_index(database);
    let (domain, _) = stress_domain(table_index);
    format!("db{database_index:02}_{domain}_{table_index:04}")
}

fn stress_column(name: &str, typ: &str, comment: &str, pk: bool, nullable: bool) -> ColumnMeta {
    ColumnMeta {
        column_name: name.into(),
        column_type: typ.into(),
        column_comment: comment.into(),
        is_primary_key: pk,
        is_nullable: nullable,
    }
}

fn stress_columns(table_index: usize) -> Vec<ColumnMeta> {
    let (_, domain_label) = stress_domain(table_index);
    let mut columns = vec![
        stress_column("id", "int", "压力测试主键ID", true, false),
        stress_column("name", "varchar(96)", &format!("{domain_label}名称"), false, false),
        stress_column("category", "varchar(32)", "业务分类", false, false),
        stress_column("status", "tinyint", "状态(0关闭1开启2灰度3归档)", false, false),
        stress_column("owner", "varchar(64)", "负责人或系统来源", false, true),
        stress_column("priority", "int", "排序优先级", false, false),
        stress_column("version", "varchar(32)", "配置版本", false, false),
        stress_column("start_time", "datetime", "开始时间", false, true),
        stress_column("end_time", "datetime", "结束时间", false, true),
        stress_column("payload", "text", "JSON配置或日志内容", false, true),
        stress_column("remark", "text", "较长备注，用于测试 inspector 和网格文本渲染", false, true),
        stress_column("updated_at", "datetime", "更新时间", false, false),
    ];

    if table_index % 17 == 0 {
        for metric_index in 1..=28 {
            columns.push(stress_column(
                &format!("metric_{metric_index:02}"),
                "decimal(12,4)",
                &format!("宽表指标列 {metric_index:02}"),
                false,
                true,
            ));
        }
    } else if table_index % 13 == 0 {
        for segment_index in 1..=12 {
            columns.push(stress_column(
                &format!("segment_{segment_index:02}"),
                "varchar(64)",
                &format!("分群字段 {segment_index:02}"),
                false,
                true,
            ));
        }
    }

    columns
}

pub fn stress_schema_for(database: &str) -> Vec<TableMeta> {
    (1..=STRESS_TABLES_PER_DATABASE)
        .map(|table_index| {
            let table_name = stress_table_name(database, table_index);
            let (_, domain_label) = stress_domain(table_index);
            TableMeta {
                table_name,
                table_comment: format!("{domain_label}压力表 #{table_index:04}，用于开发模式性能检测"),
                columns: stress_columns(table_index),
            }
        })
        .collect()
}

pub fn stress_total_rows(table_name: &str) -> usize {
    let table_index = stress_table_index(table_name);
    if table_index % 20 == 0 {
        5000
    } else if table_index % 10 == 0 {
        3000
    } else if table_index % 5 == 0 {
        1000
    } else {
        400 + (table_index % 7) * 50
    }
}

fn stress_cell_value(table: &TableMeta, column: &ColumnMeta, row_number: usize) -> String {
    match column.column_name.as_str() {
        "id" => row_number.to_string(),
        "name" => format!("{}_row_{row_number:05}", table.table_name),
        "category" => ["system", "combat", "economy", "event", "ops"][row_number % 5].to_string(),
        "status" => (row_number % 4).to_string(),
        "owner" => ["designer", "ops", "server", "client", "analytics"][row_number % 5].to_string(),
        "priority" => ((row_number * 7) % 1000).to_string(),
        "version" => format!("{}.{}.{}", row_number % 3 + 1, row_number % 12, row_number % 30),
        "start_time" => format!("2026-{:02}-{:02} {:02}:00:00", row_number % 12 + 1, row_number % 28 + 1, row_number % 24),
        "end_time" => format!("2026-{:02}-{:02} {:02}:30:00", (row_number + 1) % 12 + 1, (row_number + 7) % 28 + 1, row_number % 24),
        "payload" => format!(r#"{{"table":"{}","row":{},"enabled":{},"weight":{}}}"#, table.table_name, row_number, row_number % 2 == 0, row_number % 97),
        "remark" => format!("压力测试备注：{} 第 {row_number} 行，包含中文、English identifiers 和较长文本。", table.table_comment),
        "updated_at" => format!("2026-{:02}-{:02} {:02}:{:02}:00", row_number % 12 + 1, row_number % 28 + 1, row_number % 24, row_number % 60),
        name if name.starts_with("metric_") => format!("{:.4}", (row_number as f64 * 1.137) + name.len() as f64),
        name if name.starts_with("segment_") => format!("segment_{}_{}", row_number % 16, name),
        _ => format!("{}_{}", column.column_name, row_number),
    }
}

pub fn stress_row(table: &TableMeta, row_number: usize) -> HashMap<String, String> {
    table
        .columns
        .iter()
        .map(|column| (column.column_name.clone(), stress_cell_value(table, column, row_number)))
        .collect()
}

pub fn materialize_stress_rows(table: &TableMeta) -> Vec<HashMap<String, String>> {
    (1..=stress_total_rows(&table.table_name))
        .map(|row_number| stress_row(table, row_number))
        .collect()
}

pub fn read_stress_demo_page(table: &TableMeta, session_id: &str, request: &TablePageRequest) -> TableSessionPage {
    let (page, page_size) = normalize_page_request(request);
    let needs_materialized_rows = request.filter.is_some() || request.sort.is_some();
    let total_rows = stress_total_rows(&table.table_name);

    let page_rows = if needs_materialized_rows {
        let rows = apply_demo_request(materialize_stress_rows(table), &table.columns, request);
        let start = ((page - 1) * page_size) as usize;
        let end = (start + page_size as usize).min(rows.len());
        if start < rows.len() { rows[start..end].to_vec() } else { Vec::new() }
    } else {
        let start = ((page - 1) * page_size) as usize + 1;
        let end = (start + page_size as usize).min(total_rows + 1);
        (start..end).map(|row_number| stress_row(table, row_number)).collect()
    };

    TableSessionPage {
        session_id: session_id.into(),
        table_name: table.table_name.clone(),
        table_comment: table.table_comment.clone(),
        columns: table.columns.clone(),
        primary_keys: primary_keys(table),
        rows: page_rows,
        total_rows: total_rows as u64,
        page,
        page_size,
    }
}

pub fn read_stress_or_materialized_page(
    materialized_rows: Option<&Vec<HashMap<String, String>>>,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
) -> TableSessionPage {
    if let Some(rows) = materialized_rows {
        read_demo_page_from_rows(rows.clone(), table, session_id, request)
    } else {
        read_stress_demo_page(table, session_id, request)
    }
}

pub fn sample_stress_rows(table: &TableMeta, limit: usize) -> Vec<HashMap<String, String>> {
    let total = stress_total_rows(&table.table_name).min(limit);
    (1..=total).map(|row_number| stress_row(table, row_number)).collect()
}
```

Then replace the existing `read_demo_page` implementation with a small wrapper that uses a new reusable helper. Replace lines `pub fn read_demo_page` through its closing brace with:

```rust
fn read_demo_page_from_rows(
    rows: Vec<HashMap<String, String>>,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
) -> TableSessionPage {
    let (page, page_size) = normalize_page_request(request);
    let rows = apply_demo_request(rows, &table.columns, request);
    let total_rows = rows.len() as u64;
    let start = ((page - 1) * page_size) as usize;
    let end = (start + page_size as usize).min(rows.len());
    let page_rows = if start < rows.len() { rows[start..end].to_vec() } else { Vec::new() };

    TableSessionPage {
        session_id: session_id.into(),
        table_name: table.table_name.clone(),
        table_comment: table.table_comment.clone(),
        columns: table.columns.clone(),
        primary_keys: primary_keys(table),
        rows: page_rows,
        total_rows,
        page,
        page_size,
    }
}

pub fn read_demo_page(
    demo_rows: &HashMap<String, Vec<HashMap<String, String>>>,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
) -> TableSessionPage {
    read_demo_page_from_rows(
        demo_rows.get(&table.table_name).cloned().unwrap_or_default(),
        table,
        session_id,
        request,
    )
}
```

- [ ] **Step 4: Run stress generator tests**

Run:

```bash
cd src-tauri && cargo test demo::tests::stress_demo -- --nocapture
```

Expected: PASS for the three new stress tests.

- [ ] **Step 5: Run existing demo tests**

Run:

```bash
cd src-tauri && cargo test demo::tests -- --nocapture
```

Expected: all demo tests pass, including the existing filter/sort/page tests.

- [ ] **Step 6: Commit this task if commits are authorized**

```bash
git add src-tauri/src/demo.rs
git commit -m "feat: add lazy stress demo generator"
```

---

### Task 2: Add runtime mode boundary and release-without-demo initialization

**Files:**
- Modify: `src-tauri/src/types.rs`
- Test: `src-tauri/src/types.rs`

- [ ] **Step 1: Write failing runtime initialization tests**

Inside the existing `#[cfg(test)] mod tests` in `src-tauri/src/types.rs`, append:

```rust
    #[test]
    fn release_like_runtime_has_no_demo_connections_without_mysql_url() {
        let runtime = RuntimeState::new(None, RuntimeOptions { demo_profile: None });

        assert!(runtime.connections.is_empty());
        assert_eq!(runtime.selected_connection_id, "");
        assert_eq!(runtime.selected_database, "");
        assert!(runtime.schema.is_empty());
        assert_eq!(runtime.demo_profile, None);
        assert!(runtime.demo_rows.is_empty());
    }

    #[test]
    fn debug_stress_runtime_has_stress_demo_connection_without_mysql_url() {
        let runtime = RuntimeState::new(None, RuntimeOptions { demo_profile: Some(DemoProfile::Stress) });

        assert_eq!(runtime.connections.len(), 1);
        assert_eq!(runtime.selected_connection_id, "demo-stress");
        assert_eq!(runtime.selected_database, "game_db_01");
        assert_eq!(runtime.demo_profile, Some(DemoProfile::Stress));
        assert_eq!(runtime.schema.len(), 800);
        assert!(runtime.demo_rows.is_empty());
    }

    #[test]
    fn mysql_runtime_ignores_demo_profile() {
        let runtime = RuntimeState::new(
            Some("mysql://root:secret@127.0.0.1:3306".into()),
            RuntimeOptions { demo_profile: Some(DemoProfile::Stress) },
        );

        assert_eq!(runtime.connections.len(), 1);
        assert!(runtime.connections.contains_key("mysql-env"));
        assert_eq!(runtime.selected_connection_id, "mysql-env");
        assert_eq!(runtime.demo_profile, None);
    }
```

- [ ] **Step 2: Run the failing runtime tests**

Run:

```bash
cd src-tauri && cargo test types::tests::release_like_runtime_has_no_demo_connections_without_mysql_url types::tests::debug_stress_runtime_has_stress_demo_connection_without_mysql_url types::tests::mysql_runtime_ignores_demo_profile -- --nocapture
```

Expected: FAIL to compile because `RuntimeOptions`, `DemoProfile`, and `RuntimeState::new` do not exist.

- [ ] **Step 3: Implement runtime options and constructor**

In `src-tauri/src/types.rs`, add these definitions before `pub struct RuntimeState`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DemoProfile {
    Stress,
}

#[derive(Debug, Clone, Copy)]
pub struct RuntimeOptions {
    pub demo_profile: Option<DemoProfile>,
}

impl RuntimeOptions {
    pub fn for_current_build() -> Self {
        Self {
            demo_profile: if cfg!(debug_assertions) { Some(DemoProfile::Stress) } else { None },
        }
    }
}
```

Add this field to `RuntimeState`:

```rust
    pub demo_profile: Option<DemoProfile>,
```

Replace the body of `impl AppState { pub fn new() -> Self { ... } }` with a runtime constructor split. The final `impl AppState` and new `impl RuntimeState` should be:

```rust
impl RuntimeState {
    pub fn new(mysql_url: Option<String>, options: RuntimeOptions) -> Self {
        let mut connections = HashMap::new();
        let mut selected_connection_id = String::new();
        let mut selected_database = String::new();
        let mut schema = Vec::new();
        let demo_profile = if mysql_url.is_some() { None } else { options.demo_profile };

        if let Some(url) = &mysql_url {
            selected_connection_id = "mysql-env".into();
            selected_database = "game_db".into();
            connections.insert("mysql-env".into(), RuntimeConnection {
                id: "mysql-env".into(),
                label: "MySQL".into(),
                host: "configured".into(),
                port: 3306,
                username: "env".into(),
                mysql_url: Some(url.clone()),
                database: Some(selected_database.clone()),
                pool: None,
            });
            schema = crate::demo::demo_schema();
        } else if matches!(demo_profile, Some(DemoProfile::Stress)) {
            selected_connection_id = crate::demo::stress_connection_id().into();
            selected_database = crate::demo::stress_default_database().into();
            connections.insert(selected_connection_id.clone(), RuntimeConnection {
                id: selected_connection_id.clone(),
                label: "Stress Demo".into(),
                host: "demo".into(),
                port: 3306,
                username: "root".into(),
                mysql_url: None,
                database: Some(selected_database.clone()),
                pool: None,
            });
            schema = crate::demo::stress_schema_for(&selected_database);
        }

        Self {
            connections,
            selected_connection_id,
            selected_database,
            schema,
            sessions: HashMap::new(),
            next_session_id: 0,
            demo_profile,
            demo_rows: HashMap::new(),
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        let mysql_url = env::var("DBSCOUT_MYSQL_URL").ok().filter(|value| !value.trim().is_empty());
        Self::with_runtime_options(mysql_url, RuntimeOptions::for_current_build())
    }

    pub fn with_runtime_options(mysql_url: Option<String>, options: RuntimeOptions) -> Self {
        Self { runtime: Mutex::new(RuntimeState::new(mysql_url, options)) }
    }
}
```

- [ ] **Step 4: Run runtime tests**

Run:

```bash
cd src-tauri && cargo test types::tests -- --nocapture
```

Expected: all `types::tests` pass.

- [ ] **Step 5: Commit this task if commits are authorized**

```bash
git add src-tauri/src/types.rs
git commit -m "feat: gate demo runtime by build mode"
```

---

### Task 3: Wire Tauri commands through the optional demo profile

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Test: `src-tauri/src/demo.rs`, `src-tauri/src/types.rs`, `src-tauri/src/commands.rs`

- [ ] **Step 1: Add imports and helpers in `commands.rs`**

Replace the existing demo import in `src-tauri/src/commands.rs`:

```rust
use crate::demo::{demo_schema_for, demo_databases, read_demo_page, resolve_demo_table};
```

with:

```rust
use crate::demo::{
    materialize_stress_rows,
    read_stress_or_materialized_page,
    resolve_demo_table,
    sample_stress_rows,
    stress_databases,
    stress_schema_for,
};
```

After the imports, add:

```rust
fn no_demo_error() -> String {
    "没有可用的内置演示数据，请先新建 MySQL 连接".into()
}

fn ensure_demo_rows_for_mutation<'a>(
    rows: &'a mut HashMap<String, Vec<HashMap<String, String>>>,
    profile: Option<DemoProfile>,
    table: &TableMeta,
) -> &'a mut Vec<HashMap<String, String>> {
    if !rows.contains_key(&table.table_name) {
        let generated = match profile {
            Some(DemoProfile::Stress) => materialize_stress_rows(table),
            None => Vec::new(),
        };
        rows.insert(table.table_name.clone(), generated);
    }
    rows.get_mut(&table.table_name).expect("demo rows were inserted")
}
```

- [ ] **Step 2: Update no-MySQL branches in command handlers**

Make these targeted replacements in `src-tauri/src/commands.rs`.

In `list_databases`, change the runtime tuple to include `demo_profile`:

```rust
let (connection_id, mysql_url, pool, demo_profile) = {
    let rt = state.runtime.lock().await;
    let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
    let connection = rt
        .connections
        .get(&connection_id)
        .ok_or_else(|| "连接不存在".to_string())?;
    (connection_id, connection.mysql_url.clone(), connection.pool.clone(), rt.demo_profile)
};
let Some(mysql_url) = mysql_url else {
    return Ok(match demo_profile {
        Some(DemoProfile::Stress) => stress_databases(&connection_id),
        None => Vec::new(),
    });
};
```

In `select_database`, include `demo_profile` in the first tuple and replace the demo branch:

```rust
let (connection_id, mysql_url, demo_profile) = {
    let rt = state.runtime.lock().await;
    let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
    let connection = rt
        .connections
        .get(&connection_id)
        .ok_or_else(|| "连接不存在".to_string())?;
    (connection_id, connection.mysql_url.clone(), rt.demo_profile)
};
```

Then replace the `else` branch with:

```rust
} else {
    let mut rt = state.runtime.lock().await;
    rt.selected_connection_id = connection_id.clone();
    rt.selected_database = database.clone();
    if let Some(connection) = rt.connections.get_mut(&connection_id) {
        connection.database = Some(database.clone());
    }
    rt.schema = match demo_profile {
        Some(DemoProfile::Stress) => stress_schema_for(&database),
        None => Vec::new(),
    };
}
```

In `get_table_schema`, include `demo_profile` in the tuple and replace the no-pool branch:

```rust
let (pool, database, schema, demo_profile) = {
    let rt = state.runtime.lock().await;
    let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
    let connection = rt
        .connections
        .get(&connection_id)
        .ok_or_else(|| "连接不存在".to_string())?;
    (
        connection.pool.clone(),
        database.unwrap_or_else(|| connection.database.clone().unwrap_or_else(|| rt.selected_database.clone())),
        rt.schema.clone(),
        rt.demo_profile,
    )
};
if let Some(pool) = pool {
    read_schema(&pool, &database, &table_name).await
} else if demo_profile.is_some() {
    resolve_demo_table(&table_name, &schema)
} else {
    Err(no_demo_error())
}
```

In `open_table_session`, change the runtime tuple to retrieve only materialized rows for the requested table:

```rust
let request = options.unwrap_or_default();
let requested_table_name = table_name.clone();
let (connection_id, database, mysql_url, schema, demo_profile, materialized_rows) = {
    let rt = state.runtime.lock().await;
    let connection_id = connection_id.unwrap_or_else(|| rt.selected_connection_id.clone());
    let connection = rt
        .connections
        .get(&connection_id)
        .ok_or_else(|| "连接不存在".to_string())?;
    let database = database.unwrap_or_else(|| connection.database.clone().unwrap_or_else(|| rt.selected_database.clone()));
    (
        connection_id,
        database,
        connection.mysql_url.clone(),
        rt.schema.clone(),
        rt.demo_profile,
        rt.demo_rows.get(&requested_table_name).cloned(),
    )
};
```

Then replace the no-pool page return with:

```rust
if let Some(pool) = pool {
    read_db_page(&pool, &table, &session_id, &request).await
} else if matches!(demo_profile, Some(DemoProfile::Stress)) {
    Ok(read_stress_or_materialized_page(materialized_rows.as_ref(), &table, &session_id, &request))
} else {
    Err(no_demo_error())
}
```

In `fetch_table_page`, change the runtime tuple and no-pool return:

```rust
let (session, schema, demo_profile, materialized_rows) = {
    let rt = state.runtime.lock().await;
    let session = rt
        .sessions
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "表会话已失效，请重新打开表".to_string())?;
    let materialized_rows = rt.demo_rows.get(&session.table_name).cloned();
    (session, rt.schema.clone(), rt.demo_profile, materialized_rows)
};
```

Use this no-pool return:

```rust
if let Some(pool) = session.pool {
    read_db_page(&pool, &table, &session_id, &request).await
} else if matches!(demo_profile, Some(DemoProfile::Stress)) {
    Ok(read_stress_or_materialized_page(materialized_rows.as_ref(), &table, &session_id, &request))
} else {
    Err(no_demo_error())
}
```

- [ ] **Step 3: Update demo mutation handlers to materialize only the edited table**

In `update_cell`, replace the no-pool block starting with `let mut rt = state.runtime.lock().await;` with:

```rust
let mut rt = state.runtime.lock().await;
let table = resolve_demo_table(&session.table_name, &rt.schema)?;
let profile = rt.demo_profile;
let rows = ensure_demo_rows_for_mutation(&mut rt.demo_rows, profile, &table);
for row in rows {
    let matched = request.row_identity.iter().all(|(key, value)| row.get(key).map(|current| current == value).unwrap_or(false));
    if matched {
        let current = row.get(&request.column_name).cloned().unwrap_or_default();
        if current != request.old_value {
            return Ok(UpdateCellResult { updated: false, conflict: true, value: current });
        }
        row.insert(request.column_name, request.new_value.clone());
        return Ok(UpdateCellResult { updated: true, conflict: false, value: request.new_value });
    }
}
Ok(UpdateCellResult { updated: false, conflict: true, value: request.old_value })
```

In `insert_row`, replace the no-pool block with:

```rust
let mut rt = state.runtime.lock().await;
let table = resolve_demo_table(&session.table_name, &rt.schema)?;
let profile = rt.demo_profile;
let rows = ensure_demo_rows_for_mutation(&mut rt.demo_rows, profile, &table);
if has_primary_key_conflict(&table, rows, &draft) {
    return Err(PRIMARY_KEY_DUPLICATE_MESSAGE.into());
}
rows.push(draft);
Ok(RowMutationResult { affected: 1 })
```

In `delete_rows`, replace the no-pool block with:

```rust
let mut rt = state.runtime.lock().await;
let table = resolve_demo_table(&session.table_name, &rt.schema)?;
let profile = rt.demo_profile;
let rows = ensure_demo_rows_for_mutation(&mut rt.demo_rows, profile, &table);
let before = rows.len();
rows.retain(|row| {
    !request.row_identities.iter().any(|identity| {
        identity.iter().all(|(key, value)| row.get(key).map(|current| current == value).unwrap_or(false))
    })
});
Ok(RowMutationResult { affected: before.saturating_sub(rows.len()) as u64 })
```

- [ ] **Step 4: Update quick search sampling for stress profile**

In `quick_search`, change the tuple from:

```rust
let (schema, demo_rows) = {
    let rt = state.runtime.lock().await;
    (rt.schema.clone(), rt.demo_rows.clone())
};
```

to:

```rust
let (schema, demo_profile, demo_rows) = {
    let rt = state.runtime.lock().await;
    (rt.schema.clone(), rt.demo_profile, rt.demo_rows.clone())
};
```

Replace the row-search loop body with:

```rust
for table in tables {
    let sampled_rows = demo_rows
        .get(&table.table_name)
        .map(|rows| rows.iter().take(20).cloned().collect::<Vec<_>>())
        .unwrap_or_else(|| match demo_profile {
            Some(DemoProfile::Stress) => sample_stress_rows(table, 20),
            None => Vec::new(),
        });
    for row in sampled_rows {
        if let Some((column, value)) = row.iter().find(|(_, value)| value.to_lowercase().contains(&query)) {
            out.push(QuickSearchItem {
                kind: "row".into(),
                table_name: table.table_name.clone(),
                column_name: Some(column.clone()),
                label: table.table_name.clone(),
                preview: format!("{column}: {value}"),
            });
        }
    }
}
```

- [ ] **Step 5: Run Rust tests**

Run:

```bash
cd src-tauri && cargo test -- --nocapture
```

Expected: all Rust tests pass.

- [ ] **Step 6: Commit this task if commits are authorized**

```bash
git add src-tauri/src/commands.rs src-tauri/src/demo.rs src-tauri/src/types.rs
git commit -m "feat: route commands through stress demo profile"
```

---

### Task 4: Handle release no-connection empty state in the frontend

**Files:**
- Modify: `src/workbench/composables/useConnection.js`
- Test: `src/workbench/useConnection.test.js`

- [ ] **Step 1: Write a failing frontend test for no backend connections**

Append to `src/workbench/useConnection.test.js`:

```js
test("loadConnections keeps an empty connection state when the backend has no connections", async () => {
  installLocalStorage();
  const workspace = createWorkspaceState();
  const calls = [];
  const invoke = async (command, payload = {}) => {
    calls.push({ command, payload });
    if (command === "list_connections") return [];
    assert.fail(`unexpected command: ${command}`);
  };
  const conn = useConnection(workspace, invoke);

  await conn.loadConnections();

  assert.deepEqual(conn.connections.value, []);
  assert.equal(conn.selectedConnectionId.value, "");
  assert.equal(conn.selectedDatabase.value, "");
  assert.deepEqual(conn.databases.value, []);
  assert.match(conn.statusText.value, /新建 MySQL 连接/);
  assert.deepEqual(calls, [{ command: "list_connections", payload: {} }]);
});
```

- [ ] **Step 2: Run the failing frontend test**

Run:

```bash
node --test src/workbench/useConnection.test.js
```

Expected: FAIL because the current message mentions demo testing instead of only creating a MySQL connection.

- [ ] **Step 3: Update the empty connection status text**

In `src/workbench/composables/useConnection.js`, replace:

```js
statusText.value = "请先在设置中配置 MySQL 连接，或使用 demo 测试连接";
```

with:

```js
statusText.value = "请先新建 MySQL 连接";
```

- [ ] **Step 4: Run the frontend connection test**

Run:

```bash
node --test src/workbench/useConnection.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit this task if commits are authorized**

```bash
git add src/workbench/composables/useConnection.js src/workbench/useConnection.test.js
git commit -m "fix: handle empty release connection state"
```

---

### Task 5: Add shared development-only performance logging utility

**Files:**
- Create: `src/workbench/utils/performanceMarks.js`
- Create: `src/workbench/utils/performanceMarks.test.js`

- [ ] **Step 1: Write the failing performance utility test**

Create `src/workbench/utils/performanceMarks.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { markPerf, measureAsync } from "./performanceMarks.js";

test("markPerf writes development-only performance records", () => {
  const previousFlag = globalThis.__DBSCOUT_PERF_ENABLED__;
  const previousDebug = console.debug;
  const records = [];
  globalThis.__DBSCOUT_PERF_ENABLED__ = true;
  console.debug = (...args) => records.push(args);

  try {
    const at = markPerf("connection.loaded", { count: 12 });

    assert.equal(typeof at, "number");
    assert.equal(records.length, 1);
    assert.equal(records[0][0], "[dbscout:perf]");
    assert.equal(records[0][1], "connection.loaded");
    assert.equal(records[0][2].count, 12);
  } finally {
    console.debug = previousDebug;
    globalThis.__DBSCOUT_PERF_ENABLED__ = previousFlag;
  }
});

test("measureAsync logs duration and returns the wrapped result", async () => {
  const previousFlag = globalThis.__DBSCOUT_PERF_ENABLED__;
  const previousDebug = console.debug;
  const records = [];
  globalThis.__DBSCOUT_PERF_ENABLED__ = true;
  console.debug = (...args) => records.push(args);

  try {
    const result = await measureAsync("invoke:list_connections", async () => "ok", { command: "list_connections" });

    assert.equal(result, "ok");
    assert.equal(records.length, 1);
    assert.equal(records[0][0], "[dbscout:perf]");
    assert.equal(records[0][1], "invoke:list_connections");
    assert.equal(records[0][2].command, "list_connections");
    assert.equal(typeof records[0][2].durationMs, "number");
  } finally {
    console.debug = previousDebug;
    globalThis.__DBSCOUT_PERF_ENABLED__ = previousFlag;
  }
});
```

- [ ] **Step 2: Run the failing utility test**

Run:

```bash
node --test src/workbench/utils/performanceMarks.test.js
```

Expected: FAIL because `performanceMarks.js` does not exist.

- [ ] **Step 3: Implement the performance utility**

Create `src/workbench/utils/performanceMarks.js`:

```js
const PERF_PREFIX = "[dbscout:perf]";
const SLOW_FRAME_MS = 32;

export function isPerformanceLoggingEnabled() {
  return Boolean(globalThis.__DBSCOUT_PERF_ENABLED__ || import.meta.env?.DEV) && typeof performance !== "undefined";
}

function roundedNow() {
  return Number(performance.now().toFixed(2));
}

function roundedDuration(start) {
  return Number((performance.now() - start).toFixed(2));
}

export function markPerf(label, details = {}) {
  if (!isPerformanceLoggingEnabled()) return null;
  const at = roundedNow();
  console.debug(PERF_PREFIX, label, { at, ...details });
  return at;
}

export async function measureAsync(label, action, details = {}) {
  if (!isPerformanceLoggingEnabled()) return action();
  const start = performance.now();
  try {
    const result = await action();
    console.debug(PERF_PREFIX, label, { ...details, durationMs: roundedDuration(start) });
    return result;
  } catch (error) {
    console.debug(PERF_PREFIX, `${label}:error`, {
      ...details,
      durationMs: roundedDuration(start),
      error: String(error?.message || error),
    });
    throw error;
  }
}

export function sampleNextFrame(label, details = {}) {
  if (!isPerformanceLoggingEnabled() || typeof requestAnimationFrame !== "function") return;
  const start = performance.now();
  requestAnimationFrame(() => {
    const frameDelayMs = roundedDuration(start);
    if (frameDelayMs >= SLOW_FRAME_MS) {
      console.debug(PERF_PREFIX, label, { ...details, frameDelayMs });
    }
  });
}
```

- [ ] **Step 4: Run the utility test**

Run:

```bash
node --test src/workbench/utils/performanceMarks.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit this task if commits are authorized**

```bash
git add src/workbench/utils/performanceMarks.js src/workbench/utils/performanceMarks.test.js
git commit -m "feat: add development performance marks"
```

---

### Task 6: Wire performance marks into command and render paths

**Files:**
- Modify: `src/workbench/utils/tauriBridge.js`
- Modify: `src/workbench/composables/useConnection.js`
- Modify: `src/workbench/composables/useTableSession.js`
- Modify: `src/workbench/components/DataGrid.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workbenchShell.test.js`

- [ ] **Step 1: Write failing static coverage for instrumentation routing**

Append to `src/workbench/workbenchShell.test.js`:

```js
test("performance instrumentation uses the shared development-only utility", () => {
  const perf = read("./utils/performanceMarks.js");
  const bridge = read("./utils/tauriBridge.js");
  const connection = read("./composables/useConnection.js");
  const tableSession = read("./composables/useTableSession.js");
  const grid = read("./components/DataGrid.vue");
  const orchestrator = read("./MySqlWorkbench.vue");

  assert.match(perf, /\[dbscout:perf\]/);
  assert.match(perf, /import\.meta\.env\?\.DEV/);
  assert.match(bridge, /measureAsync/);
  assert.match(connection, /markPerf/);
  assert.match(tableSession, /markPerf/);
  assert.match(grid, /sampleNextFrame/);
  assert.match(orchestrator, /workbench\.mounted/);
});
```

- [ ] **Step 2: Run the failing static test**

Run:

```bash
node --test src/workbench/workbenchShell.test.js
```

Expected: FAIL because these imports/marks are not wired yet.

- [ ] **Step 3: Instrument Tauri command round trips**

In `src/workbench/utils/tauriBridge.js`, add:

```js
import { measureAsync } from "./performanceMarks.js";
```

Replace `invokeWorkbench` with:

```js
export async function invokeWorkbench(command, payload = {}) {
  return measureAsync(`invoke:${command}`, async () => {
    try {
      return await tauriInvoke(command, payload);
    } catch (error) {
      if (isTauriInvokeUnavailable(error)) {
        return mockWorkbenchInvoke(command, payload);
      }
      throw error;
    }
  }, { command });
}
```

- [ ] **Step 4: Instrument connection and database loading**

In `src/workbench/composables/useConnection.js`, add this import:

```js
import { markPerf, measureAsync } from "../utils/performanceMarks.js";
```

Inside `loadConnections`, replace:

```js
connections.value = applyConnectionOrder(await invokeWorkbench("list_connections"));
```

with:

```js
connections.value = applyConnectionOrder(await measureAsync("connection.list", () => invokeWorkbench("list_connections")));
markPerf("connection.loaded", { count: connections.value.length });
```

Inside `selectConnection`, replace:

```js
const nextDatabases = applyDatabaseOrder(connectionId, await invokeWorkbench("list_databases", { connectionId }));
```

with:

```js
const nextDatabases = applyDatabaseOrder(
  connectionId,
  await measureAsync("database.list", () => invokeWorkbench("list_databases", { connectionId }), { connectionId }),
);
markPerf("database.loaded", { connectionId, count: nextDatabases.length });
```

Inside `selectDatabase`, after the `list_tables` call updates `workspace.tables`, add:

```js
markPerf("tables.loaded", { connectionId, database, count: workspace.tables.length });
```

If the code does not have a single obvious post-`list_tables` line, place the mark immediately after the statement assigning table placeholders to `workspace.tables`.

- [ ] **Step 5: Instrument table session loading and page replacement**

In `src/workbench/composables/useTableSession.js`, add:

```js
import { markPerf, measureAsync, sampleNextFrame } from "../utils/performanceMarks.js";
```

In `openTable`, replace the `open_table_session` invoke with:

```js
const page = await measureAsync("table.open.invoke", () => invokeWorkbench("open_table_session", {
  connectionId,
  database,
  tableName,
  options: { page: 1, pageSize: REQUEST_PAGE_SIZE },
}), { connectionId, database, tableName });
```

Immediately before `replaceTabPage(workspace, tab.id, page);`, add:

```js
markPerf("table.page.replace.start", { tableName, rows: page.rows?.length || 0, columns: page.columns?.length || 0 });
```

Immediately after `replaceTabPage(workspace, tab.id, page);`, add:

```js
markPerf("table.page.replace.end", { tableName, rows: tab.rows?.length || 0, columns: tab.columns?.length || 0 });
sampleNextFrame("table.first-grid-frame", { tableName, rows: tab.rows?.length || 0, columns: tab.columns?.length || 0 });
```

In `fetchPage`, wrap `fetch_table_page` with:

```js
const payload = await measureAsync("table.fetch.invoke", () => invokeWorkbench("fetch_table_page", {
  sessionId: tab.sessionId,
  request: buildPageRequest(tab, page),
}), { tableName: tab.tableName, page });
```

In `loadNextPage`, wrap `fetch_table_page` with:

```js
const payload = await measureAsync("table.fetchMore.invoke", () => invokeWorkbench("fetch_table_page", {
  sessionId: tab.sessionId,
  request: buildPageRequest(tab, nextPage),
}), { tableName: tab.tableName, page: nextPage });
```

- [ ] **Step 6: Instrument grid scroll frame sampling**

In `src/workbench/components/DataGrid.vue`, add:

```js
import { sampleNextFrame } from "../utils/performanceMarks.js";
```

Near the other top-level variables, add:

```js
let lastScrollPerfSampleAt = 0;
```

Replace `onGridWrapScroll` with:

```js
function onGridWrapScroll(event) {
  emit('scroll', event);
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  if (now - lastScrollPerfSampleAt > 250) {
    lastScrollPerfSampleAt = now;
    sampleNextFrame("grid.scroll.frame", {
      tableName: props.tab?.tableName || "",
      loadedRows: props.tab?.rows?.length || 0,
      visibleRows: props.visibleRows.length,
      columns: props.activeColumns.length,
    });
  }
}
```

- [ ] **Step 7: Instrument workbench boot milestones**

In `src/workbench/MySqlWorkbench.vue`, add:

```js
import { markPerf, sampleNextFrame } from "./utils/performanceMarks.js";
```

After the imports and before state initialization, add:

```js
markPerf("workbench.module-loaded");
```

Inside `onMounted(async () => {`, add as the first line:

```js
markPerf("workbench.mounted");
```

After `await conn.loadConnections();`, add:

```js
markPerf("workbench.connections-ready", { connections: connections.value.length, databases: databases.value.length });
```

After `await restoreSavedTabs();`, add:

```js
markPerf("workbench.tabs-restored", { tabs: workspace.tabs.length });
sampleNextFrame("workbench.first-usable-frame", { tabs: workspace.tabs.length, tables: workspace.tables.length });
```

- [ ] **Step 8: Run frontend tests**

Run:

```bash
node --test src/workbench/workbenchShell.test.js src/workbench/utils/performanceMarks.test.js src/workbench/useConnection.test.js
```

Expected: all listed tests pass.

- [ ] **Step 9: Commit this task if commits are authorized**

```bash
git add src/workbench/utils/tauriBridge.js src/workbench/composables/useConnection.js src/workbench/composables/useTableSession.js src/workbench/components/DataGrid.vue src/workbench/MySqlWorkbench.vue src/workbench/workbenchShell.test.js
git commit -m "feat: add development performance instrumentation"
```

---

### Task 7: Full automated verification

**Files:**
- No code changes unless a test failure reveals a task implementation mistake.

- [ ] **Step 1: Run all Rust tests**

Run:

```bash
cd src-tauri && cargo test -- --nocapture
```

Expected: PASS. If a test fails, fix the smallest implementation mistake in the task that introduced it, then rerun this command.

- [ ] **Step 2: Run all JS tests recursively**

Run:

```bash
node --test src/workbench
```

Expected: PASS. If a test fails, fix the smallest implementation mistake in the task that introduced it, then rerun this command.

- [ ] **Step 3: Run Rust type check**

Run:

```bash
cd src-tauri && cargo check
```

Expected: PASS.

- [ ] **Step 4: Run frontend build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit verification fixes if commits are authorized and changes were required**

If Steps 1-4 required fixes, commit only those fixes:

```bash
git add <fixed-files>
git commit -m "fix: stabilize stress demo verification"
```

---

### Task 8: Runtime performance verification in Tauri dev mode

**Files:**
- No code changes unless runtime verification reveals a bug in the stress demo implementation.

- [ ] **Step 1: Start the Tauri dev app without a MySQL URL**

Run:

```bash
npm run tauri -- dev
```

Expected: the app launches with one `Stress Demo` connection. The console should include `[dbscout:perf]` records such as `workbench.mounted`, `connection.loaded`, and `workbench.first-usable-frame`.

- [ ] **Step 2: Verify stress databases**

In the running app, open the connection's database list.

Expected: 12 databases named `game_db_01` through `game_db_12`.

- [ ] **Step 3: Verify 800-table sidebar pressure**

Select `game_db_01`.

Expected: around 800 tables appear in the sidebar, and the console includes `[dbscout:perf] tables.loaded` with `count: 800`.

- [ ] **Step 4: Open a regular stress table**

Open a table whose name does not end in `_0005`, `_0010`, `_0017`, or `_0020`.

Expected: table opens, grid renders, and console includes `table.open.invoke`, `table.page.replace.start`, `table.page.replace.end`, and `table.first-grid-frame`.

- [ ] **Step 5: Open a large stress table**

Open a table ending in `_0020`.

Expected: status bar reports 5000 total rows, the loaded page contains up to `REQUEST_PAGE_SIZE` rows, and scrolling does not trigger obvious UI freezes.

- [ ] **Step 6: Open a wide stress table**

Open a table ending in `_0017`.

Expected: the grid contains at least 30 columns and horizontal scrolling works.

- [ ] **Step 7: Sample grid scroll performance**

Scroll vertically through the large table for at least 10 seconds.

Expected: if frames are slow, console emits `[dbscout:perf] grid.scroll.frame` records with table name, loaded row count, visible row count, column count, and frame delay. If no records appear during smooth scrolling, that is acceptable because the sampler logs only frames over the slow-frame threshold.

- [ ] **Step 8: Verify release-like no-demo behavior through tests or release run**

Preferred runtime check:

```bash
npm run tauri -- build
```

Then run the built app without `DBSCOUT_MYSQL_URL`.

Expected: no `Demo GameDB` and no `Stress Demo` connection appear; the app shows the real connection entry path.

If a local release run is not possible, rely on the passing Rust test `release_like_runtime_has_no_demo_connections_without_mysql_url` and report that release runtime observation was not performed.

- [ ] **Step 9: Record baseline findings**

Create a short report in the final response with these values observed from console logs:

```text
Startup:
- workbench.mounted: <observed>
- connection.loaded: <observed>
- workbench.first-usable-frame: <observed>

Sidebar:
- selected database: game_db_01
- tables.loaded count: 800

Table open:
- regular table invoke/page/frame: <observed>
- large table invoke/page/frame: <observed>
- wide table invoke/page/frame: <observed>

Scroll:
- slow frame records: <count and worst observed frameDelayMs>
```

- [ ] **Step 10: Commit runtime fixes if commits are authorized and changes were required**

If runtime verification required code changes, commit only those fixes:

```bash
git add <fixed-files>
git commit -m "fix: align stress demo runtime behavior"
```

---

## Self-Review

- Spec coverage:
  - Dev-only stress demo: Tasks 1-3.
  - Release no Demo: Tasks 2, 4, and 8.
  - 10-15 databases and around 800 tables: Task 1.
  - Lazy row generation: Tasks 1 and 3.
  - Deterministic data: Task 1.
  - Development measurements: Tasks 5, 6, and 8.
  - Verification: Tasks 7 and 8.
- Placeholder scan: no placeholder instructions are left for implementation; every code step includes exact snippets or commands.
- Type consistency:
  - `DemoProfile::Stress`, `RuntimeOptions`, and `RuntimeState::new` are introduced before command routing uses `rt.demo_profile`.
  - Stress functions used by commands are introduced in Task 1.
  - Frontend instrumentation consistently imports from `performanceMarks.js`.
