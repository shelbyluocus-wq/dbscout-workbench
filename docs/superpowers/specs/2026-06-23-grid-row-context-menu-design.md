# 行号右键菜单：往上新增行 / 删除行

- 日期：2026-06-23
- 分支：feat/backup-storage-and-snapshot-delete（暂用，实现前应切到新分支）
- 状态：已通过设计评审，待编写实现计划

## 1. 目标

在数据网格的行号单元格上右键，弹出包含「往上新增行」「删除行」两项的上下文菜单：

- **往上新增行**：在右键的数据行正上方插入一条可编辑空行（绿底标记），自动聚焦该空行第一个可编辑列。用户录入后通过 Ctrl+S / Enter / 失焦提交，提交成功后落库并刷新页面，行最终位置由数据库实际顺序决定（关系表无物理行序，"上方"仅是视觉概念）。
- **删除行**：删除右键所在行，复用现有单行删除链路。

只读连接下两项隐藏。

## 2. 非目标（Out of Scope）

- 不改造虚拟滚动的总高度计算（草稿行不计入虚拟高度）。
- 不把草稿行持久插入到 `tab.rows` 数据数组中。
- 不做"提交后保持新行在原插入位置"（刷新后位置由 DB 决定）。
- 不迁移现有删除确认对话框 `window.confirm` 到 `useConfirm`（保持最小改动）。
- 不改动现有末尾追加插入行的行为与键盘导航到末尾进入插入行的逻辑。
- 不新增独立的行级菜单组件（复用全局 `ContextMenu.vue`）。

## 3. 关键设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 插入语义 | 视觉上方插入可编辑空行，即时编辑手动保存 | Navicat/Excel 式交互，符合用户预期 |
| 草稿状态载体 | 复用现有 `insertDrafts[tab.id]`，给草稿对象加 `anchorIndex` 字段 | 草稿行本就独立于 `tab.rows`、不计入虚拟滚动，只需改渲染位置 |
| 虚拟滚动 | 不改造，草稿行落入可视区时多渲染一行 | 草稿行数量少（典型 1 行），滚动偏差不可察，风险最低 |
| 菜单载体 | 复用全局 `ContextMenu.vue`，新增 `kind='grid-row'` 分支 | 单一菜单实例，与现有对象树/表级菜单一致 |
| 删除行 | 复用 `useRowSelection.deleteRow(tab, row)` | 已含 `window.confirm` + `delete_rows` + `fetchPage` |
| 只读连接 | 菜单项隐藏 | 与现有插入/删除只读判断一致 |
| 提交后位置 | 不保持，刷新后由 DB 决定 | 关系表无物理序，已与用户确认可接受 |

## 4. 架构与数据流

```
DataGrid 行号 <td> (@contextmenu.prevent.stop)
  → emit('row-contextmenu', tab, row, originalIndex, $event)
WorkbenchPane 转发 @row-contextmenu
  → MySqlWorkbench.openRowContextMenu(event, tab, row, originalIndex)
  → useContextMenu.openRowContextMenu(...)
       写入 contextMenu { kind:'grid-row', rowTabId, rowKey, anchorIndex, rowReadOnly }
  → ContextMenu.vue 渲染 grid-row 分支（readOnly 时隐藏两项）
      「往上新增行」→ emit('grid-row-insert-above')
          → MySqlWorkbench → useGridEditor.insertDraftAbove(tab, anchorIndex)
      「删除行」    → emit('grid-row-delete')
          → MySqlWorkbench → useRowSelection.deleteRow(tab, row)
```

### 4.1 草稿行带 anchorIndex 的渲染模型

现有 `insertDrafts[tab.id]` 是草稿数组，渲染时整体追加在 `tab.rows` 之后。本设计给草稿对象加 `anchorIndex` 字段：

- `anchorIndex = null` → 末尾追加（现有行为，保持不变）
- `anchorIndex = N`（N 为右键行的 `originalIndex`）→ 该草稿行渲染在 `originalIndex === N` 的数据行**之前**

渲染规则（`DataGrid.vue` `<tbody>`）：

1. 顶部虚拟占位 `<tr class="wb-virtual-spacer">`（不变）
2. `v-for` 遍历 `visibleRows`（仍为 `tab.rows.slice(start, end)`，不变）：
   - 在每个 `originalIndex` 之前，先渲染 `anchorIndex === originalIndex` 的草稿行（复用现有 `wb-insert-row` 模板）
   - 再渲染该数据行（现有模板不变）
3. 底部虚拟占位（不变）
4. 末尾仍渲染 `anchorIndex === null` 的草稿行（现有末尾追加行为）

草稿行不计入 `virtualRange.totalHeight`（仍为 `tab.rows.length * GRID_ROW_HEIGHT`），仅在其 anchor 落入可视区 `[start, end)` 时多渲染一行。因草稿行数量少，滚动偏差不可察。

### 4.2 草稿数组排序

`getInsertRows(tab)` 返回值按 `anchorIndex` 升序排列，`null` 视为 `Infinity` 排在末尾。这样：

