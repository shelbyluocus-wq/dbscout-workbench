<script setup>
import { t } from "../i18n/index.js";
import { computed } from "vue";
import { X } from "lucide-vue-next";

import { parseUpdateNotes, updateNoteListClass } from "../utils/updateNotes.js";

// The notice previews the first changes; the dialog lists all of them.
const NOTICE_NOTE_LIMIT = 3;

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
const notes = computed(() => parseUpdateNotes(update.value?.body));
const shownNotes = computed(() => notes.value.items.slice(0, NOTICE_NOTE_LIMIT));
const hiddenNoteCount = computed(() => notes.value.items.length - shownNotes.value.length);
</script>

<template>
  <aside class="wb-update-notice" role="status" aria-live="polite" aria-atomic="true">
    <header class="wb-update-notice-head">
      <span class="wb-update-notice-mark" aria-hidden="true"></span>
      <strong v-if="hasAppUpdate" class="wb-update-notice-title">{{ t('m_ac217e4d1ca4') }} <span class="wb-update-notice-version">{{ update?.version }}</span></strong>
      <strong v-else class="wb-update-notice-title">{{ t('m_b7f4a1cf74bb') }}{{ agentUpdate?.version }} {{ t('m_08d43bdc4dcb') }}</strong>
      <button type="button" class="wb-update-notice-close" :title="t('m_56f252b08c5a')" :aria-label="t('m_cba14f04be04')" @click="emit('close')">
        <X :size="14" aria-hidden="true" />
      </button>
    </header>

    <component
      :is="notes.ordered ? 'ol' : 'ul'"
      v-if="hasAppUpdate && shownNotes.length"
      class="wb-update-note-list wb-update-notice-notes"
      :class="updateNoteListClass(notes)"
    >
      <li v-for="(note, index) in shownNotes" :key="index"><span class="wb-update-note-text">{{ note }}</span></li>
    </component>
    <p v-else-if="hasAppUpdate" class="wb-update-notice-text">{{ t('m_f6f4b26b0385') }}</p>
    <p v-else class="wb-update-notice-text">{{ t('m_31eab2f3aa78') }}</p>

    <footer class="wb-update-notice-foot">
      <span v-if="hasAppUpdate && hiddenNoteCount > 0" class="wb-update-notice-more">{{ t('updater.notice.moreNotes', { count: hiddenNoteCount }) }}</span>
      <button type="button" class="wb-update-notice-action" @click="emit('open')">{{ t('m_2a55c0f908c5') }}</button>
    </footer>
  </aside>
</template>
