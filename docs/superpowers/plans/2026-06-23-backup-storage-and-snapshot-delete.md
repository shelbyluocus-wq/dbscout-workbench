# 备份中心存储位置可修改 + 单条快照删除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让备份中心存储位置可自定义修改，并支持单条快照删除。

**Architecture:** `BackupConfig` 新增 `storage_dir: Option<String>` 字段（None=默认 app_data_dir）。路径解析分双层：`config_root`（config.json 永驻，不受 storage_dir 影响）与 `storage_root`（快照+审计库根，可被 storage_dir 覆盖）。`list_snapshots` 合并扫描当前+旧位置并标记 `location`。新增 `delete_snapshot`（带越权路径校验）与 `pick_backup_directory`（rfd 选目录）两个命令。改 storage_dir 时复制旧 audit.sqlite 到新位置并重建 OnceCell（改为 `Mutex<Option<Pool>>`）。

**Tech Stack:** Rust + Tauri 2 + sqlx + rfd 0.17；Vue 3 Composition API + node:test。

**Spec:** `docs/superpowers/specs/2026-06-23-backup-storage-and-snapshot-delete-design.md`

---

## 文件结构

| 文件 | 责任 | 操作 |
|---|---|---|
| `src-tauri/src/types.rs` | `BackupConfig` 加 `storage_dir`、`SnapshotInfo` 加 `location`；`BackupState.audit_pool` 改 `Mutex<Option<Pool>>` | 修改 |
| `src-tauri/src/backup.rs` | `config_root`/`storage_root`/`snapshots_root` 重构；`delete_snapshot`；`list_snapshots` 合并扫描 | 修改 |
| `src-tauri/src/audit.rs` | 复用 `storage_root`；`ensure_audit_pool` 适配新容器；新增 `reset_audit_pool`、`migrate_audit_db` | 修改 |
| `src-tauri/src/commands.rs` | 新增 `delete_snapshot`、`pick_backup_directory`；`set_backup_config` 加迁移 | 修改 |
| `src-tauri/src/lib.rs` | 注册 2 个新命令 | 修改 |
| `src/workbench/composables/useBackupCenter.js` | `deleteSnapshot`、`pickStorageDir`、busy 字段、config 默认值 | 修改 |
| `src/workbench/components/BackupCenterDialog.vue` | 存储位置区块、删除按钮、旧位置角标、hint 文案 | 修改 |
| `src/workbench/workbench.css` | 新增样式类 | 修改 |
| `src/workbench/useBackupCenter.test.js` | 更新 mock + 新增 delete/pick 测试 | 修改 |

---

### Task 1: BackupConfig 与 SnapshotInfo 类型扩展

**Files:**
- Modify: `src-tauri/src/types.rs:582-629`（BackupConfig）、`690-700`（SnapshotInfo）、`568-580`（BackupState）

- [ ] **Step 1: 给 BackupConfig 加 storage_dir 字段**

在 `src-tauri/src/types.rs` 的 `BackupConfig` struct 中，`audit_retention_days` 字段后追加：

```rust
    #[serde(default = "default_storage_dir")]
    pub storage_dir: Option<String>,
```

在 `default_audit_retention_days` 函数（行 614）后追加默认值函数：

```rust
fn default_storage_dir() -> Option<String> {
    None
}
```

在 `Default for BackupConfig` impl（行 618-629）中追加字段：

```rust
            storage_dir: default_storage_dir(),
```

- [ ] **Step 2: 给 SnapshotInfo 加 location 字段**

在 `SnapshotInfo` struct（行 690-700）的 `manifest` 字段后追加：

```rust
    pub location: String,
```

- [ ] **Step 3: 把 BackupState.audit_pool 从 OnceCell 改为 Mutex<Option<Pool>>**

把 `src-tauri/src/types.rs:568-580` 的 `BackupState` 改为：

```rust
pub struct BackupState {
    pub audit_pool: tokio::sync::Mutex<Option<sqlx::SqlitePool>>,
    pub snapshot_jobs: tokio::sync::Mutex<HashMap<String, ()>>,
}

impl Default for BackupState {
    fn default() -> Self {
        Self {
            audit_pool: tokio::sync::Mutex::new(None),
            snapshot_jobs: tokio::sync::Mutex::new(HashMap::new()),
        }
    }
}
```

- [ ] **Step 4: 运行 cargo check 验证编译（会有 audit.rs 的调用点报错，预期）**

