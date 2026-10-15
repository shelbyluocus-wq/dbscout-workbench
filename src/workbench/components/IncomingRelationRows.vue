<script setup>
// One "referenced by" line on the relation page: which column of which table
// points at the selected row and how many rows do. It expands into the
// referencing rows (key and name, 50 at a time), each a jump, and a button
// opens all of them as one filtered tab.
import { computed, onBeforeUnmount, watch } from "vue";
import { ArrowRight, ChevronRight, LoaderCircle, SquareArrowOutUpRight } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { createIncomingRelationRows, fetchIncomingRelationRows } from "../incomingRelationRows.js";
import TableCommentTip from "./TableCommentTip.vue";

const props = defineProps({
  context: { type: Object, required: true },
  // Rows that reference the selected row; null when counting failed.
  count: { type: Number, default: null },
  // The count is still on its way.
  counting: { type: Boolean, default: false },
  table: { type: String, required: true },
  tableComment: { type: String, default: "" },
  column: { type: String, required: true },
});
const emit = defineEmits(["open-row", "open-all"]);
const { state, reset, toggle, loadMore } = createIncomingRelationRows(
  (offset) => fetchIncomingRelationRows(props.context, offset),
);
watch(() => JSON.stringify(props.context), reset, { flush: "sync" });
onBeforeUnmount(reset);

const empty = computed(() => !props.counting && props.count === 0);
const listKind = computed(() => props.context?.relation?.kind === "list");
const openAllLabel = computed(() => (Number.isFinite(props.count) && props.count > 0
  ? t("relations.incoming.openAll", { count: props.count })
  : t("relations.incoming.openAllUnknown")));
</script>

<template>
  <article class="wb-incoming-relation" :class="{ 'is-open': state.expanded, 'is-empty': empty }">
    <div class="wb-incoming-head">
      <button
        class="wb-incoming-toggle"
        type="button"
        :aria-expanded="state.expanded"
        :disabled="empty"
        :title="`${table}.${column}`"
        @click="toggle"
      >
        <ChevronRight :size="12" :stroke-width="2.2" class="wb-incoming-chevron" :class="{ 'is-open': state.expanded }" aria-hidden="true" />
        <span class="wb-incoming-title">
          <TableCommentTip :name="table" :comment="tableComment"><span class="wb-incoming-table">{{ table }}</span></TableCommentTip><span class="wb-incoming-column">.{{ column }}</span>
        </span>
        <span v-if="listKind" class="wb-incoming-tag">{{ t('relations.kindList') }}</span>
        <span v-if="counting" class="wb-incoming-count is-pending" role="status">
          <LoaderCircle :size="11" class="wb-incoming-spin" aria-hidden="true" />
          <span class="wb-visually-hidden">{{ t('relations.incoming.counting') }}</span>
        </span>
        <span v-else-if="count === null" class="wb-incoming-count is-failed">{{ t('relations.incoming.countFailed') }}</span>
        <span v-else class="wb-incoming-count">{{ t('relations.incoming.rows', { count }) }}</span>
      </button>
      <button
        v-if="!empty"
        type="button"
        class="wb-incoming-open"
        :title="openAllLabel"
        :aria-label="openAllLabel"
        @click="emit('open-all')"
      >
        <SquareArrowOutUpRight :size="13" aria-hidden="true" />
      </button>
    </div>
    <div v-if="state.expanded" class="wb-incoming-details" :aria-busy="state.loading">
      <ul v-if="state.rows.length" class="wb-incoming-list">
        <li v-for="row in state.rows" :key="`${row.ordinal}:${row.key}`">
          <button
            v-if="row.identity"
            type="button"
            class="wb-incoming-row"
            :title="t('relations.incoming.openRow')"
            @click="emit('open-row', row)"
          >
            <span class="wb-incoming-key">{{ row.label }}</span>
            <span v-if="row.name" class="wb-incoming-name">{{ row.name }}</span>
            <ArrowRight :size="12" class="wb-incoming-go" aria-hidden="true" />
          </button>
          <span v-else class="wb-incoming-note">{{ t('relations.incoming.noKey', { row: row.ordinal }) }}</span>
        </li>
      </ul>
      <p v-if="state.loading" class="wb-incoming-note" role="status">
        <LoaderCircle :size="12" class="wb-incoming-spin" aria-hidden="true" />{{ t('relations.loading') }}
      </p>
      <p v-else-if="state.error" class="wb-incoming-note is-error" role="alert">
        {{ state.error }}
        <button type="button" class="wb-incoming-more" @click="loadMore">{{ t('relations.incoming.retry') }}</button>
      </p>
      <p v-else-if="state.loaded && !state.rows.length" class="wb-incoming-note">{{ t('relations.incoming.empty') }}</p>
      <button v-else-if="state.hasMore" type="button" class="wb-incoming-more" @click="loadMore">{{ t('relations.incoming.more') }}</button>
    </div>
  </article>
