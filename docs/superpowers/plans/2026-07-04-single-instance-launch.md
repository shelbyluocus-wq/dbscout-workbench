# Single-Instance Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure 黑猫 only has one active desktop instance, and a second launch silently reveals and focuses the existing main window.

**Architecture:** Add one small Rust window-reveal module that centralizes “show, unminimize, focus” behavior for the `main` window. Wire Tauri’s official single-instance plugin into startup and reuse the same reveal/toggle helpers from tray, global shortcut, runtime shortcut registration, and the second-launch callback.

**Tech Stack:** Tauri 2, Rust 2021, `tauri-plugin-single-instance`, existing `tauri-plugin-global-shortcut`, Cargo test.

## Global Constraints

- The product name is **黑猫** and the Tauri identifier is `com.dbscout.workbench`.
- The app targets Windows + macOS; do not use a Windows-only mutex or platform-specific lock.
- The second launch must not create a duplicate window.
- The second launch must not show a warning or prompt.
- If the existing window is hidden to tray, minimized, or behind other windows, it must be shown, unminimized, and focused.
- Window reveal operations are best-effort; individual `show`, `unminimize`, or `set_focus` failures must not crash the app.
- Keep existing first-launch behavior unchanged.
- Keep existing tray and global-shortcut behavior consistent with the new second-launch behavior.

---

## File Structure

- Create `src-tauri/src/window_reveal.rs`
  - Owns shared window reveal/toggle behavior.
  - Provides an injectable trait for unit-testing call sequence without launching the desktop app.
  - Exposes `reveal_main_window(&AppHandle)` and `toggle_main_window(&AppHandle)` for existing callers.

- Modify `src-tauri/src/lib.rs`
  - Register the new module.
  - Register `tauri-plugin-single-instance` early in the builder chain.
  - Replace duplicated tray/global-shortcut reveal code with `window_reveal` helper calls.

- Modify `src-tauri/src/commands.rs`
  - Replace duplicated runtime shortcut reveal/toggle code with `window_reveal::toggle_main_window`.

- Modify `src-tauri/Cargo.toml`
  - Add `tauri-plugin-single-instance = "2"`.

- Modify `Cargo.lock`
  - Let Cargo update the lockfile when tests/checks run.

---

### Task 1: Centralize Main Window Reveal Behavior

**Files:**
- Create: `src-tauri/src/window_reveal.rs`
- Modify: `src-tauri/src/lib.rs:1-20`
- Modify: `src-tauri/src/lib.rs:48-101`
- Modify: `src-tauri/src/commands.rs:4363-4397`
- Test: `src-tauri/src/window_reveal.rs`

**Interfaces:**
- Consumes: Tauri `AppHandle`, `Manager`, `Runtime`, and `WebviewWindow` APIs already used in `lib.rs` and `commands.rs`.
- Produces:
  - `pub(crate) fn reveal_window<W: RevealWindowOps>(window: &W)` — calls `show`, `unminimize`, `focus` in order.
  - `pub(crate) fn reveal_main_window<R: Runtime>(app: &AppHandle<R>)` — finds the `main` window and reveals it if present.
  - `pub(crate) fn toggle_main_window<R: Runtime>(app: &AppHandle<R>)` — hides visible/non-minimized `main`, otherwise reveals it.

- [ ] **Step 1: Create the failing helper test**

Create `src-tauri/src/window_reveal.rs` with only the test scaffold and intentionally missing implementation references:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct FakeWindow {
        calls: RefCell<Vec<&'static str>>,
    }

    impl FakeWindow {
        fn new() -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.borrow().clone()
        }
    }

    impl RevealWindowOps for FakeWindow {
        fn reveal_show(&self) {
            self.calls.borrow_mut().push("show");
        }

        fn reveal_unminimize(&self) {
            self.calls.borrow_mut().push("unminimize");
        }

        fn reveal_focus(&self) {
            self.calls.borrow_mut().push("focus");
        }
    }

    #[test]
    fn reveal_window_shows_unminimizes_and_focuses_in_order() {
        let window = FakeWindow::new();

        reveal_window(&window);

        assert_eq!(window.calls(), vec!["show", "unminimize", "focus"]);
    }
}
```

- [ ] **Step 2: Register the module so the test compiles far enough to fail for missing items**

In `src-tauri/src/lib.rs`, add the module near the existing module list:

```rust
mod account;
mod agent;
mod audit;
mod audit_sync;
mod backup;
mod clickhouse;
mod commands;
mod db;
mod ddl;
mod demo;
mod svn_updater;
mod sync;
pub mod types;
mod validation;
mod window_reveal;
```

- [ ] **Step 3: Run the focused test and verify it fails**

Run:

```bash
cd src-tauri && cargo test window_reveal --lib
```

Expected: FAIL to compile with errors like `cannot find trait RevealWindowOps in this scope` and `cannot find function reveal_window in this scope`.

- [ ] **Step 4: Implement the shared reveal/toggle module**

Replace `src-tauri/src/window_reveal.rs` with:

```rust
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

