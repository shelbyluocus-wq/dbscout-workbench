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
  relationEvidenceKey,
  relationEvidenceTitle,
  relationIsActionable,
  relationNeedsReview,
  relationReasonLabel,
  relationRelevantColumns,
  relationStatusLabel,
  relationTitle,
  rowCellValue,
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
