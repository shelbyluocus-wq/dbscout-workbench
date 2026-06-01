import test from "node:test";
import assert from "node:assert/strict";
import * as sidebarDragPreview from "./sidebarDragPreview.js";

const { previewDragOrder, sameDragTarget } = sidebarDragPreview;

const connections = [{ id: "demo" }, { id: "mysql-1" }, { id: "mysql-2" }];
const connectionId = (connection) => connection.id;

test("previewDragOrder moves an item before the target", () => {
  assert.deepEqual(
    previewDragOrder(connections, "mysql-2", "demo", { position: "before", getKey: connectionId }).map(connectionId),
    ["mysql-2", "demo", "mysql-1"],
  );
});

test("previewDragOrder moves an item after the target", () => {
  assert.deepEqual(
    previewDragOrder(connections, "demo", "mysql-1", { position: "after", getKey: connectionId }).map(connectionId),
    ["mysql-1", "demo", "mysql-2"],
  );
});

test("previewDragOrder moves an earlier item after a later target", () => {
  assert.deepEqual(previewDragOrder(["a", "b", "c", "d"], "a", "c", { position: "after" }), ["b", "c", "a", "d"]);
});

test("previewDragOrder moves a later item before an earlier target", () => {
  assert.deepEqual(previewDragOrder(["a", "b", "c", "d"], "d", "b", { position: "before" }), ["a", "d", "b", "c"]);
});

test("previewDragOrder does not mutate the original list", () => {
  const input = [{ id: "a" }, { id: "b" }, { id: "c" }];

  assert.deepEqual(previewDragOrder(input, "c", "a", { position: "before", getKey: connectionId }).map(connectionId), ["c", "a", "b"]);
  assert.deepEqual(input.map(connectionId), ["a", "b", "c"]);
});

test("previewDragOrder leaves order unchanged when target is the source", () => {
  assert.deepEqual(
    previewDragOrder(connections, "mysql-1", "mysql-1", { position: "after", getKey: connectionId }).map(connectionId),
    ["demo", "mysql-1", "mysql-2"],
  );
});

test("previewDragOrder leaves order unchanged when source or target is missing", () => {
  assert.deepEqual(
    previewDragOrder(connections, "missing", "demo", { position: "before", getKey: connectionId }).map(connectionId),
    ["demo", "mysql-1", "mysql-2"],
  );
  assert.deepEqual(
    previewDragOrder(connections, "demo", "missing", { position: "before", getKey: connectionId }).map(connectionId),
    ["demo", "mysql-1", "mysql-2"],
  );
});

test("sameDragTarget compares kind, id, and position", () => {
  assert.equal(sameDragTarget({ kind: "database", id: "game", position: "before" }, "database", "game", "before"), true);
  assert.equal(sameDragTarget({ kind: "database", id: "game", position: "after" }, "database", "game", "before"), false);
  assert.equal(sameDragTarget({ kind: "connection", id: "game", position: "before" }, "database", "game", "before"), false);
});

test("resolvePreviewDropTarget uses the active preview target when the drop lands on the dragged source", () => {
  assert.deepEqual(
    sidebarDragPreview.resolvePreviewDropTarget({ sourceId: "demo", targetId: "mysql-1", targetPosition: "after" }, "demo"),
    { targetId: "mysql-1", position: "after" },
  );
});
