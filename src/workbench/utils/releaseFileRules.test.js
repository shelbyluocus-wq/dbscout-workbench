import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanExclusionRules, excludingRule, exclusionRuleKind, ruleForPick } from "./releaseFileRules.js";

test("folder rules match at any depth unless they name a path", () => {
  assert.equal(excludingRule("library/imports/3a/x.json", ["library/"]), "library/");
  assert.equal(excludingRule("tools/library/readme.md", ["library/"]), "library/");
  assert.equal(excludingRule("assets/resources/channel/tw/sdk.json", ["assets/resources/channel/"]), "assets/resources/channel/");
  assert.equal(excludingRule("other/assets/resources/channel/a.json", ["assets/resources/channel/"]), "");
  assert.equal(excludingRule("assets/library.ts", ["library/"]), "");
});

test("file rules, wildcards and Windows separators", () => {
  assert.equal(excludingRule("assets/script/config/ChannelConfig.ts", ["assets/script/config/ChannelConfig.ts"]), "assets/script/config/ChannelConfig.ts");
  assert.equal(excludingRule("assets\\script\\config\\ChannelConfig.ts", ["assets/script/config/channelconfig.ts"]), "assets/script/config/channelconfig.ts");
  assert.equal(excludingRule("assets/a/b/c.meta", ["*.meta"]), "*.meta");
  assert.equal(excludingRule("assets/a/b/c.meta.bak", ["*.meta"]), "");
  assert.equal(excludingRule("assets/x/deep/y.json", ["assets/**/y.json"]), "assets/**/y.json");
  assert.equal(excludingRule("assets/x/y.json", ["assets/*/y.json"]), "assets/*/y.json");
  assert.equal(excludingRule("assets/x/deep/y.json", ["assets/*/y.json"]), "");
});

test("version-control folders are always excluded", () => {
  assert.equal(excludingRule(".svn/wc.db", []), ".svn/");
  assert.equal(excludingRule("assets/.svn/entries", []), ".svn/");
});

test("rules are cleaned, deduplicated case-insensitively and never repeat the fixed ones", () => {
  assert.deepEqual(cleanExclusionRules([" temp/ ", "TEMP/", ".\\build\\", "", ".svn/", "build/"]), ["temp/", "build/"]);
});

test("a file or folder chosen in the client becomes a rule anchored to the client", () => {
  assert.equal(ruleForPick("assets/config/Config.ts", "file"), "assets/config/Config.ts");
  assert.equal(ruleForPick("build", "folder"), "/build/");
  assert.equal(ruleForPick("Config.ts", "file"), "/Config.ts");
  assert.equal(ruleForPick("assets\\bundles\\activity", "folder"), "assets/bundles/activity/");
  // A top-level folder never excludes its namesakes deeper in the tree.
  assert.equal(excludingRule("build/android/main.js", [ruleForPick("build", "folder")]), "/build/");
  assert.equal(excludingRule("assets/build/main.js", [ruleForPick("build", "folder")]), "");
  assert.equal(excludingRule("assets/bundles/activity/P5/npc.png", [ruleForPick("assets/bundles/activity", "folder")]), "assets/bundles/activity/");
  assert.deepEqual(["/build/", "*.meta", "assets/config/Config.ts"].map(exclusionRuleKind), ["folder", "pattern", "file"]);
});
