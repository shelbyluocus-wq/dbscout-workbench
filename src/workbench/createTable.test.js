import test from "node:test";
import assert from "node:assert/strict";
import { nextTick, reactive, ref } from "vue";
import { onMockEvent } from "./mock/mockEventBus.js";
import { initialCreateTableDraft, validateCreateTableDraft, createTablePayload } from "./utils/createTable.js";
import { useTableDesign } from "./composables/useTableDesign.js";
import { mockWorkbenchInvoke, resetMockWorkbenchState } from "./mock/mockBackend.js";
import { createWorkspaceState, openCreateTableTab } from "./workspaceState.js";
import { buildWorkspaceSnapshot, parseWorkspaceSnapshot } from "./utils/workspacePersistence.js";
import { formatTableTabTitle } from "./utils/tabDisplay.js";

const scope = { connectionId: "demo", database: "game_db" };
function request(name = "new_rewards") {
  const draft = initialCreateTableDraft();
  draft.tableName = name;
  return createTablePayload(scope, draft);
}

test("create validates names and keeps the source scope explicit", () => {
  const draft = initialCreateTableDraft();
  assert.equal(validateCreateTableDraft(draft).valid, false);
  for (const name of ["good_name", "_a", "A".repeat(64)]) {
    draft.tableName = name;
    assert.equal(validateCreateTableDraft(draft).valid, true);
    assert.equal(createTablePayload(scope, draft).tableName, name);
  }
  for (const name of ["1bad", "a;DROP", "a".repeat(65), "a b"]) {
    draft.tableName = name;
    assert.equal(validateCreateTableDraft(draft).valid, false);
  }
});

test("independent creation tabs persist drafts without preview authority", () => {
  const workspace = reactive(createWorkspaceState(scope));
  const first = openCreateTableTab(workspace, scope);
  const second = openCreateTableTab(workspace, scope);
  assert.notEqual(first.tabKey, second.tabKey);
  first.draft.tableName = "new_rewards";
  first.preview = { previewSignature: "never-restore-this" };
  const snapshot = parseWorkspaceSnapshot(buildWorkspaceSnapshot(workspace));
  assert.equal(snapshot.tabs[0].createMode, true);
  assert.equal(snapshot.tabs[0].draft.tableName, "new_rewards");
  assert.equal(snapshot.tabs[0].preview, undefined);
  const restored = openCreateTableTab(workspace, { ...scope, draft: snapshot.tabs[0].draft });
  assert.equal(restored.draft.columns[0].originalName, "");
  assert.equal(formatTableTabTitle(restored), "new_rewards @game_db");
  assert.equal(second.draft.tableName, "");
});

test("mock preview is read-only, signature-bound and creates an empty table only once", async () => {
  resetMockWorkbenchState();
  const definition = request();
  const before = await mockWorkbenchInvoke("list_tables", scope);
  const preview = await mockWorkbenchInvoke("preview_create_table", { request: definition });
  assert.match(preview.statements[0], /^CREATE TABLE `game_db`.`new_rewards`/);
  assert.deepEqual(await mockWorkbenchInvoke("list_tables", scope), before);
  for (const changes of [{}, { confirmed: false }, { confirmed: true, previewSignature: "old" }, { confirmed: true, tableName: "different" }]) {
    await assert.rejects(mockWorkbenchInvoke("create_table", { request: { ...definition, previewSignature: preview.previewSignature, ...changes } }), /预览.*确认/);
  }
  const result = await mockWorkbenchInvoke("create_table", { request: { ...definition, previewSignature: preview.previewSignature, confirmed: true } });
  assert.equal(result.applied, true);
  assert.equal(result.schema.columns[0].column_name, "ID");
  const page = await mockWorkbenchInvoke("open_table_session", { ...scope, tableName: "new_rewards", options: { page: 1, pageSize: 10 } });
  assert.deepEqual(page.rows, []);
  assert.equal(page.totalRows, 0);
  await assert.rejects(mockWorkbenchInvoke("preview_create_table", { request: definition }), /同名/);
  await assert.rejects(mockWorkbenchInvoke("create_table", { request: { ...definition, previewSignature: preview.previewSignature, confirmed: true } }), /同名/);
  await assert.rejects(mockWorkbenchInvoke("preview_create_table", { request: { ...request("another"), connectionId: "demo-mongo" } }), /MongoDB/);
});

