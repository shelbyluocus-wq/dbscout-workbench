<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";
import AgentHeader from "./AgentHeader.vue";
import AgentSettings from "./AgentSettings.vue";
import AgentMessage from "./AgentMessage.vue";
import AgentApprovalCard from "./AgentApprovalCard.vue";
import AgentComposer from "./AgentComposer.vue";
import AgentStartupCard from "./AgentStartupCard.vue";

const props = defineProps({
  assistant: { type: Object, required: true },
  activeTab: { type: Object, default: null },
});

const emit = defineEmits(["send"]);
const settingsOpen = ref(false);
const settingsWrapperRef = ref(null);

const tableSource = computed(() => {
  if (!props.activeTab?.tableName) return "当前数据库";
  return `${props.activeTab.database ? `${props.activeTab.database}.` : ""}${props.activeTab.tableName}`;
});

const headline = computed(() => {
  if (props.assistant.messages.value.length === 0) return "How can I help with this database?";
  return "数据库上下文已接入";
});

const startupProgress = computed(() => props.assistant.startupProgress.value);

function submit() {
  emit("send");
}

function toggleSettings() {
  settingsOpen.value = !settingsOpen.value;
}

function closeSettings() {
  settingsOpen.value = false;
}

function onDocumentPointerDown(event) {
  if (settingsWrapperRef.value?.contains?.(event.target)) return;
  closeSettings();
}

function onDocumentKeydown(event) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closeSettings();
}

watch(settingsOpen, (isOpen) => {
  if (isOpen) {
    document.addEventListener("pointerdown", onDocumentPointerDown);
    document.addEventListener("keydown", onDocumentKeydown);
  } else {
    document.removeEventListener("pointerdown", onDocumentPointerDown);
    document.removeEventListener("keydown", onDocumentKeydown);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  document.removeEventListener("keydown", onDocumentKeydown);
});

const agentStatusLabel = computed(() => {
  switch (props.assistant.status.value) {
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
    <div ref="settingsWrapperRef">
      <AgentHeader
        :table-source="tableSource"
        :is-busy="assistant.isBusy.value || assistant.isStarting.value"
        :settings-open="settingsOpen"
        @new-session="assistant.startNewSession()"
        @toggle-settings="toggleSettings"
      />

      <AgentSettings v-if="settingsOpen" :assistant="assistant" />
    </div>

    <section class="wb-ai-conversation" aria-live="polite">
      <AgentStartupCard
        v-if="startupProgress.visible"
        :progress="startupProgress"
      />

      <article v-else-if="assistant.messages.value.length === 0" class="wb-ai-hero">
        <h2>{{ headline }}</h2>
        <p>由 Claude Code 驱动：可读取 schema、执行只读查询，写操作需经批准。</p>
      </article>

      <AgentMessage
        v-else
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
