import test from "node:test";
import assert from "node:assert/strict";

import { databaseRelationGraph, localRelationGraph } from "./relationGraph.js";
import { CARD_TABLES_PER_SECTION, relationGraphCard } from "./relationGraphCard.js";

function edge(source, target, column = `${target}_id`, status = "confirmed") {
  return { id: `${source}.${column}>${target}.id`, sourceTable: source, sourceColumn: column, targetTable: target, targetColumn: "id", kind: "value", status };
}

const many = Array.from({ length: 70 }, (_, index) => edge(`user_${String(index).padStart(2, "0")}`, "item"));
const DATA = {
  edges: [...many, edge("item", "attr"), edge("item", "attr", "bonus_id", "stale"), edge("item", "item", "parent_id")],
  tables: { item: { name: "Item", comment: "道具表", columns: { attr_id: "属性ID" } }, attr: { name: "attr", comment: "属性表" } },
};

test("the card groups relations by the other table, with fields and the worst status", () => {
  const graph = localRelationGraph(DATA, "item", { depth: 1 });
  const card = relationGraphCard(graph, "item", { tables: DATA.tables, currentTable: "item" });
  assert.equal(card.name, "Item");
  assert.equal(card.comment, "道具表");
  assert.equal(card.side, "center");
  assert.equal(card.center, true);
  assert.equal(card.openable, false, "the table already open");
  const references = card.sections.find((section) => section.key === "references");
  assert.equal(references.tableCount, 1);
  assert.equal(references.fieldCount, 2);
  assert.equal(references.groups[0].status, "stale");
  assert.deepEqual(references.groups[0].fields.map((field) => field.from), ["attr_id", "bonus_id"]);
  const [attrField, bonusField] = references.groups[0].fields;
  assert.equal(attrField.fromName, "Item.attr_id");
  assert.equal(attrField.fromComment, "属性ID");
  assert.equal(attrField.toName, "attr.id");
  assert.equal(attrField.toComment, "");
  assert.equal(bonusField.fromComment, "", "a field without a comment has no card");
  assert.ok(card.sections.some((section) => section.key === "self"));
});

test("a hovered card keeps a few tables; a pinned one lists many more", () => {
  const graph = localRelationGraph(DATA, "item", { depth: 1 });
  const hover = relationGraphCard(graph, "item", { tables: DATA.tables });
  const referencedBy = (card) => card.sections.find((section) => section.key === "referencedBy");
  assert.equal(referencedBy(hover).groups.length, CARD_TABLES_PER_SECTION.hover);
  assert.equal(referencedBy(hover).more, 70 - CARD_TABLES_PER_SECTION.hover);
  const pinned = relationGraphCard(graph, "item", { tables: DATA.tables, pinned: true });
  assert.equal(referencedBy(pinned).groups.length, CARD_TABLES_PER_SECTION.pinned);
  assert.equal(referencedBy(pinned).more, 10);
});

test("centering is offered while exploring, for any table but the center", () => {
  const whole = databaseRelationGraph(DATA, "item");
  assert.equal(relationGraphCard(whole, "attr", { explore: true }).focusable, true);
  assert.equal(relationGraphCard(whole, "item", { explore: true }).focusable, false);
  assert.equal(relationGraphCard(whole, "attr").focusable, false);
  assert.equal(relationGraphCard(whole, "missing"), null);
  assert.equal(relationGraphCard(whole, ""), null);
});
