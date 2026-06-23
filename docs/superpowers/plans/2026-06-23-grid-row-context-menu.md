# 行号右键菜单：往上新增行 / 删除行 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在数据网格行号处右键弹出菜单，含「往上新增行」（在该行正上方插入可编辑草稿行并聚焦首列）与「删除行」两项，只读连接隐藏这两项。

**Architecture:** 复用全局 `ContextMenu.vue`，新增 `kind='grid-row'` 分支。草稿行仍由 `useGridEditor` 的 `insertDrafts` 管理，给草稿对象加 `anchorIndex` 字段标记视觉插入位置；`DataGrid.vue` 渲染时把 anchored 草稿行插入到对应数据行之前，末尾追加草稿行保持不变。提交链路完全复用现有 `commitInsertRow`。删除行复用 `useRowSelection.deleteRow`。

**Tech Stack:** Vue 3 (Composition API, `<script setup>`)，`node:test`/`node:assert/strict`，Tauri bridge。

**Spec:** `docs/superpowers/specs/2026-06-23-grid-row-context-menu-design.md`

---

## 文件结构

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/workbench/composables/useGridEditor.js` | 草稿行状态机：加 `anchorIndex`、新增 `insertDraftAbove`、`getInsertRows`/`insertPosition` 适配 | 修改 |
| `src/workbench/composables/useContextMenu.js` | 上下文菜单状态：加 `grid-row` kind 与行级字段、新增 `openRowContextMenu` | 修改 |
| `src/workbench/components/ContextMenu.vue` | 菜单 UI：加 `grid-row` 分支两项 | 修改 |
| `src/workbench/components/DataGrid.vue` | 数据网格：行号加 `@contextmenu`、emits 加 `row-contextmenu`、草稿行按 anchor 渲染 | 修改 |
| `src/workbench/components/WorkbenchPane.vue` | 转发 `row-contextmenu` 事件 | 修改 |
| `src/workbench/MySqlWorkbench.vue` | 接线：`openRowContextMenu`、ContextMenu props/events | 修改 |
| `src/workbench/useGridEditor.test.js` | `insertDraftAbove` 单测 | 修改 |
| `src/workbench/useContextMenu.test.js` | `openRowContextMenu` 单测 | 修改 |

后端 `commands.rs`/`types.rs`/`mockBackend.js` 无改动。

---

## Task 1: useGridEditor 草稿对象支持 anchorIndex 字段

**Files:**
- Modify: `src/workbench/composables/useGridEditor.js:175-177`（`createInsertRow`）

为草稿对象加 `anchorIndex` 字段（`null` = 末尾追加，保持现有行为；数字 = 渲染在该 originalIndex 数据行之前）。

**关键约束：`getInsertRows` 不排序。** 它被 `ensureInsertRow`、`insertRowIndex`、`commitInsertRows` 等用于查找/push/splice，必须返回 `insertDrafts[tab.id]` 存储数组本身（live reference）。anchorIndex 的排序只在 DataGrid 渲染层（Task 7 的 `insertRowsByAnchor` computed）按需分组，不触碰存储顺序。

- [ ] **Step 1: 写失败测试**

追加到 `src/workbench/useGridEditor.test.js`：

```javascript
test("createInsertRow defaults anchorIndex to null for trailing append", () => {
  const { editor } = createEditor();
  editor.selectInsertCell(editor.tab, 0);
  const row = editor.getInsertRows(editor.tab)[0];
  assert.equal(row.anchorIndex, null);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node --test src/workbench/useGridEditor.test.js`
Expected: FAIL（`row.anchorIndex` 为 `undefined`）。

- [ ] **Step 3: 实现 createInsertRow 加 anchorIndex**

修改 `src/workbench/composables/useGridEditor.js:175-177`：

```javascript
  function createInsertRow(anchorIndex = null) {
    return { id: `insert-${nextInsertRowId++}`, draft: {}, anchorIndex };
  }
```

`getInsertRows`（L234-238）**保持不变**（仍返回 `insertDrafts[tab.id]` 存储数组）。anchored 草稿通过 `push` 追加到存储末尾，顺序由 Task 7 渲染层分组决定，存储顺序不影响正确性。

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test src/workbench/useGridEditor.test.js`
Expected: 新测试 PASS，原有测试不回归。

- [ ] **Step 5: 提交**

```bash
git add src/workbench/composables/useGridEditor.js src/workbench/useGridEditor.test.js
git commit -m "feat(workbench): 草稿行对象加 anchorIndex 字段支持视觉插入位置"
```

---

## Task 2: useGridEditor 新增 insertDraftAbove 函数

**Files:**
- Modify: `src/workbench/composables/useGridEditor.js`（新增 `insertDraftAbove`，约 L262 后；并在 return 块 L1428 导出）

`insertDraftAbove(tab, anchorIndex)`：只读 tab 拒绝；创建带 `anchorIndex` 的草稿 push 进 `insertDrafts[tab.id]`；`showInsertRow(tab)`；找到第一个可编辑列（非主键自增列优先，否则第一个非主键列，否则 0）；调 `selectInsertCell(tab, newRowId, firstEditableColumnIndex)` 聚焦首列。

- [ ] **Step 1: 写失败测试**

追加到 `src/workbench/useGridEditor.test.js`：

```javascript
test("insertDraftAbove creates an anchored draft at the given originalIndex and selects first editable column", () => {
  const { editor, tab } = createEditor({
    columns: [
      { column_name: "id", column_type: "int", is_primary_key: true, extra: "auto_increment" },
      { column_name: "name", column_type: "varchar" },
      { column_name: "level", column_type: "int" },
    ],
  });

  editor.insertDraftAbove(tab, 1);

  const rows = editor.getInsertRows(tab);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].anchorIndex, 1);
  assert.equal(editor.isInsertRowVisible(tab), true);
  assert.equal(editor.selectedInsertCell.value.rowId, rows[0].id);
  // 首个可编辑列 = name（index 1），跳过主键自增 id
  assert.equal(editor.selectedInsertCell.value.columnIndex, 1);
});

test("insertDraftAbove on a read-only tab is rejected and reports status", () => {
  const { editor, tab, statusText } = createEditor({ readOnly: true });

  editor.insertDraftAbove(tab, 0);

  assert.equal(editor.getInsertRows(tab).length, 0);
  assert.match(statusText.value, /只读/);
});

test("insertDraftAbove with no primary-key column selects column index 0", () => {
  const { editor, tab } = createEditor();

  editor.insertDraftAbove(tab, 2);

  const rows = editor.getInsertRows(tab);
  assert.equal(rows[0].anchorIndex, 2);
  assert.equal(editor.selectedInsertCell.value.columnIndex, 0);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node --test src/workbench/useGridEditor.test.js`
Expected: 三个新测试 FAIL（`editor.insertDraftAbove is not a function`）。

- [ ] **Step 3: 实现 insertDraftAbove**

`isPrimaryKeyColumn` 已存在于 `src/workbench/composables/useGridEditor.js:997`，直接复用。

在 `src/workbench/composables/useGridEditor.js` 的 `ensureTrailingInsertRow` 函数（L258-261）之后插入：

```javascript
  function firstEditableColumnIndex() {
    const cols = activeColumns.value;
    // 优先：非主键的第一列
    const nonPk = cols.findIndex((col) => !isPrimaryKeyColumn(col));
    if (nonPk >= 0) return nonPk;
    // 全是主键时取第一列（自增主键留空由后端生成）
    return 0;
  }

  function insertDraftAbove(tab, anchorIndex) {
    if (!tab?.id) return;
    if (isReadOnlyTab(tab)) {
      setReadOnlyStatus(tab);
      return;
    }
    const rows = getInsertRows(tab);
    const newRow = createInsertRow(anchorIndex);
    rows.push(newRow);
    showInsertRow(tab);
    const columnIndex = firstEditableColumnIndex();
    selectInsertCell(tab, newRow.id, columnIndex);
  }
```

- [ ] **Step 4: 导出 insertDraftAbove**

修改 `src/workbench/composables/useGridEditor.js` 的 return 块（约 L1468 `selectInsertCell,` 附近），新增一行：

```javascript
    selectInsertCell,
    insertDraftAbove,
    selectInsertRow,
```

- [ ] **Step 5: 运行测试验证通过**

Run: `node --test src/workbench/useGridEditor.test.js`
Expected: 三个新测试 PASS，原有测试不回归。

- [ ] **Step 6: 提交**

```bash
git add src/workbench/composables/useGridEditor.js src/workbench/useGridEditor.test.js
git commit -m "feat(workbench): useGridEditor 新增 insertDraftAbove 在指定行上方插入草稿"
```

---

## Task 3: useGridEditor insertPosition 适配 anchorIndex 视觉行号

**Files:**
- Modify: `src/workbench/composables/useGridEditor.js:212-216`（`insertPosition`）

当前 `insertPosition` 的 `rowIndex = tab.rows.length + insertRowIndex(tab, rowId)`，把所有草稿当作追加在末尾。anchored 草稿的视觉行号应为 `anchorIndex + 该 anchor 之前的草稿数`。

- [ ] **Step 1: 写失败测试**

追加到 `src/workbench/useGridEditor.test.js`：

```javascript
test("insertPosition reports anchored draft's visual row index at its anchor", () => {
  const { editor, tab } = createEditor();

  editor.insertDraftAbove(tab, 1);
  const anchored = editor.getInsertRows(tab)[0];
  const position = editor.insertPosition(tab, anchored.id, 0);

  // anchorIndex=1 → 视觉行号 = 1（该草稿插在第 1 行数据之前）
  assert.equal(position.rowIndex, 1);
});

test("insertPosition reports trailing draft's visual row index after all data rows", () => {
  const { editor, tab } = createEditor();

  editor.selectInsertCell(tab, 0);
  const trailing = editor.getInsertRows(tab)[0];
  const position = editor.insertPosition(tab, trailing.id, 0);

  // tab.rows.length=3，末尾追加 → 视觉行号 = 3
  assert.equal(position.rowIndex, 3);
});
```

注意：需导出 `insertPosition` 才能测试。当前 return 块未导出它。

- [ ] **Step 2: 运行测试验证失败**

Run: `node --test src/workbench/useGridEditor.test.js`
Expected: FAIL（`editor.insertPosition is not a function`）。

- [ ] **Step 3: 实现 insertPosition 适配**

修改 `src/workbench/composables/useGridEditor.js:212-216`：

```javascript
  function insertPosition(tab, rowId, columnIndex) {
    const column = columnName(activeColumns.value[columnIndex]);
    const row = getInsertRows(tab).find((candidate) => candidate.id === rowId);
    const anchorIndex = row?.anchorIndex;
    let rowIndex;
    if (anchorIndex == null) {
      // 末尾追加：视觉行号 = 数据行数 + 之前末尾追加草稿数
      rowIndex = tab.rows.length + Math.max(0, insertRowIndex(tab, rowId));
    } else {
      // anchored：视觉行号 = anchorIndex + 该 anchor 处之前的草稿数
      const before = getInsertRows(tab).filter(
        (candidate) => candidate.id !== rowId
          && candidate.anchorIndex != null
          && candidate.anchorIndex < anchorIndex,
      ).length;
      rowIndex = anchorIndex + before;
    }
    return { rowIndex, columnIndex, rowKey: getInsertRowKey(tab, rowId), column };
  }
```

- [ ] **Step 4: 导出 insertPosition**

在 return 块新增（紧邻 `insertDraftAbove`）：

```javascript
    insertDraftAbove,
    insertPosition,
```

- [ ] **Step 5: 运行测试验证通过**

Run: `node --test src/workbench/useGridEditor.test.js`
Expected: 两个新测试 PASS，原有测试不回归。

- [ ] **Step 6: 提交**

```bash
git add src/workbench/composables/useGridEditor.js src/workbench/useGridEditor.test.js
git commit -m "feat(workbench): insertPosition 适配 anchorIndex 视觉行号"
```

---

## Task 4: useContextMenu 支持 grid-row kind

**Files:**
- Modify: `src/workbench/composables/useContextMenu.js`（`contextMenu` reactive L10-20 加字段、新增 `openRowContextMenu`、return 导出）
- Test: `src/workbench/useContextMenu.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `src/workbench/useContextMenu.test.js`：

```javascript
test("openRowContextMenu stores grid-row target with row identity and anchor index", () => {
  const menu = useContextMenu(
    { statusText: { value: "" } },
    { loadTables: async () => {}, ensureTableSchema: async () => {}, fetchPage: async () => {} },
    { value: null },
  );
  // tab 必须带 columns，否则 buildRowKey 内 buildRowIdentity 会 tab.columns.map 报错
  const tab = { id: "tab-1", tableName: "hero", readOnly: false, columns: [{ column_name: "id" }, { column_name: "name" }] };
  const row = { id: "42", name: "Alice" };

  menu.openRowContextMenu({ clientX: 30, clientY: 40 }, tab, row, 2);

  assert.equal(menu.contextMenu.open, true);
  assert.equal(menu.contextMenu.kind, "grid-row");
  assert.equal(menu.contextMenu.tableScoped, false);
  assert.equal(menu.contextMenu.rowTabId, "tab-1");
  assert.equal(menu.contextMenu.anchorIndex, 2);
  assert.equal(menu.contextMenu.rowReadOnly, false);
  assert.equal(menu.contextMenu.row, row);
  // buildRowKey 输出 "id=42&name=Alice"（无 primaryKeys 时用所有列）
  assert.equal(menu.contextMenu.rowKey, "id=42&name=Alice");
});

test("openRowContextMenu flags read-only tabs", () => {
  const menu = useContextMenu(
    { statusText: { value: "" } },
    { loadTables: async () => {}, ensureTableSchema: async () => {}, fetchPage: async () => {} },
    { value: null },
  );
  const tab = { id: "tab-2", tableName: "hero", readOnly: true, columns: [{ column_name: "id" }] };
  const row = { id: "9" };

  menu.openRowContextMenu({ clientX: 1, clientY: 2 }, tab, row, 0);

  assert.equal(menu.contextMenu.rowReadOnly, true);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node --test src/workbench/useContextMenu.test.js`
Expected: FAIL（`menu.openRowContextMenu is not a function`）。

- [ ] **Step 3: 实现 contextMenu 字段与 openRowContextMenu**

修改 `src/workbench/composables/useContextMenu.js`。先在文件顶部 import `buildRowKey`：

```javascript
import { computed, reactive } from "vue";
import { normalizeTableComment, normalizeTableName } from "../utils/normalize.js";
import { buildRowKey } from "../utils/rowIdentity.js";
```


修改 `contextMenu` reactive（L10-20），在末尾加字段：

```javascript
  const contextMenu = reactive({
    open: false,
    x: 0,
    y: 0,
    kind: "general",
    tableName: "",
    tableComment: "",
    connectionId: "",
    database: "",
    tableScoped: false,
    rowTabId: "",
    rowKey: "",
    anchorIndex: null,
    rowReadOnly: false,
    row: null,
  });
```

在 `openContextMenu` 函数之后（L45 后）新增 `openRowContextMenu`：

```javascript
  function openRowContextMenu(event, tab, row, originalIndex) {
    contextMenu.open = true;
    contextMenu.x = event.clientX;
    contextMenu.y = event.clientY;
    contextMenu.kind = "grid-row";
    contextMenu.tableScoped = false;
    contextMenu.tableName = "";
    contextMenu.tableComment = "";
    contextMenu.connectionId = "";
    contextMenu.database = "";
    contextMenu.rowTabId = String(tab?.id || "");
    contextMenu.rowKey = buildRowKey(tab, row);
    contextMenu.anchorIndex = originalIndex;
    contextMenu.rowReadOnly = Boolean(tab?.readOnly || tab?.read_only);
    contextMenu.row = row;
  }
```

修改 return（L128）：

```javascript
  return { contextMenu, contextMenuStyle, openContextMenu, openRowContextMenu, closeContextMenu, refreshFromContextMenu, openDesignFromContextMenu, renameFromContextMenu };
```

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test src/workbench/useContextMenu.test.js`
Expected: 新测试 PASS，原有测试不回归。

- [ ] **Step 5: 提交**

```bash
git add src/workbench/composables/useContextMenu.js src/workbench/useContextMenu.test.js
git commit -m "feat(workbench): useContextMenu 新增 grid-row kind 与 openRowContextMenu"
```

---

## Task 5: ContextMenu.vue 新增 grid-row 菜单项

**Files:**
- Modify: `src/workbench/components/ContextMenu.vue`（props L4-13、emits L15、template L31-39）

- [ ] **Step 1: 增加 rowReadOnly prop**

修改 `src/workbench/components/ContextMenu.vue` props（L4-13），在 `tableName` 后加：

```javascript
const props = defineProps({
  open: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  tableScoped: { type: Boolean, default: false },
  kind: { type: String, default: "general" },
  connectionId: { type: String, default: "" },
  database: { type: String, default: "" },
  tableName: { type: String, default: "" },
  rowReadOnly: { type: Boolean, default: false },
});
```

- [ ] **Step 2: 增加 emits**

修改 `src/workbench/components/ContextMenu.vue` L15：

```javascript
const emit = defineEmits(['refresh', 'open-design', 'sync-database', 'send-table', 'rename', 'remove-connection', 'grid-row-insert-above', 'grid-row-delete']);
```

- [ ] **Step 3: 增加 grid-row 菜单项**

修改 `src/workbench/components/ContextMenu.vue` template（L32-39），在 `<menu>` 内现有项之前插入 grid-row 分支：

```html
  <menu v-if="open" class="wb-context-menu" :style="contextMenuStyle" role="menu" aria-label="上下文菜单" @click.stop>
    <template v-if="kind === 'grid-row' && !rowReadOnly">
      <button type="button" role="menuitem" @click="emit('grid-row-insert-above')">往上新增行</button>
      <button type="button" role="menuitem" class="danger" @click="emit('grid-row-delete')">删除行</button>
    </template>
    <button v-if="tableScoped" type="button" role="menuitem" @click="emit('open-design')">表设计</button>
    <button v-if="tableScoped" type="button" role="menuitem" @click="emit('rename')">重命名</button>
    <button v-if="kind === 'connection'" type="button" role="menuitem" @click="emit('remove-connection')">移除连接</button>
    <button type="button" role="menuitem" @click="emit('refresh')">刷新</button>
    <button v-if="kind === 'database'" type="button" role="menuitem" @click="emitSyncDatabase">覆盖同步…</button>
    <button v-if="tableScoped" type="button" role="menuitem" @click="emit('send-table')">发送到…</button>
  </menu>
```

- [ ] **Step 4: 确认 .danger 样式存在**

Run: `grep -n "\.danger" src/workbench/workbench.css src/workbench/components/ContextMenu.vue`

确认 `.wb-context-menu .danger` 或类似样式存在。若无，在 `workbench.css` 的 `.wb-context-menu` 样式块附近补一个：

```css
.wb-context-menu button.danger {
  color: var(--wb-danger, #d33);
}
```

- [ ] **Step 5: 运行相关测试验证不回归**

Run: `node --test src/workbench/useContextMenu.test.js`
Expected: PASS（组件无单测，仅确认 composable 测试不回归）。

- [ ] **Step 6: 提交**

```bash
git add src/workbench/components/ContextMenu.vue src/workbench/workbench.css
git commit -m "feat(workbench): ContextMenu 新增 grid-row 往上新增行/删除行菜单项"
```

---

## Task 6: DataGrid.vue 行号加 contextmenu 事件与 emits

**Files:**
- Modify: `src/workbench/components/DataGrid.vue`（emits L53-89、行号 td L394-400）

- [ ] **Step 1: 注册 row-contextmenu emit**

修改 `src/workbench/components/DataGrid.vue` emits（L53-89），在 `'contextmenu'`（L87）后加：

```javascript
  'contextmenu',
  'row-contextmenu',
  'select-column',
```

- [ ] **Step 2: 行号 td 加 @contextmenu**

修改 `src/workbench/components/DataGrid.vue` 数据行行号 td（L394-400）：

```html
            <td
              class="wb-row-index wb-row-header"
              :class="{ 'row-selected': tab.selectedRowKeys.has(rowKey) }"
              title="选择整行"
              @mousedown.left.stop.prevent="onRowSelectStart(tab, row, originalIndex, $event)"
              @click.stop="emit('toggle-row-select', tab, row, $event)"
              @contextmenu.prevent.stop="emit('row-contextmenu', tab, row, originalIndex, $event)"
            >{{ originalIndex + 1 }}</td>
```

- [ ] **Step 3: 运行测试验证不回归**

Run: `node --test src/workbench/useGridEditor.test.js src/workbench/useContextMenu.test.js`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add src/workbench/components/DataGrid.vue
git commit -m "feat(workbench): DataGrid 行号单元格加 row-contextmenu 事件"
```

---

## Task 7: DataGrid.vue 草稿行按 anchorIndex 渲染

**Files:**
- Modify: `src/workbench/components/DataGrid.vue`（script setup 加 `insertRowsByAnchor` computed、`<tbody>` L380-498 渲染改造）

这是最核心的渲染改动。把当前"末尾整块渲染草稿行"改为"anchored 草稿插入对应数据行前 + 末尾追加草稿渲染在末尾"。

- [ ] **Step 1: 在 script setup 增加 computed**

在 `src/workbench/components/DataGrid.vue` script setup（props/emits 之后，约 L90 附近）增加 computed：

```javascript
import { computed, inject, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";
```
确认 `computed` 已导入（L2 已有）。增加：

```javascript
// 按 anchorIndex 分组的草稿行：Map<anchorIndex, insertRow[]>，末尾追加草稿归入 key=null
const insertRowsByAnchor = computed(() => {
  const map = new Map();
  const rows = props.getInsertRows(props.tab);
  for (const row of rows) {
    const key = row.anchorIndex == null ? null : row.anchorIndex;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
});

// 末尾追加草稿（anchorIndex==null），按存储顺序
const trailingInsertRows = computed(() => insertRowsByAnchor.value.get(null) || []);

// 给定 originalIndex 处需在其前渲染的 anchored 草稿（anchorIndex===originalIndex）
function anchoredInsertRowsAt(originalIndex) {
  return insertRowsByAnchor.value.get(originalIndex) || [];
}
```

- [ ] **Step 2: 提取草稿行 tr 模板为内联复用**

当前草稿行模板在 L441-498。改造 `<tbody>`（L380-498）：数据行 `v-for` 中，在每个 `originalIndex` 数据行之前先 `v-for` 渲染 `anchoredInsertRowsAt(originalIndex)` 的草稿行；末尾渲染 `trailingInsertRows`。

为避免模板重复，使用 Vue `<template v-for>` 嵌套。新 `<tbody>` 结构：

```html
        <tbody>
          <tr v-if="virtualRange.padTop > 0" aria-hidden="true" class="wb-virtual-spacer">
            <td :style="{ height: virtualRange.padTop + 'px' }" :colspan="1 + activeColumns.length"></td>
          </tr>
          <template v-for="{ row, originalIndex, rowKey } in visibleRows" :key="rowKey">
            <!-- anchored 草稿行：渲染在该 originalIndex 数据行之前 -->
            <tr
              v-for="insertRow in isInsertRowVisible(tab) ? anchoredInsertRowsAt(originalIndex) : []"
              :key="insertRow.id"
              class="wb-insert-row"
              :class="{ 'row-selected': selectedInsertRow?.tabId === tab.id && selectedInsertRow?.rowId === insertRow.id }"
            >
              <td
                class="wb-row-index wb-row-insert-marker wb-row-header"
                :class="{ 'row-selected': selectedInsertRow?.tabId === tab.id && selectedInsertRow?.rowId === insertRow.id }"
                title="选择新增行"
                @mousedown.stop.prevent
                @click.stop="emit('insert-row-select', tab, insertRow.id, $event)"
              >{{ originalIndex + 1 }}</td>
              <td
                v-for="(column, columnIndex) in activeColumns"
                :key="`insert-${insertRow.id}-${columnName(column)}`"
                :style="colStyle(tab.id, columnName(column))"
                :data-column-index="columnIndex"
                :data-row-key="getInsertRowKey(tab, insertRow)"
                :data-column-name="columnName(column)"
                :class="{
                  pending: false,
                  error: false,
                  selected: selectedCell?.rowKey === getInsertRowKey(tab, insertRow) && selectedCell?.column === columnName(column) && selectedCell?.tabId === tab.id,
                  editing: editingCell?.rowKey === getInsertRowKey(tab, insertRow) && editingCell?.column === columnName(column),
                  'insert-selected': selectedInsertCell?.tabId === tab.id && selectedInsertCell?.rowId === insertRow.id && selectedInsertCell?.columnIndex === columnIndex,
                }"
                @mousedown.left="emit('cell-mousedown', tab, insertRowObject(insertRow), columnName(column), originalIndex, columnIndex, $event)"
                @mouseenter="emit('cell-enter', tab, insertRowObject(insertRow), columnName(column), originalIndex, columnIndex)"
                @mouseup="emit('range-end')"
                @click="emit('cell-click', tab, insertRowObject(insertRow), columnName(column), originalIndex, columnIndex)"
                @dblclick="emit('cell-dblclick', tab, insertRowObject(insertRow), columnName(column), originalIndex, columnIndex)"
              >
                <input
                  v-if="editingCell?.rowKey === getInsertRowKey(tab, insertRow) && editingCell?.column === columnName(column)"
                  :value="editDraft"
                  :data-insert-row-id="insertRow.id"
                  :data-insert-column-index="columnIndex"
                  :data-row-index="originalIndex"
                  :data-column-index="columnIndex"
                  :placeholder="isPrimaryKeyColumn(column) ? 'auto' : ''"
                  @focus="emit('insert-focus', tab, insertRow.id, columnIndex)"
                  @input="emit('edit-input', $event.target.value)"
                  @paste.prevent.stop="emit('insert-paste', tab, insertRow.id, columnIndex, $event)"
                  @keydown.arrow-up.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                  @keydown.arrow-down.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                  @keydown.arrow-left.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                  @keydown.arrow-right.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                  @keydown.tab.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                  @keydown.escape.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                  @blur="emit('cell-blur')"
                  @keydown.enter.prevent.stop="emit('finish-edit')"
                />
                <span v-else class="wb-cell-text" v-html="highlightInsertCell(tab, insertRow, column)"></span>
              </td>
            </tr>
            <!-- 数据行 -->
            <tr
              class="wb-grid-row"
              :class="{
                'row-even': originalIndex % 2 === 1,
                'row-selected': tab.selectedRowKeys.has(rowKey),
                'row-active': selectedCell?.tabId === tab.id && selectedCell?.rowKey === rowKey,
              }"
            >
              <td
                class="wb-row-index wb-row-header"
                :class="{ 'row-selected': tab.selectedRowKeys.has(rowKey) }"
                title="选择整行"
                @mousedown.left.stop.prevent="onRowSelectStart(tab, row, originalIndex, $event)"
                @click.stop="emit('toggle-row-select', tab, row, $event)"
                @contextmenu.prevent.stop="emit('row-contextmenu', tab, row, originalIndex, $event)"
              >{{ originalIndex + 1 }}</td>
              <td
                v-for="(column, columnIndex) in activeColumns"
                :key="columnName(column)"
                :style="colStyle(tab.id, columnName(column))"
                :data-column-index="columnIndex"
                :data-row-key="rowKey"
                :data-column-name="columnName(column)"
                :title="getCellError(editState, tabScopeKey(tab), rowKey, columnName(column)) || ''"
                :class="{
                  pending: isCellPending(editState, tabScopeKey(tab), rowKey, columnName(column)),
                  error: getCellError(editState, tabScopeKey(tab), rowKey, columnName(column)),
                  selected: selectedCell?.rowKey === rowKey && selectedCell?.column === columnName(column) && selectedCell?.tabId === tab.id,
                  editing: editingCell?.rowKey === rowKey && editingCell?.column === columnName(column),
                  'search-match': isSearchMatchCell(tab, row, columnName(column), rowKey),
                  'is-null': row[columnName(column)] == null,
                  ...getCellRangeClasses(tab, rowKey, columnName(column), originalIndex, columnIndex),
                }"
                @mousedown.left="emit('cell-mousedown', tab, row, columnName(column), originalIndex, columnIndex, $event)"
                @mouseenter="emit('cell-enter', tab, row, columnName(column), originalIndex, columnIndex)"
                @mouseup="emit('range-end')"
                @click="emit('cell-click', tab, row, columnName(column), originalIndex, columnIndex)"
                @dblclick="emit('cell-dblclick', tab, row, columnName(column), originalIndex, columnIndex)"
              >
                <input
                  v-if="editingCell?.rowKey === rowKey && editingCell?.column === columnName(column)"
                  :value="editDraft"
                  :data-row-index="originalIndex"
                  :data-column-index="columnIndex"
                  @input="emit('edit-input', $event.target.value)"
                  @blur="emit('cell-blur')"
                  @keydown.enter.prevent.stop="emit('finish-edit')"
                  @keydown.escape.prevent.stop="emit('cancel-edit')"
                  @keydown.tab.prevent.stop="emit('tab-edit', $event.shiftKey)"
                />
                <span v-else class="wb-cell-text" v-html="highlightCell(tab, row, columnName(column), rowKey)"></span>
              </td>
            </tr>
          </template>
          <tr v-if="virtualRange.totalHeight - virtualRange.padTop - visibleRows.length * GRID_ROW_HEIGHT > 0" aria-hidden="true" class="wb-virtual-spacer">
            <td :style="{ height: (virtualRange.totalHeight - virtualRange.padTop - visibleRows.length * GRID_ROW_HEIGHT) + 'px' }" :colspan="1 + activeColumns.length"></td>
          </tr>
          <!-- 末尾追加草稿行（anchorIndex==null） -->
          <tr
            v-for="(insertRow, insertRowIndex) in isInsertRowVisible(tab) ? trailingInsertRows : []"
            :key="insertRow.id"
            class="wb-insert-row"
            :class="{ 'row-selected': selectedInsertRow?.tabId === tab.id && selectedInsertRow?.rowId === insertRow.id }"
          >
            <td
              class="wb-row-index wb-row-insert-marker wb-row-header"
              :class="{ 'row-selected': selectedInsertRow?.tabId === tab.id && selectedInsertRow?.rowId === insertRow.id }"
              title="选择新增行"
              @mousedown.stop.prevent
              @click.stop="emit('insert-row-select', tab, insertRow.id, $event)"
            >{{ tab.rows.length + insertRowIndex + 1 }}</td>
            <td
              v-for="(column, columnIndex) in activeColumns"
              :key="`insert-${insertRow.id}-${columnName(column)}`"
              :style="colStyle(tab.id, columnName(column))"
              :data-column-index="columnIndex"
              :data-row-key="getInsertRowKey(tab, insertRow)"
              :data-column-name="columnName(column)"
              :title="getCellError(editState, tabScopeKey(tab), getInsertRowKey(tab, insertRow), columnName(column)) || ''"
              :class="{
                pending: isCellPending(editState, tabScopeKey(tab), getInsertRowKey(tab, insertRow), columnName(column)),
                error: getCellError(editState, tabScopeKey(tab), getInsertRowKey(tab, insertRow), columnName(column)),
                selected: selectedCell?.rowKey === getInsertRowKey(tab, insertRow) && selectedCell?.column === columnName(column) && selectedCell?.tabId === tab.id,
                editing: editingCell?.rowKey === getInsertRowKey(tab, insertRow) && editingCell?.column === columnName(column),
                'insert-selected': selectedInsertCell?.tabId === tab.id && selectedInsertCell?.rowId === insertRow.id && selectedInsertCell?.columnIndex === columnIndex,
                ...getCellRangeClasses(tab, getInsertRowKey(tab, insertRow), columnName(column), tab.rows.length + insertRowIndex, columnIndex),
              }"
              @mousedown.left="emit('cell-mousedown', tab, insertRowObject(insertRow), columnName(column), tab.rows.length + insertRowIndex, columnIndex, $event)"
              @mouseenter="emit('cell-enter', tab, insertRowObject(insertRow), columnName(column), tab.rows.length + insertRowIndex, columnIndex)"
              @mouseup="emit('range-end')"
              @click="emit('cell-click', tab, insertRowObject(insertRow), columnName(column), tab.rows.length + insertRowIndex, columnIndex)"
              @dblclick="emit('cell-dblclick', tab, insertRowObject(insertRow), columnName(column), tab.rows.length + insertRowIndex, columnIndex)"
            >
              <input
                v-if="editingCell?.rowKey === getInsertRowKey(tab, insertRow) && editingCell?.column === columnName(column)"
                :value="editDraft"
                :data-insert-row-id="insertRow.id"
                :data-insert-column-index="columnIndex"
                :data-row-index="tab.rows.length + insertRowIndex"
                :data-column-index="columnIndex"
                :placeholder="isPrimaryKeyColumn(column) ? 'auto' : ''"
                @focus="emit('insert-focus', tab, insertRow.id, columnIndex)"
                @input="emit('edit-input', $event.target.value)"
                @paste.prevent.stop="emit('insert-paste', tab, insertRow.id, columnIndex, $event)"
                @keydown.arrow-up.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                @keydown.arrow-down.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                @keydown.arrow-left.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                @keydown.arrow-right.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                @keydown.tab.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                @keydown.escape.prevent.stop="emit('insert-keydown', tab, insertRow.id, columnIndex, $event)"
                @blur="emit('cell-blur')"
                @keydown.enter.prevent.stop="emit('finish-edit')"
              />
              <span v-else class="wb-cell-text" v-html="highlightInsertCell(tab, insertRow, column)"></span>
            </td>
          </tr>
        </tbody>
```

- [ ] **Step 3: 确认 insertRowObject / tabScopeKey / isPrimaryKeyColumn 在 DataGrid 可用**

Run: `grep -n "insertRowObject\|tabScopeKey\|isPrimaryKeyColumn\|highlightInsertCell\|isSearchMatchCell" src/workbench/components/DataGrid.vue`

确认这些 helper 在 DataGrid script setup 中已定义或注入。`insertRowObject`、`tabScopeKey`、`isPrimaryKeyColumn`、`highlightInsertCell`、`isSearchMatchCell` 在原末尾草稿模板中已使用（L470、L461、L483、L496、L414），故已可用。

- [ ] **Step 4: 运行测试验证不回归**

Run: `node --test src/workbench/useGridEditor.test.js src/workbench/useContextMenu.test.js`
Expected: PASS（组件无单测，确认 composable 测试不回归）。

- [ ] **Step 5: 启动 dev 手测渲染**

Run: `npm run dev`
手测：打开表 → 在某行行号右键 → 选「往上新增行」→ 确认绿底空行出现在该行正上方（若接线尚未完成，此步在 Task 9 后完整验证）。

- [ ] **Step 6: 提交**

```bash
git add src/workbench/components/DataGrid.vue
git commit -m "feat(workbench): DataGrid 草稿行按 anchorIndex 在对应数据行前渲染"
```

---

## Task 8: WorkbenchPane 转发 row-contextmenu

**Files:**
- Modify: `src/workbench/components/WorkbenchPane.vue`（emits L32-51、DataGrid 绑定 L649-712、新增 `openRowContextMenu` 函数）

- [ ] **Step 1: 注册 emit**

修改 `src/workbench/components/WorkbenchPane.vue` emits（L32-51），在 `"table-contextmenu"`（L40）后加：

```javascript
  "table-contextmenu",
  "row-contextmenu",
  "open-design",
```

- [ ] **Step 2: 新增 openRowContextMenu 转发函数**

在 `src/workbench/components/WorkbenchPane.vue` 的 `openTableContextMenu`（L507-510）之后加：

```javascript
function openRowContextMenu(event, tab, row, originalIndex) {
  focusPane();
  emit("row-contextmenu", event, tab, row, originalIndex);
}
```

- [ ] **Step 3: DataGrid 绑定 @row-contextmenu**

修改 `src/workbench/components/WorkbenchPane.vue` DataGrid 绑定（L711 `@contextmenu="openTableContextMenu"` 后）加：

```javascript
      @contextmenu="openTableContextMenu"
      @row-contextmenu="openRowContextMenu"
```

- [ ] **Step 4: 运行测试验证不回归**

Run: `node --test src/workbench`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/workbench/components/WorkbenchPane.vue
git commit -m "feat(workbench): WorkbenchPane 转发 row-contextmenu 事件"
```

---

## Task 9: MySqlWorkbench 接线 openRowContextMenu 与菜单事件

**Files:**
- Modify: `src/workbench/MySqlWorkbench.vue`（解构 useContextMenu L301-314、WorkbenchPane 绑定 L1727、ContextMenu 挂载 L1788-1803、新增 handler 函数）

- [ ] **Step 1: 解构 openRowContextMenu 与 insertDraftAbove**

修改 `src/workbench/MySqlWorkbench.vue` useContextMenu 解构（L309 `openContextMenu,` 后），加 `openRowContextMenu`：

```javascript
  openContextMenu,
  openRowContextMenu,
  closeContextMenu,
```

`useGridEditor` 返回的对象解构在 L254-272（`} = editor;`）。在 `selectInsertCell,`（L261）后加 `insertDraftAbove,`：

```javascript
  selectInsertCell,
  insertDraftAbove,
  selectInsertRow,
```

- [ ] **Step 2: 新增 openActiveRowContextMenu 包装函数**

`activeDataTab` 是 computed（L183），用 `.value` 访问；`deleteRow` 已从 useRowSelection 解构（L302）。在 `src/workbench/MySqlWorkbench.vue` 的 `openActiveTableContextMenu`（L1142-1144）之后加：

```javascript
function openActiveRowContextMenu(event, tab, row, originalIndex) {
  closeTabContextMenu();
  openRowContextMenu(event, tab, row, originalIndex);
}

function onGridRowInsertAbove() {
  const tab = activeDataTab.value;
  const anchorIndex = contextMenu.anchorIndex;
  closeContextMenu();
  if (!tab) return;
  insertDraftAbove(tab, anchorIndex);
}

function onGridRowDelete() {
  const tab = activeDataTab.value;
  const row = contextMenu.row;
  closeContextMenu();
  if (!tab || !row) return;
  deleteRow(tab, row);
}
```

- [ ] **Step 3: WorkbenchPane 绑定 @row-contextmenu**

修改 `src/workbench/MySqlWorkbench.vue` WorkbenchPane 绑定（L1727 `@table-contextmenu="openActiveTableContextMenu"` 后）加：

```javascript
          @table-contextmenu="openActiveTableContextMenu"
          @row-contextmenu="openActiveRowContextMenu"
```

- [ ] **Step 4: ContextMenu 挂载加 props 与事件**

修改 `src/workbench/MySqlWorkbench.vue` ContextMenu 挂载（L1788-1803）：

```html
    <ContextMenu
      :open="contextMenu.open"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :table-scoped="contextMenu.tableScoped"
      :kind="contextMenu.kind"
      :connection-id="contextMenu.connectionId"
      :database="contextMenu.database"
      :table-name="contextMenu.tableName"
      :row-read-only="contextMenu.rowReadOnly"
      @refresh="refreshFromContextMenu"
      @open-design="openDesignFromContextMenu"
      @sync-database="openDatabaseSync"
      @send-table="openTableCopyFromContext"
      @rename="openTableRenameFromContext"
      @remove-connection="removeConnectionFromContext"
      @grid-row-insert-above="onGridRowInsertAbove"
      @grid-row-delete="onGridRowDelete"
    />
```

- [ ] **Step 5: 运行全部测试验证不回归**

Run: `node --test src/workbench`
Expected: PASS。

- [ ] **Step 6: 启动 dev 完整手测**

Run: `npm run dev`

手测清单：
1. 打开表 → 数据行行号右键 → 弹出菜单含「往上新增行」「删除行」
2. 点「往上新增行」→ 该行正上方出现绿底空行，自动聚焦首列
3. 录入数据 → Ctrl+S / Enter / 失焦 → 提交成功 → 刷新，新行落库
4. 主键重复录入 → 保存失败，草稿保留，状态栏提示"插入失败"
5. 行号右键 →「删除行」→ 确认对话框 → 删除 → 刷新
6. 只读连接右键 → 菜单不含这两项
7. 多次对同一行「往上新增行」→ 草稿按顺序排列在该行前
8. 末尾追加插入（键盘导航到末尾进入插入行）→ 行为不变

- [ ] **Step 7: 提交**

```bash
git add src/workbench/MySqlWorkbench.vue
git commit -m "feat(workbench): 接线行号右键菜单往上新增行与删除行"
```

---

## Self-Review（计划完成后自查）

**1. Spec 覆盖：**
- 往上新增行（视觉上方插入草稿、聚焦首列）→ Task 2、3、7、9 ✓
- 删除行（复用 deleteRow）→ Task 5、9 ✓
- 只读连接隐藏两项 → Task 5（`v-if="!rowReadOnly"`）、9（props 传递）✓
- 菜单载体复用全局 ContextMenu → Task 4、5、9 ✓
- 草稿 anchorIndex 渲染 → Task 7 ✓
- 虚拟滚动不改造 → Task 7 未动 virtualRange ✓
- 提交链路复用 → Task 2 不改 commitInsertRow ✓
- 主键重复等保存细节复用 → 现有 commitDraftObject 不变 ✓
- 边界（多次插入、删除刷新、末尾追加不变）→ Task 9 手测覆盖 ✓
- 测试（useGridEditor/useContextMenu 单测 + 回归）→ Task 1-4、9 ✓

**2. 占位符扫描：** 无 TBD/TODO，所有代码步骤含完整代码。Task 4 测试断言修正了硬编码问题。Task 2 的 `isPrimaryKeyColumn` 来源在 Step 4 验证。

**3. 类型一致性：**
- `createInsertRow(anchorIndex=null)` → `{ id, draft, anchorIndex }` 贯穿 Task 1、2 ✓
- `insertDraftAbove(tab, anchorIndex)` 签名 Task 2 定义、Task 9 调用 ✓
- `openRowContextMenu(event, tab, row, originalIndex)` Task 4 定义、Task 8/9 调用 ✓
- `onGridRowInsertAbove`/`onGridRowDelete` Task 9 定义与 ContextMenu emit 名一致（`grid-row-insert-above`/`grid-row-delete`）✓
- `contextMenu.row` / `contextMenu.anchorIndex` / `contextMenu.rowReadOnly` Task 4 定义、Task 9 使用 ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-grid-row-context-menu.md`.
