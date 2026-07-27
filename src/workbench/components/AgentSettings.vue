<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import AgentSessionList from "./AgentSessionList.vue";

const { assistant } = defineProps({
  assistant: { type: Object, required: true },
});

const emit = defineEmits(["close"]);

onMounted(() => {
  assistant.listSessions();
  assistant.loadExternalMcpStatus();
});

function onResume(id) {
  // Fire-and-forget — the sidecar emits `session_messages` asynchronously and
  // the panel transcript is replaced when that event lands. Closing the
  // settings popover immediately surfaces the result to the user.
  assistant.resumeSession(id);
  emit("close");
}

// "已保存" indicator: useAgent bumps `configSavedAt` whenever the settings
// watcher persists to localStorage. Show a transient pill that resets its
// 1.5s fade-out timer on every change, so a burst of typing keeps the chip
// visible until the user pauses.
const savedVisible = ref(false);
const mcpCopiedTarget = ref("");
const genericMcpConfig = computed(() => JSON.stringify({
  command: assistant.externalMcpStatus.value?.nodePath || "node",
  args: [
    assistant.externalMcpStatus.value?.serverPath || "mcp-server.mjs",
    "--app-executable",
    assistant.externalMcpStatus.value?.appPath || "blackcat",
  ],
}, null, 2));
let savedTimer = null;
let mcpCopiedTimer = null;

async function copyMcpInstallCommand(target) {
  const field = target === "codex" ? "codexInstallCommand" : "installCommand";
  const command = String(assistant.externalMcpStatus.value?.[field] || "");
  if (!command) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(command);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = command;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand?.("copy") === true;
      textarea.remove();
      if (!copied) throw new Error("当前环境不允许访问剪贴板");
    }
  } catch (error) {
    assistant.externalMcpError.value = `复制失败：${String(error?.message || error)}`;
    return;
  }
  mcpCopiedTarget.value = target;
  if (mcpCopiedTimer) clearTimeout(mcpCopiedTimer);
  mcpCopiedTimer = setTimeout(() => {
    mcpCopiedTarget.value = "";
    mcpCopiedTimer = null;
  }, 1500);
}

watch(
  () => assistant?.configSavedAt?.value,
  (now, prev) => {
    if (!now || now === prev) return;
    savedVisible.value = true;
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      savedVisible.value = false;
      savedTimer = null;
    }, 1500);
  },
);

onBeforeUnmount(() => {
  if (savedTimer) clearTimeout(savedTimer);
  if (mcpCopiedTimer) clearTimeout(mcpCopiedTimer);
});
</script>

<template>
  <section class="wb-ai-config-panel" aria-label="Agent 设置">
    <Transition name="wb-ai-saved">
      <span v-if="savedVisible" class="wb-ai-config-saved" aria-live="polite">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        已保存
      </span>
    </Transition>

    <div class="wb-ai-config-group">
      <strong class="wb-ai-config-title">端点与模型</strong>
      <p class="wb-ai-config-hint">
        留空时使用内置/环境中的 Claude Code 认证与默认设置。
        <button type="button" class="wb-ai-config-link" @click="assistant.useLocalClaudeCodeConfig()">一键清空</button>
      </p>

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
        <span>Auth Token</span>
        <input
          v-model="assistant.authToken.value"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="Bearer token，可留空"
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

    <div class="wb-ai-config-group wb-ai-mcp-group">
      <div class="wb-ai-mcp-heading">
        <div>
          <strong class="wb-ai-config-title">外部 MCP</strong>
          <p class="wb-ai-config-hint">让 Codex、Claude Code 等外部 AI 读取数据库，并在黑猫中打开或定位表。</p>
        </div>
        <span
          class="wb-ai-mcp-status"
          :class="{ 'is-active': assistant.externalMcpStatus.value?.enabled }"
        >
          {{ assistant.externalMcpStatus.value?.enabled ? "已开启" : "已关闭" }}
        </span>
      </div>

      <label class="wb-ai-config-toggle">
        <input
          :checked="assistant.externalMcpStatus.value?.enabled"
          :disabled="assistant.externalMcpLoading.value"
          type="checkbox"
          @change="assistant.setExternalMcpEnabled($event.target.checked)"
        />
        <span>允许本机外部 AI 连接</span>
      </label>

      <p class="wb-ai-mcp-safety">
        不提供任意写 SQL、改单元格或改表结构。唯一写入能力是经显式确认的整表导入；每次导入前必须先把原表数据备份为本地 XLSX，备份失败则取消导入。
      </p>

      <p class="wb-ai-mcp-safety">
        黑猫未运行时，外部 AI 会按需启动隐藏后台实例，不会主动弹出窗口；调用“打开表”或“显示黑猫”时才会显示软件界面。电脑上仍需有一个后台进程实际执行 MCP 请求。
      </p>

      <div v-if="assistant.externalMcpStatus.value?.enabled" class="wb-ai-mcp-details">
        <div class="wb-ai-mcp-runtime">
          <span>后台控制服务 {{ assistant.externalMcpStatus.value?.running ? "运行中" : "未运行" }}</span>
          <span>已连接 {{ assistant.externalMcpStatus.value?.connectedClients || 0 }}</span>
        </div>
        <label class="wb-ai-config-field">
          <span>Codex 注册命令</span>
          <textarea
            :value="assistant.externalMcpStatus.value?.codexInstallCommand || ''"
            rows="3"
            readonly
            spellcheck="false"
          />
        </label>
        <button type="button" class="wb-ai-mcp-copy" @click="copyMcpInstallCommand('codex')">
          {{ mcpCopiedTarget === "codex" ? "已复制" : "复制 Codex 命令" }}
        </button>
        <label class="wb-ai-config-field">
          <span>Claude Code 注册命令</span>
          <textarea
            :value="assistant.externalMcpStatus.value?.installCommand || ''"
            rows="3"
            readonly
            spellcheck="false"
          />
        </label>
        <button type="button" class="wb-ai-mcp-copy" @click="copyMcpInstallCommand('claude')">
          {{ mcpCopiedTarget === "claude" ? "已复制" : "复制 Claude Code 命令" }}
        </button>
        <label class="wb-ai-config-field">
          <span>其他 stdio MCP 客户端</span>
          <textarea
            :value="genericMcpConfig"
            rows="7"
            readonly
            spellcheck="false"
          />
        </label>
      </div>

      <p v-if="assistant.externalMcpError.value" class="wb-ai-mcp-error" role="alert">
        {{ assistant.externalMcpError.value }}
      </p>
    </div>

    <AgentSessionList
      :sessions="assistant.sessions.value"
      :last-session-id="assistant.lastSessionId.value"
      @resume="onResume"
      @delete="assistant.deleteSession"
      @refresh="assistant.listSessions"
    />
  </section>
</template>
