<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import AgentHeader from "./AgentHeader.vue";
import AgentSettings from "./AgentSettings.vue";
import AgentMessage from "./AgentMessage.vue";
import AgentPlanCard from "./AgentPlanCard.vue";
import AgentApprovalCard from "./AgentApprovalCard.vue";
import AgentComposer from "./AgentComposer.vue";
import AgentStartupCard from "./AgentStartupCard.vue";
import AgentOnboarding from "./AgentOnboarding.vue";
import SelectedCellIdentity from "./SelectedCellIdentity.vue";

const props = defineProps({
  assistant: { type: Object, required: true },
  activeTab: { type: Object, default: null },
  schema: { type: Array, default: () => [] },
  selectedCell: { type: Object, default: null },
  selectedRange: { type: Object, default: null },
});

const emit = defineEmits(["send", "open-table-reference"]);

const settingsOpen = ref(false);
const settingsWrapperRef = ref(null);
const conversationRef = ref(null);
const busyElapsed = ref(0);
const showScrollToBottom = ref(false);
const copiedMessageId = ref("");
let copiedTimer = null;
let busyTimer = null;

// Stick-to-bottom auto-scroll. Mirrors Claude Code: if the user is near the
// bottom we keep snapping down as new content arrives; if they've scrolled up
// to read history we stay put. Sending a new user message always re-anchors.
const STICK_THRESHOLD = 80;
let stickToBottom = true;
let prevMessagesLength = 0;

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
}

function onConversationScroll() {
  const el = conversationRef.value;
  if (!el) return;
  stickToBottom = isNearBottom(el);
  showScrollToBottom.value = !stickToBottom;
}

function scrollConversationToBottom() {
  const el = conversationRef.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  stickToBottom = true;
  showScrollToBottom.value = false;
}

function startBusyTimer() {
  stopBusyTimer();
  busyElapsed.value = 0;
  busyTimer = setInterval(() => {
    busyElapsed.value += 1;
  }, 1000);
}

function stopBusyTimer() {
  if (busyTimer) {
    clearInterval(busyTimer);
    busyTimer = null;
  }
}

watch(
  () => props.assistant.isBusy.value,
  (isBusy) => {
    if (isBusy) startBusyTimer();
    else stopBusyTimer();
  },
  { immediate: true },
);

// A compact signature of every visible aspect of the conversation. When this
// changes the DOM may have grown taller, so we re-anchor the scroll if the
// user was sticking to the bottom. New user messages force a re-anchor.
const conversationSignature = computed(() => {
  const messages = props.assistant.messages.value;
  const last = messages[messages.length - 1];
  const tools = (last?.toolUses?.length || 0) + (last?.toolResults?.length || 0);
  const startup = props.assistant.startupProgress.value;
  return [
    messages.length,
    last?.id || "",
    last?.role || "",
    (last?.content || "").length,
    (last?.thinking || "").length,
    tools,
    last?.done ? 1 : 0,
    props.assistant.status.value,
    Boolean(props.assistant.error.value),
    startup?.visible ? 1 : 0,
  ].join("|");
});

watch(conversationSignature, () => {
  const messages = props.assistant.messages.value;
  const length = messages.length;
  const last = messages[length - 1];
  const grew = length > prevMessagesLength;
  const userJustSent = grew && last?.role === "user";
  prevMessagesLength = length;

  if (userJustSent) {
    stickToBottom = true;
  }

  if (!stickToBottom) return;
  nextTick(scrollConversationToBottom);
});

// Loading a saved session is a hard transcript replace, not an append.
// Force a scroll-to-bottom so the user lands on the latest message of the
// session they just clicked, regardless of where they had scrolled before.
watch(
  () => props.assistant.replayCounter.value,
  () => {
    stickToBottom = true;
    prevMessagesLength = props.assistant.messages.value.length;
    nextTick(scrollConversationToBottom);
  },
);

const tableSource = computed(() => {
  if (!props.activeTab?.tableName) return "当前数据库";
  return `${props.activeTab.database ? `${props.activeTab.database}.` : ""}${props.activeTab.tableName}`;
});

const headline = computed(() => {
  if (props.assistant.messages.value.length === 0) return "How can I help with this database?";
  return "数据库上下文已接入";
});

const startupProgress = computed(() => props.assistant.startupProgress.value);

const tableReferences = computed(() => (
  Array.isArray(props.schema)
    ? props.schema
        .map((table) => ({
          ...table,
          tableName: table?.tableName || table?.table_name || table?.name || "",
        }))
        .filter((table) => table.tableName)
    : []
));

// Show the dedicated onboarding screen until the user has explicitly
// engaged with the agent config — either by filling in fields, by clicking
// "use built-in/environment config", or because they had a config from before this
// onboarding was added (handled by useAgent's seed). Driving this from a
// dedicated flag (rather than `apiKey === ""`) means power users with a
// working bundled or environment auth can clear the fields and not get stuck
// looking at the onboarding screen forever.
const needsOnboarding = computed(
  () => !props.assistant.onboardingComplete.value
);