Run: `cd src-tauri && cargo check 2>&1 | tail -20`
Expected: 报错集中在 `audit.rs` 的 `state.backup.audit_pool.get()` / `get_or_try_init`（OnceCell 方法在新容器上不存在）。这些将在 Task 3 修复。`types.rs` 本身应无错。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/types.rs
git commit -m "feat(backup): BackupConfig 加 storage_dir 字段，SnapshotInfo 加 location，audit_pool 改 Mutex<Option>"
```

---

### Task 2: backup.rs 路径解析双层重构 + delete_snapshot + list 合并扫描

**Files:**
- Modify: `src-tauri/src/backup.rs:52-91`（路径函数）、`110`（stream_snapshot）、`446-489`（list_snapshots）、`512-549`（snapshot_to_info）、`554-582`（prune_snapshots）、文件末尾追加 `delete_snapshot`

- [ ] **Step 1: 重写路径函数为双层**

把 `src-tauri/src/backup.rs:52-70` 的 `backup_root`/`snapshots_root`/`config_path` 三个函数替换为：

```rust
/// config.json 永远在这里 —— 不受 storage_dir 影响（安全网：自定义路径
/// 可能失效，但配置必须总能读到）。
pub fn config_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法获取应用数据目录: {error}"))?;
    let dir = base.join("backup");
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建配置目录失败: {error}"))?;
    Ok(dir)
}

/// 快照 + 审计库的根目录：storage_dir 自定义时用之，否则回退 config_root。
pub fn storage_root(app: &AppHandle, config: &BackupConfig) -> Result<PathBuf, String> {
    match &config.storage_dir {
        Some(dir) if !dir.trim().is_empty() => {
            let path = PathBuf::from(dir);
            std::fs::create_dir_all(&path)
                .map_err(|error| format!("创建存储目录失败: {error}"))?;
            Ok(path)
        }
        _ => config_root(app),
    }
}

/// 默认位置（app_data_dir/backup）下的 snapshots 根，用于合并扫描旧位置。
fn legacy_snapshots_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_root(app)?.join("snapshots"))
}

fn snapshots_root(app: &AppHandle, config: &BackupConfig) -> Result<PathBuf, String> {
    let dir = storage_root(app, config)?.join("snapshots");
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建快照目录失败: {error}"))?;
    Ok(dir)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_root(app)?.join("config.json"))
}
```

- [ ] **Step 2: 修 stream_snapshot 调用点**

`src-tauri/src/backup.rs:110`，把：

```rust
    let dir = snapshots_root(app)?
```

改为：

```rust
    let dir = snapshots_root(app, config)?
```

（`stream_snapshot` 已接收 `config: &BackupConfig` 参数，行 106。）

- [ ] **Step 3: 给 snapshot_to_info 加 location 参数**

把 `src-tauri/src/backup.rs:512-549` 的 `snapshot_to_info` 签名和返回改为：

```rust
fn snapshot_to_info(
    connection_id: &str,
    database: &str,
    sql_path: &Path,
    manifest: Option<SnapshotManifest>,
    location: &str,
) -> Result<SnapshotInfo, String> {
    let size_bytes = std::fs::metadata(sql_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let ts = sql_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(parse_snapshot_stem_ts)
        .unwrap_or_default();
    let manifest_path = sql_path.with_extension("manifest.json");
    let manifest_value = if let Some(manifest) = manifest {
        serde_json::to_value(manifest).ok()
    } else {
        std::fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
    };
    let table_count = manifest_value
        .as_ref()
        .and_then(|value| value.get("tables"))
        .and_then(|tables| tables.as_array())
        .map(|tables| tables.len() as u32)
        .unwrap_or(0);
    Ok(SnapshotInfo {
        path: sql_path.to_string_lossy().to_string(),
        connection_id: connection_id.to_string(),
        database: database.to_string(),
        ts,
        size_bytes,
        table_count,
        manifest: manifest_value,
        location: location.to_string(),
    })
}
```

- [ ] **Step 4: 修 create_snapshot 的 snapshot_to_info 调用**

`src-tauri/src/backup.rs:258`，把：

```rust
    snapshot_to_info(connection_id, database, &sql_path, Some(manifest))
```

改为：

```rust
    snapshot_to_info(connection_id, database, &sql_path, Some(manifest), "current")
```

（create_snapshot 创建的快照必然在当前 storage_dir 下，标 "current"。）

- [ ] **Step 5: 重写 list_snapshots 为合并扫描**

把 `src-tauri/src/backup.rs:446-489` 的 `list_snapshots` 替换为：

```rust
pub fn list_snapshots(
    app: &AppHandle,
    config: &BackupConfig,
    connection_filter: Option<&str>,
    database_filter: Option<&str>,
) -> Result<Vec<SnapshotInfo>, String> {
    let current_root = snapshots_root(app, config)?;
    let mut entries = Vec::new();
    collect_snapshots(&current_root, connection_filter, database_filter, "current", &mut entries);

    // 当 storage_dir 被自定义且与默认位置不同时，额外扫描旧位置（只读可见）。
    let legacy = legacy_snapshots_root(app)?;
    let custom = config
        .storage_dir
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if custom && legacy != current_root && legacy.exists() {
        collect_snapshots(&legacy, connection_filter, database_filter, "legacy", &mut entries);
    }

    entries.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(entries)
}

/// 扫描一个 snapshots root 下的 <conn>/<db>/*.sql，追加到 entries。
fn collect_snapshots(
    root: &Path,
    connection_filter: Option<&str>,
    database_filter: Option<&str>,
    location: &str,
    entries: &mut Vec<SnapshotInfo>,
) {
    if !root.exists() {
        return;
    }
    let connections: Vec<PathBuf> = match connection_filter {
        Some(filter) => vec![root.join(safe_segment(filter))],
        None => read_dir_dirs(root),
    };
    for conn_dir in connections {
        let conn_name = match conn_dir.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };
        if !conn_dir.is_dir() {
            continue;
        }
        let databases: Vec<PathBuf> = match database_filter {
            Some(filter) => vec![conn_dir.join(safe_segment(filter))],
            None => read_dir_dirs(&conn_dir),
        };
        for db_dir in databases {
            let db_name = match db_dir.file_name().and_then(|n| n.to_str()) {
                Some(name) => name.to_string(),
                None => continue,
            };
            if !db_dir.is_dir() {
                continue;
            }
            for sql_path in read_dir_files(&db_dir, "sql") {
                if let Ok(info) = snapshot_to_info(&conn_name, &db_name, &sql_path, None, location) {
                    entries.push(info);
                }
            }
        }
    }
}
```

- [ ] **Step 6: 修 prune_snapshots 调用点**

`src-tauri/src/backup.rs:560`，把：

```rust
    let root = snapshots_root(app)?;
