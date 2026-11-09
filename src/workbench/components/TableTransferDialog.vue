<script setup>
import { t } from "../i18n/index.js";
import { tPlatform } from "../utils/platformLabels.js";
import {
  Cloud,
  FileText,
  FolderOpen,
  FolderSearch,
  HardDrive,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  User,
  X,
} from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useConfirm } from "../composables/useConfirm.js";
import { useEscClose } from "../composables/useEscClose.js";
import { TABLE_TRANSFER_TEMPLATE_NAME_MAX_LENGTH } from "../composables/useTableTransfer.js";

import { isMacOSPlatform } from "../utils/desktopPlatform.js";

const props = defineProps({
  transfer: { type: Object, required: true },
});

const emit = defineEmits(["close"]);

const dialogRef = ref(null);
const logRef = ref(null);

const dialog = props.transfer.dialog;
const templates = computed(() => props.transfer.templates.value);
const activeTemplate = computed(() => props.transfer.activeTemplate.value);
const isRunning = computed(() => props.transfer.isRunning.value);
const canRun = computed(() => props.transfer.canRun.value);
const stageLabel = computed(() => props.transfer.stageLabel.value);
const result = computed(() => props.transfer.result.value);

useEscClose(() => true, () => emit("close"), () => isRunning.value, { dialogRef });

const STATUS_TITLES = {
  running: "转表进行中",
  succeeded: "转表完成",
  failed: "转表失败",
  cancelled: "已取消",
};

const statusTitle = computed(() => STATUS_TITLES[dialog.status] || "");
const showLog = computed(() => dialog.status !== "idle" && dialog.logLines.length > 0);
const logText = computed(() => dialog.logLines.join("\n"));

// 日志追加时自动滚到底部。
watch(
  () => dialog.logLines.length,
  async () => {
    await nextTick();
    if (logRef.value) logRef.value.scrollTop = logRef.value.scrollHeight;
  },
);

// 运行时长指示：脚本阶段可能持续几分钟，让"还在正常跑"可视化。
const startedAt = ref(0);
const clockNow = ref(0);
let clockTimer = null;

