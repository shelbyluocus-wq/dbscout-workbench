import test from "node:test";
import assert from "node:assert/strict";
import { nextTick, reactive, ref } from "vue";

import { useTableDesign } from "./composables/useTableDesign.js";

const designMeta = {
  table_name: "items",
  table_comment: "道具表",
  columns: [
    { column_name: "id", column_type: "bigint", is_nullable: false, is_primary_key: true, primary_key_ordinal: 1, column_default: null, column_comment: "主键" },
    { column_name: "name", column_type: "varchar(64)", is_nullable: true, is_primary_key: false, column_default: "", column_comment: "名称" },
  ],
};

function createHarness({ invoke, onApplied } = {}) {
  const calls = [];
  const fakeInvoke = invoke || (async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_design") return designMeta;
    if (command === "preview_table_design_change") {
      return {
        signature: "preview-signature",
        sourceSignature: "source-signature",
        statements: ["ALTER TABLE `items` COMMENT = '道具配置'"],
        warnings: ["预览 SQL 后请确认"],
      };
    }
    if (command === "apply_table_design_change") {
      return {
        schema: {
          ...designMeta,
          table_comment: payload.draft.tableComment,
        },
        applied: true,
      };
    }
    throw new Error(`unexpected command ${command}`);
  });
  const source = reactive({ connectionId: "mysql-1", database: "game", tableName: "items" });
  const design = useTableDesign(fakeInvoke, source, { onApplied });
  return { calls, source, design };
}

test("loadDesign requests metadata with the table source and normalizes the draft", async () => {
  const { calls, design } = createHarness();

  await design.loadDesign();

  assert.deepEqual(calls[0], {
    command: "get_table_design",
    payload: { connectionId: "mysql-1", database: "game", tableName: "items" },
  });
  assert.equal(design.loading.value, false);
  assert.equal(design.error.value, "");
  assert.equal(design.original.value.tableName, "items");
  assert.equal(design.draft.tableComment, "道具表");
  assert.equal(design.draft.columns[1].length, "64");
  assert.equal(design.dirty.value, false);
});

test("dirty state turns true after editing the draft", async () => {
  const { design } = createHarness();
  await design.loadDesign();

  design.draft.tableComment = "道具配置";
  await nextTick();

  assert.equal(design.dirty.value, true);
});

test("late loadDesign responses for an old source do not overwrite the current source draft", async () => {
  let resolveItems;
  let resolveOrders;
  const calls = [];
  const invoke = (command, payload) => {
    calls.push({ command, payload: { ...payload } });
    if (command !== "get_table_design") throw new Error(`unexpected command ${command}`);
    if (payload.tableName === "items") {
      return new Promise((resolve) => {
        resolveItems = () => resolve({
          table_name: "items",
          table_comment: "late items design",
          columns: [{ column_name: "item_id", column_type: "bigint", is_primary_key: true, is_nullable: false }],
        });
      });
    }
    if (payload.tableName === "orders") {
      return new Promise((resolve) => {
        resolveOrders = () => resolve({
          table_name: "orders",
          table_comment: "current orders design",
          columns: [{ column_name: "order_id", column_type: "bigint", is_primary_key: true, is_nullable: false }],
        });
      });
    }
    throw new Error(`unexpected table ${payload.tableName}`);
  };
  const source = reactive({ connectionId: "mysql-1", database: "game", tableName: "items" });
  const design = useTableDesign(invoke, source);

  const firstLoad = design.loadDesign();
  source.tableName = "orders";
  const secondLoad = design.loadDesign();
  resolveOrders();
  await secondLoad;
  resolveItems();
  await firstLoad;

  assert.deepEqual(calls.map((call) => call.payload.tableName), ["items", "orders"]);
  assert.equal(design.original.value.tableName, "orders");
  assert.equal(design.draft.tableName, "orders");
  assert.equal(design.draft.tableComment, "current orders design");
  assert.equal(design.draft.columns[0].name, "order_id");
  assert.equal(design.loading.value, false);
});