```

改为：

```rust
    let root = snapshots_root(app, config)?;
```

（`prune_snapshots` 已接收 `config: &BackupConfig`，行 556。prune 只清理当前位置，不动旧位置——旧位置快照由用户单条删除。）

- [ ] **Step 7: 在 backup.rs 末尾追加 delete_snapshot 函数**

在 `src-tauri/src/backup.rs` 文件末尾（最后一个函数之后）追加：

```rust
/// Delete a single snapshot (.sql + .manifest.json). Validates the path is
/// inside either the current snapshots root or the legacy default root, to
/// prevent deleting arbitrary files.
pub fn delete_snapshot(
    app: &AppHandle,
    config: &BackupConfig,
    snapshot_path: &str,
) -> Result<(), String> {
    let path = std::path::Path::new(snapshot_path)
        .canonicalize()
        .map_err(|error| format!("快照路径无效: {error}"))?;
    let current_root = snapshots_root(app, config)?
        .canonicalize()
        .map_err(|error| format!("解析快照目录失败: {error}"))?;
    let legacy_root = legacy_snapshots_root(app)?
        .canonicalize()
        .unwrap_or_else(|_| current_root.clone());
    let inside_current = path.strip_prefix(&current_root).is_ok();
    let inside_legacy = path.strip_prefix(&legacy_root).is_ok();
    if !inside_current && !inside_legacy {
        return Err("路径不在允许的快照目录内".into());
    }
    std::fs::remove_file(&path).map_err(|error| format!("删除快照失败: {error}"))?;
    let manifest = path.with_extension("manifest.json");
    let _ = std::fs::remove_file(&manifest);
    Ok(())
}
```

- [ ] **Step 8: 运行 cargo check**

Run: `cd src-tauri && cargo check 2>&1 | tail -20`
Expected: `backup.rs` 无错。剩余报错在 `commands.rs`（list_snapshots 命令调用签名变了）和 `audit.rs`（Task 3 处理）。

- [ ] **Step 9: 提交**

```bash
git add src-tauri/src/backup.rs
git commit -m "feat(backup): 路径双层重构 + delete_snapshot + list_snapshots 合并扫描旧位置"
```

---

### Task 3: audit.rs 适配新容器 + 复用 storage_root + 迁移/重置

**Files:**
- Modify: `src-tauri/src/audit.rs:93-141`（backup_dir/audit_db_path/ensure_audit_pool），追加 `reset_audit_pool`、`migrate_audit_db`

- [ ] **Step 1: 删除重复的 backup_dir，audit_db_path 改用 storage_root**

把 `src-tauri/src/audit.rs:93-107` 的 `backup_dir` 和 `audit_db_path` 替换为：

```rust
fn audit_db_path(app: &AppHandle, config: &crate::types::BackupConfig) -> Result<PathBuf, String> {
    Ok(crate::backup::storage_root(app, config)?.join("audit.sqlite"))
}
```

（删除 `audit.rs:94-103` 的 `backup_dir`，消除与 `backup.rs` 的重复实现。）

- [ ] **Step 2: 重写 ensure_audit_pool 适配 Mutex<Option<Pool>>**

把 `src-tauri/src/audit.rs:109-141` 的 `ensure_audit_pool` 替换为：

```rust
/// Lazily create (once) and return the SQLite audit pool. Stored in
/// `AppState.backup.audit_pool` (Mutex<Option<Pool>>) so the pool can be
/// reset when storage_dir changes.
pub async fn ensure_audit_pool(
    app: &AppHandle,
    state: &crate::types::AppState,
) -> Result<SqlitePool, String> {
    {
        let guard = state.backup.audit_pool.lock().await;
        if let Some(pool) = guard.as_ref() {
            return Ok(pool.clone());
        }
    }
    let config = crate::backup::load_config(app);
    let path = audit_db_path(app, &config)?;
    let url = format!(
        "sqlite://{}?mode=rwc",
        path.to_string_lossy().replace('\\', "/")
    );
    let options = SqliteConnectOptions::from_str(&url)
        .map_err(|error| format!("初始化审计库失败: {error}"))?
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| format!("连接审计库失败: {error}"))?;
    sqlx::query("PRAGMA journal_mode=WAL")
        .execute(&pool)
        .await
        .map_err(|error| format!("设置审计库 WAL 失败: {error}"))?;
    ensure_schema(&pool).await?;
    let mut guard = state.backup.audit_pool.lock().await;
    // If another task raced us, reuse theirs and drop ours.
    if let Some(existing) = guard.as_ref() {
        return Ok(existing.clone());
    }
    *guard = Some(pool.clone());
    Ok(pool)
}
```

- [ ] **Step 3: 追加 reset_audit_pool 和 migrate_audit_db**

在 `src-tauri/src/audit.rs` 的 `ensure_audit_pool` 函数之后追加：

```rust
/// Drop the cached audit pool so the next `ensure_audit_pool` reconnects at
/// the (possibly new) path. Called after storage_dir changes.
pub async fn reset_audit_pool(state: &crate::types::AppState) {
    let mut guard = state.backup.audit_pool.lock().await;
    if let Some(pool) = guard.take() {
        let _ = pool.close().await;
    }
}

