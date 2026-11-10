// Sample content for the release demo, grounded in the 決勝2 client (jswz,
// Cocos Creator 3.8.8, Android) and its config database. Read from the
// project: table and column names, item IDs, names and development open
// flags, platform names (buildopenplatprop), the working-copy layout under
// chengxu, the conversion script name, the build output, the QA release
// guard and the hot-update version format. Simulated: each platform's own
// database and folder, revisions, diffs and versions.
// Dates are relative to the update day so the demo stays current.

import { addDays, evaluatePlanRule, formatPlanDate, parsePlanNote, stateFlag } from "./releasePlanNotes.js";
import { DEMO_CONFIG_TABLES } from "./releaseFlowDemoTables.js";

export { DEMO_CONFIG_TABLES };

export const DEMO_SOURCE_DATABASE = "newsg_4cfg";
export const DEMO_WORKSPACE = "D:\\jswz\\chengxu";
export const DEMO_SOURCE_CLIENT = `${DEMO_WORKSPACE}\\client\\jswz`;
export const DEMO_COCOS_VERSION = "3.8.8";
export const DEMO_COCOS_PATH = `${DEMO_WORKSPACE}\\client\\creator3.8\\CocosCreator.exe`;
export const DEMO_TRANSFER_SCRIPT = `${DEMO_WORKSPACE}\\tool\\生成配置\\1-生成全部配置-客户端\\4区生成全部配置.bat`;
export const DEMO_BUILD_OUTPUT = "build\\android";
export const DEMO_BUNDLE_COUNT = 56;
export const DEMO_PROPS_COUNT = 487;
export const DEMO_REVISION = 52817;
export const DEMO_HOT_UPDATE = Object.freeze({ previous: "1.023", next: "1.024" });
export const DEMO_HOT_UPDATE_BYTES = 187_365_376;

// heroprop holds heroes, pets, spirits and mounts by ID range; OpenFlag 0 keeps
// one closed. Features open per platform in buildopenplatprop.IsOpen.
export const RELEASE_PLAN_CATEGORIES = Object.freeze([
  Object.freeze({ id: "hero", table: "heroprop", keyColumns: Object.freeze(["ID"]), flagColumn: "OpenFlag" }),
  Object.freeze({ id: "mount", table: "heroprop", keyColumns: Object.freeze(["ID"]), flagColumn: "OpenFlag" }),
  Object.freeze({ id: "spirit", table: "heroprop", keyColumns: Object.freeze(["ID"]), flagColumn: "OpenFlag" }),
  Object.freeze({ id: "pet", table: "heroprop", keyColumns: Object.freeze(["ID"]), flagColumn: "OpenFlag" }),
  Object.freeze({ id: "feature", table: "buildopenplatprop", keyColumns: Object.freeze(["BuildID", "Idx"]), flagColumn: "IsOpen" }),
]);

// Platform names as buildopenplatprop lists them.
export const DEMO_PLATFORM_IDS = Object.freeze(["douyin", "tap", "wanxin", "tw"]);
export const DEMO_DEFAULT_PLATFORM = "tw";
const PLATFORM_NAMES = Object.freeze({ douyin: "抖音", tap: "TAP", wanxin: "玩心", tw: "TW" });

