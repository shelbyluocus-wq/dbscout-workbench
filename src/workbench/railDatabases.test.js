import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";

import {
  RAIL_AUTO_COLOR_ORDER,
  RAIL_DATABASE_COLORS,
  RAIL_DATABASE_ICON_IDS,
  RAIL_INK_DARK,
  RAIL_INK_LIGHT,
  autoRailColor,
  deriveRailMonogram,
  isCompactRailText,
  nextRailColor,
  normalizeRailColor,
  normalizeRailIcon,
  normalizeRailText,
  railDatabaseId,
  readableInkOn,
} from "./utils/railDatabaseGlyph.js";
import {
  RAIL_DATABASE_ICON_COMPONENTS,
  railDatabaseIconComponent,
} from "./components/railDatabaseIcons.js";
import { databaseDecorationIconComponent } from "./components/databaseDecorationIcons.js";
import { useRailDatabases } from "./composables/useRailDatabases.js";
import { setPinnedDatabaseShortcut } from "./utils/pinnedDatabases.js";
import en from "./i18n/en.js";
import zhCN from "./i18n/zhCN.js";
import zhTW from "./i18n/zhTW.js";

test("deriveRailMonogram prefers the first digit run, then Han, then initials", () => {
  const cases = {
    newsg_20cfg: "20",
    newsg_4actcfg: "4",
    plat_ad_101_actcfg: "101",
    test_a20_activity_20261029104415_actcfg: "20",
    rcd4test: "4",
    cfg: "Cf",
    emaptoolserv: "Em",
    "plat tap": "PT",
    测试服: "测试",
    "": "DB",
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(deriveRailMonogram(input), expected, input);
  }
});

test("normalizeRailText strips whitespace and clips by script width", () => {
  assert.equal(normalizeRailText("abcd"), "abc");
  assert.equal(normalizeRailText(" a b "), "ab");
  assert.equal(normalizeRailText("测试服"), "测试");
  assert.equal(normalizeRailText("a测b"), "a测");
  assert.equal(normalizeRailText("  "), "");
  assert.equal(normalizeRailText(null), "");
});

test("normalizeRailIcon and normalizeRailColor only keep valid values", () => {
  assert.equal(normalizeRailIcon("rocket"), "rocket");
  assert.equal(normalizeRailIcon("Rocket "), "rocket");
  assert.equal(normalizeRailIcon("dragon"), "");
  assert.equal(normalizeRailIcon(""), "");
  assert.equal(normalizeRailColor("#C2410C"), "#c2410c");
  assert.equal(normalizeRailColor("red"), "");
  assert.equal(normalizeRailColor("#12345"), "");
  assert.equal(normalizeRailColor(""), "");
});

test("isCompactRailText flags long or wide glyphs", () => {
  assert.equal(isCompactRailText("abc"), true);
  assert.equal(isCompactRailText("ab"), false);
  assert.equal(isCompactRailText("测试"), true);
  assert.equal(isCompactRailText("a测"), true);
  assert.equal(isCompactRailText("A"), false);
});

function channelLuminance(value) {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channelLuminance((value >> 16) & 255)
    + 0.7152 * channelLuminance((value >> 8) & 255)
    + 0.0722 * channelLuminance(value & 255)
  );
}

function contrast(first, second) {
  const [high, low] = luminance(first) > luminance(second)
    ? [luminance(first), luminance(second)]
    : [luminance(second), luminance(first)];
  return (high + 0.05) / (low + 0.05);
}

test("readableInkOn picks an ink readable on every palette color and edge cases", () => {
  for (const color of [...RAIL_DATABASE_COLORS, "#ffff00", "#000000", "#ffffff", "#808080"]) {
    const ink = readableInkOn(color);
    assert.ok([RAIL_INK_LIGHT, RAIL_INK_DARK].includes(ink), `${color} -> ${ink}`);
    const ratio = contrast(ink, color);
    const other = ink === RAIL_INK_LIGHT ? RAIL_INK_DARK : RAIL_INK_LIGHT;
    assert.ok(ratio >= contrast(other, color), `${color} should use the higher-contrast ink`);
    assert.ok(ratio >= 4.45, `${color} -> ${ink} contrast ${ratio.toFixed(2)}`);
  }
  assert.equal(readableInkOn("not-a-color"), RAIL_INK_LIGHT);
});

test("the auto color order is a brand-first permutation of the palette", () => {
  assert.equal(RAIL_AUTO_COLOR_ORDER.length, RAIL_DATABASE_COLORS.length);
  assert.deepEqual(
    [...RAIL_AUTO_COLOR_ORDER].sort(),
    [...RAIL_DATABASE_COLORS].sort(),
  );
  assert.equal(RAIL_AUTO_COLOR_ORDER[0], "#0f766e");
});