/// Copy audit.sqlite (+ -wal / -shm) from `from_dir` to `to_dir` if the
/// target does not already have one. Used when storage_dir changes so audit
/// history survives the move. Best-effort: WAL files may not exist.
pub fn migrate_audit_db(from_dir: &Path, to_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to_dir).map_err(|error| format!("创建目标目录失败: {error}"))?;
    for suffix in ["audit.sqlite", "audit.sqlite-wal", "audit.sqlite-shm"] {
        let src = from_dir.join(suffix);
        let dst = to_dir.join(suffix);
        if src.exists() && !dst.exists() {
            std::fs::copy(&src, &dst)
                .map_err(|error| format!("迁移审计库 {suffix} 失败: {error}"))?;
        }
    }
    Ok(())
}
```

确保文件顶部已有 `use std::path::{Path, PathBuf};`（若只有 `PathBuf`，补上 `Path`）。

- [ ] **Step 4: 运行 cargo check**

Run: `cd src-tauri && cargo check 2>&1 | tail -20`
Expected: `audit.rs` 无错。剩余报错在 `commands.rs`（list_snapshots 命令 + Task 4 新增命令）。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/audit.rs
git commit -m "refactor(audit): 复用 storage_root，audit_pool 改 Mutex<Option>，加 reset/migrate"
```

---

### Task 4: commands.rs 新增命令 + set_backup_config 迁移 + list_snapshots 适配

**Files:**
- Modify: `src-tauri/src/commands.rs:3574-3584`（list_snapshots 命令）、`3657-3668`（set_backup_config），追加 `delete_snapshot`、`pick_backup_directory`

- [ ] **Step 1: 修 list_snapshots 命令传 config**

把 `src-tauri/src/commands.rs:3574-3584` 改为：