watch(
  isRunning,
  (running) => {
    if (clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
    if (running) {
      startedAt.value = Date.now();
      clockNow.value = startedAt.value;
      clockTimer = setInterval(() => {
        clockNow.value = Date.now();
      }, 1000);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer);
});

const elapsedText = computed(() => {
  if (!isRunning.value || !startedAt.value) return "";
  const seconds = Math.max(0, Math.floor((clockNow.value - startedAt.value) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `已运行 ${minutes}:${String(seconds % 60).padStart(2, "0")}`;
});

function pickScript() {
  props.transfer.pickScript(activeTemplate.value.id);
}

function pickProjectDir() {
  props.transfer.pickProjectDir(activeTemplate.value.id);
}

function browseScript() {
  void props.transfer.revealPath(activeTemplate.value.scriptPath);
}

function browseProject() {
  void props.transfer.revealPath(props.transfer.projectFolderToReveal(activeTemplate.value.projectRoot));
}

function setConflictStrategy(value) {
  props.transfer.updateTemplate(activeTemplate.value.id, { conflictStrategy: value });
}

function start() {
  void props.transfer.run();
}

function cancelRun() {
  void props.transfer.cancel();
}

const runDisabledReason = computed(() => {
  if (isRunning.value) return "转表进行中…";
  if (!activeTemplate.value?.scriptPath) return "请先选择转表脚本";
  if (!activeTemplate.value?.projectRoot) return "请先选择游戏工程文件夹";
  return "运行脚本 → 定位产出 → SVN 更新 → 覆盖拷贝进 assets";
});

// Inline template naming. "add" shows the name field where the new tab will
// appear; "rename" swaps the template's own tab for the field. The add button
// and template actions hide meanwhile: leaving the field saves the name, which
// can switch the active template before their click handler runs.
const PENDING_TEMPLATE_ID = "__pending__";
const { confirm } = useConfirm();
const nameEdit = reactive({ mode: "", templateId: "", draft: "" });

const tabItems = computed(() =>
  nameEdit.mode === "add" ? [...templates.value, { id: PENDING_TEMPLATE_ID }] : templates.value,
);
const editingTabId = computed(() => {
  if (nameEdit.mode === "add") return PENDING_TEMPLATE_ID;
  return nameEdit.mode === "rename" ? nameEdit.templateId : "";
});
const nameProblem = computed(() =>
  nameEdit.mode ? props.transfer.validateTemplateName(nameEdit.draft, nameEdit.templateId) : "",
);
const nameError = computed(() => {
  if (nameProblem.value === "invalid") return t("tableTransfer.nameRequired");
  if (nameProblem.value === "duplicate") return t("tableTransfer.nameDuplicate");
  return "";
});

const vSelectOnMount = {
  mounted(element) {
    element.focus({ preventScroll: true });
    element.select();
  },
};

function templateTitle(template) {
  return template.builtIn
    ? t("tableTransfer.builtInTemplateHint")
    : t("tableTransfer.customTemplateHint", { name: template.name });
}

function startAddTemplate() {
  if (isRunning.value) return;
  nameEdit.mode = "add";
  nameEdit.templateId = "";
  nameEdit.draft = props.transfer.suggestTemplateName(t("tableTransfer.defaultTemplateName"));
}

function startRenameTemplate(template) {
  if (isRunning.value || !template) return;
  props.transfer.setActiveTemplate(template.id);
  nameEdit.mode = "rename";
  nameEdit.templateId = template.id;
  nameEdit.draft = template.name;
}

function endNameEdit({ refocus = false } = {}) {
  nameEdit.mode = "";
  nameEdit.templateId = "";
  nameEdit.draft = "";
  if (!refocus) return;
  void nextTick(() => dialogRef.value?.querySelector('[role="tab"][aria-selected="true"]')?.focus());
}

function commitNameEdit({ fromBlur = false } = {}) {
  if (!nameEdit.mode) return;
  const { status } =
    nameEdit.mode === "add"
      ? props.transfer.addTemplate(nameEdit.draft)
      : props.transfer.renameTemplate(nameEdit.templateId, nameEdit.draft);
  // Enter keeps an unusable name open with its error; leaving the field drops
  // the edit instead of pulling focus back.
  if (["created", "renamed", "unchanged"].includes(status) || fromBlur) {
    endNameEdit({ refocus: !fromBlur });
  }
}

function onNameBlur() {
  // Switching to another window blurs the field too. Keep the edit open so a
  // name copied from elsewhere can still be pasted; focus returns on the way back.
  if (!document.hasFocus()) return;
  commitNameEdit({ fromBlur: true });
}

function onNameKeydown(event) {
  // Chinese input methods use Enter/Esc too; WebKit reports the Enter that
  // ends a composition with keyCode 229 rather than isComposing.
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter") {
    event.preventDefault();
    commitNameEdit();
  } else if (event.key === "Escape") {
    // A prevented Escape tells the dialog layer to keep this dialog open.
    event.preventDefault();
    endNameEdit({ refocus: true });
  }
}

async function deleteActiveTemplate() {
  const template = activeTemplate.value;
  if (isRunning.value || !template || template.builtIn) return;
  const confirmed = await confirm({
    title: t("m_f5a3ec56b46f"),
    message: t("tableTransfer.deleteTemplateMessage", { name: template.name }),
    note: t("tableTransfer.deleteTemplateNote"),
    confirmText: t("m_2f9daa828907"),
    cancelText: t("m_2cd0f3be8738"),
    danger: true,
  });
  if (confirmed) props.transfer.deleteTemplate(template.id);
}
</script>

<template>
  <div class="wb-dialog-overlay">
    <section
      ref="dialogRef"
      class="wb-dialog wb-table-transfer-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wb-table-transfer-title"
      tabindex="-1"
    >
      <!-- Header -->
      <header class="wb-dialog-header wb-table-transfer-header">
        <div>
          <h2 id="wb-table-transfer-title">{{ t('m_510ce8f45357') }}</h2>
          <p>{{ t('m_200516ae1204') }}</p>
        </div>
        <button
          type="button"
          class="wb-dialog-close"
          :aria-label="t('m_3da29c4a3338')"
          :disabled="isRunning"
          @click="emit('close')"
        >
          ×
        </button>
      </header>

      <div class="wb-table-transfer-body">
        <!-- 模板页签 -->
        <div class="wb-table-transfer-templates">
          <div class="wb-table-transfer-tabs" role="tablist" :aria-label="t('m_fc621ca9bf0b')">
            <template v-for="item in tabItems" :key="item.id">
              <input
                v-if="item.id === editingTabId"
                v-model="nameEdit.draft"
                v-select-on-mount
                type="text"
                class="wb-table-transfer-name-input"
                :maxlength="TABLE_TRANSFER_TEMPLATE_NAME_MAX_LENGTH"
                :placeholder="t('tableTransfer.templateName')"
                :aria-label="t('tableTransfer.templateName')"
                :aria-invalid="nameProblem ? 'true' : 'false'"
                :aria-describedby="nameError ? 'wb-table-transfer-name-error' : undefined"
                @keydown="onNameKeydown"
                @blur="onNameBlur"
              />
              <button
                v-else
                type="button"
                role="tab"
                :aria-selected="item.id === activeTemplate.id"
                class="wb-table-transfer-tab"
                :class="{ 'is-active': item.id === activeTemplate.id }"
                :title="templateTitle(item)"
                :disabled="isRunning"
                @click="transfer.setActiveTemplate(item.id)"
                @dblclick="startRenameTemplate(item)"
                @keydown.f2.prevent="startRenameTemplate(item)"
              >
                {{ item.name }}
              </button>
            </template>
          </div>
          <button
            v-if="!nameEdit.mode"
            type="button"
            class="wb-table-transfer-add"
            :title="t('tableTransfer.addTemplateHint')"
            :disabled="isRunning"
            @click="startAddTemplate"
          >
            <Plus :size="14" aria-hidden="true" /> {{ t('tableTransfer.addTemplate') }}
          </button>
          <div v-if="!nameEdit.mode" class="wb-table-transfer-template-actions">
            <button
              type="button"
              :title="t('m_1bf7e836eb4c')"
              :disabled="isRunning"
              @click="startRenameTemplate(activeTemplate)"
            >
              <Pencil :size="14" aria-hidden="true" /> {{ t('m_0d0cbac2eee5') }}
            </button>
            <button
              v-if="!activeTemplate.builtIn"
              type="button"
              class="is-danger"
              :title="t('m_f5a3ec56b46f')"
              :disabled="isRunning"
              @click="deleteActiveTemplate"
            >
              <Trash2 :size="14" aria-hidden="true" /> {{ t('m_2f9daa828907') }}
            </button>
          </div>
        </div>
        <p
          v-if="nameError"
          id="wb-table-transfer-name-error"
          class="wb-table-transfer-name-error"
          aria-live="polite"
        >
          {{ nameError }}
        </p>

        <!-- 配置项 -->
        <div class="wb-table-transfer-form">
          <div class="wb-table-transfer-field">
            <span class="wb-table-transfer-label">{{ t('m_df3b0c3feaf7') }}</span>
            <div class="wb-table-transfer-path">
              <input
                type="text"
                :value="activeTemplate.scriptPath"
                readonly
                :placeholder="t(isMacOSPlatform() ? 'tableTransfer.macScriptHint' : 'm_c6aadb8f03ed')"
                :aria-label="t('m_56675578a75d')"
              />
              <button type="button" class="wb-table-transfer-pick" :disabled="isRunning" @click="pickScript">
                <FileText :size="18" aria-hidden="true" /> {{ t('m_b902d80b8b41') }} </button>
              <button
                type="button"
                class="wb-table-transfer-browse"
                :title="tPlatform('m_d10ec81b9024')"
                :aria-label="t('m_d9b35c1d0873')"
                :disabled="isRunning || !activeTemplate.scriptPath"
                @click="browseScript"
              >
                <FolderSearch :size="18" aria-hidden="true" /> {{ t('m_a8c81f93f2e0') }} </button>
            </div>
          </div>
          <div class="wb-table-transfer-field">
            <span class="wb-table-transfer-label">{{ t('m_e82d96ad7002') }}</span>
            <div class="wb-table-transfer-path">
              <input
                type="text"
                :value="activeTemplate.projectRoot"
                readonly
                :placeholder="t('m_6ff1b0c2db35')"
                :aria-label="t('m_6fff77983833')"
              />
              <button type="button" class="wb-table-transfer-pick" :disabled="isRunning" @click="pickProjectDir">
                <FolderOpen :size="18" aria-hidden="true" /> {{ t('m_93e76151bbeb') }} </button>
              <button
                type="button"
                class="wb-table-transfer-browse"
                :title="tPlatform('m_d10ec81b9024')"
                :aria-label="t('m_c2af1dee9520')"
                :disabled="isRunning || !activeTemplate.projectRoot"
                @click="browseProject"
              >
                <FolderSearch :size="18" aria-hidden="true" /> {{ t('m_a8c81f93f2e0') }} </button>
            </div>
          </div>
          <div class="wb-table-transfer-field">
            <label class="wb-table-transfer-label" for="wb-transfer-retention">{{ t('tableTransfer.retention') }}</label>
            <div>
              <input
                id="wb-transfer-retention"
                type="number"
                min="0"
                max="3650"
                step="1"
                :value="activeTemplate.retentionDays"
                :disabled="isRunning"
                @change="transfer.updateTemplate(activeTemplate.id, { retentionDays: $event.target.value }); $event.target.value = activeTemplate.retentionDays"
              />
              <p v-if="transfer.cleanupMessage.value" role="status" class="wb-table-transfer-cleanup-error">{{ t('tableTransfer.cleanupFailed') }} {{ transfer.cleanupMessage.value }}</p>
            </div>
          </div>
          <div class="wb-table-transfer-field">
            <span class="wb-table-transfer-label">{{ t('m_60a33016fc13') }}</span>
            <div class="wb-table-transfer-strategy" role="radiogroup" :aria-label="t('m_930b09549775')">
              <label>
                <input
                  type="radio"
                  name="wb-table-transfer-strategy"
                  :checked="activeTemplate.conflictStrategy === 'theirs'"
                  :disabled="isRunning"
                  @change="setConflictStrategy('theirs')"
                />
                <Cloud :size="13" aria-hidden="true" /> {{ t('m_d59a850d6c4c') }} </label>
              <label>
                <input
                  type="radio"
                  name="wb-table-transfer-strategy"
                  :checked="activeTemplate.conflictStrategy === 'mine'"
                  :disabled="isRunning"
                  @change="setConflictStrategy('mine')"
                />
                <HardDrive :size="13" aria-hidden="true" /> {{ t('m_71983c02ba0c') }} </label>
              <label>
                <input
                  type="radio"
                  name="wb-table-transfer-strategy"
                  :checked="activeTemplate.conflictStrategy === 'manual'"
                  :disabled="isRunning"
                  @change="setConflictStrategy('manual')"
                />
                <User :size="13" aria-hidden="true" /> {{ t('m_8350ce67f10f') }} </label>
            </div>
          </div>
        </div>

        <!-- 状态区 -->
        <div v-if="dialog.status !== 'idle' || dialog.errorMessage" class="wb-table-transfer-status" :data-status="dialog.status">
          <div class="wb-table-transfer-status-line">
            <LoaderCircle v-if="isRunning" :size="14" class="wb-table-transfer-spin" aria-hidden="true" />
            <TriangleAlert v-else-if="dialog.status === 'failed'" :size="14" aria-hidden="true" />
            <strong>{{ statusTitle }}</strong>
            <span v-if="isRunning" class="wb-table-transfer-stage">
              {{ stageLabel }}<template v-if="dialog.stageMessage"> · {{ dialog.stageMessage }}</template>
              <template v-if="elapsedText"> · {{ elapsedText }}</template>
            </span>
          </div>
          <p v-if="dialog.errorMessage" class="wb-table-transfer-error">
            {{ dialog.errorMessage }}
          </p>
          <div v-if="dialog.status === 'succeeded' && result" class="wb-table-transfer-result">
            <span>{{ t('m_08bd6fa642d3') }}{{ result.outputDir }}</span>
            <span>{{ t('m_37ca6a80dc6f') }}{{ result.copiedFiles }} {{ t('m_3a116815bc9d') }}</span>
          </div>
          <pre v-if="showLog" ref="logRef" class="wb-table-transfer-log" :aria-label="t('m_b3d188484e57')">{{ logText }}</pre>
        </div>
      </div>

      <!-- Footer -->
      <footer class="wb-dialog-actions wb-table-transfer-footer">
        <button v-if="isRunning" type="button" @click="cancelRun">{{ t('m_15a3277ed96d') }}</button>
        <button v-else type="button" @click="emit('close')">{{ t('m_3fd47edce45b') }}</button>
        <span :title="runDisabledReason">
          <button
            type="button"
            class="wb-dialog-primary"
            :disabled="!canRun"
            @click="start"
          >
            {{ isRunning ? t('m_38a2d609f30b') : t('m_1e95990832d3') }}
          </button>
        </span>
      </footer>
    </section>
  </div>
</template>

<style scoped>
#wb-transfer-retention {
  width: 100px;
  min-height: 30px;
  padding: 0 8px;
  border: 1px solid var(--wb-border-strong);
  border-radius: 4px;
  background: var(--wb-cell-editor);
  color: var(--wb-text);
  font-size: var(--wb-fs-body);
}

#wb-transfer-retention:disabled {
  color: var(--wb-disabled);
}