test("late previewDesign responses for an old source do not overwrite the current source preview", async () => {
  let resolveItems;
  const calls = [];
  const invoke = (command, payload) => {
    calls.push({ command, payload: { ...payload } });
    if (command === "get_table_design") {
      if (payload.tableName === "items") return designMeta;
      if (payload.tableName === "orders") {
        return {
          table_name: "orders",
          table_comment: "orders design",
          columns: [{ column_name: "order_id", column_type: "bigint", is_primary_key: true, is_nullable: false }],
        };
      }
    }
    if (command === "preview_table_design_change" && payload.tableName === "items") {
      return new Promise((resolve) => {
        resolveItems = () => resolve({
          signature: "items-preview-signature",
          sourceSignature: "items-source-signature",
          statements: ["ALTER TABLE `items` COMMENT = 'late items preview'"],
          warnings: [],
        });
      });
    }
    throw new Error(`unexpected ${command} for ${payload.tableName}`);
  };
  const itemsTab = reactive({ connectionId: "mysql-1", database: "game", tableName: "items" });
  const ordersTab = reactive({ connectionId: "mysql-1", database: "game", tableName: "orders" });
  const source = ref(itemsTab);
  const design = useTableDesign(invoke, source);
  await design.loadDesign();
  design.draft.tableComment = "queued items preview";
  await nextTick();

  const pendingPreview = design.previewDesign();
  source.value = ordersTab;
  await design.loadDesign({ force: true });
  resolveItems();
  const previewResult = await pendingPreview;

  assert.equal(previewResult, null);
  assert.deepEqual(calls.map((call) => `${call.command}:${call.payload.tableName}`), [
    "get_table_design:items",
    "preview_table_design_change:items",
    "get_table_design:orders",
  ]);
  assert.equal(design.draft.tableName, "orders");
  assert.equal(design.draft.tableComment, "orders design");
  assert.equal(design.previewOpen.value, false);
  assert.equal(design.preview.value.signature, null);
  assert.deepEqual(design.preview.value.statements, []);
  assert.equal(ordersTab.preview?.signature ?? null, null);
  assert.equal(itemsTab.preview?.signature ?? null, null);
  assert.equal(itemsTab.loading, false);
});

test("late applyDesign responses for an old source do not overwrite the current source or emit the new source", async () => {
  let resolveItemsApply;
  const appliedEvents = [];
  const calls = [];
  const invoke = (command, payload) => {
    calls.push({ command, payload: { ...payload } });
    if (command === "get_table_design") {
      if (payload.tableName === "items") return designMeta;
      if (payload.tableName === "orders") {
        return {
          table_name: "orders",
          table_comment: "orders design",
          columns: [{ column_name: "order_id", column_type: "bigint", is_primary_key: true, is_nullable: false }],
        };
      }
    }
    if (command === "preview_table_design_change" && payload.tableName === "items") {
      return {
        previewSignature: "items-preview-signature",
        schemaSignature: "items-schema-signature",
        statements: ["ALTER TABLE `items` COMMENT = 'queued items apply'"],
        warnings: [],
      };
    }
    if (command === "apply_table_design_change" && payload.tableName === "items") {
      return new Promise((resolve) => {
        resolveItemsApply = () => resolve({
          applied: true,
          schema: {
            table_name: "items",
            table_comment: "late applied items design",
            columns: [{ column_name: "item_id", column_type: "bigint", is_primary_key: true, is_nullable: false }],
          },
        });
      });
    }
    throw new Error(`unexpected ${command} for ${payload.tableName}`);
  };
  const itemsTab = reactive({ connectionId: "mysql-1", database: "game", tableName: "items" });
  const ordersTab = reactive({ connectionId: "mysql-1", database: "game", tableName: "orders" });
  const source = ref(itemsTab);
  const design = useTableDesign(invoke, source, { onApplied: (event) => appliedEvents.push(event) });
  await design.loadDesign();
  design.draft.tableComment = "queued items apply";
  await nextTick();
  await design.previewDesign();

  const pendingApply = design.applyDesign();
  source.value = ordersTab;
  await design.loadDesign({ force: true });
  resolveItemsApply();
  const applyResult = await pendingApply;

  assert.equal(applyResult, null);
  assert.deepEqual(calls.map((call) => `${call.command}:${call.payload.tableName}`), [
    "get_table_design:items",
    "preview_table_design_change:items",
    "apply_table_design_change:items",
    "get_table_design:orders",
  ]);
  assert.equal(design.schema.value.table_name, "orders");
  assert.equal(design.draft.tableName, "orders");
  assert.equal(design.draft.tableComment, "orders design");
  assert.equal(design.previewOpen.value, false);
  assert.equal(design.saving.value, false);
  assert.equal(ordersTab.saving, false);
  assert.equal(itemsTab.saving, false);
  assert.equal(appliedEvents.length, 0);
});