// [key, name, development flag, seeds for 抖音 / TAP / 玩心 / TW]. A seed is
// ["o", day] (opens), ["r", from, to] (open range), ["c", day] (closes),
// "A" (already open), "N" (not yet), "?" (a note the parser cannot read) or
// "" (no note).
const PLAN_ITEMS = Object.freeze({
  hero: [
    [1059, "光铸战神", 1, ["A", "A", "A", "A"]],
    [1060, "魂劫先知", 1, ["A", "A", ["o", -14], "A"]],
    [1061, "红龙女王", 1, [["o", -21], ["o", -21], ["o", -7], ["o", 0]]],
    [1062, "闪耀羽月", 1, [["o", -14], ["o", -14], ["o", 0], ["o", 7]]],
    [1063, "月夜星光", 1, [["o", -7], ["o", -7], ["o", 7], ["o", 14]]],
    [1065, "永夜魅影", 0, [["o", 7], ["o", 7], "N", "N"]],
    [1066, "星灵圣曦", 0, [["o", 21], ["o", 21], "N", "N"]],
    [1075, "暮光青铜", 0, ["N", "N", "N", "N"]],
  ],
  mount: [
    [6503, "晶盾战犀", 1, ["A", "A", "A", "A"]],
    [6504, "圣霜灵犀", 1, ["A", "A", "A", "A"]],
    [6505, "不死无敌", 1, [["o", -10], ["o", -10], ["o", 3], ["o", 0]]],
    [6506, "圣独角兽", 1, [["o", -10], ["o", -10], ["o", 3], ["o", 0]]],
    [6517, "狂雷狮鹫", 1, [["o", -3], ["o", -3], ["o", 14], ["o", 14]]],
    [6605, "虚空梦魇", 0, [["o", 14], ["o", 14], "N", "N"]],
    [6606, "天穹星骓", 0, ["?", "", "N", "N"]],
  ],
  spirit: [
    [5503, "帝王镜影", 1, ["A", "A", "A", "A"]],
    [5505, "大地镜影", 1, [["o", -12], ["o", -12], ["o", -5], ["o", -5]]],
    [5511, "雷霆镜影", 1, [["o", -5], ["o", -5], ["o", 9], ["o", 9]]],
    [5517, "炎魔镜影", 1, [["o", 2], ["o", 2], "N", "N"]],
    [5605, "无限大地", 0, [["o", 28], ["o", 28], "N", "N"]],
    [5611, "愤怒雷霆", 0, ["N", "N", "N", "?"]],
  ],
  pet: [
    [5401, "生命灵主", 1, ["A", "A", "A", "A"]],
    [5402, "灵魂灵主", 1, ["A", "A", "A", "A"]],
    [5411, "闪电灵主", 1, [["o", -20], ["o", -20], ["o", -6], ["o", -6]]],
    [5412, "风息灵主", 1, [["o", -20], ["o", -20], ["o", 0], ["o", 0]]],
    [5417, "烈焰灵主", 1, [["o", -4], ["o", -4], ["o", 11], ["o", 11]]],
    [5418, "纯水灵主", 1, [["o", -4], ["o", -4], ["o", 11], ["o", 11]]],
    [5400, "隐士灵主-SSR", 0, ["N", "N", "N", "N"]],
  ],
  feature: [
    [{ BuildID: 10, Idx: 100 }, "养成积分", 0, ["N", "N", "N", "N"]],
    [{ BuildID: 81, Idx: 100 }, "坐骑重生", 0, ["N", "N", "N", ["o", 7]]],
    [{ BuildID: 82, Idx: 100 }, "战宠重生", 0, ["N", "N", "N", "N"]],
    [{ BuildID: 83, Idx: 100 }, "祭灵重生", 1, ["A", "A", "A", "A"]],
    [{ BuildID: 117, Idx: 100 }, "装备强化", 1, ["A", "A", "A", "A"]],
    [{ BuildID: 134, Idx: 100 }, "玩具强化", 1, ["N", "N", "N", "N"]],
    [{ BuildID: 197, Idx: 100 }, "高阶恶魔入侵", 1, ["N", "N", "N", "N"]],
  ],
});

function itemId(category, key) {
  return `${category}-${typeof key === "object" ? Object.values(key).join("-") : key}`;
}

export const RELEASE_PLAN_ITEMS = Object.freeze(
  RELEASE_PLAN_CATEGORIES.flatMap((category) =>
    PLAN_ITEMS[category.id].map(([key, name, devFlag, seeds]) => Object.freeze({
      id: itemId(category.id, key),
      category: category.id,
      key: typeof key === "object" ? Object.freeze(key) : key,
      name,
      devFlag,
      seeds: Object.freeze(Object.fromEntries(DEMO_PLATFORM_IDS.map((platform, index) => [platform, seeds[index]]))),
    })),
  ),
);

/** "1061", or "117 · 100" for a composite key. */
export function planItemKeyLabel(item) {
  return typeof item.key === "object" ? Object.values(item.key).join(" · ") : String(item.key);
}

