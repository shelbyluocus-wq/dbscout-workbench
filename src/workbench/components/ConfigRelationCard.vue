<script setup>
// One relation: its two ends, why it is believed and the review actions that
// fit its status. In the inspector it is a compact list row whose evidence
// opens on demand; the review dialog shows the same item with its evidence
// laid out (`detailed`).
import { t } from "../i18n/index.js";
import { computed, ref } from "vue";
import { relationHasMultipleValues } from "../utils/referenceParser.js";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Ban,
  Braces,
  Check,
  ChevronDown,
  CodeXml,
  Info,
  Link2,
  MessageSquareText,
  Undo2,
} from "lucide-vue-next";
import {
  relationEndParts,
  relationEvidenceKey,
  relationEvidenceTitle,
  relationIsActionable,
  relationReasonLabel,
  tableColumnComment,
  tableDisplayName,
} from "../utils/configRelations.js";
import CommentTip from "./CommentTip.vue";
import TableMentionText from "./TableMentionText.vue";
import RelationStatusBadge from "./RelationStatusBadge.vue";
import RelationEvidenceList from "./RelationEvidenceList.vue";

const props = defineProps({
  relation: { type: Object, required: true },
  // "source.column → target.column"; each end links its table when present in `tables`.
  title: { type: String, required: true },
  titleHint: { type: String, default: "" },
  // Current-database table index. Names in the title link only when present.
  tables: { type: Object, default: null },
  // Backend lowercase-name -> { name, comment, columns } map; gives each
  // field in the title its comment card.
  labels: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  // "outgoing" / "incoming" relative to the inspected table; picks the icon.
  direction: { type: String, default: "" },
  // Evidence always visible, no disclosure (review dialog).
  detailed: { type: Boolean, default: false },
});

const emit = defineEmits(["open", "review"]);

const EVIDENCE_ICONS = Object.freeze({ comment: MessageSquareText, code: CodeXml, format: Braces });
const DIRECTION_ICONS = Object.freeze({ outgoing: ArrowUpRight, incoming: ArrowDownLeft });

const rejected = computed(() => props.relation.status === "rejected");
const actionable = computed(() => relationIsActionable(props.relation));
// Confirmed relations are the norm; only the exceptions carry a pill.
const showStatus = computed(() => !rejected.value && props.relation.status !== "confirmed");
// The title reads source → target; each end's field carries its comment.
function titleEnd(text, table, column) {
  return {
    ...relationEndParts(text, column),
    tipName: `${tableDisplayName(props.labels, table)}.${column}`,
    comment: tableColumnComment(props.labels, table, column),
  };
}

const ends = computed(() => {
  const [from, ...rest] = String(props.title || "").split(" → ");
  const to = rest.join(" → ");
  const relation = props.relation;
  return {
    from: titleEnd(from, relation.sourceTable, relation.sourceColumn),
    to: to ? titleEnd(to, relation.targetTable, relation.targetColumn) : null,
  };
});
const leadIcon = computed(() => DIRECTION_ICONS[props.direction] || Link2);
const evidence = computed(() => props.relation.evidence || []);

const open = ref(false);
const showDetails = computed(() => props.detailed || open.value);
const detailsId = `wb-relation-card-${Math.random().toString(36).slice(2, 10)}`;

function toggle() {
  if (!props.detailed) open.value = !open.value;
}

// The whole row opens the evidence for pointer users; links and buttons
// inside it keep their own clicks, and the chevron button is the keyboard path.
function onRowClick(event) {
  if (event.target?.closest?.("button, a, input")) return;
  if (globalThis.window?.getSelection?.()?.toString()) return;
  toggle();
}
</script>

