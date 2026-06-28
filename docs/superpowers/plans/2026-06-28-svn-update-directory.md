# SVN Update Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Gitee updater with a local SVN working-copy updater that checks `latest.json`, prompts for new versions, launches the local installer, and opens the update folder when SVN update fails.

**Architecture:** Add a focused Rust `svn_updater` module for configuration, SVN command execution, manifest parsing, installer launch, and folder opening. Keep the existing Vue updater state/dialog surface, but swap `updaterAdapter.js` to call new Tauri commands instead of `@tauri-apps/plugin-updater`.

**Tech Stack:** Tauri 2 Rust commands, Vue 3 composables/components, Node `node:test`, Vite build, PowerShell on Windows.

---

## File Structure

- Create `src-tauri/src/svn_updater.rs`: backend storage, command helpers, manifest parser, version comparison, SVN command execution, installer launch, and unit tests.
- Modify `src-tauri/src/lib.rs`: register the module and add new Tauri commands; remove official updater plugin initialization.
- Modify `src-tauri/src/commands.rs`: add thin command wrappers calling `svn_updater`.
- Modify `src-tauri/tauri.conf.json`: remove Gitee updater endpoint/public key block and `createUpdaterArtifacts`; keep existing bundle/resources.
- Modify `src-tauri/capabilities/main.json`: remove `updater:default`, keep `process:default`.
- Modify `package.json`: remove `@tauri-apps/plugin-updater`; replace `release:gitee-manifest` with `release:svn-manifest`.
- Delete `scripts/gitee-updater-manifest.mjs` and `scripts/gitee-updater-manifest.test.mjs`.
- Create `scripts/svn-updater-manifest.mjs` and `scripts/svn-updater-manifest.test.mjs`.
- Modify `src/workbench/utils/updaterAdapter.js`: use Tauri core `invoke` for SVN update commands and browser fallback.
- Modify `src/workbench/utils/updaterAdapter.test.js`: test SVN adapter normalization and fallback.
- Modify `src/workbench/composables/useUpdater.js`: adjust copy, state handling, folder selection support, and install progress semantics.
- Modify `src/workbench/useUpdater.test.js`: update Gitee-specific tests to SVN behavior.
- Modify `src/workbench/components/UpdateDialog.vue`: change text from download/Gitee to SVN update/install folder workflow.
- Modify `src/workbench/workbenchShell.test.js`: remove Gitee updater assertions and add SVN updater wiring assertions.

## Task 1: Backend SVN Updater Module

**Files:**
- Create: `src-tauri/src/svn_updater.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `cargo test --manifest-path src-tauri/Cargo.toml svn_updater`

- [ ] **Step 1: Add failing Rust unit tests**

Create `src-tauri/src/svn_updater.rs` with tests for `compare_versions`, local manifest parsing, missing installer detection, and Explorer verbatim prefix cleanup. The initial file should compile once the implementation is filled in.

- [ ] **Step 2: Implement backend types and helpers**

Define:

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SvnUpdateConfig {
    pub directory: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SvnCheckResponse {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub date: Option<String>,
    pub body: Option<String>,
    pub installer_path: Option<String>,
    pub directory: Option<String>,
    pub needs_directory: bool,
}
```

- [ ] **Step 3: Implement config storage**

Store JSON under `app.path().app_config_dir()/svn-update.json`. Implement `load_config(app)`, `save_config(app, config)`, and command helper `get_config(app)`.

- [ ] **Step 4: Implement folder picker and folder opener**

Use `rfd::AsyncFileDialog::new().set_title("选择 SVN 更新目录").pick_folder().await` for selection. Add cross-platform folder opening modeled after `backup.rs`, with Windows `explorer.exe`.

- [ ] **Step 5: Implement SVN executable resolution and update**

Resolution:

```rust
fn resolve_svn_exe(app: &AppHandle) -> Option<PathBuf> {
    // resources/svn/svn.exe first on Windows when present
    // then svn.exe on PATH
}
```

