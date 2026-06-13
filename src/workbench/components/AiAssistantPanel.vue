<script setup>
import { computed, ref } from "vue";
import { DEFAULT_AI_API_URL } from "../composables/useAiAssistant.js";

const props = defineProps({
  assistant: { type: Object, required: true },
  activeTab: { type: Object, default: null },
});

const emit = defineEmits(["send"]);
const settingsOpen = ref(false);
const historyOpen = ref(false);

const tableSource = computed(() => {
  if (!props.activeTab?.tableName) return "当前数据库";
  return `${props.activeTab.database ? `${props.activeTab.database}.` : ""}${props.activeTab.tableName}`;
});

const assistantHeadline = computed(() => {
  if (props.assistant.messages.value.length === 0) return "How can I help with this database?";
  return "数据库上下文已接入";
});

function submit() {
  emit("send");
}

function toggleSettings() {
  settingsOpen.value = !settingsOpen.value;
  if (settingsOpen.value) historyOpen.value = false;
}

function toggleHistory() {
  historyOpen.value = !historyOpen.value;
  if (historyOpen.value) settingsOpen.value = false;
}

function startNewSession() {
  settingsOpen.value = false;
  historyOpen.value = false;
  props.assistant.startNewSession();
}

function restoreSession(sessionId) {
  props.assistant.restoreSession(sessionId);
  historyOpen.value = false;
}

function restoreDefaultApiUrl() {
  props.assistant.apiUrl.value = DEFAULT_AI_API_URL;
}
</script>

<template>
  <aside class="wb-inspector wb-ai-panel wb-info-pane" aria-label="数据库 AI 助手">
    <header class="wb-ai-shell-header">
      <div class="wb-ai-brand">
        <span class="wb-ai-brand-mark" aria-hidden="true">AI</span>
        <div>
          <strong>Database AI</strong>
          <span :title="tableSource">{{ tableSource }}</span>
        </div>
      </div>
      <div class="wb-ai-header-actions">
        <button
          type="button"
          class="wb-ai-icon-button"
          title="新会话"
          aria-label="新会话"
          :disabled="assistant.isBusy.value"
          @click="startNewSession"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
        </button>
        <button
          type="button"
          class="wb-ai-icon-button"
          title="历史会话"
          aria-label="历史会话"
          :aria-expanded="historyOpen"
          @click="toggleHistory"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 6h14" />
            <path d="M5 12h14" />
            <path d="M5 18h9" />
          </svg>
        </button>
        <button
          type="button"
          class="wb-ai-icon-button"
          title="AI 设置"
          aria-label="AI 设置"
          :aria-expanded="settingsOpen"
          @click="toggleSettings"
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

    <section v-if="historyOpen" class="wb-ai-history-panel" aria-label="历史会话">
      <header>
        <strong>历史会话</strong>
        <span>{{ assistant.sessionHistory.value.length }} 条</span>
      </header>
      <button
        v-for="session in assistant.sessionHistory.value"
        :key="session.id"
        type="button"
        class="wb-ai-history-item"
        @click="restoreSession(session.id)"
      >
        <span>{{ session.title }}</span>
        <em>{{ session.messageCount }} 条消息</em>
      </button>
      <p v-if="assistant.sessionHistory.value.length === 0">还没有历史会话。</p>
    </section>

    <section v-if="settingsOpen" class="wb-ai-config-panel" aria-label="AI 服务配置">
      <label>
        <span>OpenAI API Key</span>
        <input
          v-model="assistant.apiKey.value"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="sk-..."
        />
      </label>
      <label>
        <span>请求地址</span>
        <div class="wb-ai-url-row">
          <input
            v-model="assistant.apiUrl.value"
            type="url"
            autocomplete="off"
            spellcheck="false"
            placeholder="https://api.openai.com/v1/responses"
          />
          <button type="button" title="恢复默认地址" aria-label="恢复默认地址" @click="restoreDefaultApiUrl">
            默认
          </button>
        </div>
      </label>
      <small>Key 和请求地址仅用于当前请求，不写入项目配置。</small>
    </section>

    <section class="wb-ai-conversation" aria-live="polite">
      <article v-if="assistant.messages.value.length === 0" class="wb-ai-hero">
        <h2>{{ assistantHeadline }}</h2>
        <p>可以问当前库、当前表、字段含义、样例数据和关键字命中。助手只读取数据，不执行写入。</p>
      </article>

      <article
        v-for="message in assistant.messages.value"
        :key="message.id"
        class="wb-ai-message"
        :class="`is-${message.role}`"
      >
        <div class="wb-ai-message-role">{{ message.role === "assistant" ? "AI" : "你" }}</div>
        <p>{{ message.content }}</p>
        <ul v-if="message.toolResults?.length" class="wb-ai-tool-list">
          <li v-for="tool in message.toolResults" :key="`${message.id}-${tool.name}-${tool.summary}`">
            <span>{{ tool.name }}</span>
            <em>{{ tool.summary }}</em>
          </li>
        </ul>
      </article>
    </section>

    <p v-if="assistant.error.value" class="wb-ai-error">{{ assistant.error.value }}</p>

    <form class="wb-ai-composer" @submit.prevent="submit">
      <textarea
        v-model="assistant.draft.value"
        :disabled="assistant.isBusy.value"
        rows="3"
        placeholder="How can I help you today?"
        @keydown.enter.exact.prevent="submit"
      ></textarea>
      <div class="wb-ai-composer-footer">
        <span>OpenAI</span>
        <span>只读工具</span>
        <button type="button" :disabled="assistant.isBusy.value" @click="assistant.clearMessages()">清空</button>
        <button type="submit" :disabled="assistant.isBusy.value || !assistant.draft.value.trim()">
          {{ assistant.isBusy.value ? "发送中" : "发送" }}
        </button>
      </div>
    </form>
  </aside>
</template>
