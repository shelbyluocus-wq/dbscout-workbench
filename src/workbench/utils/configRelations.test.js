import test from "node:test";
import assert from "node:assert/strict";

import en from "../i18n/en.js";
import zhCN from "../i18n/zhCN.js";
import zhTW from "../i18n/zhTW.js";
import {
  RELATION_STATUSES,
  clientDialectLabel,
  connectionOffersConfigRelations,
  coverageGapText,
  isEmptyReferenceValue,
  referenceValuesFromCell,
  relationChipLabel,
  relationDirection,
  relationEndParts,
  relationEvidenceKey,
  relationEvidenceTitle,
  relationIsActionable,
  relationLabelColumn,
  relationNeedsReview,
  relationReasonLabel,
  relationRelevantColumns,
  relationRowName,
  relationStatusLabel,
  relationTableSummary,
  relationTitle,
  rowCellValue,
  shortCodePath,
  splitRejectedRelations,
  tableColumnComment,
  tableDisplayComment,
  tableDisplayName,
} from "./configRelations.js";

const translate = (key, params = {}) =>
  [key, ...Object.entries(params).map(([name, value]) => `${name}=${value}`)].join("|");

// Every status, reason and coverage code the backend can send.
const BACKEND_REASONS = [
  "matchesCode", "manual", "codeOnly", "commentOnly", "commentWithoutClient", "formatOnly",
  "codeChanged", "codeRemoved", "evidenceGone", "commentConflict", "rejected",
];
const BACKEND_GAPS = ["noClient", "clientMissing", "analyzing", "scanFailed", "notUsedByClient", "untracedLookups"];

test("only real MySQL connections offer config relations", () => {
  assert.equal(connectionOffersConfigRelations({ id: "c1", kind: "mysql" }), true);
  assert.equal(connectionOffersConfigRelations({ id: "demo-stress", kind: "mysql", sampleData: true }), false);
  assert.equal(connectionOffersConfigRelations({ id: "ch", kind: "clickhouse" }), false);
  assert.equal(connectionOffersConfigRelations({ id: "mongo", kind: "mongodb" }), false);
  assert.equal(connectionOffersConfigRelations({ kind: "mysql" }), false);
  assert.equal(connectionOffersConfigRelations(null), false);
});

test("a cell references its keys in order, without empty markers or repeats", () => {
  assert.deepEqual(referenceValuesFromCell("value", " 1001 "), ["1001"]);
  assert.deepEqual(referenceValuesFromCell("value", 7), ["7"]);
  for (const empty of ["", "0", "-1", "null", "NULL", "[]", null, undefined]) {
    assert.deepEqual(referenceValuesFromCell("value", empty), [], `cell ${String(empty)}`);
  }
  assert.deepEqual(referenceValuesFromCell("list", '[{"ID":3},{"ID":0},{"id":2},{"ID":3}]'), ["3", "2"]);
  assert.deepEqual(referenceValuesFromCell("list", "3|2"), []);
  assert.equal(isEmptyReferenceValue(" 0 "), true);
  assert.equal(isEmptyReferenceValue("00"), false);
});

test("the relation chip says where the listed rows came from", () => {
  const origin = { sourceTable: "hero", sourceColumn: "skill_id", targetTable: "skill", targetColumn: "id" };
  assert.equal(
    relationChipLabel({
      relationFilter: { column: "id", values: ["1", "2", "3", "4", "5"] },
      relationOrigin: { direction: "outgoing", ...origin },
    }, translate),
    "relations.chip.from|table=hero|column=skill_id|values=1, 2, 3 relations.chip.more|count=2",
  );
  assert.equal(
    relationChipLabel({
      relationFilter: { column: "reward_pool", kind: "listContains", values: ["1001"] },
      relationOrigin: { direction: "incoming", ...origin },
    }, translate),
    "relations.chip.contains|column=reward_pool|values=1001",
  );
  assert.equal(
    relationChipLabel({ relationFilter: { column: "skill_id", values: ["7", "8"] } }, translate),
    "relations.chip.equals|column=skill_id|values=7, 8",
  );
  assert.equal(relationChipLabel({ relationFilter: null }, translate), "");
  assert.equal(relationChipLabel(null, translate), "");
});

