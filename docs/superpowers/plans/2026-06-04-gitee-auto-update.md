# Gitee Auto Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a free Gitee-backed Tauri auto-update workflow with an in-app titlebar notice, update dialog, download/install progress, and release tooling.

**Architecture:** Use Tauri v2's updater and process plugins for signed desktop updates, with Gitee raw `latest.json` as the static update endpoint and Gitee Releases as the free asset host. Keep frontend update behavior in a testable adapter/composable pair, render update UI through a focused dialog component, and keep release manifest generation in Node scripts.

**Tech Stack:** Tauri 2, Vue 3 Composition API, Vite, Node.js test runner, PowerShell release commands, Gitee Releases/raw files.

---

## File Structure

- Create `src/workbench/appVersion.js`: frontend version constant synchronized with package/Tauri versions.
- Create `src/workbench/appVersion.test.js`: proves frontend version stays aligned.
- Create `src/workbench/utils/updaterAdapter.js`: normalizes Tauri updater/process plugin calls and browser fallback.
- Create `src/workbench/utils/updaterAdapter.test.js`: adapter tests without Tauri runtime.
- Create `src/workbench/composables/useUpdater.js`: updater state machine and progress handling.
- Create `src/workbench/useUpdater.test.js`: state machine tests.
- Create `src/workbench/components/UpdateDialog.vue`: compact update status/install dialog.
- Modify `src/workbench/MySqlWorkbench.vue`: wire titlebar update entry, startup check, and dialog.
- Modify `src/workbench/workbench.css`: update entry/dialog styling using `--wb-*` tokens.
- Modify `src/workbench/workbenchShell.test.js`: structural tests for updater UI and Tauri config.
- Modify `package.json` and `package-lock.json`: add updater/process plugin packages and release scripts.
- Modify `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`: add updater/process Rust plugins.
- Modify `src-tauri/src/lib.rs`: initialize updater/process plugins.
- Modify `src-tauri/tauri.conf.json`: enable updater artifacts and configure Gitee endpoint/public key.
- Modify `src-tauri/capabilities/main.json`: allow updater/process commands.
- Create `scripts/sync-update-version.mjs`: version synchronization helper.
- Create `scripts/gitee-updater-manifest.mjs`: creates and verifies Gitee `latest.json`.
- Create `scripts/sync-update-version.test.mjs`: version sync tests.
- Create `scripts/gitee-updater-manifest.test.mjs`: manifest generation and Gitee limit tests.
- Create `docs/gitee-auto-update-release.md`: human release checklist for the free Gitee path.

The public updater key generated on this machine is:

```text
dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEJDQzAzRjhFMjY5M0RDQkYKUldTLzNKTW1qai9Bdk8yVGZzMGxlRGh3QS81SkhRdC9vMUtuN2FTV0lBUHpaR21nVHpGQ3lJTi8K
```

The matching private key is stored outside Git at:

```text
C:\Users\Administrator\.tauri\dbscout-workbench.key
```

## Task 1: Native Updater Configuration And Version Constant

**Files:**
- Create: `src/workbench/appVersion.js`
- Create: `src/workbench/appVersion.test.js`
- Modify: `src/workbench/workbenchShell.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/main.json`

- [ ] **Step 1: Write failing version and native config tests**

Create `src/workbench/appVersion.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { APP_VERSION } from "./appVersion.js";

const readJson = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), "utf8"));

test("frontend app version matches package and Tauri config", () => {
  const pkg = readJson("../../package.json");
  const tauri = readJson("../../src-tauri/tauri.conf.json");

  assert.equal(APP_VERSION, pkg.version);
  assert.equal(APP_VERSION, tauri.version);
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
});
```

Append this test to `src/workbench/workbenchShell.test.js`:

```js
test("tauri updater is configured for the free Gitee release feed", () => {
  const pkg = JSON.parse(read("../../package.json"));
  const cargo = read("../../src-tauri/Cargo.toml");
  const lib = read("../../src-tauri/src/lib.rs");
  const config = JSON.parse(read("../../src-tauri/tauri.conf.json"));
  const capability = JSON.parse(read("../../src-tauri/capabilities/main.json"));

  assert.ok(pkg.dependencies["@tauri-apps/plugin-updater"]);
  assert.ok(pkg.dependencies["@tauri-apps/plugin-process"]);
  assert.match(cargo, /tauri-plugin-updater/);
  assert.match(cargo, /tauri-plugin-process/);
  assert.match(lib, /tauri_plugin_process::init\(\)/);
  assert.match(lib, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);

  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.equal(
    config.plugins.updater.endpoints[0],
    "https://gitee.com/shelbylouis/dbscout-workbench-release/raw/master/latest.json",
  );
  assert.equal(
    config.plugins.updater.pubkey,
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEJDQzAzRjhFMjY5M0RDQkYKUldTLzNKTW1qai9Bdk8yVGZzMGxlRGh3QS81SkhRdC9vMUtuN2FTV0lBUHpaR21nVHpGQ3lJTi8K",
  );
  assert.equal(config.plugins.updater.windows.installMode, "passive");
  assert.ok(capability.permissions.includes("updater:default"));
  assert.ok(capability.permissions.includes("process:default"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test src/workbench/appVersion.test.js src/workbench/workbenchShell.test.js
```

Expected: FAIL because `src/workbench/appVersion.js` does not exist and updater dependencies/configuration are missing.

