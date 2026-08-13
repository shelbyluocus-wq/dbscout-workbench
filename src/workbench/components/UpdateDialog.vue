<script setup>
import { computed, ref } from "vue";

import { formatBytes } from "../composables/useUpdater.js";
import { useEscClose } from "../composables/useEscClose.js";

const props = defineProps({
  updater: {
    type: Object,
    required: true,
  },
});

const emit = defineEmits(["close", "check", "downloadAndInstall", "pickDirectory", "relaunch"]);

// 检查或启动安装包时不要用 Esc 关闭窗口，避免丢失当前状态。
const dialogRef = ref(null);
useEscClose(() => true, () => emit("close"), () => props.updater.isBusy.value, { dialogRef });

const update = computed(() => props.updater.availableUpdate.value);
const agentUpdate = computed(() => props.updater.agentRuntimeUpdate.value);
const hasAppUpdate = computed(() => props.updater.status.value === "available");
const agentUpdateSize = computed(() => formatBytes(agentUpdate.value?.size || 0));
const hasKnownLength = computed(() => Number(props.updater.contentLength.value) > 0);
const downloadedLabel = computed(() => formatBytes(props.updater.downloadedBytes.value));
const totalLabel = computed(() => formatBytes(props.updater.contentLength.value));
const checkedLabel = computed(() => {
  if (!props.updater.lastCheckedAt.value) return "尚未检查";
  return new Date(props.updater.lastCheckedAt.value).toLocaleString("zh-CN");
});
const progressStyle = computed(() => ({
  "--wb-update-progress-width": hasKnownLength.value ? `${props.updater.downloadPercent.value}%` : "42%",
}));
</script>

<template>
  <div class="wb-dialog-overlay">
    <section ref="dialogRef" class="wb-dialog wb-update-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-update-title" tabindex="-1">
      <header class="wb-dialog-header">
        <strong id="wb-update-title">应用更新</strong>
        <button type="button" class="wb-dialog-close" :disabled="updater.isBusy.value" :title="updater.isBusy.value ? '更新检查中，请等待完成' : '关闭'" aria-label="关闭更新窗口" @click="emit('close')">×</button>
      </header>

      <div class="wb-update-body">
        <p class="wb-update-version-line">
          <span>当前版本</span>
          <strong>{{ updater.currentVersion.value }}</strong>
        </p>

        <template v-if="hasAppUpdate">
          <p class="wb-update-version-line">
            <span>最新版本</span>
            <strong>{{ update?.version }}</strong>
          </p>
          <p v-if="update?.date" class="wb-update-meta">发布时间：{{ new Date(update.date).toLocaleString("zh-CN") }}</p>
          <p v-if="update?.directory" class="wb-update-meta">SVN 更新目录：{{ update.directory }}</p>
          <pre v-if="update?.body" class="wb-update-notes">{{ update.body }}</pre>
          <p v-else class="wb-update-meta">此版本没有填写更新说明。</p>
        </template>

        <template v-else-if="updater.status.value === 'agentAvailable'">
          <p class="wb-update-meta">主程序已经是最新版本。AI 组件可独立更新，不需要重新安装黑猫。</p>
        </template>

        <template v-else-if="updater.status.value === 'downloading'">
          <p class="wb-update-meta">正在启动本地安装包：{{ downloadedLabel }}<template v-if="hasKnownLength"> / {{ totalLabel }}</template></p>
          <div
            class="wb-update-progress"
            :class="{ 'is-indeterminate': !hasKnownLength }"
            role="progressbar"
            :aria-valuenow="hasKnownLength ? updater.downloadPercent.value : undefined"
            aria-valuemin="0"
            aria-valuemax="100"
            :style="progressStyle"
          >
            <span class="wb-update-progress-fill"></span>
          </div>
        </template>

        <p v-else-if="updater.status.value === 'installed'" class="wb-update-meta">安装包已启动。安装完成后可以重启应用。</p>
        <p v-else-if="updater.status.value === 'checking'" class="wb-update-meta">正在更新 SVN 目录并检查版本……</p>
        <p v-else-if="updater.status.value === 'error'" class="wb-update-error">{{ updater.errorMessage.value }}</p>
        <p v-else-if="updater.status.value === 'unavailable'" class="wb-update-error">{{ updater.errorMessage.value }}</p>
        <p v-else class="wb-update-meta">已是最新版本。上次检查：{{ checkedLabel }}</p>

        <p v-if="agentUpdate?.available" class="wb-update-agent-runtime">
          本次包含 AI 组件更新 v{{ agentUpdate.version }}（约 {{ agentUpdateSize }}）。更新会在后台完成，不影响数据库功能。
        </p>
      </div>

      <footer class="wb-dialog-actions">
        <button type="button" :disabled="updater.isBusy.value" @click="emit('close')">稍后</button>
        <button v-if="updater.canPickDirectory.value" type="button" :disabled="updater.isBusy.value" @click="emit('pickDirectory')">选择 SVN 更新目录</button>
        <button v-if="hasAppUpdate" type="button" class="wb-update-primary" @click="emit('downloadAndInstall')">安装更新</button>
        <button v-else-if="updater.status.value === 'agentAvailable'" type="button" class="wb-update-primary" @click="emit('close')">知道了</button>
        <button v-else-if="updater.status.value === 'installed'" type="button" class="wb-update-primary" @click="emit('relaunch')">立即重启</button>
        <button v-else type="button" :disabled="updater.isBusy.value" @click="emit('check')">重新检查</button>
      </footer>
    </section>
  </div>
</template>
