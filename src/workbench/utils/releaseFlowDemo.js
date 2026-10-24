// Sample content for the release-flow demo: three platforms, the open plans
// of five content kinds, and what SVN, the file copy, table conversion, the
// diff and a Cocos build would report. Item names follow the interface
// language; seeded notes and platform names become the user's own data once
// saved. Dates are relative to the update date so the demo always looks
// current.

import { addDays, evaluatePlanRule, formatPlanDate, parsePlanNote, stateFlag } from "./releasePlanNotes.js";
import { defaultCocosEditorPath } from "./cocosBuildCommand.js";

export const DEMO_SOURCE_DATABASE = "game_config_dev";
export const DEMO_SOURCE_CLIENT = "D:\\client\\jswz";
export const DEMO_COCOS_VERSION = "3.8.8";
export const DEMO_REVISION = 48213;

// Each kind of planned content maps to the table and switch column a write
// updates. The key column identifies the row.
export const RELEASE_PLAN_CATEGORIES = Object.freeze([
  Object.freeze({ id: "hero", table: "hero", keyColumn: "ID", flagColumn: "IsOpen" }),
  Object.freeze({ id: "mount", table: "mount", keyColumn: "ID", flagColumn: "IsOpen" }),
  Object.freeze({ id: "spirit", table: "spirit", keyColumn: "ID", flagColumn: "IsOpen" }),
  Object.freeze({ id: "pet", table: "battle_pet", keyColumn: "ID", flagColumn: "IsOpen" }),
  Object.freeze({ id: "feature", table: "function_open", keyColumn: "ID", flagColumn: "IsOpen" }),
]);

const LOCALE_INDEX = Object.freeze({ en: 0, "zh-CN": 1, "zh-TW": 2 });

// [key, [en, zh-CN, zh-TW], seeds for cn / tw / sea]. A seed is ["o", day]
// (opens), ["r", from, to] (open range), ["c", day] (closes), "A" (already
// open), "N" (not yet), "?" (a note the parser cannot read) or "" (no note).
const PLAN_ITEMS = Object.freeze({
  hero: [
    [1012, ["Ember Valkyrie", "赤焰·炎姬", "赤焰·炎姬"], [["o", -40], ["o", -12], ["o", 5]]],
    [1013, ["Frost Kite", "霜翎·雪鸢", "霜翎·雪鳶"], [["o", -20], ["o", 0], "N"]],
    [1014, ["Iron Warden", "玄甲·镇岳", "玄甲·鎮岳"], ["A", "A", "A"]],
    [1015, ["Azure Phoenix", "青鸾", "青鸞"], [["o", -3], ["o", 4], "N"]],
    [1016, ["Yaksha", "夜叉", "夜叉"], [["o", 0], ["o", 11], ["o", 25]]],
    [1017, ["Thunder Monk", "雷音", "雷音"], [["r", -60, -30], ["r", -7, 20], "A"]],
    [1018, ["Bai Ze", "白泽", "白澤"], ["N", "N", "N"]],
    [1019, ["Nine Tails", "九尾", "九尾"], [["o", 14], "?", ""]],
  ],
  mount: [
    [2001, ["Snowtread Steed", "踏雪乌骓", "踏雪烏騅"], ["A", "A", "A"]],
    [2002, ["Red Hare", "赤兔", "赤兔"], [["o", -5], ["o", 0], ["o", 9]]],
    [2003, ["Black Tortoise", "玄龟", "玄龜"], [["o", 2], ["o", 2], "N"]],
    [2004, ["Cloud Qilin", "云麒麟", "雲麒麟"], ["A", ["o", -30], ["o", -2]]],
    [2005, ["Feilian", "飞廉", "飛廉"], ["N", "N", "N"]],
  ],
  spirit: [
    [3001, ["Zhulong", "烛龙", "燭龍"], ["A", ["o", -21], ["o", -1]]],
    [3002, ["Goumang", "句芒", "句芒"], [["o", -14], ["o", -3], ["o", 6]]],
    [3003, ["Zhurong", "祝融", "祝融"], [["o", 0], ["o", 7], "N"]],
    [3004, ["Gonggong", "共工", "共工"], [["r", -10, 10], ["r", 0, 13], ["r", 3, 17]]],
    [3005, ["Houtu", "后土", "后土"], ["N", "N", "N"]],
  ],
  pet: [
    [4001, ["Fire Fox", "火狐", "火狐"], ["A", "A", "A"]],
    [4002, ["Storm Hawk", "雷鹰", "雷鷹"], [["o", -8], ["o", -1], ["o", 12]]],
    [4003, ["Stone Sprite", "石灵", "石靈"], [["o", 3], ["o", 3], ["o", 3]]],
    [4004, ["Ice Moth", "冰蝶", "冰蝶"], [["o", -2], ["o", 6], "N"]],
    [4005, ["Ink Qilin", "墨麟", "墨麟"], ["N", ["o", 30], "N"]],
  ],
  feature: [
    [5001, ["Cross-server arena", "跨服竞技", "跨服競技"], [["o", -30], ["o", 0], ["o", 14]]],
    [5002, ["Guild war", "公会战", "公會戰"], ["A", "A", "A"]],
    [5003, ["Ladder", "天梯", "天梯"], [["o", -7], ["o", 7], ["o", 21]]],
    [5004, ["Treasure vault", "宝物收藏", "寶物收藏"], [["o", -60], ["o", -1], ["o", -1]]],
    [5005, ["Limited shop", "限时商店", "限時商店"], [["r", -3, 3], ["r", 0, 6], ["r", 0, 6]]],
    [5006, ["Mentorship", "师徒系统", "師徒系統"], [["c", -10], ["c", 0], "A"]],
    [5007, ["Marriage", "婚姻系统", "婚姻系統"], ["N", "N", "N"]],
  ],
});

