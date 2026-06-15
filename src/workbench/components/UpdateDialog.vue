<script setup>
import { computed } from "vue";

import { formatBytes } from "../composables/useUpdater.js";

const props = defineProps({
  updater: {
    type: Object,
    required: true,
  },
});

const emit = defineEmits(["close", "check", "downloadAndInstall", "relaunch"]);

const update = computed(() => props.updater.availableUpdate.value);
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
  <div class="wb-dialog-overlay" @click.self="emit('close')">
    <section class="wb-dialog wb-update-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-update-title">
      <header class="wb-dialog-header">
        <strong id="wb-update-title">应用更新</strong>
        <button type="button" class="wb-dialog-close" aria-label="关闭更新窗口" @click="emit('close')">×</button>
      </header>

      <div class="wb-update-body">
        <p class="wb-update-version-line">
          <span>当前版本</span>
          <strong>{{ updater.currentVersion.value }}</strong>
        </p>

        <template v-if="updater.status.value === 'available'">
          <p class="wb-update-version-line">
            <span>最新版本</span>
            <strong>{{ update?.version }}</strong>
          </p>
          <p v-if="update?.date" class="wb-update-meta">发布时间：{{ new Date(update.date).toLocaleString("zh-CN") }}</p>
          <pre v-if="update?.body" class="wb-update-notes">{{ update.body }}</pre>
          <p v-else class="wb-update-meta">此版本没有填写更新说明。</p>
        </template>

        <template v-else-if="updater.status.value === 'downloading'">
          <p class="wb-update-meta">正在下载更新：{{ downloadedLabel }}<template v-if="hasKnownLength"> / {{ totalLabel }}</template></p>
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

        <p v-else-if="updater.status.value === 'installed'" class="wb-update-meta">更新已安装，重启后生效。</p>
        <p v-else-if="updater.status.value === 'checking'" class="wb-update-meta">正在检查 Gitee 更新源…</p>
        <p v-else-if="updater.status.value === 'error'" class="wb-update-error">{{ updater.errorMessage.value }}</p>
        <p v-else-if="updater.status.value === 'unavailable'" class="wb-update-error">{{ updater.errorMessage.value }}</p>
        <p v-else class="wb-update-meta">已是最新版本。上次检查：{{ checkedLabel }}</p>
      </div>

      <footer class="wb-dialog-actions">
        <button type="button" @click="emit('close')">稍后</button>
        <button v-if="updater.status.value === 'available'" type="button" class="wb-update-primary" @click="emit('downloadAndInstall')">下载并安装</button>
        <button v-else-if="updater.status.value === 'installed'" type="button" class="wb-update-primary" @click="emit('relaunch')">立即重启</button>
        <button v-else type="button" :disabled="updater.isBusy.value" @click="emit('check')">重新检查</button>
      </footer>
    </section>
  </div>
</template>
