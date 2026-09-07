<script setup>
import { Cloud, FileText, FolderOpen, FolderSearch, HardDrive, LoaderCircle, TriangleAlert, User, X } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useEscClose } from "../composables/useEscClose.js";

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
          <h2 id="wb-table-transfer-title">一键转表(一键导出客户端prop)</h2>
          <p>运行转表脚本生成配置包，先 SVN 更新游戏工程，再覆盖配置表到 assets。</p>
        </div>
        <button
          type="button"
          class="wb-dialog-close"
          aria-label="关闭一键转表窗口"
          :disabled="isRunning"
          @click="emit('close')"
        >
          ×
        </button>
      </header>

      <div class="wb-table-transfer-body">
        <!-- 模板页签 -->
        <div class="wb-table-transfer-tabs" role="tablist" aria-label="转表模板">
          <button
            v-for="template in templates"
            :key="template.id"
            type="button"
            role="tab"
            :aria-selected="template.id === activeTemplate.id"
            class="wb-table-transfer-tab"
            :class="{ 'is-active': template.id === activeTemplate.id }"
            :disabled="isRunning"
            @click="transfer.setActiveTemplate(template.id)"
          >
            {{ template.name }}
          </button>
        </div>

        <!-- 配置项 -->
        <div class="wb-table-transfer-form">
          <div class="wb-table-transfer-field">
            <span class="wb-table-transfer-label">转表脚本</span>
            <div class="wb-table-transfer-path">
              <input
                type="text"
                :value="activeTemplate.scriptPath"
                readonly
                placeholder="选择 .exe / .bat / .lnk 转表脚本"
                aria-label="转表脚本路径"
              />
              <button type="button" class="wb-table-transfer-pick" :disabled="isRunning" @click="pickScript">
                <FileText :size="13" aria-hidden="true" />
                选择脚本…
              </button>
              <button
                type="button"
                class="wb-table-transfer-browse"
                title="在资源管理器中打开"
                aria-label="浏览转表脚本所在位置"
                :disabled="isRunning || !activeTemplate.scriptPath"
                @click="browseScript"
              >
                <FolderSearch :size="13" aria-hidden="true" />
                浏览
              </button>
            </div>
          </div>
          <div class="wb-table-transfer-field">
            <span class="wb-table-transfer-label">游戏工程</span>
            <div class="wb-table-transfer-path">
              <input
                type="text"
                :value="activeTemplate.projectRoot"
                readonly
                placeholder="选择游戏工程文件夹（或其中的 assets 目录）"
                aria-label="游戏工程路径"
              />
              <button type="button" class="wb-table-transfer-pick" :disabled="isRunning" @click="pickProjectDir">
                <FolderOpen :size="13" aria-hidden="true" />
                选择文件夹…
              </button>
              <button
                type="button"
                class="wb-table-transfer-browse"
                title="在资源管理器中打开"
                aria-label="浏览游戏工程文件夹"
                :disabled="isRunning || !activeTemplate.projectRoot"
                @click="browseProject"
              >
                <FolderSearch :size="13" aria-hidden="true" />
                浏览
              </button>
            </div>
          </div>
          <div class="wb-table-transfer-field">
            <span class="wb-table-transfer-label">冲突处理</span>
            <div class="wb-table-transfer-strategy" role="radiogroup" aria-label="SVN 冲突处理策略">
              <label>
                <input
                  type="radio"
                  name="wb-table-transfer-strategy"
                  :checked="activeTemplate.conflictStrategy === 'theirs'"
                  :disabled="isRunning"
                  @change="setConflictStrategy('theirs')"
                />
                <Cloud :size="13" aria-hidden="true" />
                冲突以云端为准
              </label>
              <label>
                <input
                  type="radio"
                  name="wb-table-transfer-strategy"
                  :checked="activeTemplate.conflictStrategy === 'mine'"
                  :disabled="isRunning"
                  @change="setConflictStrategy('mine')"
                />
                <HardDrive :size="13" aria-hidden="true" />
                冲突以本地为准
              </label>
              <label>
                <input
                  type="radio"
                  name="wb-table-transfer-strategy"
                  :checked="activeTemplate.conflictStrategy === 'manual'"
                  :disabled="isRunning"
                  @change="setConflictStrategy('manual')"
                />
                <User :size="13" aria-hidden="true" />
                遇到冲突由我处理
              </label>
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
          <p v-if="dialog.errorMessage" class="wb-dialog-error">
            {{ dialog.errorMessage }}
          </p>
          <div v-if="dialog.status === 'succeeded' && result" class="wb-table-transfer-result">
            <span>产出目录：{{ result.outputDir }}</span>
            <span>覆盖文件：{{ result.copiedFiles }} 个</span>
          </div>
          <pre v-if="showLog" ref="logRef" class="wb-table-transfer-log" aria-label="转表日志">{{ logText }}</pre>
        </div>
      </div>

      <!-- Footer -->
      <footer class="wb-dialog-actions wb-table-transfer-footer">
        <button v-if="isRunning" type="button" @click="cancelRun">取消运行</button>
        <button v-else type="button" @click="emit('close')">关闭</button>
        <span :title="runDisabledReason">
          <button
            type="button"
            class="wb-dialog-primary"
            :disabled="!canRun"
            @click="start"
          >
            {{ isRunning ? "转表进行中…" : "开始转表" }}
          </button>
        </span>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.wb-table-transfer-dialog {
  width: 740px;
  max-width: calc(100vw - 48px);
  /* 顶部留白收紧（全局 .wb-dialog 是 padding: 16px 18px） */
  padding-top: 10px;
}