label[for="wb-transfer-retention"] {
  align-self: start;
  padding-top: 7px;
}

.wb-table-transfer-cleanup-error {
  margin: 6px 0 0;
  color: var(--wb-secondary-text);
  font-size: var(--wb-fs-caption);
}

.wb-table-transfer-cleanup-error {
  color: var(--wb-danger-text);
  overflow-wrap: anywhere;
}

.wb-table-transfer-dialog {
  display: flex;
  flex-direction: column;
  width: 740px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  overflow: hidden;
  /* 顶部留白收紧（全局 .wb-dialog 是 padding: 16px 18px） */
  padding-top: 10px;
}

/* Two-line header: keep the close button level with the title, not centred
   against the title plus description. */
.wb-table-transfer-header {
  align-items: flex-start;
  margin-bottom: 8px;
}

/* 关闭按钮加大（全局是 28px / 16px 字） */
.wb-table-transfer-header .wb-dialog-close {
  width: 36px;
  height: 36px;
  margin-top: -6px;
  font-size: 22px;
}

.wb-table-transfer-header h2 {
  font-size: var(--wb-fs-heading);
}

.wb-table-transfer-header p {
  font-size: var(--wb-fs-body);
}

.wb-table-transfer-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 4px 16px 12px;
  overflow: auto;
}

