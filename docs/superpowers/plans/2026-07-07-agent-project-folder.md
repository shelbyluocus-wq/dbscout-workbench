# Database Agent Project Folder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Database Agent add multiple local project folders, show one current project clearly, and read/search that current project through safe read-only tools.

**Architecture:** Keep the existing stable Agent SDK working directory so session history remains stable. Add a separate frontend project-context store, lightweight Tauri folder-pick/validation commands, and a sidecar MCP server named `dbscout-project` that exposes only read-only project file tools guarded by path and sensitivity checks.

**Tech Stack:** Vue 3 Composition API, localStorage, Tauri 2 commands, Rust path/file metadata APIs, Node.js ESM sidecar, Claude Agent SDK in-process MCP tools, node:test, Rust unit tests.

**Commit policy note:** This session only commits when the user explicitly asks. The commit steps below are included for authorized execution; if commits are not authorized in the implementation session, skip the `git commit` command and report the intended commit message.

---

## File Structure

### Create

- `src/workbench/composables/useAgentProjects.js` — Owns local project list state, persistence, add/select/remove behavior, validation refresh, and the agent-facing project context object.
- `src/workbench/composables/useAgentProjects.test.js` — Unit tests for persistence, current-project switching, context generation, canceled picker handling, and unavailable project refresh.
- `src/workbench/components/AgentProjectPicker.vue` — Renders the compact project status/dropdown used by the Agent header.
- `src-tauri/src/agent/project.rs` — Rust helpers for normalizing, picking, and validating project directories.
- `sidecar/projectTools.mjs` — Read-only project filesystem MCP tools and path/sensitivity guards.
- `sidecar/projectTools.test.mjs` — Unit tests for project read/list/search behavior and security boundaries.

### Modify

- `src/workbench/MySqlWorkbench.vue` — Instantiate project-context state and pass it into `useAgent`/`AgentPanel`.
- `src/workbench/composables/useAgent.js` — Accept optional project context, include current project in Agent context and user message labels.
- `src/workbench/components/AgentPanel.vue` — Pass project state into header and route add/select/remove events.
- `src/workbench/components/AgentHeader.vue` — Host the project picker under the existing Database Agent title/status.
- `src/workbench/components/AgentMessage.vue` — Display database and project labels cleanly for user messages; strip project MCP prefixes in tool display names.
- `src/workbench/workbench.css` — Add styles for project picker, read-only badge, unavailable state, and project message labels using existing `--wb-*`/`--wb-ai-*` tokens.
- `src/workbench/workbenchShell.test.js` — Structural test that the Agent panel exposes the project picker and commands.
- `src/workbench/mock/mockBackend.js` — Mock folder picker/validation and project-related Agent responses for browser-only dev.
- `src-tauri/src/agent/mod.rs` — Export the new `agent::project` module.
- `src-tauri/src/agent/protocol.rs` — Add optional project context to `AgentContext` and wire serialization tests.
- `src-tauri/src/commands.rs` — Add `agent_pick_project_directory` and `agent_validate_project_directory` Tauri commands.
- `src-tauri/src/lib.rs` — Register the two new Tauri commands.
- `sidecar/agent-runner.mjs` — Register `dbscout-project`, include current project in system/turn context, and keep using stable `AGENT_CWD`.
- `sidecar/toolApproval.mjs` — Auto-approve read-only project tools and normalize the `mcp__dbscout-project__` prefix.
- `sidecar/toolApproval.test.mjs` — Verify read-only project tool approval and write tool denial still work.

---

### Task 1: Frontend Project Context Store

**Files:**
- Create: `src/workbench/composables/useAgentProjects.js`
- Create: `src/workbench/composables/useAgentProjects.test.js`

- [ ] **Step 1: Write failing tests for project state persistence and current-project behavior**

Create `src/workbench/composables/useAgentProjects.test.js` with:

```js
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextTick } from "vue";
import { useAgentProjects } from "./useAgentProjects.js";

function installMemoryStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  return store;
}

describe("useAgentProjects", () => {
  afterEach(() => {
    delete globalThis.localStorage;
  });

  it("adds a picked project, selects it, and persists it", async () => {
    const store = installMemoryStorage();
    const calls = [];
    const projects = useAgentProjects(async (command, payload) => {
      calls.push({ command, payload });
      if (command === "agent_pick_project_directory") {
        return {
          id: "e-project-dbscout-workbench",
          name: "dbscout-workbench",
          path: "E:/project/dbscout-workbench",
          shortPath: "E:/project/dbscout-workbench",
          available: true,
          readOnly: true,
        };
      }
      return null;
    });

    const added = await projects.addProjectFromDirectory();
    await nextTick();

    assert.equal(added?.name, "dbscout-workbench");
    assert.equal(projects.items.value.length, 1);
    assert.equal(projects.currentProject.value.name, "dbscout-workbench");
    assert.equal(projects.currentProjectForAgent.value.rootPath, "E:/project/dbscout-workbench");
    assert.equal(projects.currentProjectForAgent.value.readOnly, true);
    assert.equal(calls[0].command, "agent_pick_project_directory");

    const saved = JSON.parse(store.get("dbscout-agent-projects"));
    assert.equal(saved.currentProjectId, "e-project-dbscout-workbench");
    assert.equal(saved.items[0].path, "E:/project/dbscout-workbench");
  });

  it("keeps the existing list when the user cancels folder picking", async () => {
    installMemoryStorage({
      "dbscout-agent-projects": JSON.stringify({
        currentProjectId: "existing",
        items: [{
          id: "existing",
          name: "existing-app",
          path: "E:/existing-app",
          shortPath: "E:/existing-app",
          available: true,
          readOnly: true,
          lastSelectedAt: 1,
        }],
      }),
    });
    const projects = useAgentProjects(async () => null);

    const added = await projects.addProjectFromDirectory();

    assert.equal(added, null);
    assert.equal(projects.items.value.length, 1);
    assert.equal(projects.currentProject.value.name, "existing-app");
  });

  it("deduplicates by id and moves a re-picked project to current", async () => {
    installMemoryStorage({
      "dbscout-agent-projects": JSON.stringify({
        currentProjectId: "one",
        items: [{
          id: "one",
          name: "one",
          path: "E:/one",
          shortPath: "E:/one",
          available: true,
          readOnly: true,
          lastSelectedAt: 1,
        }],
      }),
    });
    const projects = useAgentProjects(async () => ({
      id: "one",
      name: "one-renamed",
      path: "E:/one",
      shortPath: "E:/one",
      available: true,
      readOnly: true,
    }));

    await projects.addProjectFromDirectory();

    assert.equal(projects.items.value.length, 1);
    assert.equal(projects.items.value[0].name, "one-renamed");
    assert.equal(projects.currentProject.value.id, "one");
  });

  it("selects the next project when removing the current project", () => {
    installMemoryStorage({
      "dbscout-agent-projects": JSON.stringify({
        currentProjectId: "two",
        items: [
          { id: "one", name: "one", path: "E:/one", shortPath: "E:/one", available: true, readOnly: true, lastSelectedAt: 1 },
          { id: "two", name: "two", path: "E:/two", shortPath: "E:/two", available: true, readOnly: true, lastSelectedAt: 2 },
        ],
      }),
    });
    const projects = useAgentProjects(async () => null);

    projects.removeProject("two");

    assert.equal(projects.items.value.length, 1);
    assert.equal(projects.currentProject.value.id, "one");
  });

  it("refreshes persisted projects with validation results", async () => {
    installMemoryStorage({
      "dbscout-agent-projects": JSON.stringify({
        currentProjectId: "gone",
        items: [{
          id: "gone",
          name: "gone",
          path: "E:/gone",
          shortPath: "E:/gone",
          available: true,
          readOnly: true,
          lastSelectedAt: 1,
        }],
      }),
    });
    const projects = useAgentProjects(async (command, payload) => {
      assert.equal(command, "agent_validate_project_directory");
      assert.equal(payload.path, "E:/gone");
      return {
        id: "gone",
        name: "gone",
        path: "E:/gone",
        shortPath: "E:/gone",
        available: false,
        readOnly: true,
        error: "项目文件夹不存在",
      };
    });

    await projects.refreshProjects();

    assert.equal(projects.currentProject.value.available, false);
    assert.equal(projects.currentProject.value.error, "项目文件夹不存在");
    assert.equal(projects.currentProjectForAgent.value.available, false);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --test src/workbench/composables/useAgentProjects.test.js
```

