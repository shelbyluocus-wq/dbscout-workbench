import test from "node:test";
import assert from "node:assert/strict";
import { computed } from "vue";
import { readdirSync, readFileSync } from "node:fs";
import { createLanguageController, readLanguagePreference, LANGUAGE_STORAGE_KEY } from "./i18n/index.js";
import en from "./i18n/en.js";
import zhCN from "./i18n/zhCN.js";
import zhTW from "./i18n/zhTW.js";
import { localizedContractSource } from "./test-support/localizedContractSource.js";

function storage(values = {}) {
  const data = new Map(Object.entries(values));
  return { get length() { return data.size; }, key: (index) => [...data.keys()][index], getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test("fresh installs default to English; existing workbench preferences preserve Chinese", () => {
  assert.equal(readLanguagePreference(storage()), "en");
  assert.equal(readLanguagePreference(storage({ unrelated: "value" })), "en");
  assert.equal(readLanguagePreference(storage({ dbscout_theme: "dark" })), "zh-CN");
  assert.equal(readLanguagePreference(storage({ "dbscout.home.columns.v1": "{}" })), "zh-CN");
  assert.equal(readLanguagePreference(storage({ [LANGUAGE_STORAGE_KEY]: "en", dbscout_theme: "dark" })), "en");
  assert.equal(readLanguagePreference(storage({ [LANGUAGE_STORAGE_KEY]: "unsupported" })), "en");
});

test("language changes are reactive, persistent and limited to the supported languages", () => {
  const saved = storage();
  const controller = createLanguageController({ storage: saved });
  const key = Object.keys(en).find((key) => en[key] !== zhCN[key]);
  const label = computed(() => controller.t(key));
  assert.equal(label.value, en[key]);
  assert.equal(controller.setLanguage("zh-CN"), true);
  assert.equal(label.value, zhCN[key]);
  assert.equal(saved.getItem(LANGUAGE_STORAGE_KEY), "zh-CN");
  assert.equal(createLanguageController({ storage: saved }).locale.value, "zh-CN");
  assert.equal(controller.setLanguage("zh-TW"), true);
  assert.equal(label.value, zhTW[key]);
  assert.equal(controller.intlLocale.value, "zh-TW");
  assert.equal(saved.getItem(LANGUAGE_STORAGE_KEY), "zh-TW");
  assert.equal(createLanguageController({ storage: saved }).locale.value, "zh-TW");
  assert.equal(controller.setLanguage("bogus"), false);
  assert.equal(controller.locale.value, "zh-TW");
  assert.equal(controller.t("unrecognized-message"), "unrecognized-message");
});

test("blocked storage never blocks startup or in-memory switching", () => {
  const controller = createLanguageController({ storage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } } });
  assert.equal(controller.locale.value, "en");
  assert.equal(controller.setLanguage("zh-CN"), true);
  assert.equal(controller.locale.value, "zh-CN");
});

test("catalogs have matching keys and placeholders, and English messages contain no Han text", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zhCN).sort());
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zhTW).sort());
  assert.ok(Object.keys(en).length > 900);
  for (const [key, value] of Object.entries(en)) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim(), key);
    assert.doesNotMatch(value, /\p{Script=Han}/u, key);
    const placeholders = (text) => [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort();
    for (const catalog of [zhCN, zhTW]) {
      assert.equal(typeof catalog[key], "string", key);
      assert.ok(catalog[key].trim(), key);
      assert.deepEqual(placeholders(value), placeholders(catalog[key]), key);
    }
  }
});

test("every statically referenced template key exists in all three catalogs", () => {
  const root = new URL("./", import.meta.url);
  const files = [new URL("MySqlWorkbench.vue", root), ...readdirSync(new URL("components/", root)).filter((name) => name.endsWith(".vue")).map((name) => new URL(`components/${name}`, root))];
  for (const file of files) for (const match of readFileSync(file, "utf8").matchAll(/\bt\(['"]([a-zA-Z0-9_.-]+)['"]/g)) {
    assert.ok(Object.hasOwn(en, match[1]), `${file.pathname}: ${match[1]}`);
    assert.ok(Object.hasOwn(zhCN, match[1]), `${file.pathname}: ${match[1]}`);
    assert.ok(Object.hasOwn(zhTW, match[1]), `${file.pathname}: ${match[1]}`);
  }
});

test("source-contract helper expands explicit translations, not data expressions", () => {
  const key = Object.keys(zhCN)[0];
  assert.equal(localizedContractSource(`{{ t('${key}') }}`), zhCN[key]);
  assert.equal(localizedContractSource(`:title="t('${key}')"`), `title="${zhCN[key]}"`);
  assert.equal(localizedContractSource("{{ row.value }}"), "{{ row.value }}");
  assert.throws(() => localizedContractSource("{{ t('m_000000000000') }}"), /Missing localization key/);
});

test("Taiwan translations use regional terminology without changing interpolated user content", () => {
  const controller = createLanguageController({ storage: storage({ [LANGUAGE_STORAGE_KEY]: "zh-TW" }) });
  const check = (source, translated) => {
    const key = Object.keys(zhCN).find((key) => zhCN[key] === source);
    assert.ok(key, source);
    assert.equal(controller.t(key), translated);
  };
  check("连接数据库服务器", "連線資料庫伺服器");
  check("字段备注", "欄位備註");
  check("打开文件", "開啟檔案");
  check("系统默认", "系統預設");
  check("冻结首行", "凍結首列");
  check("冻结首列", "凍結首欄");
  check("单元格内容", "儲存格內容");
  check("导入", "匯入");
  check("导出当前表", "匯出目前表");
  assert.equal(controller.t("m_88ce9bfd24f4", { detail: "简体用户数据😀" }), "简体用户数据😀 · 正在開啟");
  assert.equal(controller.t("m_ff9c1fbf5115", { count: 120 }), "已載入全部 120 列");
});

test("shell tooltips, grid labels, stats and updater titles follow the selected language", async () => {
  const { updateTitle } = await import("./composables/useUpdater.js");
  const english = createLanguageController({ storage: storage({ [LANGUAGE_STORAGE_KEY]: "en" }) });
  assert.equal(updateTitle("idle", null, english.t), "Check for updates");
  assert.equal(updateTitle("available", { version: "0.2.0" }, english.t), "New version 0.2.0 available");
  assert.equal(updateTitle("idle"), "检查更新");
  assert.equal(english.t("shell.withShortcut", { action: english.t("shell.pinWindow"), shortcut: "F8" }), "Pin window (F8)");
  assert.equal(english.t("grid.sortColumn", { column: "id" }), "Sort id");
  assert.equal(english.t("selectionStats.sum"), "Sum");

  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const leaks = [
    ["./MySqlWorkbench.vue", /快速打开（|"钉住窗口"|"解除钉住"/],
    ["./components/CellDetailPanel.vue", /展开单元格内容|\{\{ item\.label \}\}|的备注（只读）/],
    ["./components/InspectorPanel.vue", /`长度 |定位到当前行的|定位到首行的/],
    ["./components/ColumnSortMenu.vue", /} 排序/],
    ["./components/AgentPanel.vue", /How can I help|"数据库上下文已接入"|"当前数据库"/],
    ["./components/DataGrid.vue", /} 数据网格`|列宽；|} 像素`|，点击清除`/],
    ["./components/WorkbenchSidebar.vue", /} 的表`|`流光颜色：/],
  ];
  for (const [path, pattern] of leaks) assert.doesNotMatch(read(path), pattern, path);
});
