import test from "node:test";
import assert from "node:assert/strict";
import {
  cellEditorKeydown,
  isImeKeyEvent,
  markCompositionEnd,
  markCompositionStart,
  shouldCommitEditorInput,
  vImeValue,
} from "./utils/imeInput.js";

test("ime key detection covers composition, Process, and Windows keyCode 229", () => {
  assert.equal(isImeKeyEvent({ isComposing: true, key: "Enter", keyCode: 13 }), true);
  assert.equal(isImeKeyEvent({ key: "Process", keyCode: 229 }), true);
  assert.equal(isImeKeyEvent({ key: "n", keyCode: 229 }), true);
  assert.equal(isImeKeyEvent({ key: "Unidentified" }), true);
  assert.equal(isImeKeyEvent({ key: "n", keyCode: 78, isComposing: false }), false);
  assert.equal(isImeKeyEvent(null), false);
});

test("cell editor keys ignore an in-progress composition", () => {
  let entered = false;
  const event = {
    key: "Enter",
    keyCode: 229,
    isComposing: true,
    preventDefault() { entered = true; },
    stopPropagation() { entered = true; },
  };
  assert.equal(cellEditorKeydown(event, { onEnter() { entered = true; } }), false);
  assert.equal(entered, false);
});

test("cell editor Enter, Escape, and Tab commit only after composition", () => {
  const calls = [];
  const event = (key, extra = {}) => ({
    key,
    keyCode: extra.keyCode || (key === "Enter" ? 13 : 0),
    shiftKey: Boolean(extra.shiftKey),
    preventDefault() { calls.push(`prevent:${key}`); },
    stopPropagation() { calls.push(`stop:${key}`); },
  });
  cellEditorKeydown(event("Enter"), { onEnter: () => calls.push("enter") });
  cellEditorKeydown(event("Escape"), { onEscape: () => calls.push("escape") });
  cellEditorKeydown(event("Tab", { shiftKey: true }), { onTab: (shift) => calls.push(`tab:${shift}`) });
  cellEditorKeydown(event("n"), {});
  assert.deepEqual(calls, [
    "prevent:Enter", "stop:Enter", "enter",
    "prevent:Escape", "stop:Escape", "escape",
    "prevent:Tab", "stop:Tab", "tab:true",
  ]);
});

test("composition updates are not committed until composition ends", () => {
  const target = { value: "ni", _composing: false };
  const start = { target };
  markCompositionStart(start);
  assert.equal(shouldCommitEditorInput({ isComposing: true, target }), false);
  assert.equal(target._composing, true);
  assert.equal(target._imeLive, true);
  markCompositionEnd({ target });
  assert.equal(target._composing, false);
  assert.equal(target._imeLive, false);
  assert.equal(shouldCommitEditorInput({ isComposing: false, target }), true);
});

test("ime value directive does not overwrite an active composition or direct-type session", () => {
  const element = { value: "n", _composing: true, _imeLive: false };
  vImeValue.updated(element, { value: "" });
  assert.equal(element.value, "n");
  element._composing = false;
  element._imeLive = true;
  vImeValue.updated(element, { value: "Alice" });
  assert.equal(element.value, "n");
  element._imeLive = false;
  vImeValue.updated(element, { value: "Alice" });
  assert.equal(element.value, "Alice");
});
