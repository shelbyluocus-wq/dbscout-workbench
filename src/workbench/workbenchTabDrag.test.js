import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ref } from "vue";
import { isFolderDropCandidate, readFolderDrop, writeTableDrag } from "./utils/tableDragPayload.js";

const source = readFileSync(new URL("./components/WorkbenchTabs.vue", import.meta.url), "utf8");

function dragTab(tab) {
  const data = new Map();
  const event = { dataTransfer: {
    effectAllowed: "",
    get types() { return [...data.keys()]; },
    setData(type, value) { data.set(type, String(value)); },
    getData(type) { return data.get(type) || ""; },
  } };
  const draggingTabId = ref("");
  const factory = new Function("props", "draggingTabId", "dragTargetTabId", "dragTargetPosition", "writeTableDrag", `
    ${source.match(/function tabKind\(tab\) \{[\s\S]*?\n\}/)[0]}
    ${source.match(/function isTableLikeTab\(tab\) \{[\s\S]*?\n\}/)[0]}
    ${source.match(/function startTabDrag\(tabId, event\) \{[\s\S]*?\n\}/)[0]}
    return startTabDrag;
  `);
  factory({ tabs: [tab], paneId: "pane-1" }, draggingTabId, ref(""), ref("before"), writeTableDrag)(tab.id, event);
  return { event, draggingTabId };
}

test("table tabs carry folder references while preserving tab reorder data", () => {
  assert.match(source, /import \{ writeTableDrag \} from "\.\.\/utils\/tableDragPayload\.js"/);
  for (const kind of [undefined, "data", "design"]) {
    const { event, draggingTabId } = dragTab({ id: "tab-1", kind, connectionId: "mysql-2", database: "game", tableName: "goodsprop" });
    assert.equal(isFolderDropCandidate(event), true);
    assert.deepEqual(readFolderDrop(event), {
      kind: "tables", connectionId: "mysql-2", database: "game", tableNames: ["goodsprop"],
    });
    assert.equal(event.dataTransfer.effectAllowed, "copyMove");
    assert.equal(event.dataTransfer.getData("application/x-dbscout-tab"), "tab-1");
    assert.equal(event.dataTransfer.getData("application/x-dbscout-pane"), "pane-1");
    assert.equal(event.dataTransfer.getData("text/plain"), "tab-1");
    assert.equal(draggingTabId.value, "tab-1");
  }
});

test("non-table and incomplete tabs cannot be added to a folder", () => {
  for (const tab of [
    ...["home", "sql", "sql-library", "folders"].map((kind) => ({ kind, tableName: "goodsprop", database: "game" })),
    { kind: "data", database: "game" },
    { kind: "data", tableName: "goodsprop" },
  ]) {
    const { event } = dragTab({ id: "tab-1", ...tab });
    assert.equal(isFolderDropCandidate(event), false);
    assert.equal(readFolderDrop(event), null);
    assert.equal(event.dataTransfer.effectAllowed, "move");
  }
});

test("opening table tabs cannot start either drag operation", () => {
  const { event, draggingTabId } = dragTab({ id: "tab-1", kind: "data", opening: true, database: "game", tableName: "goodsprop" });
  assert.deepEqual(event.dataTransfer.types, []);
  assert.equal(draggingTabId.value, "");
});

test("folder drop accepts a tab from its database and rejects a different connection or database", () => {
  const folderSource = readFileSync(new URL("./components/TableFolderPage.vue", import.meta.url), "utf8");
  const folder = { id: "folder-1" };
  for (const target of [
    { connectionId: "mysql-2", database: "game" },
    { connectionId: "mysql-1", database: "game" },
    { connectionId: "mysql-2", database: "other" },
  ]) {
    const { event } = dragTab({ id: "tab-1", kind: "data", connectionId: "mysql-2", database: "game", tableName: "goodsprop" });
    const additions = [];
    const notices = [];
    event.preventDefault = () => {};
    const factory = new Function("dropTargetId", "contentDropActive", "readFolderDrop", "scope", "store", "reportAdded", "notify", "t", `
      ${folderSource.match(/function dropInto\(folder, event\) \{[\s\S]*?\n\}/)[0]}
      return dropInto;
    `);
    factory(ref("folder-1"), ref(true), readFolderDrop, ref(target), {
      addTables: (...args) => additions.push(args),
    }, () => {}, (...args) => notices.push(args), (key) => key)(folder, event);
    if (target.connectionId === "mysql-2" && target.database === "game") {
      assert.deepEqual(additions, [["folder-1", ["goodsprop"], target]]);
      assert.deepEqual(notices, []);
    } else {
      assert.deepEqual(additions, []);
      assert.deepEqual(notices, [["warning", "tableFolders.otherDatabase"]]);
    }
  }
});
