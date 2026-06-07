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
});

const emit = defineEmits(['refresh', 'open-design', 'sync-database', 'send-table', 'rename']);

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
    <button v-if="tableScoped" type="button" role="menuitem" @click="emit('open-design')">表设计</button>
    <button v-if="tableScoped" type="button" role="menuitem" @click="emit('rename')">重命名</button>
    <button type="button" role="menuitem" @click="emit('refresh')">刷新</button>
    <button v-if="kind === 'database'" type="button" role="menuitem" @click="emitSyncDatabase">覆盖同步...</button>
    <button v-if="tableScoped" type="button" role="menuitem" @click="emit('send-table')">发送到...</button>
  </menu>
</template>
