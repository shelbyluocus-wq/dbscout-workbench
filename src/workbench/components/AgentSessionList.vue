<script setup>
const props = defineProps({
  sessions: { type: Array, default: () => [] },
  lastSessionId: { type: String, default: "" },
});

const emit = defineEmits(["resume", "delete", "refresh"]);

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function titleFor(session) {
  return session.title || session.name || `会话 ${session.id?.slice(-6) || ""}`;
}

function isCurrent(session) {
  return session.id === props.lastSessionId || session.sessionId === props.lastSessionId;
}

// Show the full original first prompt as the hover tooltip when the polished
// title was truncated; fall back to the visible title otherwise.
function tooltipFor(session) {
  const fp = typeof session.firstPrompt === "string" ? session.firstPrompt.trim() : "";
  return fp || titleFor(session);
}

function confirmDelete(session) {
  const name = titleFor(session);
  if (window.confirm(`确定删除会话「${name}」？此操作无法撤销。`)) {
    emit("delete", session.id || session.sessionId);
  }
}
</script>

<template>
  <section class="wb-ai-session-list" aria-label="会话历史">
    <header class="wb-ai-session-header">
      <strong>会话历史</strong>
      <button
        type="button"
        class="wb-ai-icon-button"
        title="刷新列表"
        aria-label="刷新列表"
        @click="emit('refresh')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </button>
    </header>

    <ul v-if="sessions.length" class="wb-ai-session-items">
      <li
        v-for="session in sessions"
        :key="session.id || session.sessionId"
        class="wb-ai-session-item"
        :class="{ 'is-current': isCurrent(session) }"
      >
        <button
          type="button"
          class="wb-ai-session-resume"
          :title="tooltipFor(session)"
          @click="emit('resume', session.id || session.sessionId)"
        >
          <span class="wb-ai-session-title">{{ titleFor(session) }}</span>
          <span class="wb-ai-session-date">{{ formatDate(session.updatedAt || session.createdAt) }}</span>
        </button>
        <button
          type="button"
          class="wb-ai-session-delete"
          title="删除会话"
          aria-label="删除会话"
          @click="confirmDelete(session)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </li>
    </ul>

    <p v-else class="wb-ai-session-empty">暂无历史会话</p>
  </section>
</template>
