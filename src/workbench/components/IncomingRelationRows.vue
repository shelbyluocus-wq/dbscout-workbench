<script setup>
import { onBeforeUnmount, watch } from "vue";
import { ChevronRight } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { createIncomingRelationRows, fetchIncomingRelationRows } from "../incomingRelationRows.js";

const props = defineProps({
  context: { type: Object, required: true },
  count: { type: Number, default: null },
  title: { type: String, required: true },
});
const emit = defineEmits(["open-row"]);
const { state, reset, toggle, loadMore } = createIncomingRelationRows(
  (offset) => fetchIncomingRelationRows(props.context, offset),
);
watch(() => JSON.stringify(props.context), reset, { flush: "sync" });
onBeforeUnmount(reset);
</script>

<template>
  <article class="wb-incoming-relation">
    <button class="wb-incoming-toggle" type="button" :aria-expanded="state.expanded" :disabled="count === 0" @click="toggle">
      <ChevronRight :size="14" :class="{ 'is-expanded': state.expanded }" aria-hidden="true" />
      <span class="wb-incoming-summary">
        <span class="wb-incoming-title" :title="title">{{ title }}</span>
        <span class="wb-incoming-count">{{ count === null ? t('relations.incoming.countFailed') : t('relations.incoming.rows', { count }) }}</span>
      </span>
    </button>
    <div v-if="state.expanded" class="wb-incoming-details" :aria-busy="state.loading">
      <template v-for="row in state.rows" :key="`${row.ordinal}:${row.key}`">
        <button v-if="row.identity" type="button" class="wb-incoming-key" :title="t('relations.incoming.openRow')" @click="emit('open-row', row)">{{ row.label }}</button>
        <span v-else class="wb-incoming-muted">{{ t('relations.incoming.noKey', { row: row.ordinal }) }}</span>
      </template>
      <span v-if="state.loading" class="wb-incoming-muted" role="status">{{ t('relations.loading') }}</span>
      <template v-else-if="state.error">
        <span class="wb-incoming-error" role="alert">{{ state.error }}</span>
        <button type="button" class="wb-incoming-more" @click="loadMore">{{ t('relations.incoming.retry') }}</button>
      </template>
      <span v-else-if="state.loaded && !state.rows.length" class="wb-incoming-muted">{{ t('relations.incoming.empty') }}</span>
      <button v-else-if="state.hasMore" type="button" class="wb-incoming-more" @click="loadMore">{{ t('relations.incoming.more') }}</button>
    </div>
  </article>
</template>

<style scoped>
.wb-incoming-relation { border: 1px solid var(--wb-border); border-radius: 6px; background: var(--wb-field-surface); }
.wb-incoming-toggle { display: flex; align-items: center; gap: 5px; width: 100%; padding: 5px 8px; border: 0; border-radius: 6px; background: transparent; text-align: left; color: var(--wb-text); cursor: pointer; }
.wb-incoming-toggle:disabled { opacity: 1; cursor: default; }
.wb-incoming-toggle:disabled svg { visibility: hidden; }
.wb-incoming-toggle svg { flex: none; }
.wb-incoming-toggle svg.is-expanded { transform: rotate(90deg); }
.wb-incoming-summary { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.wb-incoming-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.wb-incoming-count { color: var(--wb-accent-strong); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.wb-incoming-details { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; max-height: 260px; overflow: auto; padding: 6px 8px 8px 27px; border-top: 1px solid var(--wb-border); }
.wb-incoming-details > * { flex: none; }
.wb-incoming-key, .wb-incoming-more { max-width: 100%; min-height: 0; padding: 2px 5px; border: 1px solid var(--wb-border); border-radius: 4px; background: var(--wb-control); color: var(--wb-text); font-size: 11.5px; text-align: left; overflow-wrap: anywhere; white-space: normal; cursor: pointer; user-select: text; }
.wb-incoming-key:hover, .wb-incoming-more:hover { border-color: var(--wb-accent); }
.wb-incoming-more { color: var(--wb-accent-strong); }
.wb-incoming-muted, .wb-incoming-error { font-size: 11.5px; overflow-wrap: anywhere; }
.wb-incoming-muted { color: var(--wb-secondary-text); }
.wb-incoming-error { color: var(--wb-danger); }
</style>