- 末尾追加逻辑（`ensureTrailingInsertRow`、`commitInsertRows` 顺序遍历）不受影响
- 多次往上插入同一 anchor：草稿按插入顺序排列在该 anchor 前
- 多个不同 anchor：各自归位

## 5. 模块改动明细

### 5.1 `useGridEditor.js`

- **`createInsertRow(anchorIndex = null)`**：返回 `{ id, draft: {}, anchorIndex }`。`null` 表示末尾追加。
- **新增 `insertDraftAbove(tab, anchorIndex)`**：
  - 只读 tab 拒绝（复用 `isReadOnlyTab(tab)` + `setReadOnlyStatus(tab)`）
  - 创建带 `anchorIndex` 的草稿，`splice` 进 `insertDrafts[tab.id]`（保持按 anchorIndex 升序，null 在末尾）
  - `showInsertRow(tab)`
  - 找到第一个可编辑列（非主键自增列优先，或第一个非主键列；与现有 `selectInsertCell` 首列选择策略一致）
  - `selectInsertCell(tab, newRowId, firstEditableColumnIndex)` 聚焦首列
- **`getInsertRows(tab)`**：返回值按 `anchorIndex` 升序（null/Infinity 末尾）。
- **`insertPosition(tab, rowId, columnIndex)`**：`rowIndex` 计算考虑 `anchorIndex`——草稿行的视觉行号 = 其 anchorIndex + 该 anchor 之前已插入的草稿数。供选择/范围/导航使用。
- **现有 `ensureInsertRow` / `ensureTrailingInsertRow` / `commitInsertRow` / `commitInsertRows` / `promoteSavedDraft` / `commitDraftObject`**：均不变。`anchorIndex` 字段对它们透明（提交仍 `INSERT` + push 末尾 + 刷新）。

### 5.2 `DataGrid.vue`

- **行号 `<td>`**（当前 L394-400）增加：
  ```html
  @contextmenu.prevent.stop="emit('row-contextmenu', tab, row, originalIndex, $event)"
  ```
- **emits** 注册 `'row-contextmenu'`。
- **新增 computed `insertRowsByAnchor`**：把 `getInsertRows(tab)` 按 `anchorIndex` 分组，返回 `Map<anchorIndex|null, insertRow[]>`。
- **`<tbody>` 渲染改造**：`v-for` 遍历 `visibleRows` 时，在每个 `originalIndex` 之前先渲染 `insertRowsByAnchor.get(originalIndex)` 的草稿行（复用现有 `wb-insert-row` `<tr>` 模板，`insertRowIndex` 改为基于 anchor 的视觉序号）；末尾仍渲染 `insertRowsByAnchor.get(null)` 的草稿行。
- 草稿行模板（含 input、事件绑定）从当前"末尾整块 `v-for`"提取为可复用片段，供"anchor 位置插入"和"末尾追加"两处共用。

### 5.3 `useContextMenu.js`

- **`contextMenu` reactive 增加字段**：`rowTabId`、`rowKey`、`anchorIndex`、`rowReadOnly`、`row`（缓存行对象供删除时直接取用）。
- **新增 `openRowContextMenu(event, tab, row, originalIndex)`**：
  - 写入 `kind='grid-row'`、`tableScoped=false`
  - 写入 `rowTabId=tab.id`、`rowKey=buildRowKey(tab, row)`、`anchorIndex=originalIndex`、`rowReadOnly=isReadOnlyTab(tab)`、`row=row`
  - 定位 `x=event.clientX`、`y=event.clientY`
- `closeContextMenu` 不变。

### 5.4 `ContextMenu.vue`

- **props 增加**：`rowReadOnly: { type: Boolean, default: false }`。
- **emits 增加**：`'grid-row-insert-above'`、`'grid-row-delete'`。
- **新增 `grid-row` 分支**（在现有菜单项之后或之前，按视觉合理位置）：
  ```html
  <template v-if="kind === 'grid-row' && !rowReadOnly">
    <button type="button" role="menuitem" @click="emit('grid-row-insert-above')">往上新增行</button>
    <button type="button" role="menuitem" class="danger" @click="emit('grid-row-delete')">删除行</button>
  </template>
  ```
- 只读时（`rowReadOnly === true`）整组隐藏，菜单仍打开但不显示这两项。

### 5.5 `WorkbenchPane.vue`

- DataGrid 事件转发：`@row-contextmenu="emit('row-contextmenu', $event)"`（或直接在 WorkbenchPane 内调用上层传入的 handler，与现有 `@table-contextmenu` 转发模式一致）。

### 5.6 `MySqlWorkbench.vue`

- 解构 `useGridEditor` 增加 `insertDraftAbove`。
- 解构 `useContextMenu` 增加 `openRowContextMenu`。
- 新增 `openRowContextMenu(event, tab, row, originalIndex)` 包装（调 `useContextMenu.openRowContextMenu`）。
- `ContextMenu` 组件挂载处增加 props `:row-read-only="contextMenu.rowReadOnly"`。
- `ContextMenu` 事件接线：
  - `@grid-row-insert-above="onGridRowInsertAbove"` → `insertDraftAbove(activeTab, contextMenu.anchorIndex)`
  - `@grid-row-delete="onGridRowDelete"` → `deleteRow(activeTab, contextMenu.row)`（`openRowContextMenu` 时顺带缓存 row 对象到 `contextMenu.row` 字段，删除时直接取用，无需反查）