function seedNote(seed, dateIso, translate) {
  if (seed === "A") return translate("releaseFlow.note.always");
  if (seed === "N") return translate("releaseFlow.note.never");
  if (seed === "?") return translate("releaseFlow.note.pendingArt");
  if (!Array.isArray(seed)) return "";
  const date = (offset) => formatPlanDate(addDays(dateIso, offset), dateIso);
  if (seed[0] === "r") return translate("releaseFlow.note.range", { from: date(seed[1]), to: date(seed[2]) });
  if (seed[0] === "c") return translate("releaseFlow.note.close", { date: date(seed[1]) });
  return translate("releaseFlow.note.open", { date: date(seed[1]) });
}

/** itemId -> platformId -> note, written in the current language. */
export function createDemoNotes(dateIso, translate) {
  const notes = {};
  for (const item of RELEASE_PLAN_ITEMS) {
    notes[item.id] = {};
    for (const platform of DEMO_PLATFORM_IDS) notes[item.id][platform] = seedNote(item.seeds[platform], dateIso, translate);
  }
  return notes;
}

// The open-plan memo groups its entries like the plan tables do, plus a free
// group for anything else the team wants to remember.
export const PLAN_MEMO_CATEGORIES = Object.freeze([...RELEASE_PLAN_CATEGORIES.map((category) => category.id), "other"]);

/**
 * The open-plan memo as first seeded: the items above with every platform's
 * note in the current language. From then on the memo belongs to the person;
 * nothing is read from a table again.
 */
export function createDemoPlanItems(dateIso, translate) {
  const notes = createDemoNotes(dateIso, translate);
  return RELEASE_PLAN_ITEMS.map((item) => ({
    id: item.id,
    category: item.category,
    name: item.name,
    ref: planItemKeyLabel(item),
    devFlag: item.devFlag,
    notes: { ...notes[item.id] },
  }));
}

/**
 * The database key a memo entry names, or null when it cannot be written:
 * "other" entries, entries without an ID, or a feature without both its
 * BuildID and Idx.
 */
export function planEntryKey(entry) {
  const category = RELEASE_PLAN_CATEGORIES.find((candidate) => candidate.id === entry?.category);
  if (!category) return null;
  const numbers = String(entry.ref ?? "").match(/\d+/g) || [];
  if (numbers.length !== category.keyColumns.length) return null;
  if (numbers.length === 1) return Number(numbers[0]);
  return Object.fromEntries(category.keyColumns.map((column, index) => [column, Number(numbers[index])]));
}

export function createDemoPlatforms() {
  return DEMO_PLATFORM_IDS.map((id) => ({
    id,
    name: PLATFORM_NAMES[id],
    sourceDatabase: DEMO_SOURCE_DATABASE,
    targetDatabase: `newsg_${id}_cfg`,
    sourceClient: DEMO_SOURCE_CLIENT,
    targetClient: `D:\\jswz\\release\\${id}\\jswz`,
    transferTemplateId: "juesheng-2",
    cocosVersion: DEMO_COCOS_VERSION,
    cocosPath: DEMO_COCOS_PATH,
    buildPlatform: "android",
    buildConfig: "",
    buildOutputName: "",
    buildDebug: false,
    buildMd5Cache: true,
    buildQaGuard: true,
  }));
}

/**
 * The flag a platform database holds before the plan is written. A synced
 * table carries the development value; a kept table still reflects the
 * platform's plan as of last week.
 */
export function demoDatabaseFlag(item, { synced, note, dateIso }) {
  if (synced) return item.devFlag;
  const lastWeek = addDays(dateIso, -7);
  return stateFlag(evaluatePlanRule(parsePlanNote(note, lastWeek), lastWeek).state) ?? 0;
}

// Tables each platform keeps for itself.
export const DEMO_SYNC_EXCLUSIONS = Object.freeze(["platspecfgtable", "conditionplatprop"]);

// The client's own .gitignore, then files that look platform-specific: server
// settings, hot-update manifests and the channel SDK.
export const DEMO_PROJECT_IGNORES = Object.freeze([
  "library/", "temp/", "local/", "build/", "output/", "outputs/", "tmp/",
  "profiles/", "native/", ".creator/", "extensions/", "keystore/", "node_modules/",
]);
export const DEMO_PLATFORM_FILES = Object.freeze([
  "assets/config/Config.ts",
  "assets/resources/project.manifest",
  "assets/resources/version.manifest",
  "assets/src/channelSdk/channel/",
]);
export const DEMO_FILE_EXCLUSIONS = Object.freeze([...DEMO_PROJECT_IGNORES, ...DEMO_PLATFORM_FILES]);