Expected: FAIL with `Cannot find module` for `useAgentProjects.js`.

- [ ] **Step 3: Implement the project context composable**

Create `src/workbench/composables/useAgentProjects.js`:

```js
import { computed, ref } from "vue";

export const AGENT_PROJECTS_KEY = "dbscout-agent-projects";

function readProjectsState() {
  try {
    const raw = localStorage.getItem(AGENT_PROJECTS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveProjectsState(state) {
  try {
    localStorage.setItem(AGENT_PROJECTS_KEY, JSON.stringify(state));
  } catch {
    // Browser storage can be unavailable in private mode; project selection is optional.
  }
}

function deriveId(path) {
  return String(path || "")
    .trim()
    .replace(/^[\\/]+/, "")
    .replace(/[:\\/]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || `project-${Date.now()}`;
}

function basename(path) {
  const parts = String(path || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || "项目文件夹";
}

export function normalizeAgentProject(raw) {
  if (!raw || typeof raw !== "object") return null;
  const path = String(raw.path || raw.rootPath || "").trim();
  if (!path) return null;
  const id = String(raw.id || deriveId(path));
  const name = String(raw.name || basename(path));
  return {
    id,
    name,
    path,
    shortPath: String(raw.shortPath || path),
    available: raw.available !== false,
    readOnly: true,
    error: raw.error ? String(raw.error) : "",
    lastSelectedAt: Number(raw.lastSelectedAt || Date.now()),
  };
}

function loadInitialItems() {
  const saved = readProjectsState();
  const items = Array.isArray(saved?.items)
    ? saved.items.map(normalizeAgentProject).filter(Boolean)
    : [];
  return {
    items,
    currentProjectId: String(saved?.currentProjectId || items[0]?.id || ""),
  };
}

export function useAgentProjects(invokeWorkbench) {
  const initial = loadInitialItems();
  const items = ref(initial.items);
  const currentProjectId = ref(initial.currentProjectId);
  const isPicking = ref(false);
  const error = ref("");

  function persist() {
    saveProjectsState({
      currentProjectId: currentProjectId.value,
      items: items.value,
    });
  }

  const currentProject = computed(() => (
    items.value.find((item) => item.id === currentProjectId.value) || null
  ));

  const currentProjectForAgent = computed(() => {
    const project = currentProject.value;
    if (!project) return null;
    return {
      id: project.id,
      name: project.name,
      rootPath: project.path,
      shortPath: project.shortPath,
      readOnly: true,
      available: project.available !== false,
    };
  });

  function upsertProject(project) {
    const normalized = normalizeAgentProject(project);
    if (!normalized) return null;
    normalized.lastSelectedAt = Date.now();
    const index = items.value.findIndex((item) => item.id === normalized.id);
    if (index >= 0) {
      items.value.splice(index, 1, { ...items.value[index], ...normalized });
    } else {
      items.value.push(normalized);
    }
    currentProjectId.value = normalized.id;
    error.value = "";
    persist();
    return normalized;
  }

  async function addProjectFromDirectory() {
    if (isPicking.value) return null;
    isPicking.value = true;
    error.value = "";
    try {
      const picked = await invokeWorkbench("agent_pick_project_directory", {});
      if (!picked) return null;
      return upsertProject(picked);
    } catch (err) {
      error.value = String(err?.message || err);
      return null;
    } finally {
      isPicking.value = false;
    }
  }

  function selectProject(id) {
    const next = items.value.find((item) => item.id === id);
    if (!next) return false;
    currentProjectId.value = next.id;
    next.lastSelectedAt = Date.now();
    persist();
    return true;
  }

  function removeProject(id) {
    const index = items.value.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const wasCurrent = items.value[index].id === currentProjectId.value;
    items.value.splice(index, 1);
    if (wasCurrent) {
      currentProjectId.value = items.value[Math.min(index, items.value.length - 1)]?.id || "";
    }
    persist();
    return true;
  }

  async function refreshProjects() {
    const nextItems = [];
    for (const project of items.value) {
      try {
        const validated = await invokeWorkbench("agent_validate_project_directory", { path: project.path });
        nextItems.push({ ...project, ...normalizeAgentProject(validated), lastSelectedAt: project.lastSelectedAt });
      } catch (err) {
        nextItems.push({
          ...project,
          available: false,
          error: String(err?.message || err || "无法访问项目文件夹"),
        });
      }
    }
    items.value = nextItems;
    if (currentProjectId.value && !items.value.some((item) => item.id === currentProjectId.value)) {
      currentProjectId.value = items.value[0]?.id || "";
    }
    persist();
  }

  return {
    items,
    currentProjectId,
    currentProject,
    currentProjectForAgent,
    isPicking,
    error,
    addProjectFromDirectory,
    upsertProject,
    selectProject,
    removeProject,
    refreshProjects,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
node --test src/workbench/composables/useAgentProjects.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit this task if authorized**

```bash
git add src/workbench/composables/useAgentProjects.js src/workbench/composables/useAgentProjects.test.js
git commit -m "feat(agent): track local project folders"
```

---

### Task 2: Tauri Project Directory Commands

**Files:**
- Create: `src-tauri/src/agent/project.rs`
- Modify: `src-tauri/src/agent/mod.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/workbench/mock/mockBackend.js`

- [ ] **Step 1: Write Rust tests for directory normalization and validation**

Create `src-tauri/src/agent/project.rs` with tests first:

```rust
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirectoryInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub short_path: String,
    pub available: bool,
    pub read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("dbscout-{name}-{suffix}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn project_info_uses_directory_name_and_read_only_flag() {
        let dir = temp_dir("project-info");
        let info = project_info_from_path(&dir).unwrap();

        assert!(info.id.contains("dbscout-project-info"));
        assert!(info.name.starts_with("dbscout-project-info"));
        assert_eq!(info.available, true);
        assert_eq!(info.read_only, true);
        assert_eq!(info.error, None);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn validate_reports_missing_directory_without_panicking() {
        let path = std::env::temp_dir().join("dbscout-project-missing-for-test");
        let info = validate_project_directory_path(&path);

        assert_eq!(info.available, false);
        assert_eq!(info.read_only, true);
        assert!(info.error.unwrap().contains("不存在"));
    }

    #[test]
    fn project_id_is_stable_for_path_variants() {
        let a = project_id_from_path(Path::new(r"E:\project\dbscout-workbench"));
        let b = project_id_from_path(Path::new("E:/project/dbscout-workbench"));

        assert_eq!(a, b);
        assert_eq!(a, "e-project-dbscout-workbench");
    }
}
```

- [ ] **Step 2: Run the Rust test to verify it fails**

Run:

```bash
cd src-tauri && cargo test agent::project --lib
```

Expected: FAIL with missing functions `project_info_from_path`, `validate_project_directory_path`, and `project_id_from_path`.

- [ ] **Step 3: Implement project directory helpers and picker**

Replace `src-tauri/src/agent/project.rs` with:

```rust
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirectoryInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub short_path: String,
    pub available: bool,
    pub read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub async fn pick_project_directory() -> Result<Option<ProjectDirectoryInfo>, String> {
    let folder = rfd::AsyncFileDialog::new()
        .set_title("选择 Agent 可读取的项目文件夹")
        .pick_folder()
        .await;
    let Some(folder) = folder else {
        return Ok(None);
    };
    project_info_from_path(folder.path()).map(Some)
}

