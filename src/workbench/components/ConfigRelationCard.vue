<script setup>
// One relation as a card: its status, endpoints, why it is believed, and the
// review actions that fit the status. Shared by the inspector relation page
// and the review dialog.
import { t } from "../i18n/index.js";
import { computed } from "vue";
import {
  relationEvidenceKey,
  relationEvidenceTitle,
  relationIsActionable,
  relationReasonLabel,
  relationStatusLabel,
} from "../utils/configRelations.js";

const props = defineProps({
  relation: { type: Object, required: true },
  title: { type: String, required: true },
  titleHint: { type: String, default: "" },
  // The title opens the relation's source table.
  openable: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
});

const emit = defineEmits(["open", "review"]);

const rejected = computed(() => props.relation.status === "rejected");
const actionable = computed(() => relationIsActionable(props.relation));
const showStatus = computed(() => !rejected.value && props.relation.status !== "confirmed");
</script>

<template>
  <article class="wb-relation-card" :class="{ 'is-rejected': rejected }">
    <div class="wb-relation-card-head">
      <span v-if="showStatus" class="wb-relation-status" :class="`is-${relation.status}`">{{ relationStatusLabel(relation.status, t) }}</span>
      <span v-if="relation.isNew && !rejected" class="wb-relation-new">{{ t('relations.review.new') }}</span>
      <button
        v-if="openable"
        type="button"
        class="wb-relation-card-title wb-relation-card-link"
        :title="titleHint"
        @click="emit('open')"
      >{{ title }}</button>
      <span v-else class="wb-relation-card-title" :title="titleHint || title">{{ title }}</span>
      <span v-if="relation.kind === 'list'" class="wb-relation-kind">{{ t('relations.kindList') }}</span>
    </div>
    <template v-if="!rejected">
      <div class="wb-relation-card-meta">
        <span class="wb-relation-reason">{{ relationReasonLabel(relation.reason, t) }}</span>
        <span
          v-for="evidence in relation.evidence || []"
          :key="relationEvidenceKey(evidence)"
          class="wb-relation-evidence"
          :title="relationEvidenceTitle(evidence)"
        >{{ t(`relations.evidence.${evidence.type}`) }}</span>
      </div>
      <p v-if="relation.codeTarget" class="wb-relation-codetarget">{{ t('relations.codeTarget', { target: relation.codeTarget }) }}</p>
    </template>
    <div v-if="rejected" class="wb-relation-card-actions">
      <button
        type="button"
        class="wb-relations-action"
        :disabled="busy"
        @click="emit('review', null)"
      >{{ t('relations.action.restore') }}</button>
    </div>
    <div v-else-if="actionable" class="wb-relation-card-actions">
      <button
        type="button"
        class="wb-relations-action is-confirm"
        :disabled="busy"
        @click="emit('review', 'confirmed')"
      >{{ t('relations.action.confirm') }}</button>
      <button
        type="button"
        class="wb-relations-action"
        :disabled="busy"
        @click="emit('review', 'rejected')"
      >{{ t('relations.action.reject') }}</button>
    </div>
  </article>
</template>

<style scoped>
.wb-relation-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-field-surface);
}

.wb-relation-card.is-rejected {
  opacity: 0.72;
}

.wb-relation-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.wb-relation-status,
.wb-relation-new,
.wb-relation-kind {
  flex: 0 0 auto;
  font-weight: 650;
}

.wb-relation-status {
  padding: 0 6px;
  border: 1px solid var(--wb-border);
  border-radius: 8px;
  color: var(--wb-secondary-text);
  font-size: 10.5px;
  line-height: 16px;
}

.wb-relation-status.is-stale {
  border-color: var(--wb-warning-border);
  background: var(--wb-warning-surface);
  color: var(--wb-warning-text);
}

.wb-relation-status.is-conflict {
  border-color: var(--wb-danger-border);
  background: var(--wb-danger-surface);
  color: var(--wb-danger-text);
}

.wb-relation-new,
.wb-relation-kind {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--wb-accent-soft);
  color: var(--wb-accent-strong);
  font-size: 10px;
}

.wb-relation-card-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--wb-text);
  font-size: 12px;
  font-weight: 600;
}

.wb-relation-card-link {
  min-height: 0;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
}

.wb-relation-card-link:hover,
.wb-relation-card-link:active {
  background: none;
}

.wb-relation-card-link:hover {
  color: var(--wb-accent-strong);
  text-decoration: underline;
}

.wb-relation-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: center;
}

.wb-relation-reason {
  color: var(--wb-secondary-text);
  font-size: 11px;
}

.wb-relation-evidence {
  padding: 0 4px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--wb-text) 8%, transparent);
  color: var(--wb-secondary-text);
  font-size: 10px;
}

.wb-relation-codetarget {
  margin: 0;
  color: var(--wb-danger-text);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.wb-relation-card-actions {
  display: flex;
  gap: 6px;
}
</style>
