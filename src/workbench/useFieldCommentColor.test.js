import test from "node:test";
import assert from "node:assert/strict";

import { createFieldCommentColorController } from "./composables/useFieldCommentColor.js";

function memoryStorage() {
  const values = {};
  return {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => { values[key] = String(value); },
    removeItem: (key) => { delete values[key]; },
    values,
  };
}

test("field comment colors persist independently for light and dark themes", () => {
  const storage = memoryStorage();
  const applied = new Map();
  const root = { style: { setProperty: (key, value) => applied.set(key, value), removeProperty: (key) => applied.delete(key) } };
  let theme = "light";
  const controller = createFieldCommentColorController({ storage, root, getTheme: () => theme });

  controller.setColor("#123456");
  theme = "dark";
  controller.syncTheme();
  controller.setColor("#abcdef");
  theme = "light";
  controller.syncTheme();

  assert.equal(controller.color.value, "#123456");
  assert.equal(applied.get("--wb-field-comment-custom"), "#123456");
  assert.equal(storage.values.dbscout_field_comment_color_dark, "#abcdef");

  controller.clear();
  assert.equal(applied.has("--wb-field-comment-custom"), false);
});