<template>
  <article
    class="wb-relation-card"
    :class="[
      `is-${relation.status}`,
      {
        'is-detailed': detailed,
        'is-open': showDetails && !detailed,
        'is-rejected': rejected,
        'needs-review': actionable,
      },
    ]"
  >
    <div class="wb-relation-card-row" @click="onRowClick">
      <component
        :is="leadIcon"
        :size="14"
        :stroke-width="2"
        class="wb-relation-card-icon"
        :class="direction ? `is-${direction}` : ''"
        aria-hidden="true"
      />
      <div class="wb-relation-card-copy">
        <div class="wb-relation-card-title" :title="titleHint || title">
          <template v-for="(end, index) in [ends.from, ends.to]" :key="index">
            <ArrowRight v-if="end && index" :size="11" :stroke-width="2.2" class="wb-relation-card-arrow" aria-hidden="true" />
            <span v-if="end" class="wb-relation-card-end">
              <TableMentionText v-if="end.prefix" :text="end.prefix" :tables="tables" @open="emit('open', $event)" /><CommentTip
                v-if="end.column"
                field
                :name="end.tipName"
                :comment="end.comment"
              >{{ end.column }}</CommentTip>
            </span>
          </template>
          <span v-if="relationHasMultipleValues(relation)" class="wb-relation-card-tag">{{ t('relations.kindList') }}</span>
          <RelationStatusBadge v-if="showStatus" :status="relation.status" />
          <span v-if="relation.isNew && !rejected" class="wb-relation-card-tag is-new">{{ t('relations.review.new') }}</span>
        </div>
        <div v-if="!rejected" class="wb-relation-card-meta">
          <span class="wb-relation-card-reason">{{ relationReasonLabel(relation.reason, t) }}</span>
          <span v-if="evidence.length && !detailed" class="wb-relation-card-evidence">
            <span
              v-for="item in evidence"
              :key="relationEvidenceKey(item)"
              class="wb-relation-card-evidence-icon"
              :title="`${t(`relations.evidence.${item.type}`)}：${relationEvidenceTitle(item)}`"
            >
              <component :is="EVIDENCE_ICONS[item.type] || Info" :size="12" aria-hidden="true" />
              <span class="wb-visually-hidden">{{ t(`relations.evidence.${item.type}`) }}</span>
            </span>
          </span>
        </div>
        <p v-if="relation.codeTarget && !showDetails" class="wb-relation-card-conflict">
          <TableMentionText
            :text="t('relations.codeTarget', { target: relation.codeTarget })"
            :tables="tables"
            @open="emit('open', $event)"
          />
        </p>
      </div>
      <button
        v-if="!detailed && !rejected"
        type="button"
        class="wb-relation-card-disclosure"
        :aria-expanded="open"
        :aria-controls="detailsId"
        :title="open ? t('relations.card.hideDetails') : t('relations.card.showDetails')"
        :aria-label="open ? t('relations.card.hideDetails') : t('relations.card.showDetails')"
        @click="toggle"
      >
        <ChevronDown :size="13" :class="{ 'is-open': open }" aria-hidden="true" />
      </button>
    </div>

    <div v-if="showDetails && !rejected" :id="detailsId" class="wb-relation-card-details">
      <RelationEvidenceList :relation="relation" :tables="tables" @open="emit('open', $event)" />
      <p v-if="relation.decidedAt" class="wb-relation-card-decided">{{ t('relations.card.decidedAt', { time: relation.decidedAt }) }}</p>
    </div>

    <div v-if="rejected" class="wb-relation-card-actions">
      <button type="button" class="wb-relation-card-action" :disabled="busy" @click="emit('review', null)">
        <Undo2 :size="12" aria-hidden="true" />{{ t('relations.action.restore') }}
      </button>
    </div>
    <div v-else-if="actionable" class="wb-relation-card-actions">
      <button type="button" class="wb-relation-card-action is-confirm" :disabled="busy" @click="emit('review', 'confirmed')">
        <Check :size="12" aria-hidden="true" />{{ t('relations.action.confirm') }}
      </button>
      <button type="button" class="wb-relation-card-action" :disabled="busy" @click="emit('review', 'rejected')">
        <Ban :size="12" aria-hidden="true" />{{ t('relations.action.reject') }}
      </button>
    </div>
  </article>
</template>

<style scoped>
.wb-relation-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 5px 4px 5px 6px;
  border-radius: 6px;
  transition: background-color var(--wb-duration-fast) ease;
}

.wb-relation-card:hover,
.wb-relation-card.is-open {
  background: var(--wb-list-hover);
}

/* Items waiting for a decision carry a status rule on their leading edge. */
.wb-relation-card.needs-review::before {
  content: "";
  position: absolute;
  top: 6px;
  bottom: 6px;
  left: 0;
  width: 2px;
  border-radius: 2px;
  background: var(--wb-warning-border);
}

.wb-relation-card.needs-review.is-conflict::before {
  background: var(--wb-danger);
}

.wb-relation-card.is-detailed {
  gap: 8px;
  padding: 10px 12px 10px 12px;
  border: 1px solid var(--wb-border);
  border-radius: 8px;
  background: var(--wb-field-surface);
}

