<script setup>
import { computed } from "vue";
import { buildSelectedCellIdentity } from "../utils/selectedCellIdentity.js";

const props = defineProps({
  tab: { type: Object, default: null },
  selectedCell: { type: Object, default: null },
  selectedRange: { type: Object, default: null },
  panel: { type: Boolean, default: false },
});

const identity = computed(() =>
  buildSelectedCellIdentity(props.tab, props.selectedCell, props.selectedRange),
);
</script>

<template>
  <section
    v-if="identity"
    class="wb-cell-identity"
    :class="{ 'is-panel': panel }"
    :title="identity.title"
    aria-label="当前字段身份"
  >
    <span class="wb-cell-identity-label">当前字段</span>
    <strong class="wb-cell-identity-column">{{ identity.column }}</strong>
    <span class="wb-cell-identity-divider" aria-hidden="true"></span>
    <span class="wb-cell-identity-label">{{ identity.keyLabel }}</span>
    <strong v-if="identity.primaryKeyText" class="wb-cell-identity-key">{{ identity.primaryKeyText }}</strong>
    <template v-if="identity.selectedCount">
      <span class="wb-cell-identity-divider" aria-hidden="true"></span>
      <span class="wb-cell-identity-count">已选 {{ identity.selectedCount }} 个单元格</span>
    </template>
  </section>
</template>
