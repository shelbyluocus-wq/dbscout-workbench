<script setup>
import AgentProjectPicker from "./AgentProjectPicker.vue";

const props = defineProps({
  tableSource: { type: String, default: "当前数据库" },
  projects: { type: Object, default: null },
  isBusy: { type: Boolean, default: false },
  settingsOpen: { type: Boolean, default: false },
  autoApproveWrites: { type: Boolean, default: false },
  databaseProfileStatus: { type: Object, default: null },
});

const emit = defineEmits(["new-session", "toggle-settings"]);
</script>

<template>
  <header class="wb-ai-shell-header">
    <div class="wb-ai-brand">
      <strong title="Database Agent — 由 Claude Code 驱动">Database Agent</strong>
      <span v-if="autoApproveWrites" class="wb-ai-auto-approve-badge" title="已开启自动批准写入：写操作无需逐一确认">自动批准</span>
      <span>{{ tableSource }}</span>
      <span
        class="wb-ai-profile-status"
        :class="`is-${databaseProfileStatus?.state || 'missing'}`"
        :title="databaseProfileStatus?.database || '当前数据库'"
      >{{ databaseProfileStatus?.label || "数据库理解：未生成" }}</span>
    </div>
    <AgentProjectPicker :projects="projects" :disabled="isBusy" />
    <div class="wb-ai-header-actions">
      <button
        type="button"
        class="wb-ai-icon-button"
        title="新会话"
        aria-label="新会话"
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
        title="Agent 设置"
        aria-label="Agent 设置"
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
