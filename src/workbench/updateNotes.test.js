import assert from "node:assert/strict";
import test from "node:test";

import { parseUpdateNotes, updateNoteListClass } from "./utils/updateNotes.js";

test("numbered release notes lose their markers and stay ordered", () => {
  const notes = parseUpdateNotes("1. 第一项\r\n2、第二项\r\n\r\n3) 第三项");
  assert.deepEqual(notes.items, ["第一项", "第二项", "第三项"]);
  assert.equal(notes.ordered, true);
  assert.deepEqual(updateNoteListClass(notes), { "is-single": false, "is-unordered": false });
});

test("bulleted or mixed release notes are not given numbers", () => {
  const bulleted = parseUpdateNotes("- one\n* two\n• three");
  assert.deepEqual(bulleted.items, ["one", "two", "three"]);
  assert.equal(bulleted.ordered, false);
  assert.deepEqual(updateNoteListClass(bulleted), { "is-single": false, "is-unordered": true });

  const mixed = parseUpdateNotes("1. one\nplain line");
  assert.deepEqual(mixed.items, ["one", "plain line"]);
  assert.equal(mixed.ordered, false);
});

test("a single line is a paragraph, and a leading version is not a list number", () => {
  const single = parseUpdateNotes("1. 修复了若干问题。");
  assert.deepEqual(single.items, ["修复了若干问题。"]);
  assert.equal(single.ordered, false);
  assert.deepEqual(updateNoteListClass(single), { "is-single": true, "is-unordered": false });

  assert.deepEqual(parseUpdateNotes("0.1.71 修复同步\n10. 第十项").items, ["0.1.71 修复同步", "第十项"]);
});

test("missing release notes give an empty list", () => {
  for (const body of [undefined, null, "", " \r\n ", "1.\n-"]) {
    assert.deepEqual(parseUpdateNotes(body), { items: [], ordered: false });
  }
});