pub fn validate_project_directory(path: String) -> ProjectDirectoryInfo {
    validate_project_directory_path(Path::new(&path))
}

pub fn validate_project_directory_path(path: &Path) -> ProjectDirectoryInfo {
    match project_info_from_path(path) {
        Ok(info) => info,
        Err(error) => {
            let normalized = normalize_display_path(path.to_path_buf());
            ProjectDirectoryInfo {
                id: project_id_from_path(path),
                name: path.file_name().and_then(|v| v.to_str()).unwrap_or("项目文件夹").to_string(),
                short_path: normalized.clone(),
                path: normalized,
                available: false,
                read_only: true,
                error: Some(error),
            }
        }
    }
}

pub fn project_info_from_path(path: &Path) -> Result<ProjectDirectoryInfo, String> {
    if !path.exists() {
        return Err(format!("项目文件夹不存在: {}", path.to_string_lossy()));
    }
    if !path.is_dir() {
        return Err(format!("所选路径不是文件夹: {}", path.to_string_lossy()));
    }
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("无法访问项目文件夹: {err}"))?;
    // A cheap read check. Do not scan recursively during selection.
    std::fs::read_dir(&canonical)
        .map_err(|err| format!("没有权限读取项目文件夹: {err}"))?;
    let display = normalize_display_path(canonical.clone());
    let name = canonical
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("项目文件夹")
        .to_string();
    Ok(ProjectDirectoryInfo {
        id: project_id_from_path(&canonical),
        name,
        path: display.clone(),
        short_path: display,
        available: true,
        read_only: true,
        error: None,
    })
}

pub fn project_id_from_path(path: &Path) -> String {
    let normalized = normalize_display_path(path.to_path_buf()).replace('\\', "/");
    let mut id = String::new();
    for ch in normalized.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            id.push(ch.to_ascii_lowercase());
        } else if ch == ':' || ch == '/' || ch.is_whitespace() {
            if !id.ends_with('-') {
                id.push('-');
            }
        }
    }
    let trimmed = id.trim_matches('-').to_string();
    if trimmed.is_empty() { "project".to_string() } else { trimmed }
}

fn normalize_display_path(path: PathBuf) -> String {
    let s = path.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest);
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("dbscout-{name}-{suffix}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn project_info_uses_directory_name_and_read_only_flag() {
        let dir = temp_dir("project-info");
        let info = project_info_from_path(&dir).unwrap();

        assert!(info.id.contains("dbscout-project-info"));
        assert!(info.name.starts_with("dbscout-project-info"));
        assert_eq!(info.available, true);
        assert_eq!(info.read_only, true);
        assert_eq!(info.error, None);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn validate_reports_missing_directory_without_panicking() {
        let path = std::env::temp_dir().join("dbscout-project-missing-for-test");
        let info = validate_project_directory_path(&path);

        assert_eq!(info.available, false);
        assert_eq!(info.read_only, true);
        assert!(info.error.unwrap().contains("不存在"));
    }

    #[test]
    fn project_id_is_stable_for_path_variants() {
        let a = project_id_from_path(Path::new(r"E:\project\dbscout-workbench"));
        let b = project_id_from_path(Path::new("E:/project/dbscout-workbench"));

        assert_eq!(a, b);
        assert_eq!(a, "e-project-dbscout-workbench");
    }
}
```

- [ ] **Step 4: Export the module and wire Tauri commands**

Modify `src-tauri/src/agent/mod.rs` near the existing module declarations:

```rust
mod db_bridge;
pub mod project;
mod protocol;
mod sql_guard;
```

Add commands to `src-tauri/src/commands.rs` near the existing agent commands:

```rust
#[tauri::command]
pub async fn agent_pick_project_directory() -> Result<Option<crate::agent::project::ProjectDirectoryInfo>, String> {
    crate::agent::project::pick_project_directory().await
}

#[tauri::command]
pub async fn agent_validate_project_directory(path: String) -> Result<crate::agent::project::ProjectDirectoryInfo, String> {
    Ok(crate::agent::project::validate_project_directory(path))
}
```

Register both commands in `src-tauri/src/lib.rs` inside `tauri::generate_handler![...]` after the existing Agent session commands:

```rust
            commands::agent_get_session_messages,
            commands::agent_pick_project_directory,
            commands::agent_validate_project_directory,
```

- [ ] **Step 5: Add mock backend command responses**

Modify `src/workbench/mock/mockBackend.js` before the `agent_start_session` branch:

```js
  if (command === "agent_pick_project_directory") {
    return {
      id: "mock-project-dbscout-workbench",
      name: "dbscout-workbench",
      path: "E:/project/dbscout-workbench",
      shortPath: "E:/project/dbscout-workbench",
      available: true,
      readOnly: true,
    };
  }
  if (command === "agent_validate_project_directory") {
    const path = String(payload.path || "");
    return {
      id: path.toLowerCase().replace(/^[\\/]+/, "").replace(/[:\\/]+/g, "-") || "mock-project",
      name: path.split(/[\\/]/).filter(Boolean).pop() || "项目文件夹",
      path,
      shortPath: path,
      available: !path.includes("missing"),
      readOnly: true,
      error: path.includes("missing") ? "项目文件夹不存在" : "",
    };
  }
```

- [ ] **Step 6: Run Rust tests and a frontend mock smoke check**

Run:

```bash
cd src-tauri && cargo test agent::project --lib
node --test src/workbench/composables/useAgentProjects.test.js
```

Expected: both PASS.

- [ ] **Step 7: Commit this task if authorized**

```bash
git add src-tauri/src/agent/project.rs src-tauri/src/agent/mod.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/workbench/mock/mockBackend.js
git commit -m "feat(agent): add project directory picker"
```

---

### Task 3: Inject Current Project into Agent Context

**Files:**
- Modify: `src-tauri/src/agent/protocol.rs`
- Modify: `src/workbench/composables/useAgent.js`
- Modify: `src/workbench/composables/useAgent.test.js`
- Modify: `src/workbench/MySqlWorkbench.vue`

- [ ] **Step 1: Write failing tests for project context injection**

Append to `src/workbench/composables/useAgent.test.js` inside the existing `describe("useAgent", ...)` block:

```js
  it("includes the current read-only project in start and send context", async () => {
    const invocations = [];
    const projectContext = {
      currentProjectForAgent: {
        value: {
          id: "mock-project",
          name: "dbscout-workbench",
          rootPath: "E:/project/dbscout-workbench",
          shortPath: "E:/project/dbscout-workbench",
          readOnly: true,
          available: true,
        },
      },
    };
    const agent = useAgent(
      { connectionId: "demo", database: "game_db", schema: [] },
      async (command, payload) => {
        invocations.push({ command, payload });
        if (command === "agent_start_session") return "started";
        return null;
      },
      projectContext,
    );

    agent.draft.value = "read project";
    await agent.send({ connectionId: "demo", database: "game_db", tableName: "player" });

    const start = invocations.find((call) => call.command === "agent_start_session");
    const send = invocations.find((call) => call.command === "agent_send");
    assert.equal(start.payload.context.project.name, "dbscout-workbench");
    assert.equal(start.payload.context.project.readOnly, true);
    assert.equal(send.payload.context.project.rootPath, "E:/project/dbscout-workbench");
    assert.equal(agent.messages.value[0].projectLabel, "项目：dbscout-workbench");
  });
