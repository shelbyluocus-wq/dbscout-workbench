import { computed, ref, shallowRef } from "vue";

import { APP_VERSION } from "../appVersion.js";
import { createTauriUpdaterAdapter } from "../utils/updaterAdapter.js";

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function updateTitle(status, update = null) {
  if (status === "idle") return "检查更新";
  if (status === "checking") return "正在检查更新";
  if (status === "available" && update?.version) return `发现新版本 ${update.version}`;
  if (status === "downloading") return "正在下载更新";
  if (status === "installed") return "更新已安装";
  if (status === "error") return "更新检查失败";
  if (status === "unavailable") return "桌面更新器不可用";
  return "已是最新版本";
}

function messageFromError(error) {
  const message = String(error?.message || error || "未知错误");
  if (/valid release JSON/i.test(message)) {
    return "Gitee 更新源还没有发布有效的 latest.json，这不是“没有新版本”。请先按发布清单上传 latest.json。";
  }
  return message;
}

export function useUpdater(initialAdapter = null) {
  const adapter = ref(initialAdapter);
  const status = ref("idle");
  const currentVersion = ref(initialAdapter?.currentVersion || APP_VERSION);
  const availableUpdate = shallowRef(null);
  const downloadedBytes = ref(0);
  const contentLength = ref(null);
  const lastCheckedAt = ref("");
  const errorMessage = ref("");
  const isDialogOpen = ref(false);

  const downloadPercent = computed(() => {
    if (!contentLength.value) return 0;
    return Math.min(100, Math.round((downloadedBytes.value / contentLength.value) * 100));
  });

  const isBusy = computed(() => status.value === "checking" || status.value === "downloading");
  const title = computed(() => updateTitle(status.value, availableUpdate.value));

  async function ensureAdapter() {
    if (!adapter.value) {
      adapter.value = await createTauriUpdaterAdapter();
      currentVersion.value = adapter.value.currentVersion || currentVersion.value;
    }
    return adapter.value;
  }

  function openDialog() {
    isDialogOpen.value = true;
  }

  function closeDialog() {
    isDialogOpen.value = false;
  }

  async function checkForUpdates({ openOnAvailable = false, openOnError = false } = {}) {
    const updater = await ensureAdapter();
    status.value = "checking";
    errorMessage.value = "";

    try {
      const result = await updater.checkForUpdate();
      currentVersion.value = result.currentVersion || currentVersion.value;
      lastCheckedAt.value = new Date().toISOString();

      if (result.available) {
        availableUpdate.value = result;
        status.value = "available";
        if (openOnAvailable) openDialog();
        return result;
      }

      if (result.unavailable) {
        status.value = "unavailable";
        errorMessage.value = result.message || "桌面更新器不可用";
        if (openOnError) openDialog();
        return result;
      }

      availableUpdate.value = null;
      status.value = "current";
      return result;
    } catch (error) {
      status.value = "error";
      errorMessage.value = messageFromError(error);
      if (openOnError) openDialog();
      return null;
    }
  }

  function handleDownloadEvent(event) {
    const data = event?.data || {};
    if (event?.event === "Started") {
      contentLength.value = Number(data.contentLength) || null;
      downloadedBytes.value = 0;
      return;
    }
    if (event?.event === "Progress") {
      downloadedBytes.value += Number(data.chunkLength) || 0;
      return;
    }
    if (event?.event === "Finished" && contentLength.value) {
      downloadedBytes.value = contentLength.value;
    }
  }

  async function downloadAndInstall() {
    if (!availableUpdate.value) {
      errorMessage.value = "没有可安装的更新";
      status.value = "error";
      openDialog();
      return false;
    }

    const updater = await ensureAdapter();
    status.value = "downloading";
    errorMessage.value = "";
    downloadedBytes.value = 0;
    contentLength.value = null;

    try {
      await updater.downloadAndInstall(availableUpdate.value, handleDownloadEvent);
      status.value = "installed";
      openDialog();
      return true;
    } catch (error) {
      status.value = "error";
      errorMessage.value = messageFromError(error);
      openDialog();
      return false;
    }
  }

  async function relaunch() {
    const updater = await ensureAdapter();
    try {
      await updater.relaunch();
      return true;
    } catch (error) {
      status.value = "error";
      errorMessage.value = messageFromError(error);
      openDialog();
      return false;
    }
  }

  return {
    adapter,
    status,
    currentVersion,
    availableUpdate,
    downloadedBytes,
    contentLength,
    downloadPercent,
    lastCheckedAt,
    errorMessage,
    isDialogOpen,
    isBusy,
    title,
    openDialog,
    closeDialog,
    checkForUpdates,
    downloadAndInstall,
    relaunch,
  };
}
