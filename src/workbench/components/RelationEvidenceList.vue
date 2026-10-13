<script setup>
// Why a relation is believed, spelled out: the comment that declares it, the
// client code that reads it (file, line and the line itself), the data sample
// that shows a list format, and for a conflict what the code reads instead.
import { t } from "../i18n/index.js";
import { Braces, CodeXml, Info, MessageSquareText, TriangleAlert } from "lucide-vue-next";
import { relationEvidenceKey, shortCodePath } from "../utils/configRelations.js";
import TableMentionText from "./TableMentionText.vue";

defineProps({
  relation: { type: Object, required: true },
  // Current-database table index; names in the conflict line link only when present.
  tables: { type: Object, default: null },
});

const emit = defineEmits(["open"]);

const EVIDENCE_ICONS = Object.freeze({ comment: MessageSquareText, code: CodeXml, format: Braces });
</script>

<template>
  <ul class="wb-relation-evidence-list">
    <li v-if="relation.codeTarget" class="wb-relation-evidence-item is-conflict">
      <TriangleAlert :size="13" class="wb-relation-evidence-icon" aria-hidden="true" />
      <TableMentionText
        class="wb-relation-evidence-text"
        :text="t('relations.codeTarget', { target: relation.codeTarget })"
        :tables="tables"
        @open="emit('open', $event)"
      />
    </li>
    <li
      v-for="evidence in relation.evidence || []"
      :key="relationEvidenceKey(evidence)"
      class="wb-relation-evidence-item"
    >
      <component :is="EVIDENCE_ICONS[evidence.type] || Info" :size="13" class="wb-relation-evidence-icon" aria-hidden="true" />
      <div class="wb-relation-evidence-body">
        <span class="wb-relation-evidence-kind">{{ t(`relations.evidence.${evidence.type}`) }}</span>
        <q v-if="evidence.type === 'comment'" class="wb-relation-evidence-text">{{ evidence.text }}</q>
        <template v-else-if="evidence.type === 'code'">
          <span class="wb-relation-evidence-location" :title="`${evidence.file}:${evidence.line}`">{{ shortCodePath(evidence.file) }}:{{ evidence.line }}</span>
          <code v-if="evidence.snippet" class="wb-relation-evidence-code">{{ evidence.snippet }}</code>
        </template>
        <code v-else-if="evidence.type === 'format'" class="wb-relation-evidence-code is-sample">{{ evidence.sample }}</code>
      </div>
    </li>
    <li v-if="!relation.evidence?.length && !relation.codeTarget" class="wb-relation-evidence-item is-empty">
      <Info :size="13" class="wb-relation-evidence-icon" aria-hidden="true" />
      <span class="wb-relation-evidence-text">{{ t('relations.evidence.none') }}</span>
    </li>
  </ul>
</template>

<style scoped>
.wb-relation-evidence-list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.wb-relation-evidence-item {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  align-items: start;
  gap: 6px;
  min-width: 0;
  color: var(--wb-text);
  font-size: 11px;
  line-height: 1.5;
}

.wb-relation-evidence-icon {
  margin-top: 2px;
  color: var(--wb-quiet-text);
}

.wb-relation-evidence-item.is-conflict {
  color: var(--wb-danger-text);
}

.wb-relation-evidence-item.is-conflict .wb-relation-evidence-icon {
  color: var(--wb-danger);
}

.wb-relation-evidence-body {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 6px;
  min-width: 0;
}

.wb-relation-evidence-kind {
  flex: none;
  color: var(--wb-secondary-text);
  font-weight: 600;
}

.wb-relation-evidence-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

q.wb-relation-evidence-text {
  color: var(--wb-remark-text);
  quotes: "\201C" "\201D";
}

.wb-relation-evidence-location {
  min-width: 0;
  color: var(--wb-secondary-text);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.wb-relation-evidence-code {
  display: block;
  flex: 1 0 100%;
  min-width: 0;
  padding: 3px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--wb-text) 6%, transparent);
  color: var(--wb-text);
  font-family: var(--wb-font-mono, ui-monospace, "Cascadia Mono", Consolas, monospace);
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.wb-relation-evidence-code.is-sample {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.wb-relation-evidence-item.is-empty {
  color: var(--wb-secondary-text);
}
</style>
