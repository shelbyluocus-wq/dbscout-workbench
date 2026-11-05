<script setup>
// The status pill used wherever a relation is listed. Confirmed relations are
// the norm and usually show no pill; callers decide when to render it.
import { t } from "../i18n/index.js";
import { relationStatusLabel } from "../utils/configRelations.js";

defineProps({
  status: { type: String, required: true },
});
</script>

<template>
  <span class="wb-relation-status-badge" :class="`is-${status}`">{{ relationStatusLabel(status, t) }}</span>
</template>

<style scoped>
.wb-relation-status-badge {
  flex: none;
  padding: 0 6px;
  border: 1px solid var(--wb-border-strong);
  border-radius: 999px;
  color: var(--wb-secondary-text);
  font-size: var(--wb-fs-caption);
  font-weight: 600;
  line-height: 15px;
  white-space: nowrap;
}

.wb-relation-status-badge.is-unconfirmed {
  border-style: dashed;
}

.wb-relation-status-badge.is-stale {
  border-color: var(--wb-warning-border);
  background: var(--wb-warning-surface);
  color: var(--wb-warning-text);
}

.wb-relation-status-badge.is-conflict {
  border-color: var(--wb-danger-border);
  background: var(--wb-danger-surface);
  color: var(--wb-danger-text);
}

.wb-relation-status-badge.is-confirmed {
  border-color: var(--wb-success-border);
  background: var(--wb-success-surface);
  color: var(--wb-success-text);
}
</style>
