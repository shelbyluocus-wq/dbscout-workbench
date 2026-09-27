<script setup>
import { t } from "../i18n/index.js";
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
  <section class="wb-ai-config-panel" :aria-label="t('m_8532a0fa68db')">
    <Transition name="wb-ai-saved">
      <span v-if="savedVisible" class="wb-ai-config-saved" aria-live="polite">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg> {{ t('m_1bd91a7d0c53') }} </span>
    </Transition>

    <div class="wb-ai-config-group">
      <strong class="wb-ai-config-title">{{ t('m_ce637685876c') }}</strong>
      <p class="wb-ai-config-hint"> {{ t('m_afacb008ea44') }} <button type="button" class="wb-ai-config-link" @click="assistant.useLocalClaudeCodeConfig()">{{ t('m_aad79a51296a') }}</button>
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
          :placeholder="t('m_06fa179bce30')"
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
        <span>{{ t('m_c98e118e0a43') }}</span>
        <input
          v-model="assistant.model.value"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="t('m_08ca5aac6b5d')"
        />
      </label>
    </div>

    <div class="wb-ai-config-group">
      <strong class="wb-ai-config-title">{{ t('m_d92ffbeedfac') }}</strong>

      <label class="wb-ai-config-field">
        <span>{{ t('m_47a270081ab2') }}</span>
        <select
          :value="assistant.permissionMode.value"
          @change="assistant.setMode($event.target.value)"
        >
          <option value="default">{{ t('m_636a565315cd') }}</option>
          <option value="plan">{{ t('m_f8a0d92d5e9a') }}</option>
        </select>
      </label>

      <label class="wb-ai-config-toggle">
        <input
          :checked="assistant.autoApproveWrites.value"
          type="checkbox"
          @change="assistant.setAutoApprove($event.target.checked)"
        />
        <span>{{ t('m_3c1b781a9ef6') }}</span>
      </label>
    </div>

    <div class="wb-ai-config-group wb-ai-mcp-group">
      <div class="wb-ai-mcp-heading">
        <div>
          <strong class="wb-ai-config-title">{{ t('m_41fcd7d9b28a') }}</strong>
          <p class="wb-ai-config-hint">{{ t('m_619d296e3972') }}</p>
        </div>
        <span
          class="wb-ai-mcp-status"
          :class="{ 'is-active': assistant.externalMcpStatus.value?.enabled }"
        >
          {{ assistant.externalMcpStatus.value?.enabled ? t('m_8a4ef3e48e4e') : t('m_6744b4c6a9aa') }}
        </span>
      </div>

      <label class="wb-ai-config-toggle">
        <input
          :checked="assistant.externalMcpStatus.value?.enabled"
          :disabled="assistant.externalMcpLoading.value"
          type="checkbox"
          @change="assistant.setExternalMcpEnabled($event.target.checked)"
        />
        <span>{{ t('m_a61c60113cfb') }}</span>
      </label>

      <p class="wb-ai-mcp-safety"> {{ t('m_0c0c688c50c9') }} </p>

      <p class="wb-ai-mcp-safety"> {{ t('m_ce93ad12e810') }} </p>

      <div v-if="assistant.externalMcpStatus.value?.enabled" class="wb-ai-mcp-details">
        <div class="wb-ai-mcp-runtime">
          <span>{{ t('m_f0642a808f14') }} {{ assistant.externalMcpStatus.value?.running ? t('m_1f0eb99b7ed0') : t('m_62cdc8713bcf') }}</span>
          <span>{{ t('m_5be0323e8adc') }} {{ assistant.externalMcpStatus.value?.connectedClients || 0 }}</span>
        </div>
        <label class="wb-ai-config-field">
          <span>{{ t('m_c6fd552b6aed') }}</span>
          <textarea
            :value="assistant.externalMcpStatus.value?.codexInstallCommand || ''"
            rows="3"
            readonly
            spellcheck="false"
          />
        </label>
        <button type="button" class="wb-ai-mcp-copy" @click="copyMcpInstallCommand('codex')">
          {{ mcpCopiedTarget === "codex" ? t('m_8f6f8d979c98') : t('m_685e3d12e56e') }}
        </button>
        <label class="wb-ai-config-field">
          <span>{{ t('m_a02299dd496a') }}</span>
          <textarea
            :value="assistant.externalMcpStatus.value?.installCommand || ''"
            rows="3"
            readonly
            spellcheck="false"
          />
        </label>
        <button type="button" class="wb-ai-mcp-copy" @click="copyMcpInstallCommand('claude')">
          {{ mcpCopiedTarget === "claude" ? t('m_8f6f8d979c98') : t('m_b30c0a6045d3') }}
        </button>
        <label class="wb-ai-config-field">
          <span>{{ t('m_d37776c322a2') }}</span>
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