test("dirty draft state persists on the design tab object when switching away and back", async () => {
  const source = reactive({
    id: "tab-design-items",
    kind: "design",
    connectionId: "mysql-1",
    database: "game",
    tableName: "items",
    tableComment: "道具表",
    loading: false,
    saving: false,
    error: "",
    design: null,
    draft: null,
    dirty: false,
    preview: "",
  });
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_design") return designMeta;
    throw new Error(`unexpected command ${command}`);
  };

  const firstInstance = useTableDesign(invoke, source);
  await firstInstance.loadDesign();
  firstInstance.draft.tableComment = "dirty draft kept on tab";
  firstInstance.draft.columns[1].length = "128";
  await nextTick();

  assert.equal(source.dirty, true);
  assert.equal(source.draft.tableComment, "dirty draft kept on tab");
  assert.equal(source.draft.columns[1].length, "128");

  const secondInstance = useTableDesign(invoke, source);

  assert.equal(secondInstance.draft.tableComment, "dirty draft kept on tab");
  assert.equal(secondInstance.draft.columns[1].length, "128");
  assert.equal(secondInstance.dirty.value, true);
  assert.equal(calls.length, 1);
});

test("applyDesign refuses to apply before a preview exists", async () => {
  const { calls, design } = createHarness();
  await design.loadDesign();

  await assert.rejects(() => design.applyDesign(), /请先预览/);
  assert.match(design.error.value, /请先预览/);
  assert.equal(calls.some((call) => call.command === "apply_table_design_change"), false);
});

test("validation errors block preview and skip the backend", async () => {
  const { calls, design } = createHarness();
  await design.loadDesign();
  design.draft.columns[0].name = "";

  const result = await design.previewDesign();

  assert.equal(result, null);
  assert.equal(design.previewOpen.value, false);
  assert.equal(design.validationErrors.value.valid, false);
  assert.equal(calls.some((call) => call.command === "preview_table_design_change"), false);
});

test("previewDesign records backend failures and clears stale preview", async () => {
  const calls = [];
  let previewAttempts = 0;
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_design") return designMeta;
    if (command === "preview_table_design_change") {
      previewAttempts += 1;
      if (previewAttempts === 1) {
        return {
          signature: "stale-preview-signature",
          sourceSignature: "stale-source-signature",
          statements: ["ALTER TABLE `items` COMMENT = 'stale'"],
          warnings: [],
        };
      }
      throw new Error("preview failed");
    }
    throw new Error(`unexpected command ${command}`);
  };
  const { design } = createHarness({ invoke });
  await design.loadDesign();
  design.draft.tableComment = "道具配置";
  await nextTick();
  await design.previewDesign();

  await assert.rejects(() => design.previewDesign(), /preview failed/);

  assert.equal(design.error.value, "preview failed");
  assert.equal(design.previewOpen.value, false);
  assert.equal(design.preview.value.signature, null);
  assert.deepEqual(design.preview.value.statements, []);
  assert.equal(calls.filter((call) => call.command === "preview_table_design_change").length, 2);
});

