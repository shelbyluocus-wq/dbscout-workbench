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

test("activity rail lists the action entries, then pins settings at the bottom", () => {
  const { items, bottomItems } = useActivityRail();
  assert.deepEqual(
    items.value.map((item) => item.id),
    ["addConnection", "quickOpen", "databaseFavorites", "backupCenter", "tableTransfer"],
  );
  assert.deepEqual(
    bottomItems.value.map((item) => item.id),
    ["settings"],
  );
});

test("activity rail entries expose icon components, translated labels, and separators", () => {
  const { items } = useActivityRail();
  for (const item of items.value) {
    assert.ok(["object", "function"].includes(typeof item.icon), `${item.id} should map to a lucide icon component`);
    assert.ok(item.label.length > 0, `${item.id} should have a translated label`);
    assert.ok(item.popup, `${item.id} should declare its popup surface for aria-haspopup`);
  }
  assert.equal(items.value[0].separatorBefore, false);
  assert.equal(items.value.find((item) => item.id === "quickOpen").separatorBefore, true);
});

test("activity rail entries carry a one-line tooltip hint", () => {
  const { items, bottomItems } = useActivityRail();
  const hints = Object.fromEntries([...items.value, ...bottomItems.value].map((item) => [item.id, item.hint]));
  assert.match(hints.quickOpen, /quick open/i);
  assert.equal(hints.databaseFavorites, "Switch to a favorite database");
  assert.match(hints.backupCenter, /snapshot|rollback/i);
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
    assert.equal(byId(rail.items.value).backupCenter.label, "備份中心");
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
    const zhCN = byId(rail.items.value);
    assert.equal(zhCN.backupCenter.label, "备份中心");
    assert.equal(zhCN.tableTransfer.label, "一键转表");
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
    const byId = Object.fromEntries(rail.items.value.map((item) => [item.id, item]));
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
    assert.equal(item.shortcutLabel, "Command+P");
    assert.equal(item.ariaShortcut, "Meta+P");
  });
});

test("activity rail reflects expanded state for popup entries", () => {
  const open = ref(false);
  const rail = useActivityRail({ expanded: { settings: () => open.value } });
  assert.equal(rail.bottomItems.value[0].expanded, false);
  open.value = true;
  assert.equal(rail.bottomItems.value[0].expanded, true);
  assert.equal(rail.bottomItems.value[0].controls, "wb-sidebar-settings-sheet");
  assert.equal(rail.items.value[0].expanded, undefined);
});

test("activity rail reorder moves entries and persists the order", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  const rail = useActivityRail({ storage });
  rail.reorder("tableTransfer", "addConnection", { position: "before" });
  assert.deepEqual(
    rail.items.value.map((item) => item.id),
    ["tableTransfer", "addConnection", "quickOpen", "databaseFavorites", "backupCenter"],
  );
  assert.equal(
    storage.getItem("dbscout_activity_rail_order"),
    JSON.stringify(["tableTransfer", "addConnection", "quickOpen", "databaseFavorites", "backupCenter"]),
  );

  // A fresh composable on the same storage restores the custom order.
  const restored = useActivityRail({ storage });
  assert.deepEqual(
    restored.items.value.map((item) => item.id),
    ["tableTransfer", "addConnection", "quickOpen", "databaseFavorites", "backupCenter"],
  );
});

test("activity rail order drops unknown ids and re-inserts missing entries at their default slot", () => {
  const storage = {
    getItem: () => JSON.stringify(["backupCenter", "goneEntry", "addConnection"]),
    setItem: () => {},
  };
  const { items } = useActivityRail({ storage });
  // Stored ids keep their relative order; missing defaults re-insert at their slot.
  assert.deepEqual(
    items.value.map((item) => item.id),
    ["backupCenter", "quickOpen", "databaseFavorites", "addConnection", "tableTransfer"],
  );
});

test("activity rail ignores corrupt or absent stored order", () => {
  for (const stored of ["{not json", "{}", '["settings"]', "123"]) {
    const rail = useActivityRail({
      storage: { getItem: () => stored, setItem: () => {} },
    });
    assert.deepEqual(
      rail.items.value.map((item) => item.id),
      ["addConnection", "quickOpen", "databaseFavorites", "backupCenter", "tableTransfer"],
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
  assert.match(rail, /v-for="\(item, index\) in previewItems"/);
  assert.match(rail, /class="wb-activity-rail-btn"/);
  assert.match(rail, /draggable="true"/);
  assert.match(rail, /@reorder="reorderActivityRailEntry"|emit\("reorder"/);
  assert.match(rail, /data-wb-rail-id/);
  assert.match(rail, /wb-activity-rail-bottom/);

  assert.match(i18n, /"shell\.activityRail":\s*"功能入口"/);
  assert.equal(ACTIVITY_RAIL_ENTRIES.length, 6);
});