const hasActiveSelectedCell = computed(() =>
  Boolean(props.activeTab && props.selectedCell?.tabId === props.activeTab.id),
);

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

async function writeClipboard(text) {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall back below
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand?.("copy") === true;
  } finally {
    textarea.remove();
  }
}

async function markCopied(messageId) {
  copiedMessageId.value = messageId || "";
  if (copiedTimer) window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => {
    copiedMessageId.value = "";
    copiedTimer = null;
  }, 1200);
}

async function copyMessageText({ message, text }) {
  if (await writeClipboard(text)) await markCopied(message?.id);
}

async function copyMessageMarkdown({ message, text }) {
  if (await writeClipboard(text)) await markCopied(message?.id);
}

async function regenerateMessage(message) {
  await props.assistant.regenerate?.(message?.id, props.activeTab);
}

function openTableReference(tableName) {
  emit("open-table-reference", tableName);
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
  stopBusyTimer();
  if (copiedTimer) window.clearTimeout(copiedTimer);
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  document.removeEventListener("keydown", onDocumentKeydown);
});

const agentStatusLabel = computed(() => {
  // 有待批准的操作时，优先提示用户 Agent 正在等待你的决定。
  if (props.assistant.pendingApprovals.value.length || props.assistant.pendingPlans.value.length) {
    return "等待你批准操作";
  }
  const elapsed = busyElapsed.value;
  const suffix = elapsed > 0 ? ` · ${elapsed}s` : "";
  switch (props.assistant.status.value) {
    case "thinking":
      return `处理中… (esc 中断${suffix})`;
    case "streaming":
      return `输出中… (esc 中断${suffix})`;
    case "error":
      return "出错了";
    default:
      return "";
  }
});
</script>

<template>
  <aside class="wb-inspector wb-ai-panel wb-info-pane" aria-label="数据库 Agent">
    <AgentOnboarding v-if="needsOnboarding" :assistant="assistant" />

    <template v-else>
    <div ref="settingsWrapperRef">
      <AgentHeader
        :table-source="tableSource"
        :is-busy="assistant.isBusy.value || assistant.isStarting.value"
        :auto-approve-writes="assistant.autoApproveWrites.value"
        :settings-open="settingsOpen"
        @new-session="assistant.startNewSession()"
        @toggle-settings="toggleSettings"
      />

      <AgentSettings v-if="settingsOpen" :assistant="assistant" @close="closeSettings" />
    </div>

    <section
      ref="conversationRef"
      class="wb-ai-conversation"
      aria-live="polite"
      @scroll.passive="onConversationScroll"
    >
      <AgentStartupCard
        v-if="startupProgress.visible"
        :progress="startupProgress"
      />

      <article v-else-if="assistant.messages.value.length === 0" class="wb-ai-hero">
        <h2>{{ headline }}</h2>
        <div class="wb-ai-hero-tips">
          <span
            v-for="prompt in dynamicPrompts"
            :key="prompt"
            role="button"
            tabindex="0"
            @click="usePrompt(prompt)"
            @keydown.enter.prevent="usePrompt(prompt)"
          >
            {{ prompt }}
          </span>
        </div>
      </article>

      <template v-else>
        <AgentMessage
          v-for="message in assistant.messages.value"
          :key="message.id"
          :message="message"
          :table-references="tableReferences"
          :copied="copiedMessageId === message.id"
          @open-table-reference="openTableReference"
          @copy-message="copyMessageText"
          @copy-message-markdown="copyMessageMarkdown"
          @regenerate="regenerateMessage"
        />
      </template>

      <button
        v-if="showScrollToBottom"
        type="button"
        class="wb-ai-scroll-bottom"
        @click="scrollConversationToBottom"
      >跳到底部</button>

      <div
        v-if="assistant.messages.value.length > 0 && (assistant.error.value || agentStatusLabel)"
        class="wb-ai-status-inline"
      >
        <p v-if="assistant.error.value" class="wb-ai-error">{{ assistant.error.value }}</p>
        <p v-else-if="agentStatusLabel" class="wb-ai-status">{{ agentStatusLabel }}</p>
      </div>
    </section>

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

    <section v-if="hasActiveSelectedCell" class="wb-ai-cell-panel" aria-label="当前单元格信息">
      <SelectedCellIdentity
        class="wb-ai-cell-identity"
        :tab="activeTab"
        :selected-cell="selectedCell"
        :selected-range="selectedRange"
        panel
      />
    </section>

    <AgentComposer
      :assistant="assistant"
      @send="submit"
      @abort="assistant.abort"
    />
    </template>
  </aside>
</template>
