<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";
import AgentHeader from "./AgentHeader.vue";
import AgentSettings from "./AgentSettings.vue";
import AgentMessage from "./AgentMessage.vue";
import AgentPlanCard from "./AgentPlanCard.vue";
import AgentApprovalCard from "./AgentApprovalCard.vue";
import AgentComposer from "./AgentComposer.vue";
import AgentStartupCard from "./AgentStartupCard.vue";
import SelectedCellIdentity from "./SelectedCellIdentity.vue";

const props = defineProps({
  assistant: { type: Object, required: true },
  activeTab: { type: Object, default: null },
  schema: { type: Array, default: () => [] },
  selectedCell: { type: Object, default: null },
  selectedRange: { type: Object, default: null },
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

function findTableMeta(schema, tableName) {
  if (!tableName || !Array.isArray(schema)) return null;
  return schema.find((t) => t?.table_name === tableName) || null;
}

function guessStringColumn(columns) {
  if (!Array.isArray(columns)) return null;
  const preferred = ["name", "username", "nickname", "title", "display_name", "full_name", "label"];
  for (const key of preferred) {
    const col = columns.find((c) => String(c?.column_name).toLowerCase() === key);
    if (col) return col.column_name;
  }
  const stringCol = columns.find((c) => {
    const type = String(c?.column_type || c?.data_type).toLowerCase();
    return type.includes("varchar") || type.includes("char") || type.includes("text");
  });
  return stringCol?.column_name || null;
}

function guessPrimaryKeyColumn(columns) {
  if (!Array.isArray(columns)) return null;
  const pk = columns.find((c) => c?.is_primary_key);
  if (pk) return pk.column_name;
  const idCol = columns.find((c) => String(c?.column_name).toLowerCase() === "id");
  return idCol?.column_name || null;
}

const dynamicPrompts = computed(() => {
  const schema = props.schema;
  let tableName = props.activeTab?.tableName;
  let table = tableName ? findTableMeta(schema, tableName) : null;

  if (!table && Array.isArray(schema) && schema.length > 0) {
    table = schema[0];
    tableName = table?.table_name;
  }

  if (!tableName) {
    return [
      "当前数据库有哪些表？",
      "描述 player 表的结构",
      "查询 player 表前 10 条数据",
    ];
  }

  const columns = table?.columns || [];
  const pk = guessPrimaryKeyColumn(columns);
  const stringCol = guessStringColumn(columns);
  const firstPrompt = `${tableName} 表有哪些字段？`;
  const secondPrompt = `查询 ${tableName} 表前 10 条数据`;
  let thirdPrompt;
  if (pk && stringCol) {
    thirdPrompt = `把 ${tableName} 表中 ${pk} 为 1 的 ${stringCol} 改成 Admin`;
  } else if (stringCol) {
    thirdPrompt = `把 ${tableName} 表中 ${stringCol} 改成 Admin`;
  } else {
    thirdPrompt = `在 ${tableName} 表中搜索关键字`;
  }

  return [firstPrompt, secondPrompt, thirdPrompt];
});

function submit() {
  emit("send");
}

async function usePrompt(text) {
  if (props.assistant.isBusy.value) return;
  props.assistant.draft.value = text;
  await props.assistant.send(props.activeTab);
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
      return "思考中…";
    case "streaming":
      return "输出中…";
    case "error":
      return "出错了";
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
        <div class="wb-ai-hero-tips">
          <span
            v-for="prompt in dynamicPrompts"
            :key="prompt"
            role="button"
            tabindex="0"
            @click="usePrompt(prompt)"
            @keydown.enter.prevent="usePrompt(prompt)"
          >
            "{{ prompt }}"
          </span>
        </div>
      </article>

      <template v-else>
        <AgentMessage
          v-for="message in assistant.messages.value"
          :key="message.id"
          :message="message"
        />
      </template>
    </section>

    <div class="wb-ai-status-stack">
      <p v-if="assistant.error.value" class="wb-ai-error">{{ assistant.error.value }}</p>
      <p v-else-if="agentStatusLabel" class="wb-ai-status">{{ agentStatusLabel }}</p>
    </div>

    <div v-if="assistant.pendingPlans.value.length" class="wb-ai-plan-stack">
      <AgentPlanCard
        v-for="plan in assistant.pendingPlans.value"
        :key="plan.reqId"
        :plan="plan"
        @approve="assistant.approvePlan"
        @deny="assistant.denyPlan"
      />
    </div>

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
      @send="submit"
      @abort="assistant.abort"
    />

    <div class="wb-ai-cell-panel">
      <SelectedCellIdentity
        v-if="activeTab"
        class="wb-ai-cell-identity"
        :tab="activeTab"
        :selected-cell="selectedCell"
        :selected-range="selectedRange"
        panel
      />
    </div>
  </aside>
</template>
