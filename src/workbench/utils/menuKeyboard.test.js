import test from "node:test";
import assert from "node:assert/strict";

import { focusMenuItem, handleMenuKeydown, menuItems } from "./menuKeyboard.js";

function fakeMenu(labels, { disabled = [] } = {}) {
  const document = { activeElement: null };
  const items = labels.map((label) => ({
    label,
    disabled: disabled.includes(label),
    getAttribute: () => null,
    focus() { document.activeElement = this; },
  }));
  const menu = {
    ownerDocument: document,
    querySelectorAll: () => items,
    focus() { document.activeElement = this; },
  };
  return { menu, document };
}

function keyEvent(key) {
  return {
    key,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
}

test("menu items skip disabled entries", () => {
  const { menu } = fakeMenu(["open", "rename", "delete"], { disabled: ["rename"] });
  assert.deepEqual(menuItems(menu).map((item) => item.label), ["open", "delete"]);
});

test("arrow keys wrap around enabled items and Home/End jump to the ends", () => {
  const { menu, document } = fakeMenu(["open", "rename", "copy", "delete"], { disabled: ["rename"] });
  focusMenuItem(menu, "first");
  assert.equal(document.activeElement.label, "open");

  handleMenuKeydown(keyEvent("ArrowDown"), menu);
  assert.equal(document.activeElement.label, "copy");
  handleMenuKeydown(keyEvent("ArrowDown"), menu);
  handleMenuKeydown(keyEvent("ArrowDown"), menu);
  assert.equal(document.activeElement.label, "open", "wraps to the first item");
  handleMenuKeydown(keyEvent("ArrowUp"), menu);
  assert.equal(document.activeElement.label, "delete", "wraps to the last item");
  handleMenuKeydown(keyEvent("Home"), menu);
  assert.equal(document.activeElement.label, "open");
  handleMenuKeydown(keyEvent("End"), menu);
  assert.equal(document.activeElement.label, "delete");
});

test("Escape and Tab close the menu; other keys pass through", () => {
  const { menu } = fakeMenu(["open"]);
  let closed = 0;
  const escape = keyEvent("Escape");
  assert.equal(handleMenuKeydown(escape, menu, { close: () => { closed += 1; } }), true);
  assert.equal(escape.prevented, true);
  assert.equal(escape.stopped, true);
  handleMenuKeydown(keyEvent("Tab"), menu, { close: () => { closed += 1; } });
  assert.equal(closed, 2);

  const enter = keyEvent("Enter");
  assert.equal(handleMenuKeydown(enter, menu, { close: () => { closed += 1; } }), false);
  assert.equal(enter.prevented, false, "Enter activates the focused item natively");
});

test("a menu without enabled items keeps focus on itself", () => {
  const { menu, document } = fakeMenu(["open"], { disabled: ["open"] });
  assert.equal(focusMenuItem(menu, "first"), false);
  assert.equal(document.activeElement, menu);
});
