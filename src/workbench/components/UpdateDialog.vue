<script setup>
import { language, t } from "../i18n/index.js";
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
  return new Date(props.updater.lastCheckedAt.value).toLocaleString(language.intlLocale.value);
});
const progressStyle = computed(() => ({
  "--wb-update-progress-width": hasKnownLength.value ? `${props.updater.downloadPercent.value}%` : "42%",
}));
</script>

<template>
  <div class="wb-dialog-overlay">
    <section ref="dialogRef" class="wb-dialog wb-update-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-update-title" tabindex="-1">
      <header class="wb-dialog-header">
        <strong id="wb-update-title">{{ t('m_64c230d22567') }}</strong>
        <button type="button" class="wb-dialog-close" :disabled="updater.isBusy.value" :title="updater.isBusy.value ? t('m_c1d284859a18') : t('m_3fd47edce45b')" :aria-label="t('m_c690cc3bf1bb')" @click="emit('close')">×</button>
      </header>

      <div class="wb-update-body">
        <p class="wb-update-version-line">
          <span>{{ t('m_837bc9576721') }}</span>
          <strong>{{ updater.currentVersion.value }}</strong>
        </p>

        <template v-if="hasAppUpdate">
          <p class="wb-update-version-line">
            <span>{{ t('m_c2a497830ef7') }}</span>
            <strong>{{ update?.version }}</strong>
          </p>
          <p v-if="update?.date" class="wb-update-meta">{{ t('m_fe0f0c2253fe') }}{{ new Date(update.date).toLocaleString(language.intlLocale.value) }}</p>
          <p v-if="update?.directory" class="wb-update-meta">{{ t('m_2243955f7737') }}{{ update.directory }}</p>
          <pre v-if="update?.body" class="wb-update-notes">{{ update.body }}</pre>
          <p v-else class="wb-update-meta">{{ t('m_658907c24641') }}</p>
        </template>

        <template v-else-if="updater.status.value === 'agentAvailable'">
          <p class="wb-update-meta">{{ t('m_d3dd537a700e') }}</p>
        </template>

        <template v-else-if="updater.status.value === 'downloading'">
          <p class="wb-update-meta">{{ t('m_fd8ab0ba832d') }}{{ downloadedLabel }}<template v-if="hasKnownLength"> / {{ totalLabel }}</template></p>
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

        <p v-else-if="updater.status.value === 'installed'" class="wb-update-meta">{{ t('m_82c2f4581914') }}</p>
        <p v-else-if="updater.status.value === 'checking'" class="wb-update-meta">{{ t('m_3cb89dcaff73') }}</p>
        <p v-else-if="updater.status.value === 'error'" class="wb-update-error">{{ updater.errorMessage.value }}</p>
        <p v-else-if="updater.status.value === 'unavailable'" class="wb-update-error">{{ updater.errorMessage.value }}</p>
        <p v-else class="wb-update-meta">{{ t('m_a2612ab21d0a') }}{{ checkedLabel }}</p>

        <p v-if="agentUpdate?.available" class="wb-update-agent-runtime"> {{ t('m_a7dc2f668bb0') }}{{ agentUpdate.version }}{{ t('m_0d8697e8c40f') }} {{ agentUpdateSize }}{{ t('m_69df77d7ed81') }} </p>
      </div>

      <footer class="wb-dialog-actions">
        <button type="button" :disabled="updater.isBusy.value" @click="emit('close')">{{ t('m_9d2ca261281a') }}</button>
        <button v-if="updater.canPickDirectory.value" type="button" :disabled="updater.isBusy.value" @click="emit('pickDirectory')">{{ t('m_61b24b2458f7') }}</button>
        <button v-if="hasAppUpdate" type="button" class="wb-update-primary" @click="emit('downloadAndInstall')">{{ t('m_7a6bafc9c853') }}</button>
        <button v-else-if="updater.status.value === 'agentAvailable'" type="button" class="wb-update-primary" @click="emit('close')">{{ t('m_de32e20193ad') }}</button>
        <button v-else-if="updater.status.value === 'installed'" type="button" class="wb-update-primary" @click="emit('relaunch')">{{ t('m_700b6c80d954') }}</button>
        <button v-else type="button" :disabled="updater.isBusy.value" @click="emit('check')">{{ t('m_c25fb86b1e96') }}</button>
      </footer>
    </section>
  </div>
</template>
