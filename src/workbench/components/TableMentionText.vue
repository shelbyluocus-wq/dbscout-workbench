<script setup>
// Renders text with a jump on each table name that exists in the supplied
// index. The rest of the text stays plain. On the relation surfaces a name
// with a comment reveals it on hover.
import { computed } from "vue";
import { t } from "../i18n/index.js";
import { splitTableMentions } from "../utils/tableMentions.js";
import TableCommentTip from "./TableCommentTip.vue";

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
      <TableCommentTip
        v-if="part.table"
        v-slot="{ describedBy, tip }"
        :name="part.table.name"
        :comment="part.table.comment"
      >
        <button
          type="button"
          class="wb-table-mention"
          :title="tip ? undefined : t('relations.action.openTable')"
          :aria-describedby="describedBy"
          @mousedown.stop.prevent
          @click.stop.prevent="openTable(part.table, $event)"
        >{{ part.text }}</button>
      </TableCommentTip>
      <template v-else>{{ part.text }}</template>
    </template>
  </span>
</template>