```rust
#[tauri::command]
pub async fn list_snapshots(
    request: ListSnapshotsRequest,
    app: AppHandle,
) -> Result<Vec<SnapshotInfo>, String> {
    let config = backup::load_config(&app);
    backup::list_snapshots(
        &app,
        &config,
        request.connection_id.as_deref(),
        request.database.as_deref(),
    )
}
```

- [ ] **Step 2: 重写 set_backup_config 加迁移逻辑**

把 `src-tauri/src/commands.rs:3657-3668` 替换为：

```rust
#[tauri::command]
pub async fn set_backup_config(
    config: BackupConfig,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BackupConfig, String> {
    // If storage_dir changed, migrate the audit DB before persisting config.
    let old_config = backup::load_config(&app);
    let storage_changed = config.storage_dir.as_deref().map(str::trim)
        != old_config.storage_dir.as_deref().map(str::trim);
    if storage_changed {
        // 1. Validate the new path is writable (create_dir_all via storage_root).
        let new_storage = backup::storage_root(&app, &config)?;
        // 2. Copy old audit.sqlite to new location (skip if target exists).
        let old_storage = backup::storage_root(&app, &old_config)?;
        if old_storage != new_storage {
            audit::migrate_audit_db(&old_storage, &new_storage)?;
        }
        // 3. Persist config.
        backup::save_config(&app, &config)?;
        // 4. Reset the cached pool so next use reconnects at the new path.
        audit::reset_audit_pool(&state).await;
    } else {
        backup::save_config(&app, &config)?;
    }
    if let Ok(pool) = audit::ensure_audit_pool(&app, &state).await {
        let _ = audit::prune_audit_logs(&pool, config.audit_retention_days).await;
    }
    Ok(config)
}
```

- [ ] **Step 3: 追加 delete_snapshot 命令**

在 `src-tauri/src/commands.rs` 的 `prune_snapshots` 命令（行 3682）之后追加：

```rust
#[tauri::command]
pub async fn delete_snapshot(snapshot_path: String, app: AppHandle) -> Result<(), String> {
    let config = backup::load_config(&app);
    backup::delete_snapshot(&app, &config, &snapshot_path)
}
```

- [ ] **Step 4: 追加 pick_backup_directory 命令**

在 `delete_snapshot` 命令之后追加：

```rust
#[tauri::command]
pub async fn pick_backup_directory() -> Result<Option<String>, String> {
    let folder = rfd::AsyncFileDialog::new()
        .set_title("选择备份存储位置")
        .pick_folder()
        .await;
    Ok(folder.map(|f| f.path().to_string_lossy().to_string()))
}
```

- [ ] **Step 5: 运行 cargo check**

Run: `cd src-tauri && cargo check 2>&1 | tail -20`
Expected: 全部通过（`rfd::AsyncFileDialog` 已是依赖，无需改 Cargo.toml）。

- [ ] **Step 6: 运行 cargo test 确认现有测试不回归**

Run: `cd src-tauri && cargo test 2>&1 | tail -20`
Expected: 现有 db.rs / demo.rs 测试全通过。

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(commands): delete_snapshot + pick_backup_directory 命令，set_backup_config 加审计库迁移"
```

---

### Task 5: lib.rs 注册新命令

**Files:**
- Modify: `src-tauri/src/lib.rs:55-60`（invoke_handler 命令列表）

- [ ] **Step 1: 注册 delete_snapshot 和 pick_backup_directory**

在 `src-tauri/src/lib.rs` 的 `invoke_handler` 中，`commands::prune_snapshots,`（行 60）之后追加两行：

```rust
        commands::delete_snapshot,
        commands::pick_backup_directory,
```

- [ ] **Step 2: 运行 cargo check**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(lib): 注册 delete_snapshot 与 pick_backup_directory 命令"
```

---

### Task 6: useBackupCenter.js 新增 deleteSnapshot / pickStorageDir

**Files:**
- Modify: `src/workbench/composables/useBackupCenter.js:48-55`（config 默认值）、`69-76`（busy）、`197-209`（saveConfig 后追加方法）、`338-366`（return 导出）

- [ ] **Step 1: config 默认值加 storageDir**

`src/workbench/composables/useBackupCenter.js:48-55`，把 config shallowRef 改为：

```js
  const config = shallowRef({
    enabled: true,
    intervalMinutes: 30,
    largeTableThreshold: 50000,
    maxPerDb: 50,
    databasesScope: "all",
    auditRetentionDays: 90,
    storageDir: null,
  });
```

- [ ] **Step 2: busy 加 deleting / pickingDir**

`src/workbench/composables/useBackupCenter.js:69-76`，把 busy reactive 改为：

