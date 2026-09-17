import test from "node:test";
import assert from "node:assert/strict";

import { createTabShortcutHintController } from "./composables/useTabShortcutHints.js";

function createTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler) {
      const list = listeners.get(type) || [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = (listeners.get(type) || []).filter((item) => item !== handler);
      listeners.set(type, list);
    },
    emit(type, event) {
      for (const handler of listeners.get(type) || []) handler(event);
    },
  };
}

test("holding Ctrl or Command shows tab shortcut hints until the modifier is released", () => {
  const target = createTarget();
  const hints = createTabShortcutHintController({
    target,
    documentTarget: target,
  });
  hints.bind();

  assert.equal(hints.hintsVisible.value, false);
  target.emit("keydown", { key: "Control", ctrlKey: true, metaKey: false });
  assert.equal(hints.hintsVisible.value, true);
  target.emit("keydown", { key: "1", ctrlKey: true, metaKey: false });
  assert.equal(hints.hintsVisible.value, true);
  target.emit("keyup", { key: "Control", ctrlKey: false, metaKey: false });
  assert.equal(hints.hintsVisible.value, false);

  target.emit("keydown", { key: "Meta", ctrlKey: false, metaKey: true });
  assert.equal(hints.hintsVisible.value, true);
  target.emit("keyup", { key: "1", ctrlKey: false, metaKey: true });
  assert.equal(hints.hintsVisible.value, true);
  target.emit("keyup", { key: "Meta", ctrlKey: false, metaKey: false });
  assert.equal(hints.hintsVisible.value, false);
});

test("window blur and hidden documents clear leftover tab shortcut hints", () => {
  const target = createTarget();
  const documentTarget = createTarget();
  documentTarget.hidden = false;
  const hints = createTabShortcutHintController({
    target,
    documentTarget,
  });
  hints.bind();

  target.emit("keydown", { key: "Control", ctrlKey: true });
  assert.equal(hints.hintsVisible.value, true);
  target.emit("blur", {});
  assert.equal(hints.hintsVisible.value, false);

  target.emit("keydown", { key: "Control", ctrlKey: true });
  documentTarget.hidden = true;
  documentTarget.emit("visibilitychange", {});
  assert.equal(hints.hintsVisible.value, false);

  hints.unbind();
  assert.equal(target.listeners.get("keydown")?.length || 0, 0);
  assert.equal(hints.hintsVisible.value, false);
});