test("nextRailColor picks the first unused palette color and falls back deterministically", () => {
  assert.equal(nextRailColor([], "any"), RAIL_AUTO_COLOR_ORDER[0]);
  assert.equal(nextRailColor([RAIL_AUTO_COLOR_ORDER[0].toUpperCase()], "any"), RAIL_AUTO_COLOR_ORDER[1]);
  assert.equal(
    nextRailColor(RAIL_AUTO_COLOR_ORDER.slice(0, 3), "any"),
    RAIL_AUTO_COLOR_ORDER[3],
  );
  assert.equal(nextRailColor(RAIL_DATABASE_COLORS, "stable-id"), autoRailColor("stable-id"));
});

test("rail icon registry covers exactly the 40 curated ids with matching labels", () => {
  assert.equal(RAIL_DATABASE_ICON_IDS.length, 40);
  assert.equal(new Set(RAIL_DATABASE_ICON_IDS).size, 40);
  assert.deepEqual(
    Object.keys(RAIL_DATABASE_ICON_COMPONENTS).sort(),
    [...RAIL_DATABASE_ICON_IDS].sort(),
  );
  for (const id of RAIL_DATABASE_ICON_IDS) {
    assert.ok(railDatabaseIconComponent(id), id);
    for (const catalog of [en, zhCN, zhTW]) {
      assert.ok(catalog[`railDatabase.icon.${id}`], `${id} missing a label`);
    }
  }
  assert.equal(railDatabaseIconComponent("nope"), null);
  for (const id of ["database", "boxes", "shield", "flask", "rocket", "archive", "star", "cloud"]) {
    assert.equal(railDatabaseIconComponent(id), databaseDecorationIconComponent(id), id);
  }
});

let store;

beforeEach(() => {
  store = {};
  globalThis.localStorage = {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = value; },
  };
});

function makeRail({ connections = null, decorations = {}, aliases = {}, current = {} } = {}) {
  const pinnedDatabases = ref([]);
  const connectionList = ref(connections ?? [
    { id: "c1", label: "Alpha", connected: true },
    { id: "c2", label: "Beta", connected: false },
  ]);
  const notes = [];
  const rail = useRailDatabases({
    pinnedDatabases,
    connections: connectionList,
    currentSource: () => current,
    databaseLabel: (connectionId, database) => aliases[`${connectionId}/${database}`] || "",
    connectionLabel: (connectionId, fallback) => fallback,
    getDatabaseDecoration: (connectionId, database) => decorations[`${connectionId}/${database}`] || null,
    translate: (key, params = {}) => `${key}|${JSON.stringify(params)}`,
    notify: (message) => notes.push(message),
  });
  return { rail, pinnedDatabases, notes };
}

test("pinning adds a rail favorite with a free palette color and a text monogram", () => {
  const { rail, pinnedDatabases, notes } = makeRail();

  assert.equal(rail.pin({ connectionId: "c1", database: "game_db" }).ok, true);
  assert.equal(pinnedDatabases.value.length, 1);
  const entry = pinnedDatabases.value[0];
  assert.equal(entry.rail, true);
  assert.equal(entry.railColor, "#0f766e");
  assert.equal(notes[0], 'railDatabase.pinned|{"name":"game_db"}');

  assert.equal(rail.pin({ connectionId: "c1", database: "other_db" }).ok, true);
  const [first, second] = rail.items.value;
  assert.equal(second.color, "#2563eb");
  assert.notEqual(first.color, second.color);
  assert.equal(first.glyph.kind, "text");
  assert.equal(first.glyph.text, "GD");

  const duplicate = rail.pin({ connectionId: "c1", database: "game_db" });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.existed, true);
  assert.equal(notes.at(-1), 'railDatabase.alreadyPinned|{"name":"game_db"}');

  assert.equal(rail.pin({}).ok, false);
});

test("the alias-aware label drives the monogram and decorations win over it", () => {
  const { rail } = makeRail({
    aliases: { "c1/prod_db": "生产服2026" },
    decorations: {
      "c1/prod_db": { icon: "rocket", color: "#c2410c", textColor: "" },
      "c1/plain_db": { icon: "database", color: "", textColor: "" },
    },
  });

  rail.pin({ connectionId: "c1", database: "prod_db" });
  const decorated = rail.items.value[0];
  assert.equal(decorated.label, "生产服2026");
  assert.equal(decorated.realName, "prod_db");
  assert.equal(decorated.glyph.kind, "icon");
  assert.equal(decorated.glyph.id, "rocket");
  assert.equal(decorated.glyph.icon, railDatabaseIconComponent("rocket"));
  assert.equal(decorated.color, "#c2410c");
  assert.equal(decorated.custom.color, "");

  rail.pin({ connectionId: "c1", database: "plain_db" });
  const plain = rail.items.value[1];
  assert.equal(plain.glyph.kind, "text");
  assert.equal(plain.glyph.text, "PD");
});

