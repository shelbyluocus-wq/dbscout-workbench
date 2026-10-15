import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Run the real pane handler: the focused input exists even when the cell is
// only selected, so testing pasteGridText alone misses this routing boundary.
const pane = readFileSync(new URL("./components/WorkbenchPane.vue", import.meta.url), "utf8");
const start = pane.indexOf("async function handleGridPaste(");
const end = pane.indexOf("\nfunction matchesInsertedDraft(", start);
assert.ok(start >= 0 && end > start);

function setup(targetKind) {
  const calls = [];
  const context = {
    focusPane() {},
    activeDataTab: { value: { id: "selected-table" } },
    statusText: { value: "" },
    async pasteIntoEditingInput() { calls.push("editing-paste"); },
    async pasteGridText(text) { calls.push(["grid-paste", text]); return { ok: true }; },
  };
  const handlePaste = new Function(...Object.keys(context),
    pane.slice(start, end) + ";return handleGridPaste;",
  )(...Object.values(context));
  const input = {
    matches(selector) {
      if (selector === "input.wb-cell-ime-hold") return targetKind === "ime-hold";
      if (selector === "td.editing input") return targetKind === "editing";
      return false;
    },
  };
  const event = {
    target: { closest: () => targetKind === "grid" ? null : input },
    clipboardData: { getData: () => "copied value" },
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  };
  return { calls, handlePaste, event };
}

for (const target of ["ime-hold", "grid"]) {
  test(`paste on ${target} updates the selected cells and suppresses native input`, async () => {
    const { calls, handlePaste, event } = setup(target);
    await handlePaste(event);
    assert.deepEqual(calls, [["grid-paste", "copied value"]]);
    assert.equal(event.defaultPrevented, true);
  });
}

test("an actively edited cell retains its text/Excel paste handler", async () => {
  const { calls, handlePaste, event } = setup("editing");
  await handlePaste(event);
  assert.deepEqual(calls, ["editing-paste"]);
  assert.equal(event.defaultPrevented, false);
});

test("other editable inputs keep native text paste", async () => {
  const { calls, handlePaste, event } = setup("other-input");
  await handlePaste(event);
  assert.deepEqual(calls, []);
  assert.equal(event.defaultPrevented, false);
});