const MAIN_WINDOW_LABEL: &str = "main";

pub(crate) trait RevealWindowOps {
    fn reveal_show(&self);
    fn reveal_unminimize(&self);
    fn reveal_focus(&self);
}

impl<R: Runtime> RevealWindowOps for WebviewWindow<R> {
    fn reveal_show(&self) {
        let _ = self.show();
    }

    fn reveal_unminimize(&self) {
        let _ = self.unminimize();
    }

    fn reveal_focus(&self) {
        let _ = self.set_focus();
    }
}

pub(crate) fn reveal_window<W: RevealWindowOps>(window: &W) {
    window.reveal_show();
    window.reveal_unminimize();
    window.reveal_focus();
}

pub(crate) fn reveal_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        reveal_window(&window);
    }
}

pub(crate) fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    let is_visible = window.is_visible().unwrap_or(false);
    let is_minimized = window.is_minimized().unwrap_or(false);
    if is_visible && !is_minimized {
        let _ = window.hide();
    } else {
        reveal_window(&window);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct FakeWindow {
        calls: RefCell<Vec<&'static str>>,
    }

    impl FakeWindow {
        fn new() -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.borrow().clone()
        }
    }

    impl RevealWindowOps for FakeWindow {
        fn reveal_show(&self) {
            self.calls.borrow_mut().push("show");
        }

        fn reveal_unminimize(&self) {
            self.calls.borrow_mut().push("unminimize");
        }

        fn reveal_focus(&self) {
            self.calls.borrow_mut().push("focus");
        }
    }

    #[test]
    fn reveal_window_shows_unminimizes_and_focuses_in_order() {
        let window = FakeWindow::new();

        reveal_window(&window);

        assert_eq!(window.calls(), vec!["show", "unminimize", "focus"]);
    }
}
```

- [ ] **Step 5: Replace duplicate reveal logic in `lib.rs`**

In `src-tauri/src/lib.rs`, keep the existing global-shortcut import and replace the direct `Manager` import comment with:

```rust
use tauri_plugin_global_shortcut::GlobalShortcutExt;
```

Then update the tray and default global shortcut callbacks inside `run()` to call the helper:

```rust
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        window_reveal::reveal_main_window(app);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Double-click the tray icon to reveal the window.
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        let app = tray.app_handle();
                        window_reveal::reveal_main_window(&app);
                    }
                })
```

Replace the default global shortcut body with:

```rust
            let shortcut_handle = app.handle().clone();
            if let Err(error) = app
                .global_shortcut()
                .on_shortcut("Alt+Shift+F", move |_app, _shortcut, event| {
                    if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    window_reveal::toggle_main_window(&shortcut_handle);
                })
            {
                eprintln!("[dbscout] 全局快捷键 Alt+Shift+F 注册失败(可能已被其他程序占用): {error}; 主窗口快捷键本次不可用,其余功能不受影响");
            }
```

- [ ] **Step 6: Replace duplicate runtime shortcut logic in `commands.rs`**

In `src-tauri/src/commands.rs`, replace the body of the `on_shortcut` callback inside `register_global_shortcut` with:

```rust
    manager
        .on_shortcut(trimmed, move |_app, _shortcut, event| {
            if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                return;
            }
            crate::window_reveal::toggle_main_window(&handle);
        })
        .map_err(|error| format!("注册快捷键失败: {error}"))
```

Do not remove `Manager` from the top-level `commands.rs` imports unless a compiler warning proves it is unused; that file uses many Tauri APIs and may need it elsewhere.

- [ ] **Step 7: Run focused Rust test**

Run:

```bash
cd src-tauri && cargo test window_reveal --lib
```

Expected: PASS, including `reveal_window_shows_unminimizes_and_focuses_in_order`.

- [ ] **Step 8: Run Rust check to catch integration mistakes**

Run:

```bash
cd src-tauri && cargo check
```

Expected: PASS with no compile errors.

- [ ] **Step 9: Commit the refactor**

Run:

```bash
git add src-tauri/src/window_reveal.rs src-tauri/src/lib.rs src-tauri/src/commands.rs
git commit -m "refactor: centralize main window reveal behavior" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Add Single-Instance Startup Handling

**Files:**
- Modify: `src-tauri/Cargo.toml:19-31`
- Modify: `Cargo.lock`
- Modify: `src-tauri/src/lib.rs:22-27`
- Test: `src-tauri/src/window_reveal.rs`

**Interfaces:**
- Consumes: `window_reveal::reveal_main_window<R: Runtime>(app: &AppHandle<R>)` from Task 1.
- Produces: Tauri startup behavior where a second process hands off to the already-running process and the existing `main` window is revealed.

- [ ] **Step 1: Add the Tauri single-instance dependency**

