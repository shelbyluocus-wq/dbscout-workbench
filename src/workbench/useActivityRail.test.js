import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ref } from "vue";
import { ACTIVITY_RAIL_ENTRIES, useActivityRail } from "./composables/useActivityRail.js";
import { language } from "./i18n/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(join(__dirname, file), "utf8");

test("activity rail pins add connection on top, lists the tool group, then pins settings at the bottom", () => {
  const { leadItems, items, bottomItems } = useActivityRail();
  assert.deepEqual(leadItems.value.map((item) => item.id), ["addConnection"]);
  assert.deepEqual(
    items.value.map((item) => item.id),
    ["quickOpen", "databaseFavorites", "tableTransfer"],
  );
  assert.deepEqual(
    bottomItems.value.map((item) => item.id),
    ["update", "settings"],
  );
});

test("activity rail entries expose icon components, translated labels, and popup surfaces", () => {
  const { leadItems, items, bottomItems } = useActivityRail();
  for (const item of [...leadItems.value, ...items.value, ...bottomItems.value]) {
    assert.ok(["object", "function"].includes(typeof item.icon), `${item.id} should map to a lucide icon component`);
    assert.ok(item.label.length > 0, `${item.id} should have a translated label`);
    assert.ok(item.popup, `${item.id} should declare its popup surface for aria-haspopup`);
  }
  assert.equal(ACTIVITY_RAIL_ENTRIES.find((entry) => entry.id === "addConnection").zone, "lead");
});

test("activity rail entries carry a one-line tooltip hint", () => {
  const { items, bottomItems } = useActivityRail();
  const hints = Object.fromEntries([...items.value, ...bottomItems.value].map((item) => [item.id, item.hint]));
  assert.match(hints.quickOpen, /quick open/i);
  assert.equal(hints.databaseFavorites, "Switch to a favorite database");
  assert.match(hints.tableTransfer, /conversion script/i);
  assert.match(hints.settings, /theme|font/i);
});

test("activity rail labels and tooltips follow the active locale", () => {
  const rail = useActivityRail();
  const byId = (list) => Object.fromEntries(list.map((item) => [item.id, item]));
  assert.equal(byId(rail.items.value).quickOpen.label, "Quick open");
  assert.equal(byId(rail.bottomItems.value).settings.label, "Settings");

  const previousLocale = language.locale.value;
  language.setLanguage("zh-TW");
  try {
    assert.equal(byId(rail.items.value).quickOpen.label, "快速開啟");
    assert.equal(byId(rail.items.value).databaseFavorites.label, "收藏資料庫");
    assert.equal(byId(rail.items.value).tableTransfer.label, "一鍵轉表");
    assert.equal(byId(rail.bottomItems.value).settings.label, "設定");
    assert.equal(byId(rail.items.value).quickOpen.hint, "快速開啟資料表與搜尋值");
    assert.equal(byId(rail.items.value).databaseFavorites.hint, "快速切換收藏的資料庫");
    assert.equal(byId(rail.bottomItems.value).settings.hint, "外觀、字體與快捷鍵");
  } finally {
    language.setLanguage(previousLocale);
  }

  language.setLanguage("zh-CN");
  try {
    assert.equal(byId(rail.items.value).tableTransfer.label, "一键转表");
  } finally {
    language.setLanguage(previousLocale);
  }
});

test("activity rail select dispatches to the matching action with the click event", () => {
  const calls = [];
  const { select } = useActivityRail({
    actions: {
      addConnection: (...args) => calls.push(["addConnection", args]),
      tableTransfer: (...args) => calls.push(["tableTransfer", args]),
      settings: (...args) => calls.push(["settings", args]),
    },
  });
  const event = { type: "click" };
  select("addConnection", event);
  select("settings", event);
  select("tableTransfer", event);
  select("unknownEntry");
  assert.deepEqual(calls, [["addConnection", [event]], ["settings", [event]], ["tableTransfer", [event]]]);
});