test("coverage gaps explain what the list may be missing", () => {
  assert.equal(coverageGapText({ code: "noClient" }, translate), "relations.gap.noClient");
  assert.equal(coverageGapText({ code: "scanFailed", message: "boom" }, translate), "relations.gap.scanFailed|message=boom");
  assert.equal(coverageGapText({ code: "untracedLookups", count: 2 }, translate), "relations.gap.untracedLookups|count=2");
  assert.equal(coverageGapText({ code: "unsupportedFields", columns: ["RewardFunc"] }, translate), "relations.gap.unsupportedFields|columns=RewardFunc");
  assert.equal(coverageGapText({ code: "somethingNew" }, translate), "");
  assert.equal(coverageGapText(null, translate), "");
});

test("only stale and conflicting relations ask for a decision", () => {
  assert.equal(relationStatusLabel("stale", translate), "relations.status.stale");
  assert.equal(relationStatusLabel("weird", translate), "relations.status.unconfirmed");
  assert.equal(relationReasonLabel("", translate), "relations.reason.codeOnly");
  assert.equal(relationNeedsReview({ status: "stale" }), true);
  assert.equal(relationNeedsReview({ status: "conflict" }), true);
  assert.equal(relationNeedsReview({ status: "unconfirmed" }), false);
  assert.equal(relationIsActionable({ status: "unconfirmed" }), false);
  assert.equal(relationIsActionable({ status: "confirmed" }), false);
  assert.equal(relationIsActionable({ status: "stale" }), true);
  assert.equal(relationIsActionable({ status: "conflict" }), true);
  assert.equal(relationIsActionable({ status: "rejected" }), false);
});