.wb-relation-card.is-detailed:hover {
  background: var(--wb-field-surface);
}

.wb-relation-card.is-detailed.needs-review::before {
  top: 10px;
  bottom: 10px;
  left: -1px;
  width: 3px;
}

.wb-relation-card-row {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: start;
  gap: 6px;
  cursor: default;
}

.wb-relation-card:not(.is-detailed):not(.is-rejected) .wb-relation-card-row {
  cursor: pointer;
}

.wb-relation-card-icon {
  margin-top: 2px;
  color: var(--wb-quiet-text);
}

.wb-relation-card-icon.is-outgoing {
  color: var(--wb-relation-out);
}

.wb-relation-card-icon.is-incoming {
  color: var(--wb-relation-in);
}

.wb-relation-card-copy {
  display: grid;
  gap: 1px;
  min-width: 0;
}

.wb-relation-card-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 5px;
  min-width: 0;
  color: var(--wb-identifier-text);
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
}

.wb-relation-card-end {
  min-width: 0;
  overflow-wrap: anywhere;
}

.wb-relation-card-arrow {
  flex: none;
  color: var(--wb-quiet-text);
}

.wb-relation-card-tag {
  flex: none;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--wb-text) 7%, transparent);
  color: var(--wb-secondary-text);
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
}

.wb-relation-card-tag.is-new {
  background: var(--wb-accent-soft);
  color: var(--wb-accent-strong);
}

.wb-relation-card-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
  min-width: 0;
}

.wb-relation-card-reason {
  min-width: 0;
  color: var(--wb-secondary-text);
  font-size: 11px;
  line-height: 16px;
}

.wb-relation-card-evidence {
  display: inline-flex;
  gap: 2px;
}

.wb-relation-card-evidence-icon {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 16px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--wb-text) 6%, transparent);
  color: var(--wb-secondary-text);
}

.wb-relation-card-conflict {
  margin: 1px 0 0;
  color: var(--wb-danger-text);
  font-size: 11px;
  line-height: 16px;
  overflow-wrap: anywhere;
}

.wb-relation-card-disclosure {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  min-height: 22px;
  margin-top: -2px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--wb-quiet-text);
  opacity: 0;
  transition: opacity var(--wb-duration-fast) ease;
}

.wb-relation-card:hover .wb-relation-card-disclosure,
.wb-relation-card.is-open .wb-relation-card-disclosure,
.wb-relation-card-disclosure:focus-visible {
  opacity: 1;
}

.wb-relation-card-disclosure:hover:not(:disabled) {
  background: color-mix(in srgb, var(--wb-text) 8%, transparent);
  color: var(--wb-text);
}

.wb-relation-card-disclosure svg {
  transition: transform var(--wb-duration-fast) var(--wb-ease-out);
}

.wb-relation-card-disclosure svg.is-open {
  transform: rotate(180deg);
}

.wb-relation-card-details {
  display: grid;
  gap: 6px;
  margin-left: 22px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--wb-field-surface);
  box-shadow: inset 0 0 0 1px var(--wb-line);
}

.wb-relation-card.is-detailed .wb-relation-card-details {
  margin-left: 22px;
  padding: 0;
  background: none;
  box-shadow: none;
}

.wb-relation-card-decided {
  margin: 0;
  color: var(--wb-quiet-text);
  font-size: 10px;
}

.wb-relation-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: 22px;
}

.wb-relation-card.is-detailed .wb-relation-card-actions {
  justify-content: flex-end;
  margin-left: 0;
}

.wb-relation-card-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 24px;
  height: 24px;
  padding: 0 9px;
  border-radius: 6px;
  font-size: 11px;
}

.wb-relation-card-action.is-confirm {
  border-color: var(--wb-accent-control);
  background: var(--wb-accent-control);
  color: var(--wb-accent-control-text);
}

.wb-relation-card-action.is-confirm:hover:not(:disabled) {
  border-color: var(--wb-accent-control-hover);
  background: var(--wb-accent-control-hover);
}

.wb-relation-card.is-rejected .wb-relation-card-title {
  color: var(--wb-secondary-text);
  font-weight: 500;
}

.wb-relation-card.is-rejected .wb-relation-card-end {
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--wb-secondary-text) 55%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .wb-relation-card,
  .wb-relation-card-disclosure,
  .wb-relation-card-disclosure svg {
    transition: none;
  }
}
</style>
