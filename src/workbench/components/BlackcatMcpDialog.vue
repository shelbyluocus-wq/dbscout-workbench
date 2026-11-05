<script setup>
import { t } from "../i18n/index.js";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ChevronDown, Files, Focus, PencilLine, TableProperties } from "lucide-vue-next";
import { useEscClose } from "../composables/useEscClose.js";
import { useCopyFeedback } from "../composables/useCopyFeedback.js";
import { genericMcpConfigJson } from "../utils/externalMcp.js";

const props = defineProps({
  assistant: { type: Object, required: true },
  theme: { type: String, default: "light" },
});

const emit = defineEmits(["close"]);

const dialogRef = ref(null);
useEscClose(() => true, () => emit("close"), null, { dialogRef });

const status = computed(() => props.assistant.externalMcpStatus.value || {});
const enabled = computed(() => Boolean(status.value.enabled));
const loading = computed(() => Boolean(props.assistant.externalMcpLoading.value));
const permissions = computed(() => ({
  navigate: true,
  writeData: true,
  schema: true,
  manageTables: true,
  ...(status.value.permissions || {}),
}));

const statusLabel = computed(() => {
  if (!enabled.value) return t("blackcatMcp.statusOff");
  const count = Number(status.value.connectedClients) || 0;
  return count > 0
    ? t("blackcatMcp.statusConnected", { count })
    : t("blackcatMcp.statusWaiting");
});

const groups = [
  { key: "navigate", icon: Focus, titleKey: "blackcatMcp.group.navigate", hintKey: "blackcatMcp.group.navigateHint" },
  { key: "writeData", icon: PencilLine, titleKey: "blackcatMcp.group.writeData", hintKey: "blackcatMcp.group.writeDataHint" },
  { key: "schema", icon: TableProperties, titleKey: "blackcatMcp.group.schema", hintKey: "blackcatMcp.group.schemaHint" },
  { key: "manageTables", icon: Files, titleKey: "blackcatMcp.group.manageTables", hintKey: "blackcatMcp.group.manageTablesHint", warning: true },
];

const genericMcpConfig = computed(() => genericMcpConfigJson(status.value));
const connectBlocks = computed(() => [
  { id: "codex", label: t("m_c6fd552b6aed"), copyLabel: t("m_685e3d12e56e"), text: String(status.value.codexInstallCommand || "") },
  { id: "claude", label: t("m_a02299dd496a"), copyLabel: t("m_b30c0a6045d3"), text: String(status.value.installCommand || "") },
  { id: "generic", label: t("m_d37776c322a2"), copyLabel: t("blackcatMcp.copy"), text: genericMcpConfig.value },
]);

const { copiedTarget, copy } = useCopyFeedback();

async function copySnippet(block) {
  try {
    await copy(block.id, block.text);
  } catch (error) {
    props.assistant.externalMcpError.value = `复制失败：${String(error?.message || error)}`;
  }
}

function close() {
  emit("close");
}

function onKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
  }
}

// Keep the connected-client count live while the dialog is open. The poll is
// silent so it never flickers the switches or the error line.
let statusTimer = null;
onMounted(() => {
  void props.assistant.loadExternalMcpStatus();
  statusTimer = setInterval(() => {
    void props.assistant.loadExternalMcpStatus({ silent: true });
  }, 3000);
});
onBeforeUnmount(() => {
  if (statusTimer) clearInterval(statusTimer);
});
</script>

<template>
  <Teleport to="body">
    <div class="wb-shortcut-dialog-overlay wb-mcp-dialog-overlay wb-floating-themed" :data-theme="theme">
      <section
        ref="dialogRef"
        class="wb-shortcut-dialog wb-mcp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wb-mcp-dialog-title"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="wb-shortcut-dialog-header wb-mcp-dialog-header">
          <strong id="wb-mcp-dialog-title">{{ t("blackcatMcp.title") }}</strong>
          <button
            type="button"
            class="wb-shortcut-dialog-close wb-mcp-dialog-close"
            :aria-label="t('m_3fd47edce45b')"
            @click="close"
          >✕</button>
        </header>

        <div class="wb-mcp-dialog-body">
          <label class="wb-mcp-master">
            <span class="wb-mcp-master-text">
              <strong>{{ t("blackcatMcp.masterTitle") }}</strong>
              <span class="wb-mcp-sub">{{ t("blackcatMcp.masterHint") }}</span>
            </span>
            <span class="wb-mcp-chip" :class="{ 'is-on': enabled }">{{ statusLabel }}</span>
            <input
              type="checkbox"
              class="wb-backup-switch"
              role="switch"
              :checked="enabled"
              :disabled="loading"
              :aria-label="t('blackcatMcp.masterTitle')"
              @change="assistant.setExternalMcpEnabled($event.target.checked)"
            />
          </label>

          <template v-if="enabled">
            <ul class="wb-mcp-groups">
              <li v-for="group in groups" :key="group.key" class="wb-mcp-group">
                <component :is="group.icon" class="wb-mcp-group-icon" :size="15" :stroke-width="1.8" />
                <label class="wb-mcp-group-main">
                  <span class="wb-mcp-group-text">
                    <span class="wb-mcp-group-name">{{ t(group.titleKey) }}</span>
                    <span class="wb-mcp-group-hint" :class="{ 'is-warning': group.warning }">{{ t(group.hintKey) }}</span>
                  </span>
                  <input
                    type="checkbox"
                    class="wb-backup-switch"
                    role="switch"
                    :checked="permissions[group.key]"
                    :disabled="loading"
                    :aria-label="t(group.titleKey)"
                    @change="assistant.setExternalMcpPermission(group.key, $event.target.checked)"
                  />
                </label>
              </li>
            </ul>
            <p class="wb-mcp-note">{{ t("blackcatMcp.writeNote") }}</p>

            <details class="wb-mcp-connect">
              <summary class="wb-mcp-connect-summary">
                <ChevronDown class="wb-mcp-connect-chevron" :size="13" :stroke-width="2" />
                <span>{{ t("blackcatMcp.connectTitle") }}</span>
              </summary>
              <div class="wb-mcp-connect-body">
                <div v-for="block in connectBlocks" :key="block.id" class="wb-mcp-connect-block">
                  <div class="wb-mcp-connect-head">
                    <span>{{ block.label }}</span>
                    <button
                      type="button"
                      class="wb-mcp-copy"
                      @click="copySnippet(block)"
                    >{{ copiedTarget === block.id ? t("m_8f6f8d979c98") : block.copyLabel }}</button>
                  </div>
                  <textarea
                    class="wb-mcp-connect-code"
                    :value="block.text"
                    :rows="block.id === 'generic' ? 7 : 2"
                    readonly
                    spellcheck="false"
                  ></textarea>
                </div>
              </div>
            </details>
          </template>

          <p v-if="assistant.externalMcpError.value" class="wb-mcp-error" role="alert">
            {{ assistant.externalMcpError.value }}
          </p>
        </div>
      </section>
    </div>
  </Teleport>
</template>
