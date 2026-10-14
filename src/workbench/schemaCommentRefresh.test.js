import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reactive, ref } from "vue";
import { applySchemaComment } from "./utils/applySchemaComment.js";
import { useConfigRelations } from "./composables/useConfigRelations.js";
import { useTableSession } from "./composables/useTableSession.js";
import { createWorkspaceState, findTableDataTabs, applyTableSchemaToDataTab, markTableDataTabSchemaStale } from "./workspaceState.js";

// Execute the actual shell handlers with controlled IO: this covers the
// right-click save -> schema reload -> relation rebuild -> jump boundary.
const shell = readFileSync(new URL("./MySqlWorkbench.vue", import.meta.url), "utf8");
const handler = (name, next) => shell.slice(shell.indexOf(`async function ${name}(`), shell.indexOf(next, shell.indexOf(`async function ${name}(`)));

test("right-click comment save refreshes both relation views and all open tabs without waiting for analysis", async () => {
  const source = { connectionId: "mysql-5", database: "newsg_4cfg", tableName: "shopprop" };
  const workspace = reactive(createWorkspaceState(source));
  let comment = "conditionplatprop";
  let indexed = comment;
  let revision = 1;
  let finishAnalysis;
  let listener;
  let writes = 0;
  let opens = 0;
  const schema = () => ({ table_name: source.tableName, columns: [{ column_name: "OpenCond", column_type: "text", column_comment: comment, is_nullable: true }] });
  const invoke = async (command, payload) => {
    if (command === "get_table_design") return schema();
    if (command === "preview_table_design_change") return { statements: ["ALTER TABLE"], previewSignature: "p", schemaSignature: "s" };
    if (command === "apply_table_design_change") {
      writes++;
      comment = payload.draft.columns[0].comment;
      return { schema: schema() };
    }
    if (command === "config_relations_overview") return { revision };
    if (command === "config_relations_table" || command === "config_relations_graph") return { revision, target: indexed };
    if (command === "config_relations_refresh") {
      finishAnalysis = () => { indexed = comment; revision++; listener({ payload: { ...source, revision } }); };
      return;
    }
    if (command === "open_table_session" || command === "fetch_table_page") {
      return { sessionId: payload.sessionId || `s${++opens}`, columns: schema().columns, rows: [], totalRows: 0, totalRowsExact: true, hasMore: false, page: 1, pageSize: 100 };
    }
    if (command === "close_table_session") return;
    throw new Error(command);
  };
  const relations = useConfigRelations({ invoke, listen: async (_, callback) => { listener = callback; return () => {}; }, debounceMs: 0 });
  const statusText = ref("");
  const session = useTableSession(workspace, invoke, { statusText });
  try {
    await relations.attach();
    await relations.loadOverview(source);
    await relations.tableRelations(source, source.tableName);
    await relations.relationGraph(source);
    await session.openTable(source);
    await session.openTable(source, { duplicate: true });
    const commentEdit = reactive({ ...source, open: true, saving: false, kind: "column", columnName: "OpenCond", error: "" });
    const context = {
      commentEdit, applySchemaComment, invokeWorkbench: invoke,
      designAppliedSource: () => source, findTableDataTabs, workspace,
      ensureTableSchema: async () => schema(), applyTableSchemaToDataTab,
      refreshTabPage: session.fetchPage, markTableDataTabSchemaStale, statusText,
      configRelations: relations, configRelationsAvailable: () => true,
      setStatus: () => {}, t: (key) => key,
    };
    const save = new Function(...Object.keys(context),
      handler("handleTableDesignApplied", "\nconst contextMenuRef") +
      handler("saveCommentEdit", "\nfunction deleteGridRow") + ";return saveCommentEdit;")(...Object.values(context));
    await save("conditionopencondprop");
    assert.equal(commentEdit.error, "");
    assert.equal(commentEdit.open, false, "saving closes before background analysis finishes");
    assert.equal(typeof finishAnalysis, "function", "saving must schedule relation analysis");
    finishAnalysis();
    await new Promise(setImmediate);
    assert.equal((await relations.tableRelations(source, source.tableName)).target, comment);
    assert.equal((await relations.relationGraph(source)).target, comment);
    assert.ok(workspace.tabs.every((tab) => tab.columns[0].column_comment === comment));
    const jumped = await session.openTable(source);
    assert.equal(jumped.columns[0].column_comment, "conditionopencondprop");
    assert.equal(writes, 1, "jumping must not write the old comment back");
  } finally {
    await session.dispose();
    relations.dispose();
  }
});
