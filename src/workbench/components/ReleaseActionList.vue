<script setup>
import { Check, Circle, LoaderCircle, TriangleAlert } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { releaseActionBlock } from "../releaseWorkflowState.js";

const props = defineProps({
  workflow: { type: Object, required: true },
  actions: { type: Array, required: true },
});
const { draft, busy } = props.workflow;
const status = (action) => draft.value.results[action] || "pending";
const reason = (action) => releaseActionBlock(draft.value, action);
</script>

<template>
  <ol class="rw-actions">
    <li v-for="action in actions" :key="action" :data-release-action="action" :data-status="status(action)">
      <Check v-if="status(action) === 'done'" :size="16" class="rw-success" aria-hidden="true" />
      <LoaderCircle v-else-if="status(action) === 'running'" :size="16" class="rw-spinning" aria-hidden="true" />
      <TriangleAlert v-else-if="['blocked', 'failed'].includes(status(action))" :size="16" class="rw-warning-text" aria-hidden="true" />
      <Circle v-else :size="14" class="rw-quiet" aria-hidden="true" />
      <span class="rw-action-name">{{ t(`release.action_${action}`) }}</span>
      <span class="rw-action-status">{{ t(`release.state_${status(action)}`) }}</span>
      <button
        v-if="status(action) !== 'done'" type="button" class="rw-btn rw-small"
        :disabled="Boolean(busy || reason(action))"
        :title="reason(action) ? t(`release.error_${reason(action)}`) : t('release.simulate', { action: t(`release.action_${action}`) })"
        :aria-label="t('release.simulate', { action: t(`release.action_${action}`) })"
        @click="workflow.run(action)"
      >{{ t('release.demo') }}</button>
    </li>
  </ol>
</template>