export const DEMO_PLATFORM_IDS = Object.freeze(["cn", "tw", "sea"]);
export const DEMO_DEFAULT_PLATFORM = "tw";

export const RELEASE_PLAN_ITEMS = Object.freeze(
  RELEASE_PLAN_CATEGORIES.flatMap((category) =>
    PLAN_ITEMS[category.id].map(([key, names, seeds]) => Object.freeze({
      id: `${category.id}-${key}`,
      category: category.id,
      key,
      names: Object.freeze(names),
      seeds: Object.freeze(Object.fromEntries(DEMO_PLATFORM_IDS.map((platform, index) => [platform, seeds[index]]))),
    })),
  ),
);

export function planItemName(item, locale) {
  return item.names[LOCALE_INDEX[locale] ?? 0] || item.names[0];
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

export function createDemoPlatforms(translate) {
  return DEMO_PLATFORM_IDS.map((id) => ({
    id,
    name: translate(`releaseFlow.demo.platform.${id}`),
    sourceDatabase: DEMO_SOURCE_DATABASE,
    targetDatabase: `game_config_${id}`,
    sourceClient: DEMO_SOURCE_CLIENT,
    targetClient: `D:\\release\\${id}\\client`,
    transferTemplateId: "juesheng-2",
    cocosVersion: DEMO_COCOS_VERSION,
    cocosPath: defaultCocosEditorPath(DEMO_COCOS_VERSION),
    buildPlatform: "web-mobile",
    buildConfig: "build-config\\web-mobile.json",
  }));
}

/**
 * The flag a demo database holds before this release. Development opens
 * everything for testing; a platform still reflects last week's plan.
 */
export function demoDatabaseFlag(item, { synced, note, dateIso }) {
  if (synced) return 1;
  const lastWeek = addDays(dateIso, -7);
  return stateFlag(evaluatePlanRule(parsePlanNote(note, lastWeek), lastWeek).state) ?? 0;
}

// Tables of the development config database, with row counts.
export const DEMO_SYNC_TABLES = Object.freeze([
  ["hero", 36], ["hero_star", 288], ["hero_skill", 412], ["hero_fetter", 96], ["mount", 24],
  ["mount_star", 120], ["spirit", 30], ["spirit_level", 600], ["battle_pet", 28], ["battle_pet_skill", 140],
  ["function_open", 64], ["item", 3812], ["equip", 1204], ["equip_suit", 88], ["skill", 2406],
  ["buff", 1130], ["monster", 2870], ["stage", 960], ["drop_table", 4215], ["reward", 6034],
  ["activity", 186], ["activity_reward", 2488], ["activity_rank", 312], ["shop", 420], ["shop_goods", 2960],
  ["recharge", 48], ["vip", 16], ["guild", 40], ["guild_war", 32], ["quest", 1544],
  ["achievement", 820], ["title", 130], ["mail_template", 96], ["notice", 24], ["localization", 18230],
  ["version_info", 1], ["server_config", 12], ["platform_settings", 8], ["channel_config", 14], ["gm_whitelist", 30],
].map(([name, rows]) => Object.freeze({ name, rows })));

export const DEMO_SYNC_EXCLUSIONS = Object.freeze(["platform_settings", "channel_config", "gm_whitelist"]);

export const DEMO_FILE_EXCLUSIONS = Object.freeze([
  "library/",
  "temp/",
  "local/",
  "build/",
  "profiles/",
  "settings/",
  "assets/resources/channel/",
  "assets/script/config/ChannelConfig.ts",
]);

// What the development client changes compared with a platform client.
export const DEMO_CLIENT_CHANGES = Object.freeze([
  ["A", "assets/script/activity/LanternFestival.ts"],
  ["A", "assets/script/activity/LanternFestival.ts.meta"],
  ["M", "assets/script/hero/HeroView.ts"],
  ["M", "assets/script/hero/HeroStarPanel.ts"],
  ["M", "assets/script/ui/shop/ShopPanel.ts"],
  ["M", "assets/script/battle/BattleController.ts"],
  ["M", "assets/script/net/Protocol.ts"],
  ["M", "assets/script/config/ChannelConfig.ts"],
  ["A", "assets/resources/prefab/activity/LanternPanel.prefab"],
  ["A", "assets/resources/prefab/activity/LanternPanel.prefab.meta"],
  ["M", "assets/resources/prefab/ui/HeroPanel.prefab"],
  ["A", "assets/resources/texture/hero/h1015.png"],
  ["A", "assets/resources/texture/hero/h1015.png.meta"],
  ["A", "assets/resources/spine/hero/h1015/h1015.skel"],
  ["A", "assets/resources/spine/hero/h1015/h1015.atlas"],
  ["A", "assets/resources/audio/bgm/lantern.mp3"],
  ["D", "assets/resources/texture/activity/banner_0930.png"],
  ["D", "assets/resources/texture/activity/banner_0930.png.meta"],
  ["M", "assets/resources/channel/tw/sdk.json"],
  ["M", "assets/resources/channel/sea/sdk.json"],
  ["M", "settings/v2/packages/builder.json"],
  ["M", "settings/v2/packages/project.json"],
  ["M", "profiles/v2/packages/scene.json"],
  ["M", "library/imports/3a/3a1f0c2e.json"],
  ["M", "temp/asset-db/assets.json"],
  ["M", "build/web-mobile/index.html"],
  ["M", ".svn/wc.db"],
  ["M", "package.json"],
].map(([status, path]) => Object.freeze({ status, path })));

// `svn update` on the platform client. The last two entries conflict when the
// demo asks for conflicts.
export const DEMO_SVN_UPDATES = Object.freeze([
  ["U", "assets\\src\\props\\propDataDefine.ts"],
  ["U", "assets\\props\\hero.json"],
  ["U", "assets\\props\\activity.json"],
  ["U", "assets\\script\\ui\\shop\\ShopPanel.ts"],
  ["A", "assets\\resources\\texture\\activity\\banner_1024.png"],
  ["A", "assets\\resources\\texture\\activity\\banner_1024.png.meta"],
  ["U", "assets\\resources\\prefab\\ui\\ActivityPanel.prefab"],
  ["D", "assets\\resources\\texture\\activity\\banner_0930.png"],
  ["C", "assets\\script\\config\\ChannelConfig.ts"],
  ["C", "assets\\resources\\i18n\\zh_TW.json"],
].map(([action, path]) => Object.freeze({ action, path })));

// Config sheets a conversion script exports into the client.
export const DEMO_TRANSFER_SHEETS = Object.freeze([
  "hero", "hero_star", "mount", "spirit", "battle_pet", "function_open",
  "item", "activity", "activity_reward", "shop_goods", "reward", "localization",
]);

function hunk(text) {
  return text.trim().split("\n").map((line) => line.replace(/^\s{4}/, ""));
}

// The working-copy diff after copying and converting. Binary files carry no
// lines; the viewer says so.
export const DEMO_DIFF_FILES = Object.freeze([
  {
    status: "M", path: "assets/props/hero.json", added: 6, removed: 2,
    lines: hunk(`
    @@ -118,5 +118,8 @@
         "1015": {
           "ID": 1015,
    -      "Quality": 4,
    +      "Quality": 5,
    +      "SkillIDs": [101501, 101502, 101503],
    +      "SkinID": 21015,
    +      "ShowInGallery": 1,
           "IsOpen": 1
         },
    `),
  },
  {
    status: "M", path: "assets/props/activity.json", added: 38, removed: 12,
    lines: hunk(`
    @@ -402,12 +402,16 @@
         "3204": {
    -      "Name": "中秋祈福",
    -      "StartTime": "2026-09-30 05:00",
    -      "EndTime": "2026-10-07 23:59",
    +      "Name": "灯会祈愿",
    +      "StartTime": "2026-10-24 12:00",
    +      "EndTime": "2026-11-06 23:59",
    +      "PanelPrefab": "activity/LanternPanel",
    +      "RewardGroup": 3204,
           "RankType": 2,
    -      "Banner": "banner_0930"
    +      "Banner": "banner_1024"
         },
    `),
  },
  {
    status: "A", path: "assets/props/lantern_festival.json", added: 64, removed: 0,
    lines: hunk(`
    @@ -0,0 +1,8 @@
    +{
    +  "1": { "ID": 1, "Stage": 1, "Need": 10, "RewardID": 320401 },
    +  "2": { "ID": 2, "Stage": 2, "Need": 30, "RewardID": 320402 },
    +  "3": { "ID": 3, "Stage": 3, "Need": 60, "RewardID": 320403 },
    +  "4": { "ID": 4, "Stage": 4, "Need": 100, "RewardID": 320404 },
    +  "5": { "ID": 5, "Stage": 5, "Need": 160, "RewardID": 320405 },
    +  "6": { "ID": 6, "Stage": 6, "Need": 240, "RewardID": 320406 }
    +}
    `),
  },
  {
    status: "M", path: "assets/props/function_open.json", added: 3, removed: 3,
    lines: hunk(`
    @@ -41,9 +41,9 @@
         "5001": {
           "ID": 5001,
           "Name": "跨服竞技",
    -      "OpenLevel": 60,
    -      "OpenServerDay": 30,
    -      "Icon": "fn_arena"
    +      "OpenLevel": 55,
    +      "OpenServerDay": 21,
    +      "Icon": "fn_arena_cross"
         },
    `),
  },
  {
    status: "M", path: "assets/src/props/propDataDefine.ts", added: 18, removed: 0,
    lines: hunk(`
    @@ -886,6 +886,24 @@ export namespace PropData {
         export interface activity {
             ID: number;
             Name: string;
    +        PanelPrefab: string;
    +        RewardGroup: number;
         }
    +
    +    export interface lantern_festival {
    +        ID: number;
    +        Stage: number;
    +        Need: number;
    +        RewardID: number;
    +    }
    `),
  },
  {
    status: "M", path: "assets/script/hero/HeroView.ts", added: 21, removed: 7,
    lines: hunk(`
    @@ -64,11 +64,17 @@ export class HeroView extends Component {
         private refreshQuality(hero: PropData.hero) {
    -        this.qualityFrame.spriteFrame = this.frames[hero.Quality - 1];
    -        this.starNode.active = hero.Quality >= 4;
    +        const frame = this.frames[Math.min(hero.Quality, this.frames.length) - 1];
    +        this.qualityFrame.spriteFrame = frame;
    +        this.starNode.active = hero.Quality >= 4;
    +        this.skinButton.active = hero.SkinID > 0;
    +        this.galleryTag.active = hero.ShowInGallery === 1;
         }
    `),
  },
  {
    status: "M", path: "assets/script/ui/shop/ShopPanel.ts", added: 9, removed: 4,
    lines: hunk(`
    @@ -132,8 +132,13 @@ export class ShopPanel extends Component {
    -    private readonly tabs = [ShopTab.Normal, ShopTab.Guild, ShopTab.Arena];
    +    private readonly tabs = [ShopTab.Normal, ShopTab.Guild, ShopTab.Arena, ShopTab.Limited];
         onEnable() {
    -        this.selectTab(this.tabs[0]);
    +        const limited = PropMgr.isFunctionOpen(5005);
    +        this.limitedTab.active = limited;
    +        this.selectTab(limited ? ShopTab.Limited : this.tabs[0]);
         }
    `),
  },
  {
    status: "A", path: "assets/script/activity/LanternFestival.ts", added: 142, removed: 0,
    lines: hunk(`
    @@ -0,0 +1,9 @@
    +import { _decorator, Component, Label } from "cc";
    +const { ccclass, property } = _decorator;
    +
    +@ccclass("LanternFestival")
    +export class LanternFestival extends Component {
    +    @property(Label) progressLabel: Label = null!;
    +
    +    start() { this.refresh(); }
    +}
    `),
  },
  { status: "A", path: "assets/resources/texture/hero/h1015.png", added: 0, removed: 0, binary: true, lines: [] },
  { status: "D", path: "assets/resources/texture/activity/banner_0930.png", added: 0, removed: 0, binary: true, lines: [] },
].map((file) => Object.freeze(file)));

// Lines a Cocos Creator 3.x command-line build prints, with the build
// progress reached after each line.
export const DEMO_COCOS_LOG = Object.freeze([
  ["Cocos Creator {version} · command-line build", 0.02],
  ["Open project: {project}", 0.04],
  ["Load build options: {config}", 0.06],
  ["Start building with platform=web-mobile, debug=false, md5Cache=true", 0.08],
  ["[Build] Query asset bundles: main, resources, internal", 0.12],
  ["[Build] Compile scripts (TypeScript → JavaScript) …", 0.2],
  ["[Build] Compile scripts done in 21.6s", 0.34],
  ["[Build] Pack assets 412 / 1286", 0.46],
  ["[Build] Pack assets 896 / 1286", 0.58],
  ["[Build] Pack assets 1286 / 1286", 0.68],
  ["[Build] Compress textures (astc / webp) …", 0.78],
  ["[Build] Generate settings.json and md5 cache", 0.86],
  ["[Build] Write build/web-mobile", 0.94],
  ["Build success in 128.4s", 1],
]);

export const DEMO_COCOS_FAILURE_LOG = Object.freeze([
  "[Build] Pack assets 896 / 1286",
  "[Error] Asset db://assets/resources/prefab/activity/LanternPanel.prefab references a missing script",
  "[Error] Build failed: 1 error(s)",
]);