```

Add a Rust serialization test to `src-tauri/src/agent/protocol.rs` tests:

```rust
    #[test]
    fn agent_context_can_include_read_only_project() {
        let op = AgentOp::UserMessage {
            text: "hello".to_string(),
            context: Some(AgentContext {
                connection_id: None,
                connection_label: None,
                database: None,
                active_table_name: None,
                schema_summary: String::new(),
                project: Some(AgentProjectContext {
                    id: "p1".to_string(),
                    name: "app".to_string(),
                    root_path: "E:/app".to_string(),
                    short_path: "E:/app".to_string(),
                    read_only: true,
                    available: true,
                }),
            }),
        };

        let json = serde_json::to_value(&op).unwrap();
        let project = json.get("context").unwrap().get("project").unwrap();
        assert_eq!(project.get("rootPath").unwrap(), "E:/app");
        assert_eq!(project.get("readOnly").unwrap(), true);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test src/workbench/composables/useAgent.test.js
cd src-tauri && cargo test agent::protocol::tests::agent_context_can_include_read_only_project --lib
```

Expected: JS FAIL because `useAgent` does not accept or serialize project context; Rust FAIL because `AgentProjectContext` and `project` field do not exist.

- [ ] **Step 3: Extend Rust AgentContext**

Modify `src-tauri/src/agent/protocol.rs` above `AgentContext`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjectContext {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub short_path: String,
    pub read_only: bool,
    pub available: bool,
}
```

Add this field to `AgentContext`:

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<AgentProjectContext>,
```

Update existing `AgentContext { ... }` literals in `protocol.rs` tests by adding:

```rust
                project: None,
```

- [ ] **Step 4: Extend useAgent to accept project context**

Modify the function signature in `src/workbench/composables/useAgent.js`:

```js
export function useAgent(workspace, invokeWorkbench, projectContext = null) {
```

Add helper functions near `contextSnapshot`:

```js
function projectSnapshot(project) {
  if (!project || typeof project !== "object") return null;
  const rootPath = String(project.rootPath || project.path || "").trim();
  const name = String(project.name || "").trim();
  if (!rootPath || !name) return null;
  return {
    id: String(project.id || rootPath),
    name,
    rootPath,
    shortPath: String(project.shortPath || rootPath),
    readOnly: true,
    available: project.available !== false,
  };
}

function formatProjectLabel(project) {
  const snapshot = projectSnapshot(project);
  return snapshot ? `项目：${snapshot.name}` : "";
}
```

Modify `appendUserMessage`:

```js
  function appendUserMessage(text, context) {
    const message = {
      id: `agent-user-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: "user",
      content: text,
    };
    const label = formatContextLabel(context);
    if (label) message.contextLabel = label;
    const projectLabel = formatProjectLabel(context?.project);
    if (projectLabel) message.projectLabel = projectLabel;
    if (context) message.context = contextSnapshot(context);
    messages.value.push(message);
    return message;
  }
```

Modify `contextSnapshot` so it preserves project context:

```js
function contextSnapshot(context) {
  const snapshot = {
    connectionId: String(context?.connectionId || ""),
    database: String(context?.database || ""),
    activeTableName: String(context?.activeTableName || context?.tableName || ""),
  };
  const project = projectSnapshot(context?.project);
  if (project) snapshot.project = project;
  return snapshot;
}
```

Modify `buildAgentContext`:

```js
  function buildAgentContext(activeTab = null) {
    const ctx = activeContext(workspace, activeTab);
    const context = {
      connectionId: ctx.connectionId,
      connectionLabel: ctx.connectionId,
      database: ctx.database,
      activeTableName: ctx.activeTableName,
      schemaSummary: formatSchemaSummary(workspace?.schema),
    };
    const project = projectSnapshot(projectContext?.currentProjectForAgent?.value);
    if (project) context.project = project;
    return context;
  }
```

Modify `normalizeReplayMessage` to preserve project labels:

```js
  if (hasOwn(raw, "projectLabel")) message.projectLabel = raw.projectLabel;
```

Place it next to the existing `contextLabel` replay line.

- [ ] **Step 5: Instantiate project context in the workbench orchestrator**

Modify `src/workbench/MySqlWorkbench.vue` imports:

```js
import { useAgentProjects } from "./composables/useAgentProjects.js";
```

Near the existing Agent setup, replace:

```js
const agent = useAgent(workspace, invokeWorkbench);
```

with:

```js
const agentProjects = useAgentProjects(invokeWorkbench);
const agent = useAgent(workspace, invokeWorkbench, agentProjects);
```

Pass `agentProjects` into `AgentPanel`:

```vue
      <AgentPanel
        v-if="inspectorMode === 'ai'"
        :assistant="agent"
        :projects="agentProjects"
        :active-tab="focusedInspectorTab"
        :schema="workspace.schema"
        :selected-cell="focusedSelectedCell"
        :selected-range="focusedSelectedRange"
        @send="sendAgentMessage"
        @open-table-reference="openAgentTableReference"
      />
```

Use the exact existing `AgentPanel` tag and add only `:projects="agentProjects"` if surrounding props differ.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
node --test src/workbench/composables/useAgent.test.js src/workbench/composables/useAgentProjects.test.js
cd src-tauri && cargo test agent::protocol --lib
```

Expected: PASS.

- [ ] **Step 7: Commit this task if authorized**

```bash
git add src-tauri/src/agent/protocol.rs src/workbench/composables/useAgent.js src/workbench/composables/useAgent.test.js src/workbench/MySqlWorkbench.vue
git commit -m "feat(agent): include current project context"
```

---

### Task 4: Agent Project Picker UI

**Files:**
- Create: `src/workbench/components/AgentProjectPicker.vue`
- Modify: `src/workbench/components/AgentHeader.vue`
- Modify: `src/workbench/components/AgentPanel.vue`
- Modify: `src/workbench/components/AgentMessage.vue`
- Modify: `src/workbench/workbench.css`
- Modify: `src/workbench/workbenchShell.test.js`

- [ ] **Step 1: Write structural tests for the project picker UI**

Append assertions to the existing `workbench exposes a database AI assistant in the inspector area` test in `src/workbench/workbenchShell.test.js` after the Agent component reads:

```js
  const projectPicker = read("./components/AgentProjectPicker.vue");
```

Add `projectPicker` into the `agentUi` join:

```js
  const agentUi = [panel, header, settings, message, approval, composer, startup, onboarding, projectPicker].join("\n");
```

Add assertions near the Agent UI assertions:

```js
  assert.match(panel, /import\s+AgentProjectPicker\s+from\s+["']\.\/AgentProjectPicker\.vue["']/);
  assert.match(panel, /:projects="projects"/);
  assert.match(header, /AgentProjectPicker/);
  assert.match(projectPicker, /未接入项目文件夹/);
  assert.match(projectPicker, /只读/);
  assert.match(projectPicker, /Agent 完成后可切换项目/);
  assert.match(projectPicker, /addProjectFromDirectory/);
  assert.match(styles, /\.wb-ai-project-picker/);
  assert.match(styles, /\.wb-ai-project-readonly/);
  assert.match(message, /projectLabel/);
```

- [ ] **Step 2: Run structural test to verify it fails**

Run:

```bash
node --test src/workbench/workbenchShell.test.js --test-name-pattern "database AI assistant"
```

Expected: FAIL because `AgentProjectPicker.vue` does not exist.

- [ ] **Step 3: Create the project picker component**

Create `src/workbench/components/AgentProjectPicker.vue`:

```vue
<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps({
  projects: { type: Object, default: null },
  disabled: { type: Boolean, default: false },
});

const open = ref(false);
const pickerRef = ref(null);

const items = computed(() => props.projects?.items?.value || []);
const currentProject = computed(() => props.projects?.currentProject?.value || null);
const hasProjects = computed(() => items.value.length > 0);
const unavailable = computed(() => currentProject.value?.available === false);
const statusText = computed(() => {
  if (!currentProject.value) return "未接入项目文件夹";
  if (unavailable.value) return "项目不可用";
  return `项目：${currentProject.value.name}`;
});
const detailText = computed(() => {
  if (props.disabled) return "Agent 完成后可切换项目";
  if (currentProject.value?.error) return currentProject.value.error;
  return currentProject.value?.shortPath || "添加项目后，Agent 可只读查看项目文件";
});

function toggleOpen() {
  if (props.disabled) return;
  open.value = !open.value;
}

async function addProject() {
  if (props.disabled) return;
  await props.projects?.addProjectFromDirectory?.();
  open.value = true;
}

function selectProject(id) {
  if (props.disabled) return;
  props.projects?.selectProject?.(id);
  open.value = false;
}

function removeProject(id, event) {
  event?.stopPropagation?.();
  if (props.disabled) return;
  props.projects?.removeProject?.(id);
}

function onDocumentPointerDown(event) {
  if (pickerRef.value?.contains?.(event.target)) return;
  open.value = false;
}

function onDocumentKeydown(event) {
  if (event.key !== "Escape") return;
  open.value = false;
}

watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener("pointerdown", onDocumentPointerDown);
    document.addEventListener("keydown", onDocumentKeydown);
  } else {
    document.removeEventListener("pointerdown", onDocumentPointerDown);
    document.removeEventListener("keydown", onDocumentKeydown);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  document.removeEventListener("keydown", onDocumentKeydown);
});
</script>

<template>
  <div ref="pickerRef" class="wb-ai-project-picker" :class="{ 'is-open': open, 'is-disabled': disabled, 'is-unavailable': unavailable }">
    <button
      type="button"
      class="wb-ai-project-trigger"
      :disabled="disabled"
      :aria-expanded="open"
      aria-label="选择 Agent 项目文件夹"
      @click="toggleOpen"
    >
      <svg class="wb-ai-project-folder" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 7.5a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        <path v-if="!hasProjects" d="M12 11v5M9.5 13.5h5" />
      </svg>
      <span class="wb-ai-project-copy">
        <strong>{{ statusText }}</strong>
        <small>{{ detailText }}</small>
      </span>
      <span v-if="currentProject" class="wb-ai-project-readonly">只读</span>
      <svg class="wb-ai-project-chevron" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    <section v-if="open" class="wb-ai-project-menu" aria-label="项目文件夹列表">
      <p v-if="disabled" class="wb-ai-project-disabled-note">Agent 完成后可切换项目</p>
      <button type="button" class="wb-ai-project-add" :disabled="disabled || projects?.isPicking?.value" @click="addProject">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        添加项目文件夹
      </button>

      <div v-if="items.length" class="wb-ai-project-list">
        <button
          v-for="project in items"
          :key="project.id"
          type="button"
          class="wb-ai-project-item"
          :class="{ 'is-current': project.id === currentProject?.id, 'is-unavailable': project.available === false }"
          :disabled="disabled"
          @click="selectProject(project.id)"
        >
          <span class="wb-ai-project-current-dot" aria-hidden="true"></span>
          <span class="wb-ai-project-item-copy">
            <strong>{{ project.name }}</strong>
            <small>{{ project.error || project.shortPath }}</small>
          </span>
          <span class="wb-ai-project-readonly">只读</span>
          <span type="button" class="wb-ai-project-remove" role="button" tabindex="0" @click="removeProject(project.id, $event)">移除</span>
        </button>
      </div>
      <p v-else class="wb-ai-project-empty">添加项目后，Agent 可以读取项目内文件并辅助理解代码。</p>
    </section>
  </div>
</template>
```

- [ ] **Step 4: Wire the picker into AgentPanel and AgentHeader**

Modify `src/workbench/components/AgentPanel.vue`:

```js
import AgentProjectPicker from "./AgentProjectPicker.vue";
```

Add prop:

```js
  projects: { type: Object, default: null },
```

Pass into `AgentHeader`:

```vue
      <AgentHeader
        :table-source="tableSource"
        :projects="projects"
        :is-busy="assistant.isBusy.value || assistant.isStarting.value"
        :auto-approve-writes="assistant.autoApproveWrites.value"
        :settings-open="settingsOpen"
        @new-session="assistant.startNewSession()"
        @toggle-settings="toggleSettings"
      />
```

Modify `src/workbench/components/AgentHeader.vue`:

```vue
<script setup>
import AgentProjectPicker from "./AgentProjectPicker.vue";

const props = defineProps({
  tableSource: { type: String, default: "当前数据库" },
  projects: { type: Object, default: null },
  isBusy: { type: Boolean, default: false },
  settingsOpen: { type: Boolean, default: false },
  autoApproveWrites: { type: Boolean, default: false },
});

const emit = defineEmits(["new-session", "toggle-settings"]);
</script>
```

Add the picker below `.wb-ai-brand` and before header actions close or immediately after the brand block:

```vue
    <AgentProjectPicker :projects="projects" :disabled="isBusy" />
```

- [ ] **Step 5: Show project labels and strip project tool prefixes**

Modify `src/workbench/components/AgentMessage.vue`:

```js
const contextLabel = computed(() => props.message.contextLabel || "");
const projectLabel = computed(() => props.message.projectLabel || "");
```

Update `toolDisplayName`:

```js
function toolDisplayName(name) {
  if (typeof name !== "string") return "工具";
  for (const mcpPrefix of ["mcp__dbscout-db__", "mcp__dbscout-project__"]) {
    if (name.startsWith(mcpPrefix)) return name.slice(mcpPrefix.length);
  }
  return name;
}
```

Update label markup:

```vue
      <div v-if="contextLabel || projectLabel" class="wb-ai-message-labels">
        <p v-if="contextLabel" class="wb-ai-context-label">{{ contextLabel }}</p>
        <p v-if="projectLabel" class="wb-ai-context-label is-project">{{ projectLabel }}</p>
      </div>
```

Remove the old single-line `<p v-if="contextLabel" ...>` after adding this block.

- [ ] **Step 6: Add CSS using existing tokens**

Append to the Agent panel section in `src/workbench/workbench.css`:

```css
.wb-ai-project-picker {
  position: relative;
  min-width: 0;
}

.wb-ai-project-trigger {
  width: 100%;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto 16px;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--wb-ai-border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--wb-ai-bg-elevated) 72%, transparent);
  color: var(--wb-ai-text);
  padding: 8px 10px;
  cursor: pointer;
  text-align: left;
}

.wb-ai-project-trigger:hover:not(:disabled),
.wb-ai-project-trigger:focus-visible {
  border-color: color-mix(in srgb, var(--wb-ai-status) 70%, var(--wb-ai-border));
  background: color-mix(in srgb, var(--wb-ai-text) 7%, var(--wb-ai-bg-elevated));
  outline: none;
}

.wb-ai-project-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

.wb-ai-project-folder,
.wb-ai-project-chevron,
.wb-ai-project-add svg {
  width: 18px;
  height: 18px;
}

.wb-ai-project-copy,
.wb-ai-project-item-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wb-ai-project-copy strong,
.wb-ai-project-item-copy strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--wb-ai-text);
}