### 5.7 删除行

直接复用 `useRowSelection.deleteRow(tab, row)`，无改动。

## 6. 保存细节（主键重复等）

复用现有 `commitDraftObject`（`useGridEditor.js:1045-1084`）校验链路：

- **前端预校验** `validateRowDraft`：主键重复（与 `tab.rows` 及其他草稿）、非空约束、类型校验。失败时拒绝，定位到出错单元格（`selectInsertCell` + `setValidationFeedback`），`statusText` 提示。
- **后端 `insert_row`** 主键冲突抛 `PRIMARY_KEY_DUPLICATE_MESSAGE`，`commitDraftObject` catch 后 `statusText.value = "插入失败：..."`。
- **草稿保留**：`commitInsertRow` 仅在 `inserted === true` 时 `clearInsertDraft`，失败时草稿保留在原 anchor 位置，用户可改后重试。
- **错误状态显示**：草稿行单元格复用 `getCellError` / `isCellPending`，key 用 `insertRowKey(tab, insertRow.id)`，与末尾草稿一致。

## 7. 边界情况

| 情况 | 处理 |
|---|---|
| 多次右键同一行往上插入 | 草稿按插入顺序排列在该 anchor 前 |
| 多个不同 anchor | 各自归位渲染 |
| 删除后 `fetchPage` 刷新 | `tab.rows` 重建；未提交的 `anchorIndex` 草稿保留，若 anchor 越界则夹紧到 `tab.rows.length`（渲染为末尾追加） |
| 末尾追加草稿（`anchorIndex=null`） | 行为完全不变，`ensureTrailingInsertRow` / 键盘导航到末尾进入插入行不受影响 |
| 只读连接 | `openRowContextMenu` 仍打开菜单，`rowReadOnly=true`，两项隐藏 |
| 提交后位置 | 刷新后行顺序由 DB 返回决定，草稿消失，新行可能不在原位（已确认可接受） |
| 草稿行 anchor 落在可视区外 | 不渲染（虚拟滚动范围内才渲染），滚动到该位置时出现 |
| 右键的是末尾追加草稿行本身 | 草稿行行号无 `@contextmenu` 绑定（仅数据行行号绑定），不触发行级菜单 |

## 8. 测试

### 8.1 JS 单测（`node --test`）

- **`useGridEditor` 单测**：
  - `insertDraftAbove` 创建带 `anchorIndex` 的草稿
  - `getInsertRows` 按 `anchorIndex` 升序（null 末尾）
  - `insertPosition` 对 anchored 草稿返回正确的视觉行号
  - 只读 tab 调 `insertDraftAbove` 被拒绝
  - 末尾追加草稿（`anchorIndex=null`）行为不回归
- **`useContextMenu` 单测**：
  - `openRowContextMenu` 写入 `kind='grid-row'`、`rowTabId`、`rowKey`、`anchorIndex`、`rowReadOnly`
  - 只读 tab 写入 `rowReadOnly=true`
- **回归**：现有 `useTableSession.test.js` / `useGridEditor` 既有测试全部通过。

### 8.2 手测

1. 行号右键 → 弹出菜单，含「往上新增行」「删除行」
2. 往上新增行 → 该行正上方出现绿底空行，自动聚焦首列
3. 录入数据 → Ctrl+S / Enter / 失焦 → 提交成功 → 刷新，新行落库
4. 主键重复 → 保存失败，草稿保留，`statusText` 提示"插入失败"
5. 右键删除行 → 确认对话框 → 删除 → 刷新
6. 只读连接右键 → 菜单项隐藏
7. 多次往上插入同一行 → 草稿按顺序排列
8. 末尾追加插入（键盘导航到末尾）→ 行为不变

## 9. 关键文件清单

- `src/workbench/composables/useGridEditor.js`（`createInsertRow`、`insertDraftAbove`、`getInsertRows`、`insertPosition`）
- `src/workbench/components/DataGrid.vue`（行号 `@contextmenu`、emits、`insertRowsByAnchor`、`<tbody>` 渲染改造）
- `src/workbench/composables/useContextMenu.js`（`contextMenu` 字段、`openRowContextMenu`）
- `src/workbench/components/ContextMenu.vue`（props、emits、`grid-row` 分支）
- `src/workbench/components/WorkbenchPane.vue`（事件转发）
- `src/workbench/MySqlWorkbench.vue`（接线、props 传递）
- `src/workbench/composables/useRowSelection.js`（无改动，复用 `deleteRow`）

## 10. 不涉及的后端改动

后端 `insert_row` / `delete_rows` / `update_cell` 命令、`types.rs`、`mockBackend.js` 均无改动。"往上新增"纯前端视觉概念，提交仍是标准 `INSERT`。
