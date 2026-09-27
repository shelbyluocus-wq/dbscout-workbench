<script setup>
import { t } from "../i18n/index.js";
import { computed } from "vue";

const props = defineProps({
  updater: {
    type: Object,
    required: true,
  },
});

const emit = defineEmits(["close", "open"]);
const update = computed(() => props.updater.availableUpdate.value || props.updater.lastCheckResult.value);
const hasAppUpdate = computed(() => Boolean(props.updater.availableUpdate.value?.available));
const agentUpdate = computed(() => props.updater.agentRuntimeUpdate.value);
const notes = computed(() =>
  String(update.value?.body || "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*•]\s*/, ""))
    .filter(Boolean),
);
</script>

<template>
  <aside class="wb-update-notice" :class="{ 'has-notes': notes.length }" role="status" aria-live="polite" aria-atomic="true">
    <span class="wb-update-notice-mark" aria-hidden="true"></span>
    <div class="wb-update-notice-copy">
      <strong v-if="hasAppUpdate">{{ t('m_ac217e4d1ca4') }} {{ update?.version }}</strong>
      <strong v-else>{{ t('m_b7f4a1cf74bb') }}{{ agentUpdate?.version }} {{ t('m_08d43bdc4dcb') }}</strong>
      <ul v-if="hasAppUpdate && notes.length" class="wb-update-notice-notes">
        <li v-for="(note, index) in notes" :key="index">{{ note }}</li>
      </ul>
      <span v-else-if="hasAppUpdate">{{ t('m_f6f4b26b0385') }}</span>
      <span v-else>{{ t('m_31eab2f3aa78') }}</span>
    </div>
    <button type="button" class="wb-update-notice-action" @click="emit('open')">{{ t('m_2a55c0f908c5') }}</button>
    <button type="button" class="wb-update-notice-close" :title="t('m_56f252b08c5a')" :aria-label="t('m_cba14f04be04')" @click="emit('close')">×</button>
  </aside>
</template>
