import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDays,
  countPlanChanges,
  daysBetween,
  evaluatePlanRule,
  formatPlanDate,
  parsePlanNote,
  planChanges,
  planStatements,
} from "./releasePlanNotes.js";

const DAY = "2026-10-24";

test("plan notes read the forms people write in Chinese and English", () => {
  assert.deepEqual(parsePlanNote("10/28 開放", DAY), { kind: "window", from: "2026-10-28", to: null });
  assert.deepEqual(parsePlanNote("10月28日开放", DAY), { kind: "window", from: "2026-10-28", to: null });
  assert.deepEqual(parsePlanNote("Open 10/28", DAY), { kind: "window", from: "2026-10-28", to: null });
  assert.deepEqual(parsePlanNote("2027-01-05 上線", DAY), { kind: "window", from: "2027-01-05", to: null });
  assert.deepEqual(parsePlanNote("10/28-11/30 開放", DAY), { kind: "window", from: "2026-10-28", to: "2026-12-01" });
  assert.deepEqual(parsePlanNote("10/28 開放、11/30 關閉", DAY), { kind: "window", from: "2026-10-28", to: "2026-11-30" });
  assert.deepEqual(parsePlanNote("開放至 11/30", DAY), { kind: "window", from: null, to: "2026-12-01" });
  assert.deepEqual(parsePlanNote("Open until 11/30", DAY), { kind: "window", from: null, to: "2026-12-01" });
  assert.deepEqual(parsePlanNote("11/30 關閉", DAY), { kind: "window", from: null, to: "2026-11-30" });
  assert.deepEqual(parsePlanNote("Closes 11/30", DAY), { kind: "window", from: null, to: "2026-11-30" });
  assert.deepEqual(parsePlanNote("已開放", DAY), { kind: "always" });
  assert.deepEqual(parsePlanNote("Already open", DAY), { kind: "always" });
  assert.deepEqual(parsePlanNote("本次開放", DAY), { kind: "open" });
  assert.deepEqual(parsePlanNote("關閉", DAY), { kind: "closed" });
  assert.deepEqual(parsePlanNote("暫不開放（原定 10/28）", DAY), { kind: "never" });
  assert.deepEqual(parsePlanNote("暂不开放", DAY), { kind: "never" });
  assert.deepEqual(parsePlanNote("Not yet", DAY), { kind: "never" });
});

test("plan notes that give no answer never produce a write", () => {
  assert.deepEqual(parsePlanNote("", DAY), { kind: "empty" });
  assert.deepEqual(parsePlanNote("   ", DAY), { kind: "empty" });
  assert.deepEqual(parsePlanNote("等美術確認", DAY), { kind: "unknown" });
  assert.deepEqual(parsePlanNote("10/32 開放", DAY), { kind: "unknown" });
  assert.deepEqual(parsePlanNote("11/30-10/28 開放", DAY), { kind: "unknown" });
  assert.deepEqual(parsePlanNote("活動結束後開放", DAY), { kind: "unknown" });
  assert.equal(evaluatePlanRule(parsePlanNote("等美術確認", DAY), DAY).state, null);
  assert.equal(evaluatePlanRule(parsePlanNote("", DAY), DAY).reason, "empty");
});

test("a date without a year lands in the year closest to the update date", () => {
  assert.equal(parsePlanNote("1/5 開放", "2026-12-28").from, "2027-01-05");
  assert.equal(parsePlanNote("12/20 開放", "2027-01-03").from, "2026-12-20");
  assert.equal(parsePlanNote("6/1 開放", "2026-10-24").from, "2026-06-01");
});

