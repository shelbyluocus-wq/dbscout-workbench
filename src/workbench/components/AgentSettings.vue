<script setup>
import { onMounted } from "vue";
import AgentSessionList from "./AgentSessionList.vue";

const { assistant } = defineProps({
  assistant: { type: Object, required: true },
});

onMounted(() => {
  assistant.listSessions();
});
</script>

<template>
  <section class="wb-ai-config-panel" aria-label="Agent 设置">
    <div class="wb-ai-config-group">
      <strong class="wb-ai-config-title">端点与模型</strong>
      <p class="wb-ai-config-hint">留空时使用本机 Claude Code 的登录与默认设置。</p>

      <label class="wb-ai-config-field">
        <span>API Key</span>
        <input
          v-model="assistant.apiKey.value"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="sk-..."
        />
      </label>

      <label class="wb-ai-config-field">
        <span>Base URL</span>
        <input
          v-model="assistant.apiUrl.value"
          type="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="https://api.anthropic.com"
        />
      </label>

      <label class="wb-ai-config-field">
        <span>模型</span>
        <input
          v-model="assistant.model.value"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="留空使用默认模型"
        />
      </label>
    </div>

    <div class="wb-ai-config-group">
      <strong class="wb-ai-config-title">行为</strong>

      <label class="wb-ai-config-field">
        <span>模式</span>
        <select
          :value="assistant.permissionMode.value"
          @change="assistant.setMode($event.target.value)"
        >
          <option value="default">执行模式 — 直接回答，写入需批准</option>
          <option value="plan">计划模式 — 先出计划，批准后再执行</option>
        </select>
      </label>

      <label class="wb-ai-config-toggle">
        <input
          :checked="assistant.autoApproveWrites.value"
          type="checkbox"
          @change="assistant.setAutoApprove($event.target.checked)"
        />
        <span>自动批准写入/修改操作</span>
      </label>
    </div>

    <AgentSessionList
      :sessions="assistant.sessions.value"
      :last-session-id="assistant.lastSessionId.value"
      @resume="assistant.resumeSession"
      @delete="assistant.deleteSession"
      @refresh="assistant.listSessions"
    />
  </section>
</template>