.wb-table-transfer-templates {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.wb-table-transfer-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.wb-table-transfer-tab {
  max-width: 220px;
  height: 30px;
  padding: 0 16px;
  overflow: hidden;
  border: 1px solid var(--wb-border-strong);
  border-radius: 4px;
  background: var(--wb-pane-header);
  color: var(--wb-text);
  font-size: var(--wb-fs-body);
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.wb-table-transfer-tab.is-active {
  border-color: var(--wb-accent);
  background: var(--wb-cell-editor);
  font-weight: 600;
}

.wb-table-transfer-tab:disabled {
  color: var(--wb-disabled);
  cursor: default;
}

.wb-table-transfer-name-input {
  width: 180px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--wb-accent);
  border-radius: 4px;
  background: var(--wb-cell-editor);
  color: var(--wb-text);
  font-size: var(--wb-fs-body);
}

.wb-table-transfer-name-input[aria-invalid="true"] {
  border-color: var(--wb-danger);
  outline-color: var(--wb-danger);
}

.wb-table-transfer-add,
.wb-table-transfer-template-actions button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 10px;
  border-radius: 4px;
  font-size: var(--wb-fs-body);
  white-space: nowrap;
}

.wb-table-transfer-add {
  border: 1px dashed var(--wb-border-strong);
  background: transparent;
  color: var(--wb-text);
}

