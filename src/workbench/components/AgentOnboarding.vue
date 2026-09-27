<script setup>
import { t } from "../i18n/index.js";
import { computed, ref } from "vue";

const props = defineProps({
  assistant: { type: Object, required: true },
});

// Endpoints are configured explicitly. Never connect to an organization-specific
// proxy automatically on a fresh installation.
const PRESETS = [
  { id: "custom", get label() { return t('m_4eafa9e925b3'); }, apiUrl: "", model: "" },
];

const showApiKey = ref(false);

// Reflects which preset is currently active based on the live values in the
// assistant refs. Editing the URL or model away from a preset's values will
// flip this to "custom" naturally.
const selectedPresetId = computed(() => {
  const url = props.assistant.apiUrl.value || "";
  const model = props.assistant.model.value || "";
  const matched = PRESETS.find(
    (p) => p.id !== "custom" && p.apiUrl === url && p.model === model
  );
  return matched?.id || "custom";
});

function selectPreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return;
  // Picking "custom" deliberately leaves the current values alone — user is
  // free to edit. Picking a real preset overwrites url/model with that
  // preset's values; the existing config-save watcher persists immediately.
  if (preset.id === "custom") return;
  props.assistant.apiUrl.value = preset.apiUrl;
  props.assistant.model.value = preset.model;
}

function handleStart() {
  // Refs are auto-persisted by the watcher in useAgent — nothing else to do.
  // The parent (AgentPanel) reactively hides this onboarding screen as soon
  // as the config is marked complete.
  props.assistant.completeOnboarding();
}
</script>

<template>
  <section class="wb-ai-onboarding" :aria-label="t('m_264210612146')">
    <header class="wb-ai-onboarding-hero">
      <span class="wb-ai-onboarding-emoji" aria-hidden="true">👋</span>
      <h2>{{ t('m_0d6b6cd6372b') }}</h2>
      <p>{{ t('m_7723b1be5e50') }}</p>
    </header>

    <div class="wb-ai-onboarding-form">
      <label class="wb-ai-onboarding-field">
        <span>{{ t('m_2374e5d33f7e') }}</span>
        <select
          :value="selectedPresetId"
          @change="selectPreset($event.target.value)"
        >
          <option v-for="preset in PRESETS" :key="preset.id" :value="preset.id">
            {{ preset.label }}
          </option>
        </select>
      </label>

      <label class="wb-ai-onboarding-field">
        <span>Base URL</span>
        <input
          v-model="assistant.apiUrl.value"
          type="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="https://..."
        />
      </label>

      <label class="wb-ai-onboarding-field">
        <span>{{ t('m_c98e118e0a43') }}</span>
        <input
          v-model="assistant.model.value"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="t('m_cb2f1709f983')"
        />
      </label>

      <label class="wb-ai-onboarding-field">
        <span>API Key</span>
        <div class="wb-ai-onboarding-key">
          <input
            v-model="assistant.apiKey.value"
            :type="showApiKey ? 'text' : 'password'"
            autocomplete="off"
            spellcheck="false"
            :placeholder="t('m_45c0a22d6463')"
            @keydown.enter.prevent="handleStart"
          />
          <button
            type="button"
            class="wb-ai-onboarding-key-toggle"
            :title="showApiKey ? t('m_145219e726b8') : t('m_4e1449e7d5e5')"
            :aria-label="showApiKey ? t('m_86b7355ec3bd') : t('m_f2bdc88464c5')"
            @click="showApiKey = !showApiKey"
          >
            <svg v-if="showApiKey" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
      </label>

      <button
        type="button"
        class="wb-ai-onboarding-start"
        @click="handleStart"
      > {{ t('m_0df040503b19') }} </button>

      <button
        type="button"
        class="wb-ai-onboarding-skip"
        @click="assistant.useLocalClaudeCodeConfig()"
      > {{ t('m_b8845e51c330') }} </button>
    </div>
  </section>
</template>
