<script setup>
// Renders text with a jump on each table name that exists in the supplied
// index. The rest of the text stays plain.
import { computed } from "vue";
import { t } from "../i18n/index.js";
import { splitTableMentions } from "../utils/tableMentions.js";

const props = defineProps({
  text: { type: String, default: "" },
  tables: { type: Object, default: null },
});

const emit = defineEmits(["open"]);

const parts = computed(() => splitTableMentions(props.text, props.tables) || [{ text: props.text ?? "" }]);

function openTable(table, event) {
  event.stopPropagation();
  event.preventDefault();
  emit("open", table);
}
</script>

<template>
  <span class="wb-table-mention-text">
    <template v-for="(part, index) in parts" :key="index">
      <button
        v-if="part.table"
        type="button"
        class="wb-table-mention"
        :title="t('relations.action.openTable')"
        @mousedown.stop.prevent
        @click.stop.prevent="openTable(part.table, $event)"
      >{{ part.text }}</button>
      <template v-else>{{ part.text }}</template>
    </template>
  </span>
</template>