test("create editor loads locally, invalidates edited previews, and reports completion once", async () => {
  resetMockWorkbenchState();
  const workspace = reactive(createWorkspaceState(scope));
  const source = reactive(openCreateTableTab(workspace, scope));
  const calls = [];
  const events = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    return mockWorkbenchInvoke(command, payload);
  };
  const editor = useTableDesign(invoke, source, { onApplied: (event) => events.push(event) });
  await editor.loadDesign({ force: true });
  assert.equal(calls.length, 0);
  assert.equal(editor.dirty.value, false);
  assert.equal(editor.draft.columns[0].originalName, "");
  editor.draft.tableName = "draft_table";
  await editor.previewDesign();
  editor.draft.tableComment = "edited";
  await assert.rejects(editor.applyDesign(), /先预览/);
  assert.equal(calls.filter((call) => call.command === "create_table").length, 0);
  await editor.loadDesign({ force: true });
  assert.equal(editor.draft.tableName, "draft_table");
  assert.equal(editor.draft.columns[0].originalName, "");
  await editor.previewDesign();
  const firstApply = editor.applyDesign();
  assert.equal(await editor.applyDesign(), null);
  await firstApply;
  assert.equal(events.length, 1);
  assert.equal(events[0].created, true);
  assert.equal(events[0].source.tableName, "draft_table");
  assert.equal(events[0].tabId, source.id);
  assert.equal(editor.dirty.value, false);
  assert.equal(source.saving, false);
  assert.equal(source.createMode, false);
  assert.equal(source.tableName, "draft_table");
  assert.equal(calls.find((call) => call.command === "create_table").payload.request.confirmed, true);
});

test("failed creation preserves the draft for correction", async () => {
  resetMockWorkbenchState();
  const source = reactive(openCreateTableTab(createWorkspaceState(scope), scope));
  const editor = useTableDesign(mockWorkbenchInvoke, source);
  await editor.loadDesign();
  editor.draft.tableName = "player";
  await assert.rejects(editor.previewDesign(), /同名/);
  assert.equal(editor.draft.tableName, "player");
  assert.equal(editor.dirty.value, true);
  assert.equal(editor.previewOpen.value, false);
  editor.resetDraft();
  assert.equal(editor.draft.columns[0].originalName, "");
  assert.equal(editor.dirty.value, false);
});

test("creation completes its original tab when the user changes sources during save", async () => {
  resetMockWorkbenchState();
  const workspace = reactive(createWorkspaceState(scope));
  const first = reactive(openCreateTableTab(workspace, scope));
  const second = reactive(openCreateTableTab(workspace, scope));
  const current = ref(first);
  let finish;
  const invoke = (command, payload) => command === "create_table"
    ? new Promise((resolve) => { finish = () => resolve(mockWorkbenchInvoke(command, payload)); })
    : mockWorkbenchInvoke(command, payload);
  const events = [];
  const editor = useTableDesign(invoke, current, { onApplied: (event) => events.push(event) });
  await editor.loadDesign();
  editor.draft.tableName = "background_table";
  await editor.previewDesign();
  const applying = editor.applyDesign();
  current.value = second;
  await editor.loadDesign();
  const remounted = useTableDesign(invoke, first);
  assert.equal(remounted.saving.value, true);
  finish();
  await applying;
  await nextTick();
  assert.equal(first.createMode, false);
  assert.equal(first.tableName, "background_table");
  assert.equal(first.saving, false);
  assert.equal(second.createMode, true);
  assert.equal(second.draft.tableName, "");
  assert.equal(remounted.saving.value, false);
  assert.equal(remounted.draft.tableName, "background_table");
  assert.equal(events.length, 1);
});

test("creation publishes a scoped refresh event only after the table exists", async () => {
  resetMockWorkbenchState();
  const events = [];
  const unlisten = onMockEvent("table-created", (event) => events.push(event.payload));
  try {
    const definition = request("event_table");
    const preview = await mockWorkbenchInvoke("preview_create_table", { request: definition });
    assert.equal(events.length, 0);
    await mockWorkbenchInvoke("create_table", { request: { ...definition, confirmed: true, previewSignature: preview.previewSignature } });
    assert.deepEqual(events, [{ ...scope, tableName: "event_table", warnings: [] }]);
  } finally {
    unlisten();
  }
});

test("a failed pending create unlocks a remounted editor and preserves the error", async () => {
  resetMockWorkbenchState();
  const source = reactive(openCreateTableTab(createWorkspaceState(scope), scope));
  let rejectCreate;
  const invoke = (command, payload) => command === "create_table"
    ? new Promise((resolve, reject) => { rejectCreate = reject; })
    : mockWorkbenchInvoke(command, payload);
  const editor = useTableDesign(invoke, source);
  await editor.loadDesign();
  editor.draft.tableName = "retry_table";
  await editor.previewDesign();
  const applying = editor.applyDesign();
  const remounted = useTableDesign(invoke, source);
  const rejected = assert.rejects(applying, /connection lost/);
  rejectCreate(new Error("connection lost"));
  await rejected;
  await nextTick();
  assert.equal(source.createMode, true);
  assert.equal(remounted.saving.value, false);
  assert.equal(remounted.error.value, "connection lost");
  assert.equal(remounted.draft.tableName, "retry_table");
});
