import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeCommentWithDirective,
  formatAgentMeaningClipboard,
  formatCommentDirective,
  parseCommentDirective,
  resolveCellEnumPreview,
  resolveCellSlotPreview,
  resolveListSamplePreview,
  stripCommentDirectives,
  suggestEnumEntriesFromComment,
  suggestPrefixFromSample,
  suggestSlotLabelsFromComment,
} from "./commentDirectives.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("parseCommentDirective parses enum, ref, list and noRelation directives", () => {
  const enumRes = parseCommentDirective(
    "可选英雄魂石的最大单位稀有度，引用 heroprop.Quality [枚举: 1=N, 2=R, 3=SR, 4=SSR, 5=UR, 6=SUR]",
  );
  assert.equal(enumRes.hasDirective, true);
  assert.equal(enumRes.kind, "enum");
  assert.equal(enumRes.entries.length, 6);
  assert.deepEqual(enumRes.entries[4], { key: "5", label: "UR" });

  const fullWidth = parseCommentDirective("品质【枚举：1蓝、2紫、3橙】");
  assert.equal(fullWidth.kind, "enum");
  assert.deepEqual(fullWidth.entries, [
    { key: "1", label: "蓝" },
    { key: "2", label: "紫" },
    { key: "3", label: "橙" },
  ]);

  const noRel = parseCommentDirective("参考 heroprop.ID [无关联]");
  assert.equal(noRel.hasDirective, true);
  assert.equal(noRel.kind, "noRelation");

  const ref = parseCommentDirective("奖励物品 [关联: goodsprop.ID]");
  assert.equal(ref.kind, "relation");
  assert.deepEqual(ref.relations, [
    { targetTable: "goodsprop", targetColumn: "ID", kind: "value", extractor: "", parser: null },
  ]);

  const listPath = parseCommentDirective("套装 [列表关联: antiquesuitattrprop.SuitID @ $[*][0]]");
  assert.equal(listPath.kind, "relation");
  assert.equal(listPath.relations[0].kind, "list");
  assert.deepEqual(listPath.relations[0].parser, { type: "jsonPaths", paths: ["$[*][0]"], exclude: [] });

  const listComma = parseCommentDirective("列表 [列表关联: goodsprop.ID @ ,]");
  assert.deepEqual(listComma.relations[0].parser, { type: "keys", delimiter: "," });

  const listMember = parseCommentDirective("奖励 [列表关联: goodsprop.ID @ ID]");
  assert.deepEqual(listMember.relations[0].parser, { type: "json", member: "ID" });

  const ordinary = parseCommentDirective("次数数组 [2, 4, 6, 8]");
  assert.equal(ordinary.hasDirective, false);
  assert.equal(ordinary.kind, "none");

  const slots = parseCommentDirective(
    "援助次数 [数组位: N魂石数量, R魂石数量, SR魂石数量, SSR魂石数量, UR魂石数量, SUR魂石数量]",
  );
  assert.equal(slots.hasDirective, true);
  assert.equal(slots.kind, "slots");
  assert.deepEqual(slots.slots, ["N魂石数量", "R魂石数量", "SR魂石数量", "SSR魂石数量", "UR魂石数量", "SUR魂石数量"]);
});

test("stripCommentDirectives and composeCommentWithDirective preserve prose cleanly", () => {
  const original = "可选英雄魂石的最大单位稀有度 [枚举: 1=N, 5=UR]";
  assert.equal(stripCommentDirectives(original), "可选英雄魂石的最大单位稀有度");
  assert.equal(
    composeCommentWithDirective(original, { kind: "noRelation" }),
    "可选英雄魂石的最大单位稀有度 [无关联]",
  );
  assert.equal(
    composeCommentWithDirective("格位品质", {
      kind: "enum",
      entries: [{ key: "1", label: "蓝" }, { key: "2", label: "紫" }],
    }),
    "格位品质 [枚举: 1=蓝, 2=紫]",
  );
  assert.equal(
    formatCommentDirective({ kind: "list", targetTable: "goodsprop", targetColumn: "ID", extractor: "ID" }),
    "[列表关联: goodsprop.ID @ ID]",
  );
});