.wb-table-transfer-add:hover:not(:disabled) {
  border-color: var(--wb-accent);
  background: var(--wb-accent-soft);
}

.wb-table-transfer-template-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

.wb-table-transfer-template-actions button {
  border: 1px solid transparent;
  background: transparent;
  color: var(--wb-secondary-text);
}

.wb-table-transfer-template-actions button:hover:not(:disabled) {
  border-color: transparent;
  background: var(--wb-accent-soft);
  color: var(--wb-text);
}

.wb-table-transfer-template-actions button.is-danger:hover:not(:disabled) {
  color: var(--wb-danger);
}

/* Sits right under the template row; the body's 12px gap would detach it. */
.wb-table-transfer-name-error {
  margin: -6px 0 0;
  color: var(--wb-danger);
  font-size: var(--wb-fs-body);
}

/* Two-column form: the label column is as wide as the longest label in the
   current language, so labels never wrap and every input lines up. */
.wb-table-transfer-form {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: center;
  column-gap: 12px;
  row-gap: 8px;
}

.wb-table-transfer-field {
  display: contents;
}

.wb-table-transfer-label {
  min-width: 56px;
  font-size: var(--wb-fs-body);
  color: var(--wb-text);
  white-space: nowrap;
}

.wb-table-transfer-path {
  flex: 1;
  display: flex;
  gap: 6px;
  min-width: 0;
}