// What the development client changes compared with a platform client.
export const DEMO_CLIENT_CHANGES = Object.freeze([
  ["M", "assets/src/modules/hero/HeroMgr.ts"],
  ["M", "assets/src/modules/mount/MountMgr.ts"],
  ["M", "assets/src/modules/pet/PetMgr.ts"],
  ["M", "assets/src/modules/altar/AltarMgr.ts"],
  ["M", "assets/src/modules/activity/ActivityMgr.ts"],
  ["M", "assets/bundles/sacSpirit/prefab/sacSpiritArtifactUI.prefab"],
  ["M", "assets/bundles/sacSpirit/prefab/sacSpiritCultivateScene.prefab"],
  ["A", "assets/bundles/activity/P5/npc_1034.png"],
  ["A", "assets/bundles/activity/P5/npc_1034.png.meta"],
  ["D", "assets/bundles/activity/P0/4.png"],
  ["D", "assets/bundles/activity/P0/4.png.meta"],
  ["M", "settings/v2/packages/builder.json"],
  ["M", "project/android/engine/android/app/build.gradle"],
  ["M", "assets/src/channelSdk/channel/DgSdk.ts"],
  ["M", "assets/config/Config.ts"],
  ["M", "assets/resources/project.manifest"],
  ["M", "assets/resources/version.manifest"],
  ["M", "library/imports/3a/3a1f0c2e.json"],
  ["M", "temp/asset-db/assets.json"],
  ["M", "build/android/data/main.js"],
  ["M", "profiles/v2/packages/scene.json"],
  ["M", ".svn/wc.db"],
].map(([status, path]) => Object.freeze({ status, path })));

// `svn update` on the platform client; the two platform-specific files
// conflict when the demo asks for conflicts.
export const DEMO_SVN_UPDATES = Object.freeze([
  ["U", "assets\\props\\props\\heroprop.json"],
  ["U", "assets\\props\\props\\delayopenzoneprop.json"],
  ["U", "assets\\props\\propsH5\\props.bin"],
  ["U", "assets\\src\\props\\propDataDefine.ts"],
  ["U", "assets\\src\\modules\\mount\\MountMgr.ts"],
  ["U", "assets\\bundles\\sacSpirit\\prefab\\sacSpiritCultivateScene.prefab"],
  ["A", "assets\\bundles\\activity\\P5\\npc_1033.png"],
  ["A", "assets\\bundles\\activity\\P5\\npc_1033.png.meta"],
  ["C", "assets\\config\\Config.ts"],
  ["C", "assets\\resources\\version.manifest"],
].map(([action, path]) => Object.freeze({ action, path })));

// Config sheets named in the conversion log (it exports all of them).
export const DEMO_TRANSFER_SHEETS = Object.freeze([
  "heroprop", "delayopenzoneprop", "buildopenplatprop", "buildopenzoneprop", "mountstarprop",
  "petstarprop", "sacspiritstarprop", "altardrawprop", "giftoptionalprop", "achievementprop",
]);

function hunk(text) {
  return text.trim().split("\n").map((line) => line.replace(/^\s{4}/, ""));
}

