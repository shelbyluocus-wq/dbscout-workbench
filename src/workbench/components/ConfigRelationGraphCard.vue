<script setup>
// The relation graph's info card for one table: which tables it references
// and which reference it, each table once with its fields beneath. Hovering
// shows a compact card; a pinned card adds the table's comment, its reach in
// the database and actions (open, center the graph on it, unpin). The graph
// decides where it goes: floating in the canvas, or docked under a narrow one.
import { t } from "../i18n/index.js";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Crosshair, Pin, PinOff, Repeat2, SquareArrowOutUpRight } from "lucide-vue-next";
import { relationStatusLabel } from "../utils/configRelations.js";
import CommentTip from "./CommentTip.vue";

defineProps({
  // { id, pinned, side, name, comment, center, openable, focusable, total, sections }
  card: { type: Object, required: true },
  // Under the graph instead of over it.
  docked: { type: Boolean, default: false },
});

const emit = defineEmits(["open", "focus", "unpin"]);

const SECTION_ICONS = Object.freeze({ references: ArrowUpRight, referencedBy: ArrowDownLeft, self: Repeat2 });

function sectionTitle(section) {
  if (section.key === "self") return t("relations.graph.card.selfFields", { count: section.fieldCount });
  return t(`relations.graph.card.${section.key}Tables`, { count: section.tableCount });
}
</script>

<template>
  <!-- Unpinned, the table's aria-label already speaks for the card; pinned,
       the card holds buttons and becomes a region of its own. -->
  <div
    class="wb-relation-graph-card"
    :class="{ 'is-pinned': card.pinned, 'is-docked': docked }"
    :role="card.pinned ? 'region' : undefined"
    :aria-label="card.pinned ? card.name : undefined"
    :aria-hidden="card.pinned ? undefined : 'true'"
  >
    <header class="wb-relation-graph-card-head">
      <span class="wb-relation-graph-card-dot" :class="`is-${card.side}`" aria-hidden="true" />
      <div class="wb-relation-graph-card-title">
        <strong>{{ card.name }}</strong>
        <span v-if="card.comment" class="wb-relation-graph-card-comment">{{ card.comment }}</span>
      </div>
      <span v-if="card.center" class="wb-relation-graph-card-badge">{{ t('relations.graph.card.center') }}</span>
      <span v-if="card.pinned" class="wb-relation-graph-card-badge is-pin">
        <Pin :size="10" aria-hidden="true" />{{ t('relations.graph.card.pinned') }}
      </span>
    </header>
    <p v-if="card.pinned" class="wb-relation-graph-card-total">{{ t('relations.graph.card.total', { count: card.total }) }}</p>
    <div class="wb-relation-graph-card-body">
      <section
        v-for="section in card.sections"
        :key="section.key"
        class="wb-relation-graph-card-section"
        :class="`is-${section.key}`"
      >
        <h4>
          <component :is="SECTION_ICONS[section.key]" :size="12" :stroke-width="2.2" aria-hidden="true" />
          {{ sectionTitle(section) }}
        </h4>
        <ul>
          <li v-for="group in section.groups" :key="group.table" class="wb-relation-graph-card-group">
            <div class="wb-relation-graph-card-table-line">
              <button
                v-if="card.pinned && group.openable && section.key !== 'self'"
                type="button"
                class="wb-relation-graph-card-table"
                :title="t('relations.graph.card.openTable', { name: group.name })"
                @click="emit('open', group.table)"
              >{{ group.name }}</button>
              <span v-else class="wb-relation-graph-card-table is-plain">{{ section.key === 'self' ? card.name : group.name }}</span>
              <span v-if="group.comment && section.key !== 'self'" class="wb-relation-graph-card-table-comment">{{ group.comment }}</span>
            </div>
            <ul class="wb-relation-graph-card-fields">
              <li v-for="field in group.fields" :key="field.id">
                <!-- Only the pinned card takes the pointer, so only it offers field comments. -->
                <code><CommentTip field :name="field.fromName" :comment="card.pinned ? field.fromComment : ''">{{ field.from }}</CommentTip></code>
                <ArrowRight :size="10" :stroke-width="2.2" class="wb-relation-graph-card-arrow" aria-hidden="true" />
                <code><CommentTip field :name="field.toName" :comment="card.pinned ? field.toComment : ''">{{ field.to }}</CommentTip></code>
                <span
                  v-if="field.status !== 'confirmed'"
                  class="wb-relation-graph-card-status"
                  :class="`is-${field.status}`"
                >{{ relationStatusLabel(field.status, t) }}</span>
              </li>
            </ul>
          </li>
        </ul>
        <p v-if="section.more" class="wb-relation-graph-card-more">
          {{ t(card.pinned ? 'relations.graph.card.moreTablesPinned' : 'relations.graph.card.moreTables', { count: section.more }) }}
        </p>
      </section>
    </div>
    <footer v-if="card.pinned" class="wb-relation-graph-card-actions">
      <button v-if="card.openable" type="button" class="wb-relation-graph-card-action is-primary" @click="emit('open', card.id)">
        <SquareArrowOutUpRight :size="12" aria-hidden="true" />{{ t('relations.graph.card.open') }}
      </button>
      <button v-if="card.focusable" type="button" class="wb-relation-graph-card-action" @click="emit('focus', card.id)">
        <Crosshair :size="12" aria-hidden="true" />{{ t('relations.graph.card.focus') }}
      </button>
      <button type="button" class="wb-relation-graph-card-action is-quiet" @click="emit('unpin')">
        <PinOff :size="12" aria-hidden="true" />{{ t('relations.graph.card.unpin') }}
      </button>
    </footer>
    <footer v-else class="wb-relation-graph-card-hint">
      <span v-if="card.openable">{{ t('relations.graph.card.clickHint') }}</span>
      <span>{{ t('relations.graph.card.pinHint') }}</span>
    </footer>
  </div>