test("resolveCellEnumPreview resolves scalar, JSON array and unmapped values", () => {
  const comment = "稀有度 [枚举: 1=N, 2=R, 3=SR, 4=SSR, 5=UR, 6=SUR]";
  assert.deepEqual(resolveCellEnumPreview("5", comment), [{ value: "5", label: "UR", state: "enum" }]);
  assert.deepEqual(resolveCellEnumPreview("0", comment), []);
  assert.deepEqual(resolveCellEnumPreview("9", comment), [{ value: "9", label: "", state: "unmapped" }]);
  assert.deepEqual(resolveCellEnumPreview("[1, 5]", comment), [
    { value: "1", label: "N", state: "enum" },
    { value: "5", label: "UR", state: "enum" },
  ]);
  assert.deepEqual(resolveCellEnumPreview("5", "普通备注没有枚举标记"), []);
});

test("resolveCellSlotPreview and suggestSlotLabelsFromComment handle NeedHelpNums style arrays", () => {
  const comment = "各稀有度魂石完成单次委托所需的援助次数（第1项为N级，依次对应N/R/SR/SSR/UR/SUR） [数组位: N魂石数量, R魂石数量, SR魂石数量, SSR魂石数量, UR魂石数量, SUR魂石数量]";
  assert.deepEqual(resolveCellSlotPreview("[2, 4, 6, 8, 10]", comment), [
    { index: 1, label: "N魂石数量", value: "2", state: "slot" },
    { index: 2, label: "R魂石数量", value: "4", state: "slot" },
    { index: 3, label: "SR魂石数量", value: "6", state: "slot" },
    { index: 4, label: "SSR魂石数量", value: "8", state: "slot" },
    { index: 5, label: "UR魂石数量", value: "10", state: "slot" },
  ]);
  assert.deepEqual(resolveCellSlotPreview("[2, 4]", "数组 [数组位: N]"), [
    { index: 1, label: "N", value: "2", state: "slot" },
    { index: 2, label: "", value: "4", state: "unmapped" },
  ]);
  assert.deepEqual(resolveCellSlotPreview("10,20,30", "属性 [数组位: 生命, 攻击, 防御]"), [
    { index: 1, label: "生命", value: "10", state: "slot" },
    { index: 2, label: "攻击", value: "20", state: "slot" },
    { index: 3, label: "防御", value: "30", state: "slot" },
  ]);
  assert.deepEqual(
    suggestSlotLabelsFromComment(
      "各稀有度魂石完成单次委托所需的援助次数一维非空数组，长度等于MaxUnitQuality，下标对应heroprop.Quality-1（第1项为N级，依次对应N/R/SR/SSR/UR/SUR）；每次援助进度+1",
    ),
    ["N", "R", "SR", "SSR", "UR", "SUR"],
  );
  assert.equal(
    formatCommentDirective({ kind: "slots", slots: ["N魂石数量", "R魂石数量"] }),
    "[数组位: N魂石数量, R魂石数量]",
  );
});

test("suggestEnumEntriesFromComment extracts legacy Chinese game-config enums", () => {
  const rarity = suggestEnumEntriesFromComment(
    "可选英雄魂石的最大单位稀有度，引用 heroprop.Quality (1N、2R、3SR、4SSR、5UR、6SUR)；可选范围为...",
  );
  assert.deepEqual(rarity, [
    { key: "1", label: "N" },
    { key: "2", label: "R" },
    { key: "3", label: "SR" },
    { key: "4", label: "SSR" },
    { key: "5", label: "UR" },
    { key: "6", label: "SUR" },
  ]);

  const quality = suggestEnumEntriesFromComment(
    "格位品质表现（非英雄品质）：1蓝、2紫、3橙；用于卡片描边",
  );
  assert.deepEqual(quality, [
    { key: "1", label: "蓝" },
    { key: "2", label: "紫" },
    { key: "3", label: "橙" },
  ]);

  const status = suggestEnumEntriesFromComment("状态(0正常1封禁)");
  assert.deepEqual(status, [
    { key: "0", label: "正常" },
    { key: "1", label: "封禁" },
  ]);
});

