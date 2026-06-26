<script setup>
import { computed, onMounted, ref } from "vue";

const props = defineProps({
  assistant: { type: Object, required: true },
});

// Available preset configurations the user can pick from. Selecting a non-
// custom preset prefills Base URL and Model. Editing either field manually
// switches the dropdown to "自定义" automatically because the values no
// longer match.
const PRESETS = [
  {
    id: "company",
    label: "公司代理",
    apiUrl: "http://43.166.227.111:8080",
    model: "gpt-5.5",
  },
  {
    id: "custom",
    label: "自定义",
    apiUrl: "",
    model: "",
  },
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

// On first mount, if the user has nothing configured at all, default to the
// company preset. If they had any existing values from a previous session,
// leave them untouched.
onMounted(() => {
  const url = (props.assistant.apiUrl.value || "").trim();
  const model = (props.assistant.model.value || "").trim();
  if (!url && !model) {
    selectPreset("company");
  }
});

function handleStart() {
  // Refs are auto-persisted by the watcher in useAgent — nothing else to do.
  // The parent (AgentPanel) reactively hides this onboarding screen as soon
  // as the config is marked complete.
  props.assistant.completeOnboarding();
}
</script>

<template>
  <section class="wb-ai-onboarding" aria-label="AI 助手初始设置">
    <header class="wb-ai-onboarding-hero">
      <span class="wb-ai-onboarding-emoji" aria-hidden="true">👋</span>
      <h2>欢迎使用 AI 助手</h2>
      <p>内置 Agent 已随应用打包。需要覆盖默认服务时，可在这里填写自定义端点与凭证。</p>
    </header>

    <div class="wb-ai-onboarding-form">
      <label class="wb-ai-onboarding-field">
        <span>接入方式</span>
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
        <span>模型</span>
        <input
          v-model="assistant.model.value"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="模型名称"
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
            placeholder="输入 API Key…"
            @keydown.enter.prevent="handleStart"
          />
          <button
            type="button"
            class="wb-ai-onboarding-key-toggle"
            :title="showApiKey ? '隐藏' : '显示'"
            :aria-label="showApiKey ? '隐藏 API Key' : '显示 API Key'"
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
      >
        开始使用
      </button>

      <button
        type="button"
        class="wb-ai-onboarding-skip"
        @click="assistant.useLocalClaudeCodeConfig()"
      >
        使用内置/环境配置
      </button>
    </div>
  </section>
</template>