.wb-table-transfer-path input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--wb-border-strong);
  border-radius: 3px;
  background: var(--wb-cell-editor);
  color: var(--wb-text);
  font-size: var(--wb-fs-body);
}

.wb-table-transfer-path button {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--wb-border-strong);
  border-radius: 3px;
  background: var(--wb-pane-header);
  color: var(--wb-text);
  font-size: var(--wb-fs-body);
  cursor: pointer;
  white-space: nowrap;
}

.wb-table-transfer-pick {
  width: 128px;
}

.wb-table-transfer-browse {
  width: 76px;
  padding: 0 8px;
}

.wb-table-transfer-path button:hover:not(:disabled) {
  border-color: var(--wb-accent);
}

.wb-table-transfer-path button:disabled {
  color: var(--wb-disabled);
  cursor: default;
}

.wb-table-transfer-strategy {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  font-size: var(--wb-fs-body);
  color: var(--wb-text);
}

.wb-table-transfer-strategy label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}

.wb-table-transfer-strategy input[type="radio"] {
  margin: 0;
  accent-color: var(--wb-accent);
}

.wb-table-transfer-strategy input[type="radio"]:focus,
.wb-table-transfer-strategy input[type="radio"]:focus-visible {
  outline: none;
  box-shadow: none;
}

.wb-table-transfer-status {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 10px;
  overflow: hidden;
  border: 1px solid var(--wb-border);
  border-radius: 4px;
  background: var(--wb-field-surface);
}

.wb-table-transfer-error {
  margin: 0;
  max-height: 7.5em;
  overflow: auto;
  color: var(--wb-danger);
  font-size: var(--wb-fs-body);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.wb-table-transfer-status[data-status="failed"] {
  border-color: var(--wb-danger);
}

.wb-table-transfer-status-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--wb-fs-body);
  color: var(--wb-text);
}

.wb-table-transfer-stage {
  color: var(--wb-field-placeholder);
}

.wb-table-transfer-spin {
  animation: wb-table-transfer-rotate 1s linear infinite;
}

@keyframes wb-table-transfer-rotate {
  to {
    transform: rotate(360deg);
  }
}

.wb-table-transfer-result {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--wb-fs-body);
  color: var(--wb-text);
  word-break: break-all;
}

.wb-table-transfer-log {
  flex: 1 1 auto;
  min-height: 80px;
  max-height: 220px;
  overflow: auto;
  padding: 2px 0 0;
  margin: 0;
  border: none;
  background: transparent;
  font-family: var(--wb-font-ui);
  font-weight: var(--wb-font-weight-ui);
  font-size: var(--wb-fs-body);
  line-height: 1.6;
  color: var(--wb-text);
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
  contain: content;
}

.wb-table-transfer-footer {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