/* 关闭按钮加大（全局是 28px / 16px 字） */
.wb-table-transfer-header {
  margin-bottom: 8px;
}

.wb-table-transfer-header .wb-dialog-close {
  width: 36px;
  height: 36px;
  font-size: 22px;
}

.wb-table-transfer-header h2 {
  font-size: 16px;
}

.wb-table-transfer-header p {
  font-size: 13px;
}

.wb-table-transfer-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 16px 12px;
  min-height: 0;
}

.wb-table-transfer-tabs {
  display: flex;
  gap: 6px;
}

.wb-table-transfer-tab {
  padding: 5px 16px;
  border: 1px solid var(--wb-border-strong);
  border-radius: 4px;
  background: var(--wb-pane-header);
  color: var(--wb-text);
  font-size: 13px;
  cursor: pointer;
}

.wb-table-transfer-tab.is-active {
  border-color: var(--wb-accent);
  background: var(--wb-cell-editor);
  font-weight: 600;
}

.wb-table-transfer-tab:disabled {
  opacity: 0.6;
  cursor: default;
}

.wb-table-transfer-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.wb-table-transfer-field {
  display: flex;
  align-items: center;
  gap: 10px;
}

.wb-table-transfer-label {
  flex: none;
  width: 60px;
  font-size: 13px;
  color: var(--wb-text);
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
  font-size: 13px;
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
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.wb-table-transfer-pick {
  width: 128px;
}

.wb-table-transfer-browse {
  width: 64px;
  padding: 0 8px;
}

.wb-table-transfer-path button:hover:not(:disabled) {
  border-color: var(--wb-accent);
}

.wb-table-transfer-path button:disabled {
  opacity: 0.6;
  cursor: default;
}

.wb-table-transfer-strategy {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  font-size: 13px;
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
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--wb-border);
  border-radius: 4px;
  background: var(--wb-field-surface);
}

.wb-table-transfer-status[data-status="failed"] {
  border-color: var(--wb-danger);
}

.wb-table-transfer-status-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
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
  font-size: 13px;
  color: var(--wb-text);
  word-break: break-all;
}

.wb-table-transfer-log {
  max-height: 220px;
  overflow: auto;
  padding: 2px 0 0;
  margin: 0;
  border: none;
  background: transparent;
  font-family: var(--wb-font-ui);
  font-weight: var(--wb-font-weight-ui);
  font-size: 13px;
  line-height: 1.6;
  color: var(--wb-text);
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
  contain: content;
}

.wb-table-transfer-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
