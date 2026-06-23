# 备份中心：存储位置可修改 + 单条快照删除

- 日期：2026-06-23
- 状态：已批准（待实现）

## 背景与目标

DB Scout Workbench 备份中心目前存在两处限制：

1. **存储位置写死**。快照、审计库、配置全部固定在 `<app_data_dir>/backup/`（`backup.rs:52-66`、`audit.rs:94-103`），用户无法自定义到其他磁盘或目录。
2. **没有单条快照删除**。只有 `prune_snapshots` 的 GFS 批量清理（`backup.rs:554`），快照行只有"还原"按钮（`BackupCenterDialog.vue:375-382`），用户无法删除某个特定快照。

本次改动让存储位置可修改，并支持单条快照删除。

## 需求决策（来自澄清）

| 维度 | 决策 |
|---|---|
| 已有快照迁移策略 | **不迁移，旧位置只读可见**。修改位置后旧快照留在原目录，新目录从空开始。 |
| 自定义路径覆盖范围 | **快照 + 审计库可改**。`config.json` 始终留在 `<app_data_dir>/backup/`。 |
| 位置输入方式 | **仅"更改…"按钮**（后端 rfd 选目录），不提供文本手输。 |
| 单条删除防误删 | **二次确认弹框**（复用现有 `useConfirm.confirm({ danger: true })`）。 |
| 旧位置可见性实现 | **列表合并展示**——`list_snapshots` 同时扫描新位置与旧位置，合并去重后按时间倒序展示。 |
| 旧位置快照删除 | **允许删除**。删除按钮对旧位置快照同样可用。 |
| 审计库 OnceCell 迁移 | **复制旧库到新位置**。改 `storage_dir` 时把旧 `audit.sqlite`（含 `-wal`/`-shm`）复制到新位置，重建 pool 指向新库。 |

## 架构

### 数据模型

**`BackupConfig` 新增字段**（`types.rs:584`）：

```rust
#[serde(default)]
pub storage_dir: Option<String>,   // None = 默认 <app_data_dir>/backup
```

- `None` 时行为与现状完全一致，老 `config.json` 无此字段自动 `None`，向后兼容。
- `Some(path)` 时，`path` 作为快照 + 审计库的根目录。
- `config.json` 本身**始终**写在 `<app_data_dir>/backup/config.json`，不随 `storage_dir` 移动——这是安全网：自定义路径可能被用户删/U盘拔/重命名，但配置必须总能读到，否则全盘失序。

**`SnapshotInfo` 新增字段**（`types.rs:690`）：

```rust
pub location: String,   // "current" | "legacy"
```

- `current`：位于当前 `storage_dir/snapshots` 下。
- `legacy`：位于默认 `<app_data_dir>/backup/snapshots` 下（仅当 `storage_dir` 被自定义且与默认不同时才出现）。

### 路径解析重构（`backup.rs`）

现有 `backup_root(app)` 写死 `<app_data_dir>/backup`。改为双层：

```rust
/// config.json 永远在这里 —— 不受 storage_dir 影响
pub fn config_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir()?.join("backup");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 快照 + 审计库的根目录：storage_dir 或回退 config_root
pub fn storage_root(app: &AppHandle, config: &BackupConfig) -> Result<PathBuf, String> {
    match &config.storage_dir {
        Some(dir) if !dir.trim().is_empty() => {
            let path = PathBuf::from(dir);
            std::fs::create_dir_all(&path)?;
            Ok(path)
        }
        _ => config_root(app),
    }
}

fn snapshots_root(app, config) -> Result<PathBuf, String> {
    Ok(storage_root(app, config)?.join("snapshots"))
}
```

- `config_path` 改用 `config_root`（位置不变）。
- `audit.rs` 的 `backup_dir`/`audit_db_path` 改为接收 `config` 参数，复用 `storage_root`。**消除 `audit.rs:94` 与 `backup.rs:52` 的重复实现**。
- 所有调用 `backup_root`/`snapshots_root`/`audit_db_path` 的地方改为先 `load_config` 再传 `config`。

### 新增命令 `delete_snapshot`（`commands.rs` + `backup.rs`）

```rust
#[tauri::command]
pub async fn delete_snapshot(snapshot_path: String, app: AppHandle) -> Result<(), String>
```

后端 `delete_snapshot(app, path)`：

1. `load_config` → 计算 `current_root = snapshots_root(app, &config)` 和 `legacy_root = <app_data_dir>/backup/snapshots`。
2. 校验 `path` 规范化后**必须**以 `current_root` 或 `legacy_root` 为前缀（`path.strip_prefix(...)`），否则返回 `"路径不在允许的快照目录内"`。防越权删除任意文件。
3. 删 `.sql` + 同名 `.manifest.json`。
4. 返回 `Ok(())`。

