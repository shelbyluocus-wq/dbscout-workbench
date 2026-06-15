<script setup>
import { computed, ref } from "vue";
import AgentHeader from "./AgentHeader.vue";
import AgentSettings from "./AgentSettings.vue";
import AgentMessage from "./AgentMessage.vue";
import AgentApprovalCard from "./AgentApprovalCard.vue";
import AgentComposer from "./AgentComposer.vue";

const props = defineProps({
  assistant: { type: Object, required: true },
  activeTab: { type: Object, default: null },
});

const emit = defineEmits(["send"]);
const settingsOpen = ref(false);

const tableSource = computed(() => {
  if (!props.activeTab?.tableName) return "当前数据库";
  return `${props.activeTab.database ? `${props.activeTab.database}.` : ""}${props.activeTab.tableName}`;
});

const headline = computed(() => {
  if (props.assistant.messages.value.length === 0) return "How can I help with this database?";
  return "数据库上下文已接入";
});

function submit() {
  emit("send");
}

function toggleSettings() {
  settingsOpen.value = !settingsOpen.value;
}

const agentStatusLabel = computed(() => {
  switch (props.assistant.status.value) {
    case "starting":
      return "启动中";
    case "thinking":
      return "思考中";
    case "streaming":
      return "输出中";
    default:
      return "";
  }
});
</script>

<template>
  <aside class="wb-inspector wb-ai-panel wb-info-pane" aria-label="数据库 Agent">
    <AgentHeader
      :table-source="tableSource"
      :is-busy="assistant.isBusy.value"
      :settings-open="settingsOpen"
      @new-session="assistant.startNewSession()"
      @toggle-settings="toggleSettings"
    />

    <AgentSettings v-if="settingsOpen" :assistant="assistant" />

    <section class="wb-ai-conversation" aria-live="polite">
      <article v-if="assistant.messages.value.length === 0" class="wb-ai-hero">
        <h2>{{ headline }}</h2>
        <p>由 Claude Code 驱动：可读取 schema、执行只读查询，写操作需经批准。</p>
      </article>

      <AgentMessage
        v-for="message in assistant.messages.value"
        :key="message.id"
        :message="message"
      />
    </section>

    <p v-if="assistant.error.value" class="wb-ai-error">{{ assistant.error.value }}</p>
    <p v-else-if="agentStatusLabel" class="wb-ai-status">{{ agentStatusLabel }}</p>

    <div v-if="assistant.pendingApprovals.value.length" class="wb-ai-approval-stack">
      <AgentApprovalCard
        v-for="approval in assistant.pendingApprovals.value"
        :key="approval.reqId"
        :approval="approval"
        @approve="assistant.approveTool"
        @deny="assistant.denyTool"
      />
    </div>

    <AgentComposer
      :assistant="assistant"
      :table-source="tableSource"
      @send="submit"
      @abort="assistant.abort"
      @clear="assistant.clearMessages"
    />
  </aside>
</template>
