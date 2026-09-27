<script setup>
import { t } from "../i18n/index.js";
import AgentProjectPicker from "./AgentProjectPicker.vue";

const props = defineProps({
  projects: { type: Object, default: null },
  isBusy: { type: Boolean, default: false },
  settingsOpen: { type: Boolean, default: false },
});

const emit = defineEmits(["new-session", "toggle-settings"]);
</script>

<template>
  <header class="wb-ai-shell-header">
    <AgentProjectPicker :projects="projects" :disabled="isBusy" />
    <div class="wb-ai-header-actions">
      <button
        type="button"
        class="wb-ai-icon-button"
        :title="t('m_c57c30bc05f7')"
        :aria-label="t('m_c57c30bc05f7')"
        :disabled="isBusy"
        @click="emit('new-session')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      </button>
      <button
        type="button"
        class="wb-ai-icon-button"
        :class="{ 'is-active': settingsOpen }"
        :title="t('m_8532a0fa68db')"
        :aria-label="t('m_8532a0fa68db')"
        :aria-expanded="settingsOpen"
        @click="emit('toggle-settings')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h7" />
          <path d="M15 7h5" />
          <circle cx="13" cy="7" r="2" />
          <path d="M4 12h4" />
          <path d="M12 12h8" />
          <circle cx="10" cy="12" r="2" />
          <path d="M4 17h9" />
          <path d="M17 17h3" />
          <circle cx="15" cy="17" r="2" />
        </svg>
      </button>
    </div>
  </header>
</template>