```js
  const busy = reactive({
    listing: false,
    filterOptions: false,
    rollingBack: false,
    snapshotting: false,
    restoring: false,
    savingConfig: false,
    deleting: false,
    pickingDir: false,
  });
```

- [ ] **Step 3: 在 pruneSnapshots 函数后追加 deleteSnapshot 和 pickStorageDir**

`src/workbench/composables/useBackupCenter.js`，在 `pruneSnapshots` 函数（行 269-282）之后、`let stopListeners = null;`（行 284）之前插入：

```js
  async function deleteSnapshot(snapshotPath) {
    busy.deleting = true;
    try {
      await invokeWorkbench("delete_snapshot", { snapshotPath });
      await loadSnapshots();
      lastError.value = "";
      return true;
    } catch (error) {
      lastError.value = errorMessage(error);
      throw error;
    } finally {
      busy.deleting = false;
    }
  }

  async function pickStorageDir() {
    busy.pickingDir = true;
    try {
      const dir = await invokeWorkbench("pick_backup_directory", {});
      return dir;
    } catch (error) {
      lastError.value = errorMessage(error);
      return null;
    } finally {
      busy.pickingDir = false;
    }
  }
```

- [ ] **Step 4: return 导出新增方法**

`src/workbench/composables/useBackupCenter.js` 的 return 对象（行 338-366），在 `pruneSnapshots,` 之后追加：

```js
    deleteSnapshot,
    pickStorageDir,
```

- [ ] **Step 5: 提交**

```bash
git add src/workbench/composables/useBackupCenter.js
git commit -m "feat(workbench): useBackupCenter 加 deleteSnapshot 与 pickStorageDir"
```

---

### Task 7: 更新 useBackupCenter.test.js mock 并加新测试

**Files:**
- Modify: `src/workbench/useBackupCenter.test.js`

- [ ] **Step 1: 更新 list_snapshots mock 加 location 字段**

`src/workbench/useBackupCenter.test.js`，把 `list_snapshots` 的 mock 返回（行 38-41）改为：

```js
      if (command === "list_snapshots") {
        return Promise.resolve([
          { path: "/tmp/s1.sql", connectionId: "demo", database: "game_db", ts: "20260620-090000", sizeBytes: 1024, tableCount: 5, manifest: null, location: "current" },
        ]);
      }
```

- [ ] **Step 2: 更新 get_backup_config mock 加 storageDir**

把 `get_backup_config` 的 mock 返回（行 42-50）改为：

```js
      if (command === "get_backup_config") {
        return Promise.resolve({
          enabled: true,
          intervalMinutes: 30,
          largeTableThreshold: 50000,
          maxPerDb: 50,
          databasesScope: "all",
          auditRetentionDays: 90,
          storageDir: null,
        });
      }
```

- [ ] **Step 3: 在 createBackend 中加 delete_snapshot 和 pick_backup_directory mock**

在 `createBackend` 的 `invokeWorkbench` 中（`prune_snapshots` 分支之后，行 64 后）追加：

```js
      if (command === "delete_snapshot") {
        deletedPaths.push(payload.snapshotPath);
        return Promise.resolve();
      }
      if (command === "pick_backup_directory") {
        return Promise.resolve(pickedDir);
      }
```

并在 `createBackend` 返回对象前（行 31 `return {` 之前）加状态：

```js
  let deletedPaths = [];
  let pickedDir = null;
```

并在返回对象中暴露它们（便于断言），在 `listeners,` 之后加：

```js
    deletedPaths,
    get pickedDir() { return pickedDir; },
    setPickedDir(v) { pickedDir = v; },
```

- [ ] **Step 4: 加 deleteSnapshot 测试**

在测试文件末尾（最后一个 test 之后）追加：

```js
test("deleteSnapshot 调用 delete_snapshot 命令并刷新列表", async () => {
  const backend = createBackend();
  const { deleteSnapshot, snapshots } = useBackupCenter({
    invokeWorkbench: backend.invokeWorkbench,
    listen: backend.listen,
  });
  await deleteSnapshot("/tmp/s1.sql");
  assert.deepEqual(backend.deletedPaths, ["/tmp/s1.sql"]);
  // loadSnapshots 被调用，snapshots 仍为数组
  assert.ok(Array.isArray(snapshots.value));
});

test("deleteSnapshot 失败时抛错并记 lastError", async () => {
  const backend = createBackend();
  const failing = (command) => {
    if (command === "delete_snapshot") return Promise.reject(new Error("路径不在允许的快照目录内"));
    return backend.invokeWorkbench(command);
  };
  const { deleteSnapshot, lastError } = useBackupCenter({
    invokeWorkbench: failing,
    listen: backend.listen,
  });
  await assert.rejects(() => deleteSnapshot("/evil.sql"), /路径不在允许/);
  assert.match(lastError.value, /路径不在允许/);
});

test("pickStorageDir 返回后端选中的目录", async () => {
  const backend = createBackend();
  backend.setPickedDir("D:/backups");
  const { pickStorageDir } = useBackupCenter({
    invokeWorkbench: backend.invokeWorkbench,
    listen: backend.listen,
  });
  const dir = await pickStorageDir();
  assert.equal(dir, "D:/backups");
});

test("pickStorageDir 用户取消返回 null", async () => {
  const backend = createBackend();
  backend.setPickedDir(null);
  const { pickStorageDir } = useBackupCenter({
    invokeWorkbench: backend.invokeWorkbench,
    listen: backend.listen,
  });
  const dir = await pickStorageDir();
  assert.equal(dir, null);
});
```