Run:

```rust
Command::new(svn_exe)
    .arg("update")
    .arg(directory)
    .output()
```

On failure, return a readable string including stdout/stderr and call `open_directory`.

- [ ] **Step 6: Implement manifest parsing and version comparison**

Read `latest.json`, accept `notes` and `pub_date`, find `platforms.windows-x86_64.path`, resolve it relative to selected folder, and reject paths escaping the selected folder.

Version comparison accepts numeric dotted versions such as `0.1.5`; newer only when manifest is greater than current app version.

- [ ] **Step 7: Implement installer launch**

`svn_update_install(installer_path)` validates the file exists and launches it with `Command::new(installer_path).spawn()`. The app does not pre-detect admin rights.

- [ ] **Step 8: Add command wrappers and registration**

Add commands:

```rust
svn_update_get_config
svn_update_pick_directory
svn_update_check
svn_update_install
svn_update_open_directory
```

Register them in `tauri::generate_handler!`.

- [ ] **Step 9: Run backend tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml svn_updater`

Expected: tests pass.

## Task 2: Remove Gitee/Tauri Updater Plugin Configuration

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/main.json`
- Modify: `package.json`
- Test: `node --test src/workbench/workbenchShell.test.js scripts/tauriConfig.test.mjs`

- [ ] **Step 1: Update tests first**

In `src/workbench/workbenchShell.test.js`, replace the Gitee endpoint assertion with checks that:

```js
assert.equal(config.plugins?.updater, undefined);
assert.doesNotMatch(JSON.stringify(config), /gitee\.com/);
assert.match(lib, /mod svn_updater;/);
assert.match(lib, /commands::svn_update_check/);
assert.ok(!capability.permissions.includes("updater:default"));
```

- [ ] **Step 2: Remove plugin dependency surfaces**

Remove:

- `@tauri-apps/plugin-updater` from `package.json`.
- `tauri-plugin-updater` from `src-tauri/Cargo.toml`.
- `.plugin(tauri_plugin_updater::Builder::new().build())` from `src-tauri/src/lib.rs`.
- `plugins.updater` from `src-tauri/tauri.conf.json`.
- `bundle.createUpdaterArtifacts` from `src-tauri/tauri.conf.json`.
- `updater:default` from `src-tauri/capabilities/main.json`.

- [ ] **Step 3: Refresh lockfiles**

Run `npm install --package-lock-only` if package-lock changes are needed. Run `cargo update -p tauri-plugin-updater --precise` is not appropriate after removal; instead run `cargo check --manifest-path src-tauri/Cargo.toml` later to refresh Cargo.lock if needed.

- [ ] **Step 4: Run config tests**

Run: `node --test src/workbench/workbenchShell.test.js scripts/tauriConfig.test.mjs`

Expected: Gitee/updater plugin assertions pass after test updates.

## Task 3: SVN Manifest Script

**Files:**
- Create: `scripts/svn-updater-manifest.mjs`
- Create: `scripts/svn-updater-manifest.test.mjs`
- Delete: `scripts/gitee-updater-manifest.mjs`
- Delete: `scripts/gitee-updater-manifest.test.mjs`
- Modify: `package.json`
- Test: `node --test scripts/svn-updater-manifest.test.mjs`

- [ ] **Step 1: Write manifest script tests**

Test:

```js
assert.equal(manifest.platforms["windows-x86_64"].path, "blackcat_0.1.5_x64-setup.exe");
assert.ok(!manifest.platforms["windows-x86_64"].url);
assert.rejects(() => createManifest({ version: "bad" }), /SemVer/);
```

- [ ] **Step 2: Implement `scripts/svn-updater-manifest.mjs`**

Export `createManifest({ version, notes, pubDate, platform, artifactPath, signature })`. CLI requires `--version`, `--artifact`, and `--out`; `--signature` is optional and read when present.