test("activity rail reflects live shortcut bindings in tooltips", () => {
  withNavigator({ platform: "Win32" }, () => {
    const shortcutHelper = {
      get(action) {
        return { openTableTransfer: "Ctrl+Shift+T", searchDatabase: "Ctrl+P" }[action] || "";
      },
    };
    const rail = useActivityRail({ shortcuts: shortcutHelper });
    const byId = Object.fromEntries([...rail.leadItems.value, ...rail.items.value].map((item) => [item.id, item]));
    assert.equal(byId.tableTransfer.shortcutLabel, "Ctrl+Shift+T");
    assert.equal(byId.quickOpen.shortcutLabel, "Ctrl+P");
    assert.equal(byId.addConnection.shortcutLabel, "");
    assert.equal(byId.tableTransfer.ariaShortcut, "Control+Shift+T");
    assert.equal(byId.quickOpen.ariaShortcut, "Control+P");
  });
});

function withNavigator(value, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value });
  try {
    run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete globalThis.navigator;
  }
}

test("activity rail tooltips use Command modifier labels on macOS", () => {
  withNavigator({ platform: "MacIntel" }, () => {
    const shortcutHelper = {
      get(action) {
        return action === "searchDatabase" ? "Ctrl+P" : "";
      },
    };
    const rail = useActivityRail({ shortcuts: shortcutHelper });
    const item = rail.items.value.find((entry) => entry.id === "quickOpen");
    assert.equal(item.shortcutLabel, "⌘P");
    assert.equal(item.ariaShortcut, "Meta+P");
  });
});

test("activity rail reflects expanded state for popup entries", () => {
  const open = ref(false);
  const rail = useActivityRail({ expanded: { settings: () => open.value } });
  assert.equal(rail.bottomItems.value[1].expanded, false);
  open.value = true;
  assert.equal(rail.bottomItems.value[1].expanded, true);
  assert.equal(rail.bottomItems.value[1].controls, "wb-sidebar-settings-sheet");
  assert.equal(rail.items.value[0].expanded, undefined);
});

test("activity rail reorder moves entries and persists the order", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  const rail = useActivityRail({ storage });
  rail.reorder("tableTransfer", "quickOpen", { position: "before" });
  assert.deepEqual(
    rail.items.value.map((item) => item.id),
    ["tableTransfer", "quickOpen", "databaseFavorites"],
  );
  assert.equal(
    storage.getItem("dbscout_activity_rail_order"),
    JSON.stringify(["tableTransfer", "quickOpen", "databaseFavorites"]),
  );

  // Fixed zones never join the sortable order.
  rail.reorder("quickOpen", "addConnection", { position: "before" });
  rail.reorder("settings", "quickOpen", { position: "before" });
  assert.deepEqual(
    rail.items.value.map((item) => item.id),
    ["tableTransfer", "quickOpen", "databaseFavorites"],
  );

  // A fresh composable on the same storage restores the custom order.
  const restored = useActivityRail({ storage });
  assert.deepEqual(
    restored.items.value.map((item) => item.id),
    ["tableTransfer", "quickOpen", "databaseFavorites"],
  );
});

test("activity rail order drops unknown ids and re-inserts missing entries at their default slot", () => {
  const storage = {
    getItem: () => JSON.stringify(["tableTransfer", "goneEntry", "addConnection", "quickOpen"]),
    setItem: () => {},
  };
  const { items } = useActivityRail({ storage });
  // Stored ids keep their relative order; missing defaults re-insert at their slot.
  assert.deepEqual(
    items.value.map((item) => item.id),
    ["tableTransfer", "databaseFavorites", "quickOpen"],
  );
});

