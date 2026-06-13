import { computed, ref } from "vue";

export const DEFAULT_AI_API_URL = "https://api.openai.com/v1/responses";

function activeContext(workspace, activeTab) {
  return {
    connectionId: String(activeTab?.connectionId || workspace.connectionId || ""),
    database: String(activeTab?.database || workspace.database || ""),
    activeTableName: String(activeTab?.tableName || ""),
  };
}

function userMessage(content) {
  return {
    id: `ai-user-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: "user",
    content,
    toolResults: [],
  };
}

function assistantMessage(response) {
  return {
    id: `ai-assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: "assistant",
    content: String(response?.answer || ""),
    toolResults: Array.isArray(response?.toolResults) ? response.toolResults : [],
  };
}

function sessionTitle(messages) {
  const firstUserMessage = messages.find((message) => message.role === "user" && String(message.content || "").trim());
  const title = String(firstUserMessage?.content || messages[0]?.content || "新会话").trim();
  return title.length > 32 ? `${title.slice(0, 32)}...` : title;
}

function createSession(messages) {
  return {
    id: `ai-session-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: sessionTitle(messages),
    messageCount: messages.length,
    createdAt: new Date().toISOString(),
    messages: messages.map((message) => ({
      ...message,
      toolResults: Array.isArray(message.toolResults) ? [...message.toolResults] : [],
    })),
  };
}

export function useAiAssistant(workspace, invokeWorkbench) {
  const apiKey = ref("");
  const apiUrl = ref(DEFAULT_AI_API_URL);
  const draft = ref("");
  const messages = ref([]);
  const sessionHistory = ref([]);
  const status = ref("idle");
  const error = ref("");
  const hasApiKey = computed(() => apiKey.value.trim().length > 0);
  const isBusy = computed(() => status.value === "thinking");

  function resetConversation() {
    messages.value = [];
    draft.value = "";
    error.value = "";
    status.value = "idle";
  }

  function archiveCurrentSession() {
    if (messages.value.length === 0) return;
    const archived = createSession(messages.value);
    sessionHistory.value = [archived, ...sessionHistory.value].slice(0, 20);
  }

  function startNewSession() {
    archiveCurrentSession();
    resetConversation();
  }

  function restoreSession(sessionId) {
    const session = sessionHistory.value.find((item) => item.id === sessionId);
    if (!session) return;
    messages.value = session.messages.map((message) => ({
      ...message,
      toolResults: Array.isArray(message.toolResults) ? [...message.toolResults] : [],
    }));
    draft.value = "";
    error.value = "";
    status.value = "idle";
  }

  async function send(activeTab = null) {
    const question = draft.value.trim();
    if (!question || isBusy.value) return;
    if (!hasApiKey.value) {
      status.value = "error";
      error.value = "请先填写 OpenAI API Key。";
      return;
    }

    const priorMessages = messages.value;
    const nextUserMessage = userMessage(question);
    messages.value = [...priorMessages, nextUserMessage];
    draft.value = "";
    status.value = "thinking";
    error.value = "";
    try {
      const response = await invokeWorkbench("ask_database_assistant", {
        context: activeContext(workspace, activeTab),
        request: {
          apiKey: apiKey.value.trim(),
          apiUrl: apiUrl.value.trim(),
          question,
          messages: priorMessages.slice(-8).map((message) => ({
            role: message.role,
            content: message.content,
          })),
        },
      });
      messages.value = [...messages.value, assistantMessage(response)];
      status.value = "idle";
    } catch (sendError) {
      status.value = "error";
      error.value = String(sendError?.message || sendError);
    }
  }

  function clearMessages() {
    resetConversation();
  }

  return {
    apiKey,
    apiUrl,
    draft,
    messages,
    sessionHistory,
    status,
    error,
    hasApiKey,
    isBusy,
    send,
    startNewSession,
    restoreSession,
    clearMessages,
  };
}
