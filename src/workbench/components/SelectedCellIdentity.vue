<script setup>
import { t } from "../i18n/index.js";
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
    :aria-label="t('m_297cfa49116d')"
  >
    <span class="wb-cell-identity-label">{{ t('m_a77aad0b736a') }}</span>
    <strong class="wb-cell-identity-column">{{ identity.column }}</strong>
    <span class="wb-cell-identity-divider" aria-hidden="true"></span>
    <span class="wb-cell-identity-label">{{ identity.keyLabel }}</span>
    <strong v-if="identity.primaryKeyText" class="wb-cell-identity-key">{{ identity.primaryKeyText }}</strong>
    <template v-if="identity.selectedCount">
      <span class="wb-cell-identity-divider" aria-hidden="true"></span>
      <span class="wb-cell-identity-count">{{ t('m_7ecf1cde6486') }} {{ identity.selectedCount }} {{ t('m_69194a31346f') }}</span>
    </template>
  </section>
</template>