test("activity rail ignores corrupt or absent stored order", () => {
  for (const stored of ["{not json", "{}", '["settings"]', "123"]) {
    const rail = useActivityRail({
      storage: { getItem: () => stored, setItem: () => {} },
    });
    assert.deepEqual(
      rail.items.value.map((item) => item.id),
      ["quickOpen", "databaseFavorites", "tableTransfer"],
      `stored=${stored}`,
    );
  }
});

test("activity rail keeps the rail component inside the workbench before the sidebar", () => {
  const orchestrator = read("./MySqlWorkbench.vue");
  const rail = read("./components/WorkbenchActivityRail.vue");
  const sidebar = read("./components/WorkbenchSidebar.vue");
  const i18n = read("./i18n/zhCN.js");

  assert.match(orchestrator, /<WorkbenchActivityRail[\s\S]*?<WorkbenchSidebar/);
  assert.doesNotMatch(sidebar, /wb-sidebar-actions-btn/);
  assert.doesNotMatch(sidebar, /open-backup-center|open-table-transfer/);

  assert.match(rail, /class="wb-activity-rail"/);
  assert.match(rail, /v-for="\(item, index\) in items"/);
  assert.match(rail, /@pointerdown="sort\.onPointerDown\(item, \$event\)"/);
  assert.match(rail, /retainPointerActivationChrome/);
  assert.match(rail, /is-pointer-activated/);
  assert.doesNotMatch(rail, /draggable=/);
  // The parent's reorder takes positional (sourceId, targetId, { position }) arguments.
  assert.match(rail, /emit\("reorder", sourceId, targetId, \{ position \}\)/);
  assert.match(orchestrator, /@reorder="reorderActivityRailEntry"/);
  assert.match(orchestrator, /:lead-items="activityRailLeadItems"/);
  assert.match(rail, /wb-activity-rail-bottom/);
  const button = read("./components/WorkbenchActivityRailButton.vue");
  assert.match(button, /class="wb-activity-rail-btn"/);
  assert.match(button, /:data-wb-rail-id="item\.id"/);

  assert.match(i18n, /"shell\.activityRail":\s*"功能入口"/);
  assert.equal(ACTIVITY_RAIL_ENTRIES.length, 7);
});

test("activity rail badges reflect live counts, cap at 99+, and hide at zero", () => {
  const pending = ref(0);
  const rail = useActivityRail({ badges: { more: () => pending.value } });
  const entry = () => rail.moreItem.value;

  assert.equal(entry().badge, 0);
  assert.equal(entry().badgeText, "");
  assert.equal(entry().badgeLabel, "");

  pending.value = 3;
  assert.equal(entry().badge, 3);
  assert.equal(entry().badgeText, "3");
  assert.equal(entry().badgeLabel, "3 to review");

  pending.value = 140;
  assert.equal(entry().badge, 140);
  assert.equal(entry().badgeText, "99+");

  // Entries without a badge source stay badge-free.
  const quickOpen = rail.items.value.find((item) => item.id === "quickOpen");
  assert.equal(quickOpen.badge, 0);
  assert.equal(quickOpen.badgeText, "");

  const button = read("./components/WorkbenchActivityRailButton.vue");
  assert.match(button, /v-if="item\.badgeText"/);
  assert.match(button, /class="wb-activity-rail-badge"/);
  assert.match(button, /v-if="item\.badgeLabel"/);
});

test("old custom rail order drops entries that moved into the More menu", () => {
  const rail = useActivityRail({ storage: {
    getItem: () => JSON.stringify(["blackcatMcp", "releaseFlow", "configRelations", "quickOpen", "databaseFavorites", "backupCenter", "tableTransfer"]),
  } });
  assert.deepEqual(rail.items.value.map((item) => item.id), ["quickOpen", "databaseFavorites", "tableTransfer"]);
});