test("rules decide the state on the update day", () => {
  const rule = (note) => parsePlanNote(note, DAY);
  assert.deepEqual(evaluatePlanRule(rule("10/24 開放"), DAY), { state: "open", reason: "opensToday" });
  assert.deepEqual(evaluatePlanRule(rule("10/20 開放"), DAY), { state: "open", reason: "open" });
  assert.deepEqual(evaluatePlanRule(rule("10/28 開放"), DAY), { state: "closed", reason: "upcoming", days: 4 });
  assert.deepEqual(evaluatePlanRule(rule("10/01-10/23 開放"), DAY), { state: "closed", reason: "ended" });
  assert.deepEqual(evaluatePlanRule(rule("10/01-10/24 開放"), DAY), { state: "open", reason: "open" });
  assert.deepEqual(evaluatePlanRule(rule("10/24 關閉"), DAY), { state: "closed", reason: "ended" });
  assert.deepEqual(evaluatePlanRule(rule("已開放"), DAY), { state: "open", reason: "always" });
  assert.deepEqual(evaluatePlanRule(rule("暫不開放"), DAY), { state: "closed", reason: "never" });
});

test("plan changes compare the plan with the stored flag and build one statement per direction", () => {
  const items = [
    { id: "a", key: 1, note: "10/20 開放", current: 0 },
    { id: "b", key: 2, note: "10/28 開放", current: 1 },
    { id: "c", key: 3, note: "已開放", current: 1 },
    { id: "d", key: 4, note: "等美術確認", current: 1 },
    { id: "e", key: 5, note: "暫不開放", current: 1 },
  ];
  const rows = planChanges(items, { dateIso: DAY, noteFor: (item) => item.note, currentFor: (item) => item.current });
  assert.deepEqual(rows.map((row) => row.change), ["open", "close", "keep", "skip", "close"]);
  assert.deepEqual(countPlanChanges(rows), { open: 1, close: 2, keep: 1, skip: 1 });
  assert.deepEqual(planStatements([{ table: "hero", keyColumn: "ID", flagColumn: "IsOpen", rows }]), [
    "UPDATE `hero` SET `IsOpen` = 1 WHERE `ID` IN (1);",
    "UPDATE `hero` SET `IsOpen` = 0 WHERE `ID` IN (2, 5);",
  ]);
});

test("statements quote identifiers and non-numeric keys", () => {
  const rows = [{ item: { key: "o'neil" }, change: "open" }];
  assert.deepEqual(planStatements([{ table: "we`ird", keyColumn: "Key", flagColumn: "On", rows }]), [
    "UPDATE `we``ird` SET `On` = 1 WHERE `Key` IN ('o''neil');",
  ]);
});

test("groups sharing a table write together, and composite keys compare as row values", () => {
  const heroes = [{ item: { key: 1062 }, change: "close" }, { item: { key: 1061 }, change: "open" }];
  const mounts = [{ item: { key: 6517 }, change: "close" }];
  const features = [{ item: { key: { BuildID: 197, Idx: 100 } }, change: "close" }, { item: { key: { BuildID: 134, Idx: 100 } }, change: "close" }];
  assert.deepEqual(planStatements([
    { table: "heroprop", keyColumns: ["ID"], flagColumn: "OpenFlag", rows: heroes },
    { table: "heroprop", keyColumns: ["ID"], flagColumn: "OpenFlag", rows: mounts },
    { table: "buildopenplatprop", keyColumns: ["BuildID", "Idx"], flagColumn: "IsOpen", rows: features },
  ]), [
    "UPDATE `heroprop` SET `OpenFlag` = 1 WHERE `ID` IN (1061);",
    "UPDATE `heroprop` SET `OpenFlag` = 0 WHERE `ID` IN (1062, 6517);",
    "UPDATE `buildopenplatprop` SET `IsOpen` = 0 WHERE (`BuildID`, `Idx`) IN ((197, 100), (134, 100));",
  ]);
});

test("date helpers stay on calendar days", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(daysBetween("2026-10-24", "2026-11-03"), 10);
  assert.equal(formatPlanDate("2026-10-28", DAY), "10/28");
  assert.equal(formatPlanDate("2027-01-05", DAY), "2027/1/5");
});