In `src-tauri/Cargo.toml`, add `tauri-plugin-single-instance = "2"` next to the other Tauri plugins:

```toml
[dependencies]
chrono = { version = "0.4", features = ["serde"] }
rfd = "0.17.2"
reqwest = { version = "0.13.3", features = ["json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "0.8", features = ["runtime-tokio-rustls", "mysql", "sqlite"] }
tauri = { version = "2", features = ["tray-icon", "image-png"] }
tauri-plugin-global-shortcut = "2"
tauri-plugin-process = "2.3.1"
tauri-plugin-single-instance = "2"
tauri-plugin-updater = "2.10.1"
tokio = { version = "1", features = ["sync", "process", "io-util", "io-std", "rt", "time", "fs"] }
uuid = { version = "1", features = ["v4"] }
```

- [ ] **Step 2: Register the plugin early in the Tauri builder**

In `src-tauri/src/lib.rs`, update the start of `run()` so the single-instance plugin appears before the other plugins:

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            window_reveal::reveal_main_window(app);
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState::new())
```

This callback must stay silent: do not add a dialog, toast, or frontend event for the second-launch case.

- [ ] **Step 3: Run Rust check and allow Cargo to update the lockfile**

Run:

```bash
cd src-tauri && cargo check
```

Expected: PASS. `Cargo.lock` may change to include `tauri-plugin-single-instance` and its transitive dependencies.

If the callback signature differs in the resolved plugin version, adapt only the closure parameter names/types while preserving this behavior:

```rust
window_reveal::reveal_main_window(app);
```

- [ ] **Step 4: Run focused unit test again**

Run:

```bash
cd src-tauri && cargo test window_reveal --lib
```

Expected: PASS.

- [ ] **Step 5: Commit the single-instance wiring**

Run:

```bash
git add src-tauri/Cargo.toml Cargo.lock src-tauri/src/lib.rs
git commit -m "feat: enforce single instance launch" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Verify Product Behavior End-to-End

**Files:**
- No source changes expected.
- May inspect generated logs or terminal output while running the app.

**Interfaces:**
- Consumes: Completed Task 1 helper and Task 2 plugin registration.
- Produces: Evidence that users get one 黑猫 instance and second launch reveals the existing window.

- [ ] **Step 1: Run the Rust backend checks**

Run:

```bash
cd src-tauri && cargo test window_reveal --lib && cargo check
```

Expected: both commands PASS.

- [ ] **Step 2: Launch the desktop app once**

Run from repository root:

```bash
npm run tauri -- dev
```

Expected: 黑猫 opens normally with one main window. The app may download the bundled Node runtime first if it is missing; that is expected for this project.

- [ ] **Step 3: Attempt a second launch while the first app is running**

Prefer a direct executable/package relaunch for this probe instead of starting a second `tauri dev` session. Repeated `npm run tauri -- dev` launches can add dev-server noise that obscures the single-instance behavior.

Use one of these approaches:

```bash
# Development build executable, if already built by the first dev launch:
src-tauri/target/debug/dbscout-workbench.exe

# Or relaunch the packaged app on macOS/Windows after creating an app bundle/installer.
```

Expected: no second 黑猫 window remains open. The existing window is brought to the front.

- [ ] **Step 4: Verify hidden/minimized reveal behavior**

With the first app still running:

1. Hide 黑猫 to tray by clicking the close button, or minimize it.
2. Relaunch the direct executable or packaged app again.

Expected: the already-running 黑猫 window is shown, unminimized, and focused. No warning is shown.

- [ ] **Step 5: Verify existing reveal entry points still behave the same**

While the app is running:

1. Use the tray menu item “显示主窗口”.
2. Double-click the tray icon.
3. Press `Alt+Shift+F`.

Expected: each entry point still reveals/focuses the main window. `Alt+Shift+F` still hides the window when it is visible and not minimized.

- [ ] **Step 6: Record final verification result**

In the implementation summary, report:

```text
Verified:
- cargo test window_reveal --lib: PASS
- cargo check: PASS
- First launch opens normally: PASS/NOT RUN
- Second launch reveals existing window without duplicate: PASS/NOT RUN
- Hidden/minimized second launch reveals existing window: PASS/NOT RUN
- Tray/global shortcut reveal still works: PASS/NOT RUN
```

If any manual check cannot be run in the environment, mark it `NOT RUN` and explain why.

---

## Self-Review

- Spec coverage: The plan covers the single active instance, silent second launch, show/unminimize/focus behavior, shared reveal helper, tray/global shortcut reuse, official Tauri plugin, best-effort errors, and Rust verification.
- Placeholder scan: No `TBD`, `TODO`, or unspecified “add tests” steps remain; code snippets and commands are concrete.
- Type consistency: `RevealWindowOps`, `reveal_window`, `reveal_main_window`, and `toggle_main_window` are introduced in Task 1 and reused consistently in Tasks 1-3.