test("applyDesign refuses previews without both preview and schema signatures", async () => {
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_design") return designMeta;
    if (command === "preview_table_design_change") {
      return {
        signature: "preview-signature-only",
        statements: ["ALTER TABLE `items` COMMENT = '道具配置'"],
        warnings: [],
      };
    }
    if (command === "apply_table_design_change") {
      return { applied: true, schema: designMeta };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const { design } = createHarness({ invoke });
  await design.loadDesign();
  design.draft.tableComment = "道具配置";
  await nextTick();
  await design.previewDesign();

  await assert.rejects(() => design.applyDesign(), /签名/);
  assert.match(design.error.value, /签名/);

  assert.equal(calls.some((call) => call.command === "apply_table_design_change"), false);
});

test("conflicting previews expose blocking feedback and skip apply", async () => {
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_design") return designMeta;
    if (command === "preview_table_design_change") {
      return {
        previewSignature: "conflict-preview-signature",
        schemaSignature: "conflict-schema-signature",
        statements: ["ALTER TABLE `items` CHANGE COLUMN `name` `name` int(11) NULL"],
        warnings: [],
        conflicts: ["字段「name」：文本改为整数可能导致数据丢失"],
      };
    }
    if (command === "apply_table_design_change") {
      return { applied: true, schema: designMeta };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const { design, source } = createHarness({ invoke });
  await design.loadDesign();
  design.draft.columns[1].type = "int";
  design.draft.columns[1].length = "11";
  await nextTick();

  await design.previewDesign();

  assert.match(design.error.value, /冲突|无法保存/);
  assert.deepEqual(design.preview.value.conflicts, ["字段「name」：文本改为整数可能导致数据丢失"]);
  await assert.rejects(() => design.applyDesign(), /冲突|无法保存/);
  assert.equal(calls.some((call) => call.command === "apply_table_design_change"), false);
  assert.equal(design.saving.value, false);
  assert.equal(source.saving, false);
});

test("editing a draft clears stale conflicting preview feedback", async () => {
  const invoke = async (command) => {
    if (command === "get_table_design") return designMeta;
    if (command === "preview_table_design_change") {
      return {
        previewSignature: "conflict-preview-signature",
        schemaSignature: "conflict-schema-signature",
        statements: ["ALTER TABLE `items` CHANGE COLUMN `name` `name` int(11) NULL"],
        warnings: [],
        conflicts: ["字段「name」：文本改为整数可能导致数据丢失"],
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const { design, source } = createHarness({ invoke });
  await design.loadDesign();
  design.draft.columns[1].type = "int";
  design.draft.columns[1].length = "11";
  await nextTick();
  await design.previewDesign();

  design.draft.columns[1].type = "varchar";
  design.draft.columns[1].length = "64";
  await nextTick();

  assert.equal(design.error.value, "");
  assert.equal(design.previewOpen.value, false);
  assert.equal(design.preview.value.signature, null);
  assert.deepEqual(design.preview.value.conflicts, []);
  assert.deepEqual(source.preview.conflicts, []);
});

test("applyDesign accepts backend previewSignature and schemaSignature payloads", async () => {
  const calls = [];
  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === "get_table_design") return designMeta;
    if (command === "preview_table_design_change") {
      return {
        previewSignature: "planned-preview-signature",
        schemaSignature: "planned-schema-signature",
        statements: ["ALTER TABLE `items` COMMENT = '道具配置'"],
        warnings: [],
      };
    }
    if (command === "apply_table_design_change") {
      return { applied: true, schema: designMeta };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const { design } = createHarness({ invoke });
  await design.loadDesign();
  design.draft.tableComment = "道具配置";
  await nextTick();
  await design.previewDesign();

  await design.applyDesign();

  const applyCall = calls.find((call) => call.command === "apply_table_design_change");
  assert.equal(applyCall.payload.previewSignature, "planned-preview-signature");
  assert.equal(applyCall.payload.schemaSignature, "planned-schema-signature");
  assert.equal(Object.hasOwn(applyCall.payload, "sourceSignature"), false);
});

test("previewDesign stores SQL preview and applyDesign clears dirty and calls onApplied", async () => {
  const appliedEvents = [];
  const { calls, design } = createHarness({ onApplied: (event) => appliedEvents.push(event) });
  await design.loadDesign();
  design.draft.tableComment = "道具配置";
  await nextTick();

  const preview = await design.previewDesign();
  const result = await design.applyDesign();

  assert.deepEqual(calls.map((call) => call.command), [
    "get_table_design",
    "preview_table_design_change",
    "apply_table_design_change",
  ]);
  const applyCall = calls.find((call) => call.command === "apply_table_design_change");
  assert.equal(preview.signature, "preview-signature");
  assert.equal(applyCall.payload.previewSignature, "preview-signature");
  assert.equal(applyCall.payload.sourceSignature, "source-signature");
  assert.equal(Object.hasOwn(applyCall.payload, "schemaSignature"), false);
  assert.equal(design.preview.value.signature, null);
  assert.equal(design.previewOpen.value, false);
  assert.equal(design.dirty.value, false);
  assert.equal(design.draft.tableComment, "道具配置");
  assert.equal(result.applied, true);
  assert.equal(appliedEvents.length, 1);
  assert.equal(appliedEvents[0].schema.table_comment, "道具配置");
  assert.equal(appliedEvents[0].source.tableName, "items");
});

test("addColumn appends a new column with an empty originalName (#6)", async () => {
  const { design } = createHarness();
  await design.loadDesign();
  const before = design.draft.columns.length;

  design.addColumn();

  assert.equal(design.draft.columns.length, before + 1);
  const column = design.draft.columns[before];
  assert.equal(column.originalName, "");
  assert.equal(column.name, "");
  assert.equal(column.type, "varchar");
  assert.equal(column.nullable, true);
  assert.equal(column.primaryKey, false);
  assert.equal(design.isNewColumn(column), true);
  assert.equal(design.dirty.value, true);
});

test("addColumn accepts an insertion index", async () => {
  const { design } = createHarness();
  await design.loadDesign();

  design.addColumn(0);

  assert.equal(design.draft.columns[0].name, "");
  assert.equal(design.isNewColumn(design.draft.columns[0]), true);
});

test("removeColumn removes existing and new columns while keeping one field", async () => {
  const { design } = createHarness();
  await design.loadDesign();
  const existingCount = design.draft.columns.length;

  assert.equal(design.removeColumn(0), true);
  assert.equal(design.draft.columns.length, existingCount - 1);

  design.addColumn();
  assert.equal(design.draft.columns.length, existingCount);
  assert.equal(design.removeColumn(existingCount - 1), true);
  assert.equal(design.draft.columns.length, existingCount - 1);

  while (design.draft.columns.length > 1) {
    assert.equal(design.removeColumn(0), true);
  }
  assert.equal(design.removeColumn(0), false);
  assert.equal(design.draft.columns.length, 1);
});

test("togglePrimaryKey appends, removes, and compacts composite primary-key order", async () => {
  const { design } = createHarness();
  await design.loadDesign();
  const first = design.draft.columns[0];
  const second = design.draft.columns[1];

  assert.equal(first.primaryKeyOrdinal, 1);
  assert.equal(design.togglePrimaryKey(second), true);
  assert.equal(second.primaryKey, true);
  assert.equal(second.primaryKeyOrdinal, 2);
  assert.equal(second.nullable, false);

  assert.equal(design.togglePrimaryKey(first), false);
  assert.equal(first.primaryKey, false);
  assert.equal(first.primaryKeyOrdinal, null);
  assert.equal(second.primaryKeyOrdinal, 1);
});

test("removeColumn ignores out-of-range indices", async () => {
  const { design } = createHarness();
  await design.loadDesign();

  assert.equal(design.removeColumn(999), false);
  assert.equal(design.removeColumn(-1), false);
});
