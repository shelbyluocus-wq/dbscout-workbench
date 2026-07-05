<script setup>
import { computed } from 'vue';

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
  // True only when a data cell is selected on a nullable, non-PK column so the
  // "设为 NULL" action is meaningful (#5).
  canSetNull: { type: Boolean, default: false },
  canToggleHitResultPane: { type: Boolean, default: false },
  hitResultPaneOpen: { type: Boolean, default: false },
  // 「删除行」按钮文字：选中多行时由父组件传入「删除 X 行」。
  deleteLabel: { type: String, default: "删除行" },
  // ── Freeze panes ───────────────────────────────────────────────────────
  // 是否显示「冻结到此行 / 冻结到此列 / 冻结到此单元格」。父组件依据右键目标位置决定。
  canFreezeRow: { type: Boolean, default: false },
  canFreezeColumn: { type: Boolean, default: false },
  // 「冻结到此单元格」：同时冻结该单元格上方所有行 + 左侧所有列（Excel「冻结窗格」语义）。
  canFreezeCell: { type: Boolean, default: false },
  // 当前是否存在任意冻结（决定「取消冻结」是否显示）。
  hasFreeze: { type: Boolean, default: false },
  // 动态标签。
  freezeRowLabel: { type: String, default: "冻结到此行" },
  freezeColumnLabel: { type: String, default: "冻结到此列" },
  freezeCellLabel: { type: String, default: "冻结到此单元格" },
});

const emit = defineEmits(['refresh', 'open-design', 'sync-database', 'send-table', 'rename', 'rename-database', 'rename-connection', 'remove-connection', 'grid-row-insert-above', 'grid-row-delete', 'set-null', 'toggle-hit-result-pane', 'freeze-row', 'freeze-column', 'freeze-cell', 'freeze-top-row', 'freeze-first-column', 'unfreeze']);

function emitSyncDatabase() {
  emit('sync-database', {
    kind: props.kind,
    connectionId: props.connectionId,
    database: props.database,
  });
}

const contextMenuStyle = computed(() => ({
  left: `${props.x}px`,
  top: `${props.y}px`,
}));
</script>

<template>
  <menu v-if="open" class="wb-context-menu" :style="contextMenuStyle" role="menu" aria-label="上下文菜单" @click.stop>
    <!-- 行操作组 -->
    <template v-if="kind === 'grid-row' && !rowReadOnly">
      <button type="button" role="menuitem" @click="emit('grid-row-insert-above')">往上新增行</button>
      <button v-if="canSetNull" type="button" role="menuitem" @click="emit('set-null')">设为 NULL</button>
      <button type="button" role="menuitem" class="danger" @click="emit('grid-row-delete')">{{ deleteLabel }}</button>
      <hr v-if="tableScoped || canFreezeRow || canFreezeColumn || canFreezeCell || hasFreeze" class="wb-context-separator" role="separator" />
    </template>
    <!-- 冻结窗格组：在表格/行右键时出现，按位置冻结（Excel 语义） -->
    <template v-if="tableScoped || kind === 'grid-row'">
      <button v-if="canFreezeCell" type="button" role="menuitem" @click="emit('freeze-cell')">{{ freezeCellLabel }}</button>
      <button v-if="canFreezeRow" type="button" role="menuitem" @click="emit('freeze-row')">{{ freezeRowLabel }}</button>
      <button v-if="canFreezeColumn" type="button" role="menuitem" @click="emit('freeze-column')">{{ freezeColumnLabel }}</button>
      <button v-if="!canFreezeCell && !canFreezeRow && !canFreezeColumn" type="button" role="menuitem" @click="emit('freeze-top-row')">冻结首行</button>
      <button v-if="!canFreezeCell && !canFreezeRow && !canFreezeColumn" type="button" role="menuitem" @click="emit('freeze-first-column')">冻结首列</button>
      <button v-if="hasFreeze" type="button" role="menuitem" @click="emit('unfreeze')">取消冻结</button>
      <hr v-if="tableScoped" class="wb-context-separator" role="separator" />
    </template>
    <!-- 表操作组 -->
    <button v-if="tableScoped" type="button" role="menuitem" @click="emit('open-design')">表设计</button>
    <button v-if="tableScoped" type="button" role="menuitem" @click="emit('rename')">重命名</button>
    <button v-if="tableScoped" type="button" role="menuitem" @click="emit('send-table')">发送到…</button>
    <button v-if="tableScoped && canToggleHitResultPane" type="button" role="menuitem" @click="emit('toggle-hit-result-pane')">{{ hitResultPaneOpen ? '关闭命中结果分栏' : '命中结果分栏' }}</button>
    <hr v-if="tableScoped || kind === 'database' || kind === 'connection'" class="wb-context-separator" role="separator" />
    <!-- 通用操作组 -->
    <button type="button" role="menuitem" @click="emit('refresh')">刷新</button>
    <button v-if="kind === 'connection'" type="button" role="menuitem" @click="emit('rename-connection')">重命名（本地别名）</button>
    <button v-if="kind === 'database'" type="button" role="menuitem" @click="emit('rename-database')">重命名（本地别名）</button>
    <button v-if="kind === 'database'" type="button" role="menuitem" @click="emitSyncDatabase">覆盖同步…</button>
    <!-- 危险操作放最后 -->
    <button v-if="kind === 'connection'" type="button" role="menuitem" class="danger" @click="emit('remove-connection')">移除连接</button>
  </menu>
</template>