</template>

<style scoped>
.wb-incoming-relation {
  border-radius: 6px;
  transition: background-color var(--wb-duration-fast) ease;
}

.wb-incoming-relation.is-open {
  background: var(--wb-list-hover);
}

.wb-incoming-head {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  border-radius: 6px;
}

.wb-incoming-head:hover {
  background: var(--wb-list-hover);
}

.wb-incoming-relation.is-open .wb-incoming-head:hover {
  background: none;
}

.wb-incoming-toggle {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 5px;
  min-width: 0;
  min-height: 26px;
  padding: 0 6px 0 4px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--wb-text);
  font-size: 12px;
  text-align: left;
}

.wb-incoming-toggle:hover:not(:disabled),
.wb-incoming-toggle:active:not(:disabled) {
  background: transparent;
}

.wb-incoming-toggle:disabled {
  opacity: 1;
  color: var(--wb-secondary-text);
}

.wb-incoming-toggle:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: -2px;
}

.wb-incoming-chevron {
  flex: none;
  color: var(--wb-quiet-text);
  transition: transform var(--wb-duration-fast) var(--wb-ease-out);
}

.wb-incoming-chevron.is-open {
  transform: rotate(90deg);
}

.wb-incoming-toggle:disabled .wb-incoming-chevron {
  visibility: hidden;
}

.wb-incoming-title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-incoming-table {
  color: var(--wb-identifier-text);
  font-weight: 600;
}

.wb-incoming-column {
  color: var(--wb-secondary-text);
}

.wb-incoming-toggle:disabled .wb-incoming-table {
  color: var(--wb-secondary-text);
  font-weight: 500;
}

.wb-incoming-tag {
  flex: none;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--wb-text) 7%, transparent);
  color: var(--wb-secondary-text);
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
}

.wb-incoming-count {
  display: inline-flex;
  flex: none;
  align-items: center;
  margin-left: auto;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--wb-relation-in-soft);
  color: var(--wb-relation-in);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  line-height: 16px;
  white-space: nowrap;
}

.wb-incoming-relation.is-empty .wb-incoming-count {
  background: none;
  color: var(--wb-quiet-text);
  font-weight: 500;
}

.wb-incoming-count.is-pending {
  background: none;
  color: var(--wb-quiet-text);
}

.wb-incoming-count.is-failed {
  background: var(--wb-danger-surface);
  color: var(--wb-danger-text);
}

.wb-incoming-open {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 24px;
  height: 24px;
  min-height: 24px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--wb-quiet-text);
}

.wb-incoming-open:hover:not(:disabled) {
  background: color-mix(in srgb, var(--wb-text) 8%, transparent);
  color: var(--wb-text);
}

.wb-incoming-details {
  display: grid;
  gap: 4px;
  padding: 0 6px 6px 21px;
}

.wb-incoming-list {
  display: grid;
  max-height: 248px;
  margin: 0;
  padding: 2px 0;
  overflow: auto;
  overscroll-behavior: contain;
  list-style: none;
  border-radius: 6px;
  background: var(--wb-field-surface);
  box-shadow: inset 0 0 0 1px var(--wb-line);
}

.wb-incoming-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 24px;
  padding: 2px 8px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--wb-text);
  font-size: 11px;
  text-align: left;
  user-select: text;
}

.wb-incoming-row:hover:not(:disabled) {
  background: var(--wb-list-hover);
}

.wb-incoming-row:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: -2px;
}

.wb-incoming-key {
  flex: none;
  max-width: 55%;
  overflow: hidden;
  color: var(--wb-identifier-text);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-incoming-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--wb-secondary-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-incoming-go {
  flex: none;
  margin-left: auto;
  color: var(--wb-quiet-text);
  opacity: 0;
  transition: opacity var(--wb-duration-fast) ease;
}

.wb-incoming-row:hover .wb-incoming-go,
.wb-incoming-row:focus-visible .wb-incoming-go {
  opacity: 1;
}

.wb-incoming-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  margin: 0;
  padding: 2px 8px;
  color: var(--wb-secondary-text);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.wb-incoming-note.is-error {
  color: var(--wb-danger-text);
}

.wb-incoming-more {
  justify-self: start;
  min-height: 22px;
  height: 22px;
  padding: 0 8px;
  border-radius: 5px;
  color: var(--wb-accent-strong);
  font-size: 11px;
}

.wb-incoming-spin {
  flex: none;
  animation: wb-incoming-rotate 0.9s linear infinite;
}

@keyframes wb-incoming-rotate {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .wb-incoming-relation,
  .wb-incoming-chevron,
  .wb-incoming-go {
    transition: none;
  }

  .wb-incoming-spin {
    animation: none;
  }
}
</style>