- [ ] **Step 5: 运行测试**

Run: `node --test src/workbench/useBackupCenter.test.js 2>&1 | tail -20`
Expected: 全部通过（原有测试 + 4 个新测试）。

- [ ] **Step 6: 提交**

```bash
git add src/workbench/useBackupCenter.test.js
git commit -m "test(workbench): useBackupCenter 加 deleteSnapshot/pickStorageDir 测试，mock 加 location/storageDir"
```

---

### Task 8: BackupCenterDialog.vue 设置面板加存储位置区块

**Files:**
- Modify: `src/workbench/components/BackupCenterDialog.vue:20`（config computed 已有）、`387-432`（config tab）

- [ ] **Step 1: 加 storageDirDisplay computed 和 onPickStorageDir handler**

在 `src/workbench/components/BackupCenterDialog.vue` 的 `<script setup>` 中，`onSaveConfig` 函数（行 167）之前插入：

```js
const storageDirDisplay = computed(() => {
  const dir = config.value?.storageDir;
  return dir && String(dir).trim() ? dir : "默认（应用数据目录）";
});

async function onPickStorageDir() {
  const dir = await props.backup.pickStorageDir();
  if (dir) {
    config.value = { ...config.value, storageDir: dir };
  }
}
```

- [ ] **Step 2: 在设置面板字段最上方加存储位置区块**

`src/workbench/components/BackupCenterDialog.vue`，在 `<div class="wb-backup-config-fields">`（行 388）之后、第一个 `<label class="wb-dialog-field wb-backup-config-field">`（启用定时快照，行 389）之前插入：

```html
          <div class="wb-backup-config-field wb-backup-storage-field">
            <span>存储位置</span>
            <div class="wb-backup-storage-control">
              <code class="wb-backup-storage-path" :title="storageDirDisplay">{{ storageDirDisplay }}</code>
              <button type="button" :disabled="busy.pickingDir || isBusy" @click="onPickStorageDir">
                {{ busy.pickingDir ? "选择中…" : "更改…" }}
              </button>
            </div>
          </div>
```

- [ ] **Step 3: 更新 hint 文案**

把 `src/workbench/components/BackupCenterDialog.vue` 的 hint（行 423-425）：

```html
        设置保存在本地。审计日志与快照均存于本机应用数据目录，与目标数据库隔离——即使目标库被误删也不会丢失。
```

改为：

```html
        设置保存在本地。更改存储位置后，旧位置快照仍可在列表中查看和删除，但新快照只写入新位置。审计日志与快照与目标数据库隔离——即使目标库被误删也不会丢失。
```

- [ ] **Step 4: 提交**

```bash
git add src/workbench/components/BackupCenterDialog.vue
git commit -m "feat(workbench): 备份设置面板加存储位置区块"
```

---

### Task 9: BackupCenterDialog.vue 快照行加删除按钮 + 旧位置角标

**Files:**
- Modify: `src/workbench/components/BackupCenterDialog.vue:369-383`（快照行）

- [ ] **Step 1: 加 onDelete handler**

在 `src/workbench/components/BackupCenterDialog.vue` 的 `<script setup>` 中，`onRestore` 函数（行 151-165）之后插入：

```js
async function onDelete(snapshot) {
  const approved = await confirm({
    title: "删除该快照？",
    message: `时间：${formatTs(snapshot.ts)}\n数据库：${snapshot.database}\n表数：${snapshot.tableCount}\n大小：${formatSize(snapshot.sizeBytes)}\n\n删除后不可恢复。`,
    confirmText: "删除",
    danger: true,
  });
  if (!approved) return;
  try {
    await props.backup.deleteSnapshot(snapshot.path);
    await alert({ title: "已删除", message: "该快照已删除。" });
  } catch (error) {
    await alert({ title: "删除失败", message: String(error?.message || error || "删除失败") });
  }
}
```