test("appearance overrides and reset restore the automatic look", () => {
  const { rail, pinnedDatabases } = makeRail();
  rail.pin({ connectionId: "c1", database: "game_db" });
  rail.pin({ connectionId: "c1", database: "other_db" });
  const target = { connectionId: "c1", database: "game_db" };

  rail.setAppearance({ ...target, icon: "rocket" });
  assert.equal(rail.items.value[0].glyph.kind, "icon");
  assert.equal(rail.items.value[0].glyph.id, "rocket");

  rail.setAppearance({ ...target, text: "AB" });
  assert.equal(rail.items.value[0].glyph.kind, "text");
  assert.equal(rail.items.value[0].glyph.text, "AB");
  assert.equal(pinnedDatabases.value[0].railIcon, undefined);

  rail.setAppearance({ ...target, color: "#be123c" });
  assert.equal(rail.items.value[0].color, "#be123c");
  assert.equal(rail.items.value[0].ink, readableInkOn("#be123c"));

  rail.resetAppearance(target);
  const reset = rail.items.value[0];
  assert.equal(reset.glyph.kind, "text");
  assert.equal(reset.glyph.text, "GD");
  assert.ok(RAIL_DATABASE_COLORS.includes(reset.color));
  assert.notEqual(reset.color, rail.items.value[1].color);
});

test("current, disconnected and missing states resolve the matching hint", () => {
  const { rail, pinnedDatabases } = makeRail({
    current: { connectionId: "c1", database: "game_db" },
  });
  rail.pin({ connectionId: "c1", database: "game_db" });
  rail.pin({ connectionId: "c2", database: "idle_db" });
  rail.pin({ connectionId: "gone", database: "lost_db" });

  const [current, disconnected, missing] = rail.items.value;
  assert.equal(current.current, true);
  assert.match(current.hint, /^railDatabase\.currentHint/);
  assert.equal(disconnected.disconnected, true);
  assert.equal(disconnected.current, false);
  assert.match(disconnected.hint, /^railDatabase\.disconnectedHint/);
  assert.equal(missing.missing, true);
  assert.equal(missing.hint, "railDatabase.missingHint|{}");

  pinnedDatabases.value = setPinnedDatabaseShortcut("c2", "idle_db", "Ctrl+2", pinnedDatabases.value);
  assert.equal(rail.unpin({ connectionId: "c2", database: "idle_db" }).ok, true);
  const kept = pinnedDatabases.value.find((entry) => entry.database === "idle_db");
  assert.equal(kept.rail, undefined);
  assert.equal(kept.shortcut, "Ctrl+2");
  assert.equal(rail.isOnRail("c2", "idle_db"), false);
});

test("reorder moves a tile before or after its neighbor", () => {
  const { rail } = makeRail();
  rail.pin({ connectionId: "c1", database: "one" });
  rail.pin({ connectionId: "c1", database: "two" });
  rail.pin({ connectionId: "c1", database: "three" });
  const [one, , three] = rail.items.value;

  rail.reorder(one.id, three.id, { position: "after" });
  assert.deepEqual(rail.items.value.map((item) => item.database), ["two", "three", "one"]);

  rail.reorder(railDatabaseId("c1", "one"), railDatabaseId("c1", "two"), { position: "before" });
  assert.deepEqual(rail.items.value.map((item) => item.database), ["one", "two", "three"]);
});

test("treats runtime-id rail tiles as reconnectable disconnected tiles when saved placeholders are pending restore", () => {
  const { rail } = makeRail({
    connections: [
      { id: "saved-mysql:192.168.1.223:8306:root", label: "root@192.168.1.223:8306", saved: true, connected: false },
      { id: "saved-mysql:192.168.1.243:8306:root", label: "root@192.168.1.243:8306", saved: true, connected: false },
    ],
  });
  rail.pin({ connectionId: "mysql-2", database: "newsg_4cfg" });
  const [tile] = rail.items.value;
  assert.equal(tile.missing, false);
  assert.equal(tile.disconnected, true);
  assert.match(tile.hint, /^railDatabase\.disconnectedHint/);
});