.wb-ai-project-copy small,
.wb-ai-project-item-copy small,
.wb-ai-project-empty,
.wb-ai-project-disabled-note {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--wb-ai-muted);
}

.wb-ai-project-readonly {
  border: 1px solid color-mix(in srgb, var(--wb-ai-status) 55%, transparent);
  border-radius: 999px;
  color: var(--wb-ai-status);
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
}

.wb-ai-project-menu {
  position: absolute;
  z-index: 12;
  top: calc(100% + 8px);
  left: 0;
  right: 0;
  display: grid;
  gap: 8px;
  border: 1px solid var(--wb-ai-border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--wb-ai-bg) 94%, black);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.35);
  padding: 10px;
}

.wb-ai-project-add,
.wb-ai-project-item {
  width: 100%;
  border: 1px solid var(--wb-ai-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--wb-ai-bg-elevated) 78%, transparent);
  color: var(--wb-ai-text);
  cursor: pointer;
}

.wb-ai-project-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 8px 10px;
}

.wb-ai-project-list {
  display: grid;
  gap: 6px;
}

.wb-ai-project-item {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  padding: 8px;
  text-align: left;
}

.wb-ai-project-item:hover:not(:disabled),
.wb-ai-project-add:hover:not(:disabled),
.wb-ai-project-item:focus-visible,
.wb-ai-project-add:focus-visible {
  border-color: var(--wb-ai-muted);
  outline: none;
}