- [ ] **Step 3: Add frontend version constant**

Create `src/workbench/appVersion.js`:

```js
export const APP_VERSION = "0.1.0";
```

- [ ] **Step 4: Install JavaScript updater packages**

Run:

```powershell
npm install @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

Expected: `package.json` and `package-lock.json` gain both packages under dependencies.

- [ ] **Step 5: Install Rust updater plugins**

Run:

```powershell
Push-Location src-tauri
cargo add tauri-plugin-updater tauri-plugin-process
Pop-Location
```

Expected: `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` gain `tauri-plugin-updater` and `tauri-plugin-process`.

- [ ] **Step 6: Initialize plugins in Rust**

Modify `src-tauri/src/lib.rs` so `run()` begins the builder chain like this:

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
```

- [ ] **Step 7: Configure updater endpoint and artifacts**

Modify `src-tauri/tauri.conf.json` so `bundle` includes updater artifacts and the top-level config includes `plugins`:

```json
  "bundle": {
    "active": true,
    "targets": ["nsis", "dmg"],
    "createUpdaterArtifacts": true,
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  },
  "plugins": {
    "updater": {
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEJDQzAzRjhFMjY5M0RDQkYKUldTLzNKTW1qai9Bdk8yVGZzMGxlRGh3QS81SkhRdC9vMUtuN2FTV0lBUHpaR21nVHpGQ3lJTi8K",
      "endpoints": [
        "https://gitee.com/shelbylouis/dbscout-workbench-release/raw/master/latest.json"
      ],
      "windows": {
        "installMode": "passive"
      }
    }
  }
```

Keep the rest of the file unchanged.

- [ ] **Step 8: Add updater capabilities**

Modify `src-tauri/capabilities/main.json` so the `permissions` array includes:

```json
    "updater:default",
    "process:default"
```

Place them after the existing window permissions.

- [ ] **Step 9: Run tests to verify they pass**

Run:

```powershell
node --test src/workbench/appVersion.test.js src/workbench/workbenchShell.test.js
```

Expected: PASS.

- [ ] **Step 10: Commit**

Run:

```powershell
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/tauri.conf.json src-tauri/capabilities/main.json src/workbench/appVersion.js src/workbench/appVersion.test.js src/workbench/workbenchShell.test.js
git commit -m "feat: configure gitee updater"
```

## Task 2: Browser-Safe Updater Adapter

**Files:**
- Create: `src/workbench/utils/updaterAdapter.js`
- Create: `src/workbench/utils/updaterAdapter.test.js`

- [ ] **Step 1: Write failing adapter tests**

Create `src/workbench/utils/updaterAdapter.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  createBrowserUpdaterAdapter,
  createUpdaterAdapter,
  normalizeUpdate,
} from "./updaterAdapter.js";

test("browser updater adapter reports desktop updater unavailable", async () => {
  const adapter = createBrowserUpdaterAdapter("not in Tauri");

  const result = await adapter.checkForUpdate();

  assert.equal(adapter.isDesktop, false);
  assert.equal(result.available, false);
  assert.equal(result.unavailable, true);
  assert.equal(result.message, "not in Tauri");
});

test("normalizes no-update responses with the current version", () => {
  assert.deepEqual(normalizeUpdate(null, "0.1.0"), {
    available: false,
    currentVersion: "0.1.0",
  });
});

test("normalizes update metadata returned by Tauri", () => {
  const raw = {
    version: "0.2.0",
    currentVersion: "0.1.0",
    date: "2026-06-04T12:00:00Z",
    body: "Release notes",
    downloadAndInstall() {},
  };

  const result = normalizeUpdate(raw, "0.1.0");

  assert.equal(result.available, true);
  assert.equal(result.version, "0.2.0");
  assert.equal(result.currentVersion, "0.1.0");
  assert.equal(result.date, "2026-06-04T12:00:00Z");
  assert.equal(result.body, "Release notes");
  assert.equal(result.rawUpdate, raw);
});

test("adapter delegates checks and installs to injected Tauri functions", async () => {
  const events = [];
  const rawUpdate = {
    version: "0.2.0",
    currentVersion: "0.1.0",
    async downloadAndInstall(onEvent) {
      onEvent({ event: "Started", data: { contentLength: 10 } });
      onEvent({ event: "Progress", data: { chunkLength: 10 } });
      onEvent({ event: "Finished" });
    },
  };
  let relaunched = false;
  const adapter = createUpdaterAdapter({
    currentVersion: "0.1.0",
    check: async () => rawUpdate,
    relaunch: async () => {
      relaunched = true;
    },
  });

  const update = await adapter.checkForUpdate();
  await adapter.downloadAndInstall(update, (event) => events.push(event.event));
  await adapter.relaunch();

  assert.equal(adapter.isDesktop, true);
  assert.equal(update.version, "0.2.0");
  assert.deepEqual(events, ["Started", "Progress", "Finished"]);
  assert.equal(relaunched, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node --test src/workbench/utils/updaterAdapter.test.js
```

Expected: FAIL because `updaterAdapter.js` does not exist.

- [ ] **Step 3: Implement updater adapter**

Create `src/workbench/utils/updaterAdapter.js`:

```js
import { APP_VERSION } from "../appVersion.js";

export function normalizeUpdate(update, currentVersion = APP_VERSION) {
  if (!update) {
    return {
      available: false,
      currentVersion,
    };
  }

  return {
    available: true,
    version: update.version,
    currentVersion: update.currentVersion || currentVersion,
    date: update.date || null,
    body: update.body || "",
    rawUpdate: update,
  };
}

export function createBrowserUpdaterAdapter(message = "桌面更新器不可用") {
  return {
    isDesktop: false,
    currentVersion: APP_VERSION,
    async checkForUpdate() {
      return {
        available: false,
        currentVersion: APP_VERSION,
        unavailable: true,
        message,
      };
    },
    async downloadAndInstall() {
      throw new Error(message);
    },
    async relaunch() {
      throw new Error("桌面重启不可用");
    },
  };
}

export function createUpdaterAdapter({
  check,
  relaunch,
  currentVersion = APP_VERSION,
} = {}) {
  if (typeof check !== "function" || typeof relaunch !== "function") {
    return createBrowserUpdaterAdapter();
  }

  return {
    isDesktop: true,
    currentVersion,
    async checkForUpdate() {
      return normalizeUpdate(await check(), currentVersion);
    },
    async downloadAndInstall(update, onEvent) {
      if (!update?.rawUpdate?.downloadAndInstall) {
        throw new Error("没有可安装的更新");
      }
      await update.rawUpdate.downloadAndInstall(onEvent);
    },
    async relaunch() {
      await relaunch();
    },
  };
}

export async function createTauriUpdaterAdapter() {
  if (!globalThis.__TAURI_INTERNALS__) {
    return createBrowserUpdaterAdapter();
  }

  try {
    const [{ check }, { relaunch }] = await Promise.all([
      import("@tauri-apps/plugin-updater"),
      import("@tauri-apps/plugin-process"),
    ]);
    return createUpdaterAdapter({ check, relaunch });
  } catch (error) {
    return createBrowserUpdaterAdapter(`加载桌面更新器失败：${String(error)}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
node --test src/workbench/utils/updaterAdapter.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/workbench/utils/updaterAdapter.js src/workbench/utils/updaterAdapter.test.js
git commit -m "feat: add updater adapter"
```

## Task 3: Updater State Machine

**Files:**
- Create: `src/workbench/composables/useUpdater.js`
- Create: `src/workbench/useUpdater.test.js`

- [ ] **Step 1: Write failing state machine tests**

Create `src/workbench/useUpdater.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { useUpdater, formatBytes, updateTitle } from "./composables/useUpdater.js";

function createAdapter({ result, installEvents = [], checkError = null } = {}) {
  return {
    isDesktop: true,
    currentVersion: "0.1.0",
    async checkForUpdate() {
      if (checkError) throw checkError;
      return result || { available: false, currentVersion: "0.1.0" };
    },
    async downloadAndInstall(_update, onEvent) {
      for (const event of installEvents) onEvent(event);
    },
    async relaunch() {
      this.relaunched = true;
    },
  };
}

test("formatBytes renders compact byte labels", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
});

test("updateTitle describes visible updater states", () => {
  assert.equal(updateTitle("checking"), "正在检查更新");
  assert.equal(updateTitle("available", { version: "0.2.0" }), "发现新版本 0.2.0");
  assert.equal(updateTitle("current"), "已是最新版本");
});

test("checkForUpdates moves to current when no update exists", async () => {
  const updater = useUpdater(createAdapter());

  await updater.checkForUpdates();

  assert.equal(updater.status.value, "current");
  assert.equal(updater.currentVersion.value, "0.1.0");
  assert.equal(updater.availableUpdate.value, null);
  assert.ok(updater.lastCheckedAt.value);
});

test("checkForUpdates records available update and opens dialog when requested", async () => {
  const updater = useUpdater(createAdapter({
    result: {
      available: true,
      version: "0.2.0",
      currentVersion: "0.1.0",
      body: "Release notes",
      date: "2026-06-04T12:00:00Z",
      rawUpdate: { downloadAndInstall() {} },
    },
  }));

  await updater.checkForUpdates({ openOnAvailable: true });

  assert.equal(updater.status.value, "available");
  assert.equal(updater.availableUpdate.value.version, "0.2.0");
  assert.equal(updater.isDialogOpen.value, true);
});

test("download progress tracks content length and install completion", async () => {
  const updater = useUpdater(createAdapter({
    result: {
      available: true,
      version: "0.2.0",
      currentVersion: "0.1.0",
      rawUpdate: { downloadAndInstall() {} },
    },
    installEvents: [
      { event: "Started", data: { contentLength: 100 } },
      { event: "Progress", data: { chunkLength: 25 } },
      { event: "Progress", data: { chunkLength: 75 } },
      { event: "Finished" },
    ],
  }));

  await updater.checkForUpdates();
  await updater.downloadAndInstall();

  assert.equal(updater.status.value, "installed");
  assert.equal(updater.downloadedBytes.value, 100);
  assert.equal(updater.contentLength.value, 100);
  assert.equal(updater.downloadPercent.value, 100);
});

