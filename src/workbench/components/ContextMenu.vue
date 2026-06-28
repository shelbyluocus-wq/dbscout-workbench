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
});

const emit = defineEmits(['refresh', 'open-design', 'sync-database', 'send-table', 'rename', 'remove-connection', 'grid-row-insert-above', 'grid-row-delete', 'set-null', 'toggle-hit-result-pane']);

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
    <button v-if="kind === 'database'" type="button" role="menuitem" @click="emitSyncDatabase">覆盖同步…</button>
    <!-- 危险操作放最后 -->
    <button v-if="kind === 'connection'" type="button" role="menuitem" class="danger" @click="emit('remove-connection')">移除连接</button>
  </menu>
</template>