- [ ] **Step 2: 快照行加删除按钮和旧位置角标**

把 `src/workbench/components/BackupCenterDialog.vue:369-383` 的快照行 `<article>` 替换为：

```html
          <article v-for="snapshot in snapshots" :key="snapshot.path" class="wb-backup-snapshot-row">
            <div class="wb-backup-snapshot-main">
              <span class="wb-backup-ts">{{ formatTs(snapshot.ts) }}</span>
              <span class="wb-backup-loc">{{ snapshot.connectionId }} · {{ snapshot.database }}</span>
              <span v-if="snapshot.location === 'legacy'" class="wb-backup-loc-tag">旧位置</span>
              <span class="wb-backup-meta">{{ snapshot.tableCount }} 表 · {{ formatSize(snapshot.sizeBytes) }}</span>
            </div>
            <div class="wb-backup-row-actions">
              <button
                type="button"
                class="wb-backup-action-btn"
                :disabled="busy.restoring || busy.deleting"
                @click="onRestore(snapshot)"
              >{{ busy.restoring ? "还原中…" : "还原" }}</button>
              <button
                type="button"
                class="wb-backup-action-btn wb-backup-action-danger"
                :disabled="busy.restoring || busy.deleting"
                @click="onDelete(snapshot)"
              >{{ busy.deleting ? "删除中…" : "删除" }}</button>
            </div>
          </article>
```

- [ ] **Step 3: 提交**

```bash
git add src/workbench/components/BackupCenterDialog.vue
git commit -m "feat(workbench): 快照行加删除按钮与旧位置角标"
```

---

### Task 10: workbench.css 新增样式

**Files:**
- Modify: `src/workbench/workbench.css`（备份区块 1217-1710 附近）

- [ ] **Step 1: 在备份区块追加新样式**

在 `src/workbench/workbench.css` 的备份样式区（`.wb-backup-config-actions` 规则之后，约行 1650 附近）追加：

```css
.wb-backup-storage-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.wb-backup-storage-control {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.wb-backup-storage-path {
  display: block;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--wb-detail-surface);
  color: var(--wb-secondary-text);
  font-family: var(--wb-mono-font, ui-monospace, monospace);
  font-size: 12px;
}
.wb-backup-action-danger {
  color: var(--wb-danger);
  border-color: var(--wb-border);
}
.wb-backup-action-danger:hover:not(:disabled) {
  background: var(--wb-control-hover);
}
.wb-backup-loc-tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--wb-detail-surface);
  color: var(--wb-muted);
  border: 1px solid var(--wb-inset-line);
}
```

- [ ] **Step 2: 提交**

```bash
git add src/workbench/workbench.css
git commit -m "style(workbench): 备份中心存储位置与删除按钮样式"
```

---

### Task 11: 全量验证

- [ ] **Step 1: Rust 检查 + 测试**

Run: `cd src-tauri && cargo check 2>&1 | tail -10 && cargo test 2>&1 | tail -15`
Expected: 编译通过，现有测试全绿。

- [ ] **Step 2: JS 测试**

Run: `node --test src/workbench 2>&1 | tail -20`
Expected: 全部 JS 测试通过（含新增 4 个）。

- [ ] **Step 3: 前端构建冒烟**

Run: `npm run build 2>&1 | tail -15`
Expected: 构建成功（若因 node runtime fetch 失败，设 `DBSCOUT_SKIP_NODE_FETCH=1` 后重试，或仅跑 `npx vite build`）。

- [ ] **Step 4: 手动验证清单（在 tauri dev 中）**

启动 `npm run tauri -- dev`，打开备份中心：
1. 设置 tab → 存储位置显示"默认（应用数据目录）"，点"更改…"选目录 → 显示新路径 → 保存设置 → 重新打开设置 tab 确认路径已持久化。
2. 快照 tab → 创建快照 → 确认新快照写入新位置（检查文件系统）。
3. 改回默认位置（点更改选 app_data 或清空——注：当前 UI 只能改不能清空，若需清空需后续迭代，本任务不强制）→ 保存 → 旧位置快照在列表中以"旧位置"角标出现。
4. 任一快照点"删除" → 二次确认 → 删除 → 列表刷新。
5. 对旧位置快照点"删除" → 确认可删。

- [ ] **Step 5: 最终提交（如有手动验证发现的小修）**

```bash
git add -A
git commit -m "chore(backup): 手动验证修正" --allow-empty
```