.wb-ai-project-current-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: transparent;
}

.wb-ai-project-item.is-current .wb-ai-project-current-dot {
  background: var(--wb-ai-status);
}

.wb-ai-project-remove {
  color: var(--wb-ai-muted);
  font-size: 11px;
}

.wb-ai-project-remove:hover {
  color: var(--wb-danger, #ef4444);
}

.wb-ai-project-picker.is-unavailable .wb-ai-project-trigger,
.wb-ai-project-item.is-unavailable {
  border-color: color-mix(in srgb, var(--wb-danger, #ef4444) 42%, var(--wb-ai-border));
}

.wb-ai-message-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}

.wb-ai-context-label.is-project {
  color: var(--wb-ai-status);
}
```

- [ ] **Step 7: Run structural test**

Run:

```bash
node --test src/workbench/workbenchShell.test.js --test-name-pattern "database AI assistant"
```

Expected: PASS.

- [ ] **Step 8: Commit this task if authorized**

```bash
git add src/workbench/components/AgentProjectPicker.vue src/workbench/components/AgentHeader.vue src/workbench/components/AgentPanel.vue src/workbench/components/AgentMessage.vue src/workbench/workbench.css src/workbench/workbenchShell.test.js
git commit -m "feat(agent): show current project in assistant panel"
```

---

### Task 5: Sidecar Read-Only Project Tools

**Files:**
- Create: `sidecar/projectTools.mjs`
- Create: `sidecar/projectTools.test.mjs`
- Modify: `sidecar/agent-runner.mjs`

- [ ] **Step 1: Write tests for read/list/search and security boundaries**

Create `sidecar/projectTools.test.mjs`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listProjectFilesForTest,
  readProjectFileForTest,
  searchProjectFilesForTest,
} from "./projectTools.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dbscout-project-tools-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "README.md"), "# Demo\nProject entry is src/main.js\n", "utf8");
  writeFileSync(join(root, "src", "main.js"), "export const answer = 42;\n", "utf8");
  writeFileSync(join(root, "node_modules", "ignored.js"), "secret dependency text\n", "utf8");
  writeFileSync(join(root, ".env"), "TOKEN=secret\n", "utf8");
  return root;
}

function context(root) {
  return {
    project: {
      id: "fixture",
      name: "fixture",
      rootPath: root,
      shortPath: root,
      readOnly: true,
      available: true,
    },
  };
}

describe("projectTools", () => {
  it("lists project files while skipping ignored directories", async () => {
    const root = fixture();
    try {
      const result = await listProjectFilesForTest(context(root), { directory: ".", limit: 20 });
      const files = result.files.map((file) => file.path).sort();

      assert.deepEqual(files, ["README.md", "src/main.js"]);
      assert.equal(result.truncated, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads a normal text file with metadata", async () => {
    const root = fixture();
    try {
      const result = await readProjectFileForTest(context(root), { path: "src/main.js" });

      assert.equal(result.path, "src/main.js");
      assert.match(result.content, /answer = 42/);
      assert.equal(result.truncated, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects sensitive files with an explicit message", async () => {
    const root = fixture();
    try {
      await assert.rejects(
        () => readProjectFileForTest(context(root), { path: ".env" }),
        /敏感文件默认不可读取/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal outside the project root", async () => {
    const root = fixture();
    try {
      await assert.rejects(
        () => readProjectFileForTest(context(root), { path: "../outside.txt" }),
        /只能读取当前项目内的文件/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlink escapes", async (t) => {
    if (process.platform === "win32") {
      t.skip("Windows symlink creation requires privileges on many machines");
      return;
    }
    const root = fixture();
    const outside = mkdtempSync(join(tmpdir(), "dbscout-project-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "outside", "utf8");
      symlinkSync(join(outside, "secret.txt"), join(root, "src", "linked-secret.txt"));
      await assert.rejects(
        () => readProjectFileForTest(context(root), { path: "src/linked-secret.txt" }),
        /只能读取当前项目内的文件/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("searches text files and returns line numbers", async () => {
    const root = fixture();
    try {
      const result = await searchProjectFilesForTest(context(root), { keyword: "answer", limit: 10 });

      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0].path, "src/main.js");
      assert.equal(result.matches[0].line, 1);
      assert.match(result.matches[0].text, /answer/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports when no project is selected", async () => {
    await assert.rejects(
      () => listProjectFilesForTest({}, { directory: "." }),
      /未选择项目文件夹/,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test sidecar/projectTools.test.mjs
```

Expected: FAIL because `projectTools.mjs` does not exist.

- [ ] **Step 3: Implement project read-only tools**

Create `sidecar/projectTools.mjs`:

```js
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".tauri",
  ".venv",
  "coverage",
]);

const SENSITIVE_NAMES = new Set([".env", ".npmrc"]);
const SENSITIVE_SUFFIXES = [".pem", ".key"];
const MAX_READ_BYTES = 120_000;
const MAX_SEARCH_FILE_BYTES = 300_000;
const MAX_LIST_ITEMS = 500;

function selectedProject(context) {
  const project = context?.project;
  if (!project?.rootPath) throw new Error("未选择项目文件夹，请先在 Agent 顶部添加项目。");
  if (project.available === false) throw new Error("当前项目文件夹不可用，请重新选择或移除该项目。");
  return project;
}

function normalizeRelative(input) {
  const value = String(input || ".").replace(/\\/g, "/").trim() || ".";
  if (value.includes("\0")) throw new Error("路径包含非法字符。");
  if (path.isAbsolute(value) || /^[a-zA-Z]:\//.test(value)) {
    throw new Error("只能读取当前项目内的相对路径。");
  }
  const normalized = path.posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("只能读取当前项目内的文件，不能使用 .. 跳出项目。");
  }
  return normalized === "." ? "" : normalized;
}

function rootRealPath(context) {
  const root = selectedProject(context).rootPath;
  return realpathSync(root);
}

function ensureInsideProject(context, relativeInput) {
  const root = rootRealPath(context);
  const relative = normalizeRelative(relativeInput);
  const candidate = path.resolve(root, relative);
  let real;
  try {
    real = realpathSync(candidate);
  } catch (err) {
    throw new Error(`项目路径不存在或无法读取: ${relative || "."}`);
  }
  const relFromRoot = path.relative(root, real);
  if (relFromRoot === "" || (!relFromRoot.startsWith("..") && !path.isAbsolute(relFromRoot))) {
    return { root, real, relative: relFromRoot.replace(/\\/g, "/") || "" };
  }
  throw new Error("只能读取当前项目内的文件，不能访问项目外路径。");
}

function pathParts(relativePath) {
  return String(relativePath || "").split(/[\\/]+/).filter(Boolean);
}

function isIgnoredRelative(relativePath) {
  return pathParts(relativePath).some((part) => DEFAULT_IGNORES.has(part));
}

function isSensitiveRelative(relativePath) {
  const parts = pathParts(relativePath);
  if (parts.includes(".ssh")) return true;
  const base = parts[parts.length - 1] || "";
  if (SENSITIVE_NAMES.has(base)) return true;
  if (base.startsWith(".env.")) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

function isLikelyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}

function toProjectRelative(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

export async function listProjectFilesForTest(context, args = {}) {
  const { root, real, relative } = ensureInsideProject(context, args.directory || ".");
  const startStat = statSync(real);
  if (!startStat.isDirectory()) throw new Error("list_project_files 只能列出目录。");
  const limit = Math.max(1, Math.min(Number(args.limit || 100), MAX_LIST_ITEMS));
  const files = [];
  const stack = [real];
  let truncated = false;

  while (stack.length) {
    const dir = stack.shift();
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const rel = toProjectRelative(root, fullPath);
      if (isIgnoredRelative(rel) || isSensitiveRelative(rel)) continue;
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = statSync(fullPath);
      files.push({ path: rel, sizeBytes: stat.size });
      if (files.length >= limit) {
        truncated = true;
        return { directory: relative || ".", files, truncated };
      }
    }
  }
  return { directory: relative || ".", files, truncated };
}

export async function readProjectFileForTest(context, args = {}) {
  const { root, real, relative } = ensureInsideProject(context, args.path || "");
  if (!relative) throw new Error("请提供要读取的项目内文件路径。");
  if (isIgnoredRelative(relative)) throw new Error("该路径位于默认忽略目录中，第一版不会读取构建产物或依赖目录。");
  if (isSensitiveRelative(relative)) throw new Error("敏感文件默认不可读取，第一版项目接入不提供敏感文件审批。");
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error("read_project_file 只能读取文件。");
  const bytes = readFileSync(real);
  if (isLikelyBinary(bytes)) throw new Error("该文件看起来是二进制文件，无法作为文本读取。");
  const truncated = bytes.length > MAX_READ_BYTES;
  const content = bytes.subarray(0, MAX_READ_BYTES).toString("utf8");
  return {
    path: toProjectRelative(root, real),
    sizeBytes: stat.size,
    truncated,
    content,
    note: truncated ? "文件过大，已返回前 120000 字节；请使用搜索缩小范围。" : "",
  };
}

export async function searchProjectFilesForTest(context, args = {}) {
  const keyword = String(args.keyword || "").trim();
  if (!keyword) throw new Error("请提供搜索关键字。");
  const limit = Math.max(1, Math.min(Number(args.limit || 50), 200));
  const listed = await listProjectFilesForTest(context, { directory: args.directory || ".", limit: MAX_LIST_ITEMS });
  const matches = [];
  for (const file of listed.files) {
    if (matches.length >= limit) break;
    if (file.sizeBytes > MAX_SEARCH_FILE_BYTES) continue;
    let result;
    try {
      result = await readProjectFileForTest(context, { path: file.path });
    } catch {
      continue;
    }
    const lines = result.content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (matches.length >= limit) return;
      if (line.toLowerCase().includes(keyword.toLowerCase())) {
        matches.push({ path: file.path, line: index + 1, text: line.slice(0, 240) });
      }
    });
  }
  return { keyword, matches, truncated: matches.length >= limit || listed.truncated };
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function createProjectMcpServer(getContext) {
  const current = () => (typeof getContext === "function" ? getContext() : {});
  return createSdkMcpServer({
    name: "dbscout-project",
    instructions:
      "You are connected to the user's current local project folder in read-only mode. " +
      "Use these tools for code and documentation questions. Do not claim to edit files or run project commands.",
    tools: [
      tool(
        "list_project_files",
        "List files under the current project folder. Call this when you need to understand project structure. Read-only.",
        {
          directory: z.string().optional().default("."),
          limit: z.number().int().min(1).max(MAX_LIST_ITEMS).optional().default(100),
        },
        async (args) => textResult(await listProjectFilesForTest(current(), args)),
      ),
      tool(
        "read_project_file",
        "Read one text file from the current project folder. Call this after locating a relevant file. Read-only.",
        { path: z.string().min(1) },
        async (args) => textResult(await readProjectFileForTest(current(), args)),
      ),
      tool(
        "search_project_files",
        "Search text in the current project folder. Call this when finding symbols, text, or relevant files. Read-only.",
        {
          keyword: z.string().min(1),
          directory: z.string().optional().default("."),
          limit: z.number().int().min(1).max(200).optional().default(50),
        },
        async (args) => textResult(await searchProjectFilesForTest(current(), args)),
      ),
    ],
    alwaysLoad: true,
  });
}
```

- [ ] **Step 4: Register project MCP server in the runner**

Modify `sidecar/agent-runner.mjs` imports:

```js
import { createProjectMcpServer } from "./projectTools.mjs";
```

In `formatTurnContext(context)`, add after the database/table lines:

```js
  if (context.project?.name) {
    lines.push(`当前项目: ${context.project.name}${context.project.readOnly ? " (只读)" : ""}`);
    if (context.project.shortPath || context.project.rootPath) {
      lines.push(`项目路径: ${context.project.shortPath || context.project.rootPath}`);
    }
    if (context.project.available === false) {
      lines.push("项目状态: 不可用，请提示用户重新选择项目文件夹");
    }
  }
```

In `handleStart(op)`, add project append prompt after active table:

```js
  if (context.project?.name) {
    appendParts.push(
      `当前项目: ${context.project.name}\n项目路径: ${context.project.shortPath || context.project.rootPath}\n项目权限: 只读。只能通过 dbscout-project 工具读取和搜索文件，不能修改文件或运行项目命令。`
    );
  }
```

Update the static assistant description:

```js
  appendParts.push(
    "你是 黑猫 的内置数据库与项目助手。你可以使用 dbscout-db 工具查看当前连接的数据库结构、采样数据和执行只读查询；可以使用 dbscout-project 工具只读查看当前项目文件。数据库问题优先使用 dbscout-db，代码和文档问题优先使用 dbscout-project。当前项目接入为只读，不要承诺已经修改项目文件。"
  );
```

Update `options.mcpServers`:

```js
    mcpServers: {
      "dbscout-db": createDbMcpServer(),
      "dbscout-project": createProjectMcpServer(() => currentContext),
    },
```

- [ ] **Step 5: Run sidecar project tool tests**

Run:

```bash
node --test sidecar/projectTools.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit this task if authorized**

```bash
git add sidecar/projectTools.mjs sidecar/projectTools.test.mjs sidecar/agent-runner.mjs
git commit -m "feat(agent): add read-only project tools"
```

---

### Task 6: Approval, Tool Display, and Mock Project Replies

**Files:**
- Modify: `sidecar/toolApproval.mjs`
- Modify: `sidecar/toolApproval.test.mjs`
- Modify: `sidecar/agent-runner.mjs`
- Modify: `src/workbench/mock/mockBackend.js`

- [ ] **Step 1: Write failing tests for project tool auto-approval**

Append to `sidecar/toolApproval.test.mjs`:

```js
  it("normalizes SDK MCP-prefixed project tool names", () => {
    assert.equal(normalizeToolName("mcp__dbscout-project__list_project_files"), "list_project_files");
    assert.equal(normalizeToolName("mcp__dbscout-project__read_project_file"), "read_project_file");
  });

  it("auto-approves read-only project tools", () => {
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-project__list_project_files"), true);
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-project__search_project_files"), true);
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-project__read_project_file"), true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test sidecar/toolApproval.test.mjs
```

Expected: FAIL because `normalizeToolName` only strips the database MCP prefix and `isAutoApprovedReadOnlyDbTool` only knows DB tools.

- [ ] **Step 3: Update tool approval classification**

Replace `sidecar/toolApproval.mjs` with:

```js
const READ_ONLY_DB_TOOLS = new Set([
  "list_databases",
  "list_tables",
  "describe_table",
  "sample_rows",
  "search_schema",
  "search_values",
  "run_read_query",
  "open_table",
]);

const READ_ONLY_PROJECT_TOOLS = new Set([
  "list_project_files",
  "search_project_files",
  "read_project_file",
]);

const MCP_PREFIXES = [
  "mcp__dbscout-db__",
  "mcp__dbscout-project__",
];

export function normalizeToolName(toolName) {
  if (typeof toolName !== "string") return "";
  for (const prefix of MCP_PREFIXES) {
    if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  }
  return toolName;
}

export function isAutoApprovedReadOnlyTool(toolName) {
  const normalized = normalizeToolName(toolName);
  return READ_ONLY_DB_TOOLS.has(normalized) || READ_ONLY_PROJECT_TOOLS.has(normalized);
}

export function isAutoApprovedReadOnlyDbTool(toolName) {
  return isAutoApprovedReadOnlyTool(toolName);
}

export function createPermissionResult(behavior, input, options = {}) {
  if (behavior === "allow") {
    return {
      behavior: "allow",
      updatedInput: input && typeof input === "object" ? input : {},
    };
  }

  return {
    behavior: "deny",
    message: options.message || "denied",
  };
}
```

The function name `isAutoApprovedReadOnlyDbTool` remains as a compatibility wrapper so existing imports continue to work.

- [ ] **Step 4: Make mock Agent responses show project tool usage**

In `src/workbench/mock/mockBackend.js`, inside `agent_send`, add project context to `mockAgentContext` in both `agent_start_session` and `agent_send` branches:

```js
      project: context.project || null,
```

Add project detection near the existing `isSchemaQuestion`/`isDataQuestion` logic:

```js
    const isProjectQuestion = /项目|代码|文件|入口|readme|component|源码|目录|folder|file|code/i.test(payload.text || "");
```

Before the database schema/data branch, add:

```js
      if (isProjectQuestion && context.project?.name) {
        emitMockEvent("agent-event", { ev: "text_delta", text: `我先只读查看项目 ${context.project.name}。` });
        emitMockEvent("agent-event", {
          ev: "tool_use",
          id: "project-call-1",
          name: "mcp__dbscout-project__search_project_files",
          input: { keyword: "入口", limit: 10 },
        });
        emitMockEvent("agent-event", {
          ev: "tool_result",
          id: "project-call-1",
          summary: "找到 README.md 和 src/main.js 中的相关内容",
          isError: false,
        });
        emitMockEvent("agent-event", { ev: "text_delta", text: `模拟结果：当前项目是 ${context.project.name}，入口线索在 src/main.js。` });
        emitMockEvent("agent-event", { ev: "result", subtype: "success", costUsd: 0, isError: false, text: "" });
        return;
      }
```

- [ ] **Step 5: Run tests**

Run:

```bash
node --test sidecar/toolApproval.test.mjs src/workbench/composables/useAgent.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit this task if authorized**

```bash
git add sidecar/toolApproval.mjs sidecar/toolApproval.test.mjs src/workbench/mock/mockBackend.js
git commit -m "feat(agent): auto-approve project read tools"
```

---

### Task 7: Integration Verification and Polish

**Files:**
- Modify if test failures require it: files touched in Tasks 1-6 only.
- No new files expected.

- [ ] **Step 1: Run all focused frontend tests**

Run:

```bash
node --test src/workbench/composables/useAgentProjects.test.js src/workbench/composables/useAgent.test.js src/workbench/workbenchShell.test.js
```

Expected: PASS. If `workbenchShell.test.js` fails because an assertion string differs after formatting, update the assertion to match the implemented class/component name while keeping coverage for `AgentProjectPicker`, `agent_pick_project_directory`, `agent_validate_project_directory`, `只读`, and `项目`.

- [ ] **Step 2: Run sidecar tests**

Run:

```bash
node --test sidecar/projectTools.test.mjs sidecar/toolApproval.test.mjs sidecar/agent-runner-smoke.test.mjs
```

Expected: PASS. If `agent-runner-smoke.test.mjs` starts an SDK path that needs the native CLI and fails for environment reasons, run the two new deterministic tests separately and record the smoke-test failure output in the final summary.

- [ ] **Step 3: Run Rust checks**

Run:

```bash
cd src-tauri && cargo test agent::project --lib && cargo test agent::protocol --lib
```

Expected: PASS.

- [ ] **Step 4: Run broad JS tests for affected directories**

Run:

```bash
node --test src/workbench sidecar
```

Expected: PASS.

- [ ] **Step 5: Run Rust backend check**

Run:

```bash
cd src-tauri && cargo check
```

Expected: PASS.

- [ ] **Step 6: Manual browser-only validation**

Run:

```bash
npm run dev
```

Open the workbench in the browser, switch to the Agent panel, and validate:

1. The Agent header shows “未接入项目文件夹”.
2. Clicking the project entry in mock mode offers “添加项目文件夹”.
3. Adding uses the mock path and changes the header to `项目：dbscout-workbench` with a `只读` badge.
4. Sending “这个项目的入口在哪里？” shows a project tool step and a project-based answer.
5. Sending “修改 README” does not claim to edit files in mock mode; if the mock generic answer is too vague, adjust the mock branch to say “当前项目接入为只读，不能修改文件”.

Stop the dev server after validation.

- [ ] **Step 7: Build verification**

Run:

```bash
npm run build
```

Expected: PASS. This also exercises the sidecar bundle path.

- [ ] **Step 8: Final cleanup**

Run:

```bash
git status --short
```

Expected: Only intended files are modified/created:

```text
 M src/workbench/MySqlWorkbench.vue
 M src/workbench/components/AgentHeader.vue
 M src/workbench/components/AgentMessage.vue
 M src/workbench/components/AgentPanel.vue
 M src/workbench/mock/mockBackend.js
 M src/workbench/workbench.css
 M src/workbench/workbenchShell.test.js
 M src/workbench/composables/useAgent.js
 M src/workbench/composables/useAgent.test.js
 M src-tauri/src/agent/mod.rs
 M src-tauri/src/agent/protocol.rs
 M src-tauri/src/commands.rs
 M src-tauri/src/lib.rs
 M sidecar/agent-runner.mjs
 M sidecar/toolApproval.mjs
 M sidecar/toolApproval.test.mjs
?? src/workbench/components/AgentProjectPicker.vue
?? src/workbench/composables/useAgentProjects.js
?? src/workbench/composables/useAgentProjects.test.js
?? src-tauri/src/agent/project.rs
?? sidecar/projectTools.mjs
?? sidecar/projectTools.test.mjs
```

- [ ] **Step 9: Commit the integrated feature if authorized**

```bash
git add src/workbench/MySqlWorkbench.vue src/workbench/components/AgentHeader.vue src/workbench/components/AgentMessage.vue src/workbench/components/AgentPanel.vue src/workbench/components/AgentProjectPicker.vue src/workbench/mock/mockBackend.js src/workbench/workbench.css src/workbench/workbenchShell.test.js src/workbench/composables/useAgent.js src/workbench/composables/useAgent.test.js src/workbench/composables/useAgentProjects.js src/workbench/composables/useAgentProjects.test.js src-tauri/src/agent/mod.rs src-tauri/src/agent/project.rs src-tauri/src/agent/protocol.rs src-tauri/src/commands.rs src-tauri/src/lib.rs sidecar/agent-runner.mjs sidecar/projectTools.mjs sidecar/projectTools.test.mjs sidecar/toolApproval.mjs sidecar/toolApproval.test.mjs
git commit -m "feat(agent): add read-only project folders"
```

---

## Self-Review

### Spec coverage

- Multiple added projects and one current project: covered by Task 1 and Task 4.
- Top-of-Agent project entry, read-only badge, unavailable state: covered by Task 4.
- Folder picker and validation: covered by Task 2.
- Stable Agent SDK working directory with separate project tools: covered by Task 5; no step changes `AGENT_CWD`.
- Read-only file list/search/read tools: covered by Task 5.
- Path traversal, absolute path, symlink escape, sensitive file, ignored directories, file size limits: covered by Task 5 tests and implementation.
- Project context in each turn: covered by Task 3 and Task 5 runner context updates.
- Auto-approve read-only project tools while keeping write approval: covered by Task 6.
- Browser mock support and manual validation: covered by Tasks 2, 6, and 7.

### Placeholder scan

No `TBD`, `TODO`, “implement later”, or “similar to” placeholders are used. Every code-changing step includes the concrete code or exact replacement block needed for that step.

### Type consistency

- Frontend agent project context uses `rootPath`, `shortPath`, `readOnly`, and `available`.
- Rust uses snake_case fields with `#[serde(rename_all = "camelCase")]`, producing the same frontend shape.
- Sidecar reads `context.project.rootPath`, matching frontend serialization.
- Tool names are consistent: `list_project_files`, `search_project_files`, `read_project_file`; MCP prefix is `mcp__dbscout-project__`.