test("rail entry and update states react without rebuilding the rail", () => {
  const pressed = ref(false);
  const busy = ref(false);
  const rail = useActivityRail({ states: {
    quickOpen: () => ({ pressed: pressed.value, disabled: busy.value }),
    update: () => ({ busy: busy.value, label: busy.value ? "Checking" : "Updates" }),
  } });
  pressed.value = true;
  busy.value = true;
  assert.equal(rail.items.value.find((item) => item.id === "quickOpen").pressed, true);
  assert.equal(rail.items.value.find((item) => item.id === "quickOpen").disabled, true);
  assert.equal(rail.bottomItems.value[0].label, "Checking");
  assert.equal(rail.bottomItems.value[0].busy, true);
});

test("minimized release workspace docks directly above the updater button with live status", () => {
  const minimized = ref(false);
  const statusText = ref("2/7");
  const hint = ref("抖音 · Updating (2/7) — click to restore");
  let restored = 0;
  const rail = useActivityRail({
    states: {
      releaseFlow: () => (minimized.value
        ? { visible: true, busy: true, statusText: statusText.value, hint: hint.value, stateClass: { "is-release-running": true } }
        : { visible: false }),
    },
    actions: {
      releaseFlow: () => { restored += 1; minimized.value = false; },
    },
  });

  assert.deepEqual(rail.bottomItems.value.map((item) => item.id), ["update", "settings"]);

  minimized.value = true;
  assert.deepEqual(rail.bottomItems.value.map((item) => item.id), ["releaseFlow", "update", "settings"]);
  assert.equal(rail.bottomItems.value[0].statusText, "2/7");
  assert.equal(rail.bottomItems.value[0].busy, true);
  assert.equal(rail.bottomItems.value[0].hint, "抖音 · Updating (2/7) — click to restore");

  statusText.value = "Done";
  assert.equal(rail.bottomItems.value[0].statusText, "Done");

  rail.select("releaseFlow");
  assert.equal(restored, 1);
  assert.deepEqual(rail.bottomItems.value.map((item) => item.id), ["update", "settings"]);
});

test("release and relation review move to More while built-in chat is excluded from the product", () => {
  const workbench = read("MySqlWorkbench.vue");
  assert.match(workbench, /id: "releaseFlow", icon: Rocket/);
  assert.match(workbench, /id: "relations", icon: Link2[^\n]*badge: configRelationsBadge\.value/);
  assert.match(workbench, /id === "releaseFlow"\) openReleaseFlow\(\)/);
  assert.match(workbench, /id === "relations"\) openConfigRelationsReview\(\)/);
  // Table folders, the backup center, Blackcat MCP and the window pin live in
  // the More menu, not as rail buttons.
  assert.match(workbench, /id: "tableFolders", icon: FolderOpen/);
  assert.match(workbench, /id: "backupCenter", icon: ShieldCheck/);
  assert.match(workbench, /id: "blackcatMcp", icon: Plug/);
  assert.match(workbench, /id: "pinWindow", icon: Pin/);
  assert.match(workbench, /id === "tableFolders"\) openTableFolderPage\(\)/);
  assert.match(workbench, /id === "backupCenter"\) void openBackupCenter\(\)/);
  assert.match(workbench, /id === "blackcatMcp"\) openBlackcatMcp\(\)/);
  assert.match(workbench, /id === "pinWindow"\) void toggleWindowPin\(\)/);
  assert.doesNotMatch(read("./composables/useActivityRail.js"), /id: "(tableFolders|backupCenter|blackcatMcp|pinWindow)"/);
  assert.doesNotMatch(workbench, /AgentPanel|useAgent\b|useAgentProjects|toggleAiAssistant|handleAvailableRuntimeUpdate/);
  const config = JSON.parse(read("../../src-tauri/tauri.conf.json"));
  assert.ok(config.bundle.resources["resources/mcp-server.mjs"]);
  assert.equal(config.bundle.resources["resources/agent-runner.mjs"], undefined);
  assert.equal(config.bundle.resources["resources/agent-auth*.json"], undefined);
  assert.doesNotMatch(read("../../src-tauri/src/lib.rs"), /commands::agent_/);
});