</template>

<style scoped>
.wb-relation-graph-card {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border-radius: 10px;
  background: var(--wb-menu-surface);
  box-shadow: 0 0 0 1px var(--wb-border), var(--wb-floating-shadow);
  color: var(--wb-text);
  font-size: var(--wb-fs-caption);
  line-height: 1.45;
  pointer-events: none;
}

/* Pinned: the card takes the pointer so it can scroll and act. */
.wb-relation-graph-card.is-pinned {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--wb-accent) 55%, var(--wb-border)), var(--wb-floating-shadow);
  pointer-events: auto;
}

/* Docked under a narrow graph: part of the page, not floating over it. */
.wb-relation-graph-card.is-docked {
  max-height: 340px;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--wb-accent) 40%, var(--wb-border));
  background: var(--wb-field-surface);
}

.wb-relation-graph-card p {
  margin: 0;
}

.wb-relation-graph-card-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 12px 7px;
}

.wb-relation-graph-card-dot {
  flex: none;
  width: 10px;
  height: 10px;
  margin-top: 4px;
  border: 1.5px solid color-mix(in srgb, var(--wb-text) 38%, transparent);
  border-radius: 50%;
  background: color-mix(in srgb, var(--wb-text) 10%, var(--wb-surface));
}

.wb-relation-graph-card-dot.is-center {
  border-color: var(--wb-surface);
  background: var(--wb-accent-control);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--wb-accent-control) 22%, transparent);
}

.wb-relation-graph-card-dot.is-out {
  border-color: var(--wb-relation-out);
  background: var(--wb-relation-out-soft);
}

.wb-relation-graph-card-dot.is-in {
  border-color: var(--wb-relation-in);
  background: var(--wb-relation-in-soft);
}

.wb-relation-graph-card-dot.is-both {
  border-color: color-mix(in srgb, var(--wb-relation-out) 50%, var(--wb-relation-in));
  background: color-mix(in srgb, var(--wb-relation-out-soft) 50%, var(--wb-relation-in-soft));
}

