<script setup>
import { t } from "../i18n/index.js";
import { searchKindLabel } from "../utils/searchKindLabels.js";
const props = defineProps({
  kind: { type: String, default: "tableName" },
  subtle: { type: Boolean, default: false },
  label: { type: String, default: "" },
});

const KNOWN_KINDS = new Set(["tableName", "tableComment", "columnName", "columnComment", "value"]);
</script>

<template>
  <span
    class="wb-search-hit-badge"
    :class="[`is-${props.kind}`, { 'is-subtle': props.subtle }]"
  >{{ props.label || (KNOWN_KINDS.has(props.kind) ? searchKindLabel(props.kind) : t('m_3b15fa5b2ac0')) }}</span>
</template>