### `list_snapshots` 合并扫描（`backup.rs:446`）

- 扫描 `current_root`，标记 `location: "current"`。
- 若 `storage_dir` 被自定义（`Some` 且与默认不同），额外扫描 `legacy_root`，标记 `location: "legacy"`。
- 两批合并，统一按 `ts` 倒序。
- 当 `storage_dir` 为 `None`（=默认位置）时，`current_root == legacy_root`，只扫一次，全标 `"current"`，与现状一致，无额外开销。

### `set_backup_config` 审计库迁移（`commands.rs:3657`）

保存配置时，若 `storage_dir` 变更（新值 ≠ 旧值），**按以下顺序**（先迁移、迁移成功才落盘）：

1. 先 `storage_root(app, &new_config)` —— 触发 `create_dir_all`，若新路径不可写/无权限，此处报错并直接返回，`save_config` 不执行，`storage_dir` 保持旧值。
2. 旧 `audit.sqlite`（含 `-wal`、`-shm`）复制到新 `storage_dir/audit.sqlite`。若新位置已存在同名文件则跳过复制（不覆盖用户已有数据）。复制失败则返回错误，`save_config` 不执行。
3. 复制成功后 `save_config` 落盘新配置。
4. 清空 `AppState.backup.audit_pool`（见下方 OnceCell 改造）。
5. 下次 `ensure_audit_pool` 用新路径重建。

**OnceCell 改造**：`tokio::sync::OnceCell<SqlitePool>` 不支持 take。改为 `tokio::sync::Mutex<Option<SqlitePool>>`：

- `ensure_audit_pool`：锁住，若 `Some` 直接 clone 返回，若 `None` 则建库存入。
- `reset_audit_pool`：锁住，take 出来 drop 旧 pool（关闭旧库连接）。

### 新增命令 `pick_backup_directory`（`commands.rs`）

```rust
#[tauri::command]
pub async fn pick_backup_directory(app: AppHandle) -> Result<Option<String>, String> {
    let folder = rfd::AsyncFileDialog::new()
        .set_title("选择备份存储位置")
        .pick_folder()
        .await;
    Ok(folder.map(|f| f.path().to_string_lossy().to_string()))
}
```

rfd 已是依赖。用后端命令包一层，比前端直接调 `@tauri-apps/plugin-dialog` 更省依赖、与现有 `invokeWorkbench` 调用风格一致。取消返回 `null`。

### 命令契约汇总

新增 2 个命令，不改动现有命令签名：

| 命令 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `delete_snapshot` | `{ snapshotPath: String }` | `()` | 越权校验后删 `.sql`+`.manifest` |
| `pick_backup_directory` | 无 | `Option<String>` | rfd 选目录，取消返回 null |

`list_snapshots` 返回的 `SnapshotInfo` 多了 `location` 字段，前端旧代码不读它也无所谓（向后兼容）。

## 前端

### `useBackupCenter.js`

1. `config` 默认值对象加 `storageDir: null`。`loadConfig` 后端返回字段已是驼峰 `storageDir`。
2. `busy` reactive 加 `deleting: false`、`pickingDir: false`。
3. 新增 `deleteSnapshot(path)`：设 `busy.deleting`、调 `invokeWorkbench("delete_snapshot", { snapshotPath: path })`、成功后 `loadSnapshots()` 刷新、失败记 `lastError` 并抛出。
4. 新增 `pickStorageDir()`：设 `busy.pickingDir`、调 `invokeWorkbench("pick_backup_directory")`、返回 `string | null`。
5. 导出新增 `deleteSnapshot`、`pickStorageDir`。

### `BackupCenterDialog.vue`

**设置面板（config tab）—— 在现有字段最上方加"存储位置"区块**：

```html
<div class="wb-backup-config-field wb-backup-storage-field">
  <span>存储位置</span>
  <div class="wb-backup-storage-control">
    <code class="wb-backup-storage-path">{{ storageDirDisplay }}</code>
    <button type="button" :disabled="busy.pickingDir || isBusy" @click="onPickStorageDir">
      {{ busy.pickingDir ? "选择中…" : "更改…" }}
    </button>
  </div>
</div>
```

- `storageDirDisplay` computed：`config.storageDir` 为空 → "默认（应用数据目录）"；否则显示路径。
- `onPickStorageDir()`：调 `pickStorageDir()`，返回非 null 则 `config.value.storageDir = dir`（**仅改内存，不立即落盘**，随"保存设置"一起提交，与其他配置项一致）。
- 现有 hint 文案补充：位置更改后，旧位置快照仍可在列表中查看和删除，但新快照只写入新位置。