// The working-copy diff after copying and converting. Binary files carry no
// lines; the viewer says so.
export const DEMO_DIFF_FILES = Object.freeze([
  {
    status: "M", path: "assets/props/props/heroprop.json", added: 1, removed: 1,
    lines: hunk(`
    @@ -2002,7 +2002,7 @@
         "PosiDesc": "后排范围法师。主动烈焰冲击在命中多个目标时追加伤害，被动连续落下三波陨石雨；觉醒使主动技附加持续伤害，专武进一步追加并强化巨型陨石。",
         "BakDesc": "希格德希尔是守护生命与秩序的红龙女王。巨龙黄昏中，龙族叛徒以古神低语撕裂守护契约，她被重伤囚禁数百年，却仍在封印中压住足以焚毁大陆的龙怒，不让族人因复仇向凡俗世界开战。脱困后，她的力量已被虚空污染，只能沉入圣所，以长眠一点点净化伤痕。即便无法展翼，希格德希尔仍通过残存契约守护世界树与众生，等待有一天重新飞上天空，而不是把天空烧成灰烬。",
         "MapPingID": 0,
    -    "OpenFlag": 0,
    +    "OpenFlag": 1,
         "Star": 5,
         "ClipItemID": 21061,
         "Quality": 5,
    `),
  },
  {
    status: "M", path: "assets/props/props/buildopenplatprop.json", added: 1, removed: 1,
    lines: hunk(`
    @@ -113,7 +113,7 @@
         "BuildID": 197,
         "Idx": 100,
         "Name": "高阶恶魔入侵",
    -    "IsOpen": 1,
    +    "IsOpen": 0,
         "Plat1": "",
         "Plat2": "",
         "Plat3": "",
    `),
  },
  {
    status: "M", path: "assets/props/props/delayopenzoneprop.json", added: 7, removed: 0,
    lines: hunk(`
    @@ -19,6 +19,13 @@
         "EndZone": 9999,
         "AfterDay": 9,
         "Group": 1005
    +  },
    +  {
    +    "ID": 1064,
    +    "StartZone": 1,
    +    "EndZone": 9999,
    +    "AfterDay": 9,
    +    "Group": 1005
       },
       {
         "ID": 1065,
    `),
  },
  {
    status: "M", path: "assets/src/modules/hero/HeroMgr.ts", added: 1, removed: 1,
    lines: hunk(`
    @@ -177,7 +177,7 @@
             let heroprops: heropropData[] = g_PropMgr.getProp(__Prop__.heroprop) as any;
             for (let i = 0; i < heroprops.length; i++) {
                 const prop = heroprops[i];
    -            if(this.getIsHeroID(prop.ID) && !prop.IsNpc){
    +            if(this.getIsHeroID(prop.ID) && prop.OpenFlag && !prop.IsNpc){
                     if (this._ownedHeros.has(prop.ID)) {
                         continue;
                     }
    `),
  },
  { status: "M", path: "assets/props/propsH5/props.bin", added: 0, removed: 0, binary: true, lines: [] },
  { status: "A", path: "assets/bundles/activity/P5/npc_1034.png", added: 0, removed: 0, binary: true, lines: [] },
  { status: "D", path: "assets/bundles/activity/P0/4.png", added: 0, removed: 0, binary: true, lines: [] },
].map((file) => Object.freeze(file)));

// What a Cocos Creator 3.x command-line Android build prints, with the
// progress reached after each line.
export const DEMO_COCOS_LOG = Object.freeze([
  ["Cocos Creator {version} · command-line build", 0.02],
  ["Open project: {project}", 0.05],
  ["Start building with platform=android, debug=false, md5Cache=true", 0.08],
  [`[Build] Query ${DEMO_BUNDLE_COUNT} asset bundles: main, resources, internal, activity, sacSpirit …`, 0.14],
  ["[Build] Compile scripts (TypeScript → JavaScript) …", 0.24],
  ["[Build] Compile scripts done", 0.38],
  ["[Build] Pack assets 4,212 / 9,630", 0.5],
  ["[Build] Pack assets 9,630 / 9,630", 0.64],
  ["[Build] Compress textures (astc_6x6) …", 0.74],
  ["[Build] Write build/android/data", 0.84],
  ["[Build] Generate build/android/proj/cfg.cmake", 0.9],
  ["Build success", 0.93],
]);

export const DEMO_COCOS_FAILURE_LOG = Object.freeze([
  "[Error] Asset db://assets/bundles/sacSpirit/prefab/sacSpiritArtifactUI.prefab references a missing script",
  "[Error] Build failed: 1 error(s)",
]);

// The client's release guard (npm run qa:release) looks for these markers.
export const DEMO_QA_MARKERS = Object.freeze(["JSWZQAToolkit", "JSWZErrorReporter", "qa-bridge.json", "com/jswz/qa/QAMemoryBridge"]);