/* Name and comment on one line while hovering; the pinned card has room for both. */
.wb-relation-graph-card-title {
  display: flex;
  flex: 1 1 auto;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.wb-relation-graph-card-title strong {
  flex: none;
  max-width: 100%;
  overflow: hidden;
  font-size: var(--wb-fs-body);
  font-weight: 650;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-relation-graph-card-comment {
  min-width: 0;
  overflow: hidden;
  color: var(--wb-secondary-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-relation-graph-card.is-pinned .wb-relation-graph-card-title {
  display: grid;
  gap: 1px;
}

.wb-relation-graph-card.is-pinned .wb-relation-graph-card-title strong {
  font-size: var(--wb-fs-body);
  white-space: normal;
  overflow-wrap: anywhere;
}

.wb-relation-graph-card.is-pinned .wb-relation-graph-card-comment {
  display: -webkit-box;
  white-space: normal;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.wb-relation-graph-card-badge {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--wb-accent-soft);
  color: var(--wb-accent-strong);
  font-size: var(--wb-fs-caption);
  font-weight: 600;
  line-height: 17px;
  white-space: nowrap;
}

.wb-relation-graph-card-total {
  margin-top: -3px;
  padding: 0 12px 8px 30px;
  color: var(--wb-quiet-text);
  font-size: var(--wb-fs-caption);
}

.wb-relation-graph-card-body {
  display: grid;
  flex: 1 1 auto;
  align-content: start;
  gap: 8px;
  min-height: 0;
  padding: 8px 12px 10px;
  overflow: hidden;
  border-top: 1px solid var(--wb-line);
}

.wb-relation-graph-card.is-pinned .wb-relation-graph-card-body {
  overflow: auto;
  overscroll-behavior: contain;
}

.wb-relation-graph-card-section {
  display: grid;
  gap: 4px;
}

.wb-relation-graph-card-section h4 {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  color: var(--wb-secondary-text);
  font-size: var(--wb-fs-caption);
  font-weight: 600;
}

.wb-relation-graph-card-section.is-references h4 svg {
  color: var(--wb-relation-out);
}

.wb-relation-graph-card-section.is-referencedBy h4 svg {
  color: var(--wb-relation-in);
}

.wb-relation-graph-card-section > ul {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0 0 0 17px;
  list-style: none;
}

.wb-relation-graph-card-group {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.wb-relation-graph-card-table-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.wb-relation-graph-card-table {
  flex: none;
  max-width: 100%;
  overflow: hidden;
  font: inherit;
  font-size: var(--wb-fs-caption);
  font-weight: 600;
  color: var(--wb-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

button.wb-relation-graph-card-table {
  min-height: 0;
  padding: 0;
  border: none;
  background: none;
  color: var(--wb-accent-strong);
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--wb-accent) 40%, transparent);
  text-underline-offset: 2px;
}

button.wb-relation-graph-card-table:hover:not(:disabled) {
  background: none;
  text-decoration-color: currentColor;
}

button.wb-relation-graph-card-table:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: 1px;
  border-radius: 2px;
}

.wb-relation-graph-card-table-comment {
  min-width: 0;
  overflow: hidden;
  color: var(--wb-quiet-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-relation-graph-card-fields {
  display: grid;
  gap: 1px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.wb-relation-graph-card-fields li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 4px;
  min-width: 0;
  color: var(--wb-secondary-text);
}

.wb-relation-graph-card-fields code {
  font-family: var(--wb-font-mono, ui-monospace, "Cascadia Mono", Consolas, monospace);
  font-size: var(--wb-fs-caption);
  overflow-wrap: anywhere;
}

.wb-relation-graph-card-arrow {
  flex: none;
  color: var(--wb-quiet-text);
}

.wb-relation-graph-card-status {
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--wb-text) 7%, transparent);
  color: var(--wb-secondary-text);
  font-size: var(--wb-fs-micro);
  font-weight: 600;
  line-height: 15px;
}

.wb-relation-graph-card-status.is-stale {
  background: var(--wb-warning-surface);
  color: var(--wb-warning-text);
}

.wb-relation-graph-card-status.is-conflict {
  background: var(--wb-danger-surface);
  color: var(--wb-danger-text);
}

.wb-relation-graph-card-more {
  padding-left: 17px;
  color: var(--wb-quiet-text);
}

.wb-relation-graph-card-hint {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 2px 12px;
  padding: 6px 12px 8px;
  border-top: 1px solid var(--wb-line);
  color: var(--wb-quiet-text);
  font-size: var(--wb-fs-caption);
}

.wb-relation-graph-card-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px 10px;
  border-top: 1px solid var(--wb-line);
}

.wb-relation-graph-card-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 24px;
  height: 24px;
  padding: 0 9px;
  border-radius: 6px;
  font-size: var(--wb-fs-caption);
}

.wb-relation-graph-card-action.is-primary {
  border-color: var(--wb-accent-control);
  background: var(--wb-accent-control);
  color: var(--wb-accent-control-text);
}

.wb-relation-graph-card-action.is-primary:hover:not(:disabled) {
  border-color: var(--wb-accent-control-hover);
  background: var(--wb-accent-control-hover);
}

.wb-relation-graph-card-action.is-primary:disabled {
  border-color: var(--wb-border);
  background: var(--wb-control);
  color: var(--wb-disabled);
  cursor: default;
}

.wb-relation-graph-card-action.is-quiet {
  margin-left: auto;
  border-color: transparent;
  background: transparent;
  color: var(--wb-secondary-text);
}

.wb-relation-graph-card-action.is-quiet:hover:not(:disabled) {
  border-color: var(--wb-border);
  color: var(--wb-text);
}
</style>