**快照行 —— 加"删除"按钮**：

```html
<div class="wb-backup-row-actions">
  <button type="button" class="wb-backup-action-btn"
          :disabled="busy.restoring || busy.deleting" @click="onRestore(snapshot)">
    {{ busy.restoring ? "还原中…" : "还原" }}
  </button>
  <button type="button" class="wb-backup-action-btn wb-backup-action-danger"
          :disabled="busy.restoring || busy.deleting" @click="onDelete(snapshot)">
    {{ busy.deleting ? "删除中…" : "删除" }}
  </button>
</div>
```

- `onDelete(snapshot)`：`confirm({ title: "删除该快照？", message: "...时间...表数...大小...\n\n删除后不可恢复。", confirmText: "删除", danger: true })` → 调 `deleteSnapshot(path)` → 成功 `alert` → 失败 `alert` 报错（复用 `onRestore` 模式）。
- 旧位置快照（`snapshot.location === "legacy"`）在 `wb-backup-snapshot-main` 加角标 `<span class="wb-backup-loc-tag">旧位置</span>`。

### CSS（`workbench.css`，备份区块 1217–1710）

复用 `--wb-*` token，新增少量类：

```css
.wb-backup-storage-field {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.wb-backup-storage-control { display: flex; align-items: center; gap: 8px; min-width: 0; }
.wb-backup-storage-path {
  display: block; max-width: 260px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; padding: 4px 8px; border-radius: 6px;
  background: var(--wb-detail-surface); color: var(--wb-secondary-text);
  font-family: var(--wb-mono-font, ui-monospace, monospace); font-size: 12px;
}
.wb-backup-action-danger {
  color: var(--wb-danger); border-color: var(--wb-border);
}
.wb-backup-action-danger:hover:not(:disabled) { background: var(--wb-control-hover); }
.wb-backup-loc-tag {
  font-size: 11px; padding: 1px 6px; border-radius: 4px;
  background: var(--wb-detail-surface); color: var(--wb-muted);
  border: 1px solid var(--wb-inset-line);
}
```

无魔法色值。

## 文件改动清单

- `src-tauri/src/types.rs` — `BackupConfig` 加 `storage_dir`、`SnapshotInfo` 加 `location`
- `src-tauri/src/backup.rs` — 路径双层重构（`config_root`/`storage_root`）、`delete_snapshot`、`list_snapshots` 合并扫描
- `src-tauri/src/audit.rs` — 复用 `storage_root`，OnceCell 改 `Mutex<Option<Pool>>` + `reset_audit_pool` + 迁移逻辑
- `src-tauri/src/commands.rs` — 新增 `delete_snapshot`、`pick_backup_directory`，`set_backup_config` 加迁移
- `src-tauri/src/lib.rs` — 注册 2 个新命令
- `src/workbench/composables/useBackupCenter.js` — `deleteSnapshot`、`pickStorageDir`、busy 字段、config 默认值
- `src/workbench/components/BackupCenterDialog.vue` — 存储位置区块、删除按钮、旧位置角标、hint 文案
- `src/workbench/workbench.css` — 新增样式类

## 错误处理

- `storage_dir` 指向不可写/不存在路径：`set_backup_config` 在 `save_config` 前先调 `storage_root(app, &new_config)` 触发 `create_dir_all`，失败则返回中文错误，配置不落盘，`storage_dir` 保持旧值。
- `delete_snapshot` 越权路径：`strip_prefix` 校验失败返回 `"路径不在允许的快照目录内"`。
- 审计库迁移失败（复制出错）：`save_config` 不执行，`storage_dir` 保持旧值，`alert` 提示用户。
- `pick_backup_directory` 用户取消：返回 `null`，前端不动 `config.storageDir`。

### 现有命令的路径适配

`create_snapshot`、`restore_snapshot`、`prune_snapshots` 已各自 `load_config`（见 `commands.rs:3594/3619/3675`），只需把路径解析函数改为接收 `config` 参数即可，命令层无需改动调用方式。

## 测试要点

- `storage_dir` 为 `None` 时所有行为与现状一致（回归）。
- `storage_dir` 自定义后：新快照写入新位置、审计库指向新位置、旧快照仍在列表可见（`legacy` 标记）。
- `delete_snapshot`：正常删除、跨位置删除（legacy）、越权路径拒绝、`.manifest.json` 同步删除。
- `set_backup_config` 变更 `storage_dir`：旧 `audit.sqlite` 复制到新位置、OnceCell 重建、新审计写入新库。
- 前端二次确认弹框、删除后列表刷新、旧位置角标显示。
