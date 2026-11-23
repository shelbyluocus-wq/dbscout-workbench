import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCellStructuredPreview } from "./cellStructuredPreview.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("buildCellStructuredPreview turns reward JSON arrays into cards with inline item names", () => {
  const raw = JSON.stringify([
    { ID: 61001, Num: 10 },
    { ID: 99999, Num: 1 },
  ]);
  const cellRelations = [
    {
      relation: { id: "r1", targetTable: "goodsprop", targetColumn: "ID", itemKey: "ID" },
      targetTable: "goodsprop",
      targetTableComment: "道具表",
      targets: [
        { value: "61001", state: "found", label: "英雄招募券" },
        { value: "99999", state: "missing", label: null },
      ],
    },
  ];

  const preview = buildCellStructuredPreview(raw, cellRelations);
  assert.equal(preview.kind, "json-array-objects");
  assert.equal(preview.canCardView, true);
  assert.equal(preview.cards.length, 2);
  assert.equal(preview.cards[0].entries[0].key, "ID");
  assert.equal(preview.cards[0].entries[0].target?.label, "英雄招募券");
  assert.equal(preview.cards[0].entries[0].target?.state, "found");
  assert.equal(preview.cards[0].entries[1].key, "Num");
  assert.equal(preview.cards[0].entries[1].target, null);
  assert.equal(preview.cards[1].entries[0].target?.state, "missing");
  assert.equal(preview.inlineTargets.length, 2);
});

test("buildCellStructuredPreview supports plain ID cells with outgoing relations and plain JSON objects", () => {
  const refOnly = buildCellStructuredPreview("61001", [
    {
      relation: { id: "r1", targetTable: "goodsprop", targetColumn: "ID" },
      targetTable: "goodsprop",
      targets: [{ value: "61001", state: "found", label: "英雄招募券" }],
    },
  ]);
  assert.equal(refOnly.kind, "refs");
  assert.equal(refOnly.canCardView, false);
  assert.equal(refOnly.inlineTargets[0].label, "英雄招募券");

  const obj = buildCellStructuredPreview('{"ItemID": 1001, "Count": 5}', []);
  assert.equal(obj.kind, "json-object");
  assert.equal(obj.canCardView, true);
  assert.equal(obj.cards[0].entries.length, 2);
});

test("cell detail relation lookup watches relation revision and clips long chip values", () => {
  const pane = fs.readFileSync(path.join(__dirname, "../components/WorkbenchPane.vue"), "utf8");
  assert.match(pane, /const cellRelationsRevision = computed\(/);
  assert.match(pane, /cellRelationsRevision\.value/);

  const css = fs.readFileSync(path.join(__dirname, "../workbench.css"), "utf8");
  const chipBlock = css.match(/\.wb-cell-detail-ref-chip\s*\{[^}]*\}/)?.[0] || "";
  assert.match(chipBlock, /overflow:\s*hidden/);
  const idBlock = css.match(/\.wb-cell-detail-ref-id\s*\{[^}]*\}/)?.[0] || "";
  assert.match(idBlock, /overflow:\s*hidden/);
  assert.match(idBlock, /text-overflow:\s*ellipsis/);
});