test("evidence explains itself on hover and keeps a stable key", () => {
  const comment = { type: "comment", text: "技能ID" };
  const code = { type: "code", file: "assets/scripts/hero/HeroModel.ts", line: 42, fingerprint: "f1" };
  const format = { type: "format", sample: '[{"ID":1001}]' };
  assert.equal(relationEvidenceTitle(comment), "技能ID");
  assert.equal(relationEvidenceTitle(code), "assets/scripts/hero/HeroModel.ts:42");
  assert.equal(relationEvidenceTitle(format), '[{"ID":1001}]');
  assert.equal(relationEvidenceTitle({ type: "later" }), "");
  assert.equal(relationEvidenceTitle(null), "");
  const keys = [comment, code, format, { ...code, fingerprint: "f2" }].map(relationEvidenceKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(relationEvidenceKey(code), relationEvidenceKey({ ...code, line: 43 }));
});

test("titles use database table case and rows are read case-insensitively", () => {
  const tables = { heroprop: { name: "HeroProp", comment: "英雄" } };
  const relation = { sourceTable: "heroprop", sourceColumn: "SkillID", targetTable: "skillprop", targetColumn: "ID" };
  assert.equal(relationTitle(relation, tables), "HeroProp.SkillID → skillprop.ID");
  assert.equal(relationTitle(null, tables), "");
  assert.equal(tableDisplayName(tables, "heroprop"), "HeroProp");
  assert.equal(tableDisplayName(tables, "missing"), "missing");
  assert.equal(tableDisplayComment(tables, "heroprop"), "英雄");
  assert.equal(tableDisplayComment(tables, "missing"), "");
  const labelled = { heroprop: { ...tables.heroprop, columns: { skillid: "技能" } } };
  assert.equal(tableColumnComment(labelled, "heroprop", "SkillID"), "技能");
  assert.equal(tableColumnComment(labelled, "heroprop", "ID"), "");
  assert.equal(tableColumnComment(tables, "heroprop", "SkillID"), "");
  assert.deepEqual(relationEndParts("HeroProp.SkillID", "SkillID"), { prefix: "HeroProp.", column: "SkillID" });
  assert.deepEqual(relationEndParts("SkillID", "skillid"), { prefix: "", column: "SkillID" });
  assert.deepEqual(relationEndParts("HeroProp.MySkillID", "SkillID"), { prefix: "HeroProp.MySkillID", column: "" });
  assert.deepEqual(
    relationRelevantColumns([relation, { ...relation, sourceColumn: "Gone", status: "rejected" }]),
    ["skillid", "id"],
  );
  assert.equal(rowCellValue({ SkillID: 7 }, "skillid"), 7);
  assert.equal(rowCellValue({ SkillID: 7, skillid: 8 }, "skillid"), 8);
  assert.equal(rowCellValue({ SkillID: 7 }, "Other"), undefined);
  assert.equal(rowCellValue(null, "SkillID"), undefined);
  assert.equal(clientDialectLabel("JSWZ", translate), "relations.client.dialectJswz");
  assert.equal(clientDialectLabel("nzg", translate), "relations.client.dialectNzg");
  assert.equal(clientDialectLabel("other", translate), "other");
});

test("every backend status, reason and coverage code has copy in each language", () => {
  const keys = [
    ...RELATION_STATUSES.map((status) => `relations.status.${status}`),
    ...BACKEND_REASONS.map((reason) => `relations.reason.${reason}`),
    ...BACKEND_GAPS.map((gap) => `relations.gap.${gap}`),
    "relations.client.dialectJswz",
    "relations.client.dialectNzg",
    "relations.chip.from",
    "relations.chip.equals",
    "relations.chip.contains",
    "relations.chip.more",
  ];
  for (const [locale, catalog] of Object.entries({ en, zhCN, zhTW })) {
    for (const key of keys) {
      assert.ok(Object.hasOwn(catalog, key), `${locale} is missing ${key}`);
    }
  }
});

test("a row is named by the same column the backend labels targets with", () => {
  const column = (name, type, extra = {}) => ({ column_name: name, column_type: type, ...extra });
  assert.equal(relationLabelColumn([
    column("ID", "int", { is_primary_key: true }),
    column("Icon", "varchar(64)"),
    column("ItemName", "varchar(64)"),
  ], ["ID"]), "ItemName");
  assert.equal(relationLabelColumn([column("id", "int"), column("Title", "varchar(32)"), column("name", "varchar(32)")], ["id"]), "name");
  assert.equal(relationLabelColumn([column("ID", "int"), column("Txt", "varchar(16)", { column_comment: "名稱" })], ["ID"]), "Txt");
  assert.equal(relationLabelColumn([{ columnName: "Desc", columnType: "text" }], []), "Desc");
  // Primary keys and non-text columns never name a row.
  assert.equal(relationLabelColumn([column("name", "varchar(8)", { is_primary_key: true }), column("Val", "int")], []), "");
  assert.equal(relationLabelColumn([column("Name", "int")], []), "");
  assert.equal(relationLabelColumn(null), "");

  assert.equal(relationRowName({ Name: "  Fire \n ball " }, "name"), "Fire ball");
  assert.equal(relationRowName({ Name: "x".repeat(60) }, "Name"), `${"x".repeat(39)}…`);
  assert.equal(relationRowName({ Name: null }, "Name"), "");
  assert.equal(relationRowName({ Name: "Potion" }, ""), "");
  assert.equal(relationRowName(null, "Name"), "");
});

test("relation lists split by side and status, and summarize for the switch badge", () => {
  const relation = (id, sourceTable, targetTable, status = "confirmed") => ({ id, sourceTable, targetTable, status });
  assert.equal(relationDirection(relation("a", "hero", "skill"), "Hero"), "outgoing");
  assert.equal(relationDirection(relation("a", "hero", "skill"), "skill"), "incoming");

  const rejected = relation("r", "hero", "skill", "rejected");
  const split = splitRejectedRelations([relation("a", "hero", "skill"), rejected, null]);
  assert.deepEqual(split.rejected, [rejected]);
  assert.equal(split.active.length, 2);

  const self = relation("quest.pre>quest.id", "quest", "quest", "stale");
  assert.deepEqual(relationTableSummary({
    outgoing: [self, relation("quest.item>item.id", "quest", "item"), relation("x", "quest", "item", "rejected")],
    incoming: [self, relation("mail.q>quest.id", "mail", "quest", "conflict")],
  }), { total: 3, review: 2 });
  assert.deepEqual(relationTableSummary({ outgoing: [], incoming: [] }), { total: 0, review: 0 });
  assert.equal(relationTableSummary(null), null);
});

test("code locations keep their last folders", () => {
  assert.equal(shortCodePath("assets/scripts/battle/DropPreview.ts"), "…/scripts/battle/DropPreview.ts");
  assert.equal(shortCodePath("D:\\client\\jswz\\a\\b.ts", 1), "…/a/b.ts");
  assert.equal(shortCodePath("battle/DropPreview.ts"), "battle/DropPreview.ts");
  assert.equal(shortCodePath(""), "");
});