test("manual check errors open the dialog and keep previous update metadata", async () => {
  const updater = useUpdater(createAdapter({
    result: {
      available: true,
      version: "0.2.0",
      currentVersion: "0.1.0",
      rawUpdate: { downloadAndInstall() {} },
    },
  }));
  await updater.checkForUpdates();
  updater.adapter.value = createAdapter({ checkError: new Error("network down") });

  await updater.checkForUpdates({ openOnError: true });

  assert.equal(updater.status.value, "error");
  assert.equal(updater.errorMessage.value, "network down");
  assert.equal(updater.availableUpdate.value.version, "0.2.0");
  assert.equal(updater.isDialogOpen.value, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node --test src/workbench/useUpdater.test.js
```

Expected: FAIL because `useUpdater.js` does not exist.

- [ ] **Step 3: Implement updater composable**

Create `src/workbench/composables/useUpdater.js`:

```js
import { computed, ref } from "vue";

import { APP_VERSION } from "../appVersion.js";
import { createTauriUpdaterAdapter } from "../utils/updaterAdapter.js";

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function updateTitle(status, update = null) {
  if (status === "checking") return "正在检查更新";
  if (status === "available" && update?.version) return `发现新版本 ${update.version}`;
  if (status === "downloading") return "正在下载更新";
  if (status === "installed") return "更新已安装";
  if (status === "error") return "更新检查失败";
  return "已是最新版本";
}

function messageFromError(error) {
  return String(error?.message || error || "未知错误");
}

export function useUpdater(initialAdapter = null) {
  const adapter = ref(initialAdapter);
  const status = ref("idle");
  const currentVersion = ref(initialAdapter?.currentVersion || APP_VERSION);
  const availableUpdate = ref(null);
  const downloadedBytes = ref(0);
  const contentLength = ref(null);
  const lastCheckedAt = ref("");
  const errorMessage = ref("");
  const isDialogOpen = ref(false);

  const downloadPercent = computed(() => {
    if (!contentLength.value) return 0;
    return Math.min(100, Math.round((downloadedBytes.value / contentLength.value) * 100));
  });
  const title = computed(() => updateTitle(status.value, availableUpdate.value));
  const isBusy = computed(() => status.value === "checking" || status.value === "downloading");

  async function ensureAdapter() {
    if (!adapter.value) adapter.value = await createTauriUpdaterAdapter();
    return adapter.value;
  }

  function openDialog() {
    isDialogOpen.value = true;
  }

  function closeDialog() {
    isDialogOpen.value = false;
  }

  async function checkForUpdates({ openOnAvailable = false, openOnError = false } = {}) {
    const updater = await ensureAdapter();
    status.value = "checking";
    errorMessage.value = "";
    try {
      const result = await updater.checkForUpdate();
      currentVersion.value = result.currentVersion || currentVersion.value;
      lastCheckedAt.value = new Date().toISOString();

      if (result.available) {
        availableUpdate.value = result;
        status.value = "available";
        if (openOnAvailable) openDialog();
        return result;
      }

      if (result.unavailable) errorMessage.value = result.message || "";
      status.value = "current";
      return result;
    } catch (error) {
      status.value = "error";
      errorMessage.value = messageFromError(error);
      if (openOnError) openDialog();
      return null;
    }
  }

  function handleDownloadEvent(event) {
    if (event?.event === "Started") {
      contentLength.value = event.data?.contentLength || null;
      downloadedBytes.value = 0;
    }
    if (event?.event === "Progress") {
      downloadedBytes.value += event.data?.chunkLength || 0;
    }
  }

  async function downloadAndInstall() {
    const updater = await ensureAdapter();
    if (!availableUpdate.value) return;
    status.value = "downloading";
    errorMessage.value = "";
    downloadedBytes.value = 0;
    contentLength.value = null;
    try {
      await updater.downloadAndInstall(availableUpdate.value, handleDownloadEvent);
      status.value = "installed";
      openDialog();
    } catch (error) {
      status.value = "error";
      errorMessage.value = messageFromError(error);
      openDialog();
    }
  }

  async function relaunch() {
    const updater = await ensureAdapter();
    await updater.relaunch();
  }

  return {
    adapter,
    status,
    currentVersion,
    availableUpdate,
    downloadedBytes,
    contentLength,
    lastCheckedAt,
    errorMessage,
    isDialogOpen,
    downloadPercent,
    title,
    isBusy,
    openDialog,
    closeDialog,
    checkForUpdates,
    downloadAndInstall,
    relaunch,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
node --test src/workbench/useUpdater.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/workbench/composables/useUpdater.js src/workbench/useUpdater.test.js
git commit -m "feat: add updater state machine"
```

## Task 4: Update Dialog And Workbench Wiring

**Files:**
- Create: `src/workbench/components/UpdateDialog.vue`
- Modify: `src/workbench/MySqlWorkbench.vue`
- Modify: `src/workbench/workbench.css`
- Modify: `src/workbench/workbenchShell.test.js`

- [ ] **Step 1: Write failing UI structure tests**

Append this test to `src/workbench/workbenchShell.test.js`:

```js
test("workbench exposes an in-app updater entry and dialog", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const dialog = read("./components/UpdateDialog.vue");
  const styles = read("./workbench.css");

  assert.match(orchestrator, /import\s+UpdateDialog\s+from\s+["']\.\/components\/UpdateDialog\.vue["']/);
  assert.match(orchestrator, /import\s+\{\s*useUpdater\s*\}\s+from\s+["']\.\/composables\/useUpdater\.js["']/);
  assert.match(orchestrator, /class="wb-update-button"/);
  assert.match(orchestrator, /@click\.stop="openUpdateDialog"/);
  assert.match(orchestrator, /<UpdateDialog/);
  assert.match(orchestrator, /void updater\.checkForUpdates\(\)/);

  assert.match(dialog, /defineProps/);
  assert.match(dialog, /currentVersion/);
  assert.match(dialog, /availableUpdate/);
  assert.match(dialog, /downloadPercent/);
  assert.match(dialog, /downloadAndInstall/);
  assert.match(dialog, /relaunch/);
  assert.match(dialog, /已是最新版本/);
  assert.match(dialog, /下载并安装/);
  assert.match(dialog, /立即重启/);

  assert.match(styles, /\.wb-update-button\s*\{/);
  assert.match(styles, /\.wb-update-button\.is-available\s*\{/);
  assert.match(styles, /\.wb-update-dialog\s*\{/);
  assert.match(styles, /\.wb-update-progress-fill\s*\{/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node --test src/workbench/workbenchShell.test.js
```

Expected: FAIL because `UpdateDialog.vue`, updater imports, and updater styles are missing.

- [ ] **Step 3: Create update dialog component**

Create `src/workbench/components/UpdateDialog.vue`:

```vue
<script setup>
import { computed } from "vue";
import { formatBytes } from "../composables/useUpdater.js";

const props = defineProps({
  updater: { type: Object, required: true },
});

const emit = defineEmits(["close", "check", "downloadAndInstall", "relaunch"]);

const update = computed(() => props.updater.availableUpdate.value);
const hasKnownLength = computed(() => Number(props.updater.contentLength.value) > 0);
const downloadedLabel = computed(() => formatBytes(props.updater.downloadedBytes.value));
const totalLabel = computed(() =>
  hasKnownLength.value ? formatBytes(props.updater.contentLength.value) : "",
);
const checkedLabel = computed(() => {
  const value = props.updater.lastCheckedAt.value;
  if (!value) return "尚未检查";
  return new Date(value).toLocaleString("zh-CN");
});
</script>

<template>
  <div class="wb-dialog-overlay" @click.self="emit('close')">
    <section class="wb-dialog wb-update-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-update-title">
      <header class="wb-dialog-header">
        <strong id="wb-update-title">应用更新</strong>
        <button type="button" class="wb-dialog-close" aria-label="关闭更新窗口" @click="emit('close')">×</button>
      </header>

      <div class="wb-update-body">
        <p class="wb-update-version-line">
          <span>当前版本</span>
          <strong>{{ updater.currentVersion.value }}</strong>
        </p>

        <template v-if="updater.status.value === 'available'">
          <p class="wb-update-version-line">
            <span>最新版本</span>
            <strong>{{ update?.version }}</strong>
          </p>
          <p v-if="update?.date" class="wb-update-meta">发布时间：{{ new Date(update.date).toLocaleString("zh-CN") }}</p>
          <pre v-if="update?.body" class="wb-update-notes">{{ update.body }}</pre>
          <p v-else class="wb-update-meta">此版本没有填写更新说明。</p>
        </template>

        <template v-else-if="updater.status.value === 'downloading'">
          <p class="wb-update-meta">正在下载更新：{{ downloadedLabel }}<template v-if="hasKnownLength"> / {{ totalLabel }}</template></p>
          <div class="wb-update-progress" :class="{ 'is-indeterminate': !hasKnownLength }" role="progressbar" :aria-valuenow="hasKnownLength ? updater.downloadPercent.value : undefined" aria-valuemin="0" aria-valuemax="100">
            <span class="wb-update-progress-fill" :style="{ width: hasKnownLength ? `${updater.downloadPercent.value}%` : '42%' }"></span>
          </div>
        </template>

        <p v-else-if="updater.status.value === 'installed'" class="wb-update-meta">更新已安装，重启后生效。</p>
        <p v-else-if="updater.status.value === 'checking'" class="wb-update-meta">正在检查 Gitee 更新源...</p>
        <p v-else-if="updater.status.value === 'error'" class="wb-update-error">{{ updater.errorMessage.value }}</p>
        <p v-else class="wb-update-meta">已是最新版本。上次检查：{{ checkedLabel }}</p>
      </div>

      <footer class="wb-dialog-actions">
        <button type="button" @click="emit('close')">稍后</button>
        <button v-if="updater.status.value === 'available'" type="button" class="wb-update-primary" @click="emit('downloadAndInstall')">下载并安装</button>
        <button v-else-if="updater.status.value === 'installed'" type="button" class="wb-update-primary" @click="emit('relaunch')">立即重启</button>
        <button v-else type="button" :disabled="updater.isBusy.value" @click="emit('check')">重新检查</button>
      </footer>
    </section>
  </div>
</template>
```

- [ ] **Step 4: Wire updater in `MySqlWorkbench.vue`**

Add imports near the existing component/composable imports:

```js
import UpdateDialog from "./components/UpdateDialog.vue";
import { useUpdater } from "./composables/useUpdater.js";
```

Create the updater after theme setup:

```js
const updater = useUpdater();

function openUpdateDialog() {
  updater.openDialog();
  if (updater.status.value === "idle" || updater.status.value === "current" || updater.status.value === "error") {
    void updater.checkForUpdates({ openOnError: true });
  }
}
```

Add a non-blocking startup check at the end of the existing `onMounted` block. This records availability for the titlebar notice without opening the dialog during startup:

```js
  void updater.checkForUpdates();
```

Add the titlebar button between `.wb-titlebar-brand` and `.wb-titlebar-controls`:

```vue
      <button
        type="button"
        class="wb-update-button"
        :class="{
          'is-checking': updater.status.value === 'checking',
          'is-available': updater.status.value === 'available',
          'is-error': updater.status.value === 'error',
        }"
        :title="updater.title.value"
        :aria-label="updater.title.value"
        @click.stop="openUpdateDialog"
      >
        <span class="wb-update-dot" aria-hidden="true"></span>
        <span v-if="updater.status.value === 'available'" class="wb-update-label">{{ updater.availableUpdate.value?.version }}</span>
      </button>
```

Add the dialog before `ImportWizardDialog`:

```vue
    <UpdateDialog
      v-if="updater.isDialogOpen.value"
      :updater="updater"
      @close="updater.closeDialog"
      @check="updater.checkForUpdates({ openOnError: true, openOnAvailable: true })"
      @download-and-install="updater.downloadAndInstall"
      @relaunch="updater.relaunch"
    />
```

- [ ] **Step 5: Add updater styles**

Append to `src/workbench/workbench.css` near titlebar styles:

```css
.wb-update-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  min-height: 24px;
  margin-left: auto;
  margin-right: 8px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--wb-secondary-text);
  box-shadow: none;
  -webkit-app-region: no-drag;
}

.wb-update-button:hover,
.wb-update-button:focus-visible {
  border-color: var(--wb-accent);
  background: var(--wb-accent-soft);
  color: var(--wb-text);
}

.wb-update-button.is-available {
  border-color: color-mix(in srgb, var(--wb-accent) 35%, transparent);
  background: var(--wb-accent-soft);
  color: var(--wb-accent-strong);
}

.wb-update-button.is-error {
  color: var(--wb-danger);
}

.wb-update-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.72;
}

.wb-update-button.is-checking .wb-update-dot {
  animation: wb-update-pulse 1s ease-in-out infinite;
}

.wb-update-label {
  font-size: 11px;
  font-weight: 650;
  line-height: 1;
}

.wb-update-dialog {
  width: 420px;
}

.wb-update-body {
  display: grid;
  gap: 10px;
}

.wb-update-version-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0;
  color: var(--wb-secondary-text);
}

.wb-update-version-line strong {
  color: var(--wb-text);
  font-variant-numeric: tabular-nums;
}

.wb-update-meta,
.wb-update-error {
  margin: 0;
  color: var(--wb-secondary-text);
  font-size: 12px;
  line-height: 1.55;
}

.wb-update-error {
  color: var(--wb-danger);
}

.wb-update-notes {
  max-height: 150px;
  margin: 0;
  overflow: auto;
  padding: 8px;
  border-radius: 6px;
  background: var(--wb-detail-surface);
  color: var(--wb-text);
  font-family: var(--wb-font-ui);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
}

.wb-update-progress {
  position: relative;
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--wb-border);
}

.wb-update-progress-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  background: var(--wb-accent-control);
  transition: width 0.16s ease;
}

.wb-update-progress.is-indeterminate .wb-update-progress-fill {
  animation: wb-update-slide 1.2s ease-in-out infinite;
}

.wb-update-primary {
  border-color: transparent;
  background: var(--wb-accent-control);
  color: var(--wb-accent-control-text);
}

.wb-update-primary:hover:not(:disabled),
.wb-update-primary:focus-visible {
  background: var(--wb-accent-control-hover);
}

@keyframes wb-update-pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

@keyframes wb-update-slide {
  0% {
    transform: translateX(-120%);
  }
  100% {
    transform: translateX(260%);
  }
}
```

Inside the existing `@media (prefers-reduced-motion: reduce)` block, add:

```css
  .wb-update-button.is-checking .wb-update-dot,
  .wb-update-progress.is-indeterminate .wb-update-progress-fill {
    animation: none !important;
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run:

```powershell
node --test src/workbench/workbenchShell.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/workbench/components/UpdateDialog.vue src/workbench/MySqlWorkbench.vue src/workbench/workbench.css src/workbench/workbenchShell.test.js
git commit -m "feat: add updater UI"
```

## Task 5: Gitee Manifest And Version Release Tooling

**Files:**
- Create: `scripts/sync-update-version.mjs`
- Create: `scripts/sync-update-version.test.mjs`
- Create: `scripts/gitee-updater-manifest.mjs`
- Create: `scripts/gitee-updater-manifest.test.mjs`
- Create: `docs/gitee-auto-update-release.md`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing script tests**

Create `scripts/sync-update-version.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { syncVersionInWorkspace } from "./sync-update-version.mjs";

test("syncVersionInWorkspace aligns package, Tauri, Cargo, and frontend version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbscout-version-"));
  fs.mkdirSync(path.join(dir, "src-tauri"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src", "workbench"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "0.1.0" }, null, 2));
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ version: "0.1.0", packages: { "": { version: "0.1.0" } } }, null, 2));
  fs.writeFileSync(path.join(dir, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: "0.1.0" }, null, 2));
  fs.writeFileSync(path.join(dir, "src-tauri", "Cargo.toml"), '[package]\nname = "dbscout-workbench"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(dir, "src", "workbench", "appVersion.js"), 'export const APP_VERSION = "0.1.0";\n');

  syncVersionInWorkspace(dir, "0.2.0");

  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version, "0.2.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8")).packages[""].version, "0.2.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "src-tauri", "tauri.conf.json"), "utf8")).version, "0.2.0");
  assert.match(fs.readFileSync(path.join(dir, "src-tauri", "Cargo.toml"), "utf8"), /version = "0\.2\.0"/);
  assert.equal(fs.readFileSync(path.join(dir, "src", "workbench", "appVersion.js"), "utf8"), 'export const APP_VERSION = "0.2.0";\n');
});
```

Create `scripts/gitee-updater-manifest.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  GITEE_MAX_ATTACHMENT_BYTES,
  createManifest,
  validateArtifactForGitee,
} from "./gitee-updater-manifest.mjs";

test("createManifest writes a Tauri static updater manifest", () => {
  const manifest = createManifest({
    version: "0.2.0",
    notes: "Release notes",
    pubDate: "2026-06-04T12:00:00Z",
    platforms: {
      "windows-x86_64": {
        signature: "abc",
        url: "https://gitee.com/shelbylouis/dbscout-workbench-release/releases/download/v0.2.0/DBScoutWorkbench_0.2.0_x64-setup.exe",
      },
    },
  });

  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.platforms["windows-x86_64"].signature, "abc");
  assert.match(manifest.platforms["windows-x86_64"].url, /releases\/download\/v0\.2\.0/);
});

test("validateArtifactForGitee rejects missing signatures and oversized files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbscout-manifest-"));
  const artifact = path.join(dir, "setup.exe");
  fs.writeFileSync(artifact, Buffer.alloc(16));

  assert.throws(() => validateArtifactForGitee({ artifactPath: artifact, signature: "" }), /signature is required/);
  assert.doesNotThrow(() => validateArtifactForGitee({ artifactPath: artifact, signature: "abc" }));

  const oversized = path.join(dir, "oversized.exe");
  fs.writeFileSync(oversized, Buffer.alloc(GITEE_MAX_ATTACHMENT_BYTES + 1));
  assert.throws(() => validateArtifactForGitee({ artifactPath: oversized, signature: "abc" }), /exceeds Gitee free attachment limit/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test scripts/sync-update-version.test.mjs scripts/gitee-updater-manifest.test.mjs
```

Expected: FAIL because both implementation scripts are missing.

- [ ] **Step 3: Implement version sync script**

Create `scripts/sync-update-version.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertSemver(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`version must be SemVer x.y.z: ${version}`);
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function syncVersionInWorkspace(workspaceRoot, version) {
  assertSemver(version);

  const packagePath = path.join(workspaceRoot, "package.json");
  const packageLockPath = path.join(workspaceRoot, "package-lock.json");
  const tauriConfigPath = path.join(workspaceRoot, "src-tauri", "tauri.conf.json");
  const cargoTomlPath = path.join(workspaceRoot, "src-tauri", "Cargo.toml");
  const appVersionPath = path.join(workspaceRoot, "src", "workbench", "appVersion.js");

  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  pkg.version = version;
  writeJson(packagePath, pkg);

  if (fs.existsSync(packageLockPath)) {
    const lock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
    lock.version = version;
    if (lock.packages?.[""]) lock.packages[""].version = version;
    writeJson(packageLockPath, lock);
  }

  const tauri = JSON.parse(fs.readFileSync(tauriConfigPath, "utf8"));
  tauri.version = version;
  writeJson(tauriConfigPath, tauri);

  const cargo = fs.readFileSync(cargoTomlPath, "utf8").replace(
    /(^version\s*=\s*")([^"]+)(")/m,
    `$1${version}$3`,
  );
  fs.writeFileSync(cargoTomlPath, cargo);

  fs.writeFileSync(appVersionPath, `export const APP_VERSION = "${version}";\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) throw new Error("usage: node scripts/sync-update-version.mjs 0.2.0");
  syncVersionInWorkspace(root, version);
}
```

- [ ] **Step 4: Implement Gitee manifest script**

Create `scripts/gitee-updater-manifest.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GITEE_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

function assertSemver(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`version must be SemVer x.y.z: ${version}`);
  }
}

export function validateArtifactForGitee({ artifactPath, signature }) {
  if (!signature || !signature.trim()) throw new Error("signature is required");
  const size = fs.statSync(artifactPath).size;
  if (size > GITEE_MAX_ATTACHMENT_BYTES) {
    throw new Error(`artifact ${path.basename(artifactPath)} exceeds Gitee free attachment limit`);
  }
  return size;
}

export function createManifest({ version, notes, pubDate, platforms }) {
  assertSemver(version);
  for (const [target, entry] of Object.entries(platforms)) {
    if (!entry.url) throw new Error(`${target} url is required`);
    if (!entry.signature) throw new Error(`${target} signature is required`);
  }
  return {
    version,
    notes: notes || "",
    pub_date: pubDate,
    platforms,
  };
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = readArg("--version");
  const artifactPath = readArg("--artifact");
  const signaturePath = readArg("--signature");
  const url = readArg("--url");
  const notes = readArg("--notes");
  const out = readArg("--out") || "latest.json";
  const pubDate = readArg("--pub-date") || new Date().toISOString();

  if (!version || !artifactPath || !signaturePath || !url) {
    throw new Error("usage: node scripts/gitee-updater-manifest.mjs --version 0.2.0 --artifact src-tauri/target/release/bundle/nsis/DBScoutWorkbench_0.2.0_x64-setup.exe --signature src-tauri/target/release/bundle/nsis/DBScoutWorkbench_0.2.0_x64-setup.exe.sig --url https://gitee.com/shelbylouis/dbscout-workbench-release/releases/download/v0.2.0/DBScoutWorkbench_0.2.0_x64-setup.exe --out latest.json");
  }

  const signature = fs.readFileSync(signaturePath, "utf8").trim();
  validateArtifactForGitee({ artifactPath, signature });
  const manifest = createManifest({
    version,
    notes,
    pubDate,
    platforms: {
      "windows-x86_64": { signature, url },
    },
  });
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
}
```

- [ ] **Step 5: Add release scripts to package.json**

Modify `package.json` scripts:

```json
    "release:sync-version": "node scripts/sync-update-version.mjs",
    "release:gitee-manifest": "node scripts/gitee-updater-manifest.mjs"
```

Keep existing scripts intact.

- [ ] **Step 6: Add release checklist documentation**

Create `docs/gitee-auto-update-release.md`:

```markdown
# Gitee Auto Update Release Checklist

This project uses the free Gitee updater path.

## Release Repository

- Public repo: `shelbylouis/dbscout-workbench-release`
- Raw manifest: `https://gitee.com/shelbylouis/dbscout-workbench-release/raw/master/latest.json`
- Attachment limit: 100 MB per file
- Attachment quota: keep the release repo within the free Gitee quota

## Signing Key

Private key path on the release machine:

```text
C:\Users\Administrator\.tauri\dbscout-workbench.key
```

Set this before building:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH="$env:USERPROFILE\.tauri\dbscout-workbench.key"
```

## Release Steps

1. Sync versions:

```powershell
npm run release:sync-version -- 0.2.0
```

2. Build signed bundle:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH="$env:USERPROFILE\.tauri\dbscout-workbench.key"
npm run tauri -- build
```

3. Upload the Windows setup `.exe` from `src-tauri\target\release\bundle\nsis` to Gitee release `v0.2.0`.

4. Generate `latest.json` after the Gitee attachment URL is available:

```powershell
node scripts/gitee-updater-manifest.mjs --version 0.2.0 --artifact "src-tauri\target\release\bundle\nsis\DBScoutWorkbench_0.2.0_x64-setup.exe" --signature "src-tauri\target\release\bundle\nsis\DBScoutWorkbench_0.2.0_x64-setup.exe.sig" --url "https://gitee.com/shelbylouis/dbscout-workbench-release/releases/download/v0.2.0/DBScoutWorkbench_0.2.0_x64-setup.exe" --out latest.json
```

5. Commit or upload `latest.json` to the root of `shelbylouis/dbscout-workbench-release`.

6. Verify the raw manifest and installer URL before announcing the release.
```

- [ ] **Step 7: Run script tests to verify they pass**

Run:

```powershell
node --test scripts/sync-update-version.test.mjs scripts/gitee-updater-manifest.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```powershell
git add package.json package-lock.json scripts/sync-update-version.mjs scripts/sync-update-version.test.mjs scripts/gitee-updater-manifest.mjs scripts/gitee-updater-manifest.test.mjs docs/gitee-auto-update-release.md
git commit -m "feat: add gitee updater release tooling"
```

## Task 6: Full Verification

**Files:**
- No new files expected

- [ ] **Step 1: Run all JavaScript workbench tests**

Run:

```powershell
node --test src/workbench
```

Expected: PASS with no failing tests.

- [ ] **Step 2: Run release script tests**

Run:

```powershell
node --test scripts/sync-update-version.test.mjs scripts/gitee-updater-manifest.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run frontend production build**

Run:

```powershell
npm run build
```

Expected: PASS and `dist/` is produced.

- [ ] **Step 4: Run Rust type checks**

Run:

```powershell
Push-Location src-tauri
cargo check
Pop-Location
```

Expected: PASS.

- [ ] **Step 5: Run Rust tests**

Run:

```powershell
Push-Location src-tauri
cargo test
Pop-Location
```

Expected: PASS.

- [ ] **Step 6: Manually verify browser fallback**

Run:

```powershell
npm run dev
```

Open `http://127.0.0.1:1431`. Click the update button in the titlebar.

Expected:

- The workbench still loads demo data.
- The update dialog opens.
- Browser mode does not crash without Tauri internals.
- A manual check reports the desktop updater is unavailable.

- [ ] **Step 7: Handle verification-only adjustments if any were required**

If no fixes were needed, do nothing. If fixes were required, return to the task
that owns the changed files, add a new failing test for the observed failure,
make the smallest fix, rerun that task's verification command, and commit with
that task's exact `git add` command.

## Self-Review Checklist

- Spec coverage: Tasks cover Gitee-only endpoint, free attachment limit, signed Tauri updater config, public/private key handling, browser fallback, titlebar notice, update dialog, progress handling, relaunch, release manifest generation, docs, and full test/build checks.
- Completeness scan: The only generated value is the actual public key listed above; no private key, access token, paid service, or unspecified endpoint is required.
- Type consistency: Adapter returns normalized update objects with `available`, `version`, `currentVersion`, `date`, `body`, and `rawUpdate`; the composable and UI use those same names.