- [ ] **Step 3: Replace package script**

Use:

```json
"release:svn-manifest": "node scripts/svn-updater-manifest.mjs"
```

Remove `release:gitee-manifest`.

- [ ] **Step 4: Run script tests**

Run: `node --test scripts/svn-updater-manifest.test.mjs`

Expected: pass.

## Task 4: Frontend Adapter And State

**Files:**
- Modify: `src/workbench/utils/updaterAdapter.js`
- Modify: `src/workbench/utils/updaterAdapter.test.js`
- Modify: `src/workbench/composables/useUpdater.js`
- Modify: `src/workbench/useUpdater.test.js`
- Test: `node --test src/workbench/utils/updaterAdapter.test.js src/workbench/useUpdater.test.js`

- [ ] **Step 1: Update adapter tests first**

Test browser fallback, invoke adapter check, pick directory, install, and relaunch restart delegation.

- [ ] **Step 2: Implement Tauri invoke adapter**

Use dynamic imports:

```js
const [{ invoke }, { relaunch }] = await Promise.all([
  import("@tauri-apps/api/core"),
  import("@tauri-apps/plugin-process"),
]);
```

Methods:

```js
checkForUpdate() => invoke("svn_update_check")
pickDirectory() => invoke("svn_update_pick_directory")
downloadAndInstall(update, onEvent) => invoke("svn_update_install", { installerPath: update.installerPath })
openDirectory(path) => invoke("svn_update_open_directory", { path })
relaunch() => relaunch()
```

For local installer launch, emit synthetic Started/Progress/Finished events so existing progress UI reaches 100%.

- [ ] **Step 3: Update `useUpdater` copy and methods**

Remove Gitee-specific `messageFromError` special case. Add `pickUpdateDirectory()` method. Preserve statuses: `idle`, `checking`, `current`, `available`, `downloading`, `installed`, `error`, `unavailable`.

- [ ] **Step 4: Run frontend updater tests**

Run: `node --test src/workbench/utils/updaterAdapter.test.js src/workbench/useUpdater.test.js`

Expected: pass.

## Task 5: Dialog Copy And Workbench Wiring

**Files:**
- Modify: `src/workbench/components/UpdateDialog.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workbenchShell.test.js`
- Test: `node --test src/workbench/workbenchShell.test.js`

- [ ] **Step 1: Update shell tests**

Assert `UpdateDialog.vue` contains "SVN 更新目录", "检查并安装", and no "Gitee".

- [ ] **Step 2: Update dialog UI**

Change visible copy:

- "应用更新" stays acceptable.
- Checking: "正在更新 SVN 目录并检查版本..."
- Available button: "安装更新"
- Current: "已是最新版本"
- Error: show message.
- Add a secondary button when adapter exposes folder selection: "选择更新目录".

- [ ] **Step 3: Wire folder picker event**

Add `@pick-directory="updater.pickUpdateDirectory"` on `UpdateDialog` and emit from the dialog button.

- [ ] **Step 4: Run shell test**

Run: `node --test src/workbench/workbenchShell.test.js`

Expected: pass.

## Task 6: Full Verification

**Files:**
- All changed files
- Test: JS, Rust, build

- [ ] **Step 1: Run targeted tests**

Run:

```powershell
node --test src/workbench/utils/updaterAdapter.test.js src/workbench/useUpdater.test.js src/workbench/workbenchShell.test.js scripts/svn-updater-manifest.test.mjs scripts/tauriConfig.test.mjs
```

Expected: pass.

- [ ] **Step 2: Run Rust checks**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml svn_updater
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: pass.

- [ ] **Step 3: Run app build**

Run:

```powershell
npm run build
```

Expected: pass.

- [ ] **Step 4: Inspect final diff for scope**

Run:

```powershell
git diff --name-status
git diff --check
```

Expected: only SVN updater/Gitee removal related files have substantive changes; no whitespace errors.
