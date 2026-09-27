<script setup>
import { t } from "../i18n/index.js";
import { computed } from "vue";

const props = defineProps({
  assistant: { type: Object, required: true },
});

const emit = defineEmits(["open-update"]);

const state = computed(() => props.assistant.runtimeState.value);
const status = computed(() => props.assistant.runtimeStatus.value || {});
const condition = computed(() => status.value.state || state.value);
const progress = computed(() => props.assistant.runtimeProgress.value || {});
const updateError = computed(() => String(props.assistant.runtimeUpdateError.value || ""));
const isChecking = computed(() => state.value === "checking");
const isDownloading = computed(() => state.value === "downloading");
const isError = computed(() => state.value === "error" || Boolean(updateError.value));

const title = computed(() => {
  if (updateError.value) return "AI 组件更新失败";
  if (isChecking.value) return "正在检查 AI 组件";
  if (isDownloading.value) return "正在安装 AI 组件";
  if (condition.value === "appUpdateRequired") return "需要先升级黑猫";
  if (status.value.needsDirectory) return "需要设置 SVN 更新目录";
  if (condition.value === "needInstall") return "AI 组件尚未安装";
  return "AI 组件暂时不可用";
});

const detail = computed(() => {
  if (updateError.value) return updateError.value;
  if (isDownloading.value && progress.value.message) return progress.value.message;
  return status.value.message || "请检查更新目录后重试。";
});

const supportingText = computed(() => {
  if (updateError.value) return "现有 AI 组件仍可使用，数据库功能不受影响。";
  if (isDownloading.value) return "安装期间可以继续使用黑猫的其他功能。";
  if (condition.value === "appUpdateRequired") {
    return status.value.ready
      ? "升级前，现有 AI 和其他数据库功能仍可正常使用。"
      : "AI 暂时不可用；数据浏览、编辑和其他功能不受影响。";
  }
  if (status.value.needsDirectory) return "只需选择一次公司发布目录，后续会自动检查更新。";
  return "AI 组件只影响内置助手，不影响数据浏览和编辑。";
});

const progressStyle = computed(() => ({
  "--wb-ai-runtime-progress": `${Math.max(0, Math.min(100, Number(progress.value.percent || 0)))}%`,
}));

const versionLabel = computed(() => {
  const installed = status.value.installedVersion;
  const available = status.value.availableVersion;
  if (installed != null && available != null && installed !== available) {
    return `当前 v${installed} · 可更新至 v${available}`;
  }
  if (available != null) return `AI 组件 v${available}`;
  if (installed != null) return `当前 AI 组件 v${installed}`;
  return "";
});

const sizeLabel = computed(() => {
  const bytes = Number(status.value.size || progress.value.totalBytes || 0);
  if (!bytes) return "";
  return `约 ${(bytes / 1024 / 1024).toFixed(1)} MB`;
});

function retry() {
  void props.assistant.retryRuntime();
}

function pickDirectory() {
  void props.assistant.pickRuntimeDirectory();
}
</script>

<template>
  <article
    class="wb-ai-runtime-card"
    :class="{ 'is-error': isError, 'is-busy': isChecking || isDownloading }"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <div class="wb-ai-runtime-copy">
      <h2>{{ title }}</h2>
      <p>{{ detail }}</p>
      <p class="wb-ai-runtime-support">{{ supportingText }}</p>
    </div>

    <div
      v-if="isChecking || isDownloading"
      class="wb-ai-runtime-progress"
      :class="{ 'is-indeterminate': isChecking }"
      :style="progressStyle"
      role="progressbar"
      :aria-valuenow="isDownloading ? progress.percent : undefined"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="title"
    >
      <span></span>
    </div>

    <div v-if="versionLabel || sizeLabel" class="wb-ai-runtime-meta">
      <span v-if="versionLabel">{{ versionLabel }}</span>
      <span v-if="sizeLabel">{{ sizeLabel }}</span>
      <strong v-if="isDownloading">{{ progress.percent || 0 }}%</strong>
    </div>

    <div v-if="!isChecking && !isDownloading" class="wb-ai-runtime-actions">
      <button
        v-if="status.needsDirectory"
        type="button"
        class="wb-ai-btn wb-ai-btn-primary"
        @click="pickDirectory"
      >{{ t('m_bb43a7fced6e') }}</button>
      <button
        v-else-if="condition === 'appUpdateRequired'"
        type="button"
        class="wb-ai-btn wb-ai-btn-primary"
        @click="emit('open-update')"
      >{{ t('m_1bd44f164934') }}</button>
      <button v-else type="button" class="wb-ai-btn wb-ai-btn-primary" @click="retry">
        {{ condition === "needInstall" ? t('m_9cdf3ab9198f') : t('m_7f6a8bd54106') }}
      </button>
    </div>
  </article>
</template>