test("formatAgentMeaningClipboard generates concise structured summary", () => {
  const text = formatAgentMeaningClipboard({
    database: "newsg_4cfg",
    tableName: "unionhelpqualityprop",
    columnName: "MaxUnitQuality",
    currentComment: "旧备注",
    nextComment: "新备注 [枚举: 5=UR]",
    sampleValue: "5",
  });
  assert.match(text, /newsg_4cfg\.unionhelpqualityprop\.MaxUnitQuality/);
  assert.match(text, /\[枚举: 5=UR\]/);
  assert.match(text, /当前单元格示例值: 5/);
});

test("cell detail panel, split layout, dialog and shell wire column meaning editing end to end", () => {
  const detail = fs.readFileSync(path.join(__dirname, "../components/CellDetailPanel.vue"), "utf8");
  const pane = fs.readFileSync(path.join(__dirname, "../components/WorkbenchPane.vue"), "utf8");
  const split = fs.readFileSync(path.join(__dirname, "../components/WorkbenchSplitLayout.vue"), "utf8");
  const dialog = fs.readFileSync(path.join(__dirname, "../components/CommentEditDialog.vue"), "utf8");
  const shell = fs.readFileSync(path.join(__dirname, "../MySqlWorkbench.vue"), "utf8");

  assert.match(detail, /resolveCellEnumPreview/);
  assert.match(detail, /wb-cell-detail-enum-chip/);
  assert.match(detail, /emit\("edit-column-meaning"\)/);
  assert.match(pane, /@edit-column-meaning="handleEditColumnMeaning"/);
  assert.match(split, /@edit-column-meaning="emit\('edit-column-meaning', \$event\)"/);
  assert.match(shell, /@edit-column-meaning="openColumnMeaningEdit"/);
  assert.match(dialog, /wb-comment-meaning-box/);
  assert.match(dialog, /copyForAgent/);
});

test("prefix and positional token extractors parse, preview and suggest cleanly", () => {
  const prefixed = parseCommentDirective("立绘表现参数 [列表关联: heroprop.ID @ npc_*]");
  assert.equal(prefixed.kind, "relation");
  assert.deepEqual(prefixed.relations[0].parser, { type: "prefixed", prefix: "npc_" });

  const slotPrefixed = parseCommentDirective("立绘表现参数 [列表关联: heroprop.ID @ ,#1:npc_*]");
  assert.deepEqual(slotPrefixed.relations[0].parser, {
    type: "prefixed",
    prefix: "npc_",
    delimiter: ",",
    index: 0,
  });

  const slotPlain = parseCommentDirective("来源参数 [列表关联: shoptypeprop.ShopType @ ,#1]");
  assert.deepEqual(slotPlain.relations[0].parser, {
    type: "token",
    delimiter: ",",
    index: 0,
  });

  const refWithExtractor = parseCommentDirective("立绘 [关联: heroprop.ID @ npc_*]");
  assert.equal(refWithExtractor.kind, "relation");
  assert.equal(refWithExtractor.relations[0].kind, "value");
  assert.deepEqual(refWithExtractor.relations[0].parser, { type: "prefixed", prefix: "npc_" });

  assert.equal(suggestPrefixFromSample("npc_1041,70,0,0,0"), "npc_");
  assert.equal(suggestPrefixFromSample("201,100,0,0,0"), "");
  assert.deepEqual(resolveListSamplePreview("npc_1041,70,0,0,0", "npc_*"), ["1041"]);
  assert.deepEqual(resolveListSamplePreview("npc_1041,70,0,0,0", ",#1:npc_*"), ["1041"]);
  assert.deepEqual(resolveListSamplePreview("201,100,0,0,0", "npc_*"), []);
  assert.deepEqual(resolveListSamplePreview("7,900", ",#1"), ["7"]);
  assert.equal(
    formatCommentDirective({ kind: "list", targetTable: "heroprop", targetColumn: "ID", extractor: "npc_*" }),
    "[列表关联: heroprop.ID @ npc_*]",
  );
});
