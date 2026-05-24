<script setup>
import { columnName } from "../utils/normalize.js";

const props = defineProps({
  activeTab: { type: Object, default: null },
  activeColumns: { type: Array, default: () => [] },
  selectedCell: { type: Object, default: null },
  textDraft: { type: String, default: "" },
});

const emit = defineEmits(["update:textDraft", "save-text-panel"]);
</script>

<template>
  <aside class="wb-inspector wb-info-pane">
    <header class="wb-pane-header">
      <div>
        <strong>信息</strong>
        <span v-if="activeTab">{{ activeTab.tableName }}</span>
      </div>
    </header>
    <section v-if="activeTab" class="wb-schema-list">
      <article v-for="column in activeColumns" :key="columnName(column)">
        <span class="wb-object-icon" data-kind="column"></span>
        <span>
          <strong>{{ columnName(column) }}</strong>
          <em>{{ column.column_type }}{{ column.is_primary_key ? " · 主键" : "" }}</em>
          <small>{{ column.column_comment }}</small>
        </span>
      </article>
    </section>
    <section class="wb-text-panel">
      <div>
        <strong>{{ selectedCell?.column }}</strong>
      </div>
      <textarea
        :value="textDraft"
        :disabled="!selectedCell"
        placeholder="选中单元格后在这里查看或编辑长文本"
        @input="emit('update:textDraft', $event.target.value)"
        @change="emit('save-text-panel')"
      ></textarea>
    </section>
  </aside>
</template>
