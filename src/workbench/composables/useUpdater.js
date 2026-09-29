import { computed, ref, shallowRef } from "vue";

import { APP_VERSION } from "../appVersion.js";
import { t, translateIn } from "../i18n/index.js";
import { createTauriUpdaterAdapter } from "../utils/updaterAdapter.js";

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const zhCnTranslate = (key, parameters) => translateIn("zh-CN", key, parameters);

export function updateTitle(status, update = null, translate = zhCnTranslate) {
  if (status === "available" && update?.version) return translate("updater.title.available", { version: update.version });
  if (status === "agentAvailable" && update?.agentRuntimeUpdate?.version) {
    return translate("updater.title.agentAvailable", { version: update.agentRuntimeUpdate.version });
  }
  const known = ["idle", "checking", "downloading", "installed", "error", "unavailable"];
  return translate(`updater.title.${known.includes(status) ? status : "current"}`);
}

function messageFromError(error) {
  return String(error?.message || error || "未知错误");
}

export function useUpdater(initialAdapter = null) {
  const adapter = ref(initialAdapter);
  const status = ref("idle");
  const currentVersion = ref(initialAdapter?.currentVersion || APP_VERSION);
  const availableUpdate = shallowRef(null);
  const lastCheckResult = shallowRef(null);
  const agentRuntimeUpdate = shallowRef(null);
  const downloadedBytes = ref(0);
  const contentLength = ref(null);
  const lastCheckedAt = ref("");
  const errorMessage = ref("");
  const isDialogOpen = ref(false);
  const isNoticeVisible = ref(false);
  let adapterPromise = null;
  let backgroundUnlisten = null;
  let backgroundListenerRequested = false;

  const downloadPercent = computed(() => {
    if (!contentLength.value) return 0;
    return Math.min(100, Math.round((downloadedBytes.value / contentLength.value) * 100));
  });

  const isBusy = computed(() => status.value === "checking" || status.value === "downloading");
  const title = computed(() => updateTitle(status.value, availableUpdate.value || lastCheckResult.value, t));
  const canPickDirectory = computed(() => Boolean(adapter.value?.supportsDirectoryPicker));

  async function ensureAdapter() {
    if (!adapter.value) {
      adapterPromise ||= createTauriUpdaterAdapter();
      adapter.value = await adapterPromise;
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

  function closeNotice() {
    isNoticeVisible.value = false;
  }

  function applyAvailableUpdate(result) {
    currentVersion.value = result.currentVersion || currentVersion.value;
    availableUpdate.value = result;
    errorMessage.value = "";
    status.value = "available";
    isNoticeVisible.value = true;
  }

  function applyCheckResult(result) {
    lastCheckResult.value = result;
    agentRuntimeUpdate.value = result?.agentRuntimeUpdate || null;
    if (result?.available) {
      applyAvailableUpdate(result);
      return;
    }
    availableUpdate.value = null;
    errorMessage.value = "";
    if (result?.agentRuntimeUpdate?.available) {
      status.value = "agentAvailable";
      isNoticeVisible.value = true;
    } else {
      status.value = "current";
      isNoticeVisible.value = false;
    }
  }

  function markAgentRuntimeHandled(version) {
    if (Number(agentRuntimeUpdate.value?.version) !== Number(version)) return;
    agentRuntimeUpdate.value = {
      ...agentRuntimeUpdate.value,
      available: false,
    };
    if (lastCheckResult.value) {
      lastCheckResult.value = {
        ...lastCheckResult.value,
        agentRuntimeUpdate: agentRuntimeUpdate.value,
      };
    }
    if (status.value === "agentAvailable") {
      status.value = "current";
      isNoticeVisible.value = false;
    }
  }

  async function checkForUpdates({ openOnAvailable = false, openOnError = false, silent = false } = {}) {
    const updater = await ensureAdapter();
    const previousStatus = status.value;
    const previousError = errorMessage.value;
    if (!silent) {
      status.value = "checking";
      errorMessage.value = "";
    }

    try {
      const result = await updater.checkForUpdate();
      currentVersion.value = result.currentVersion || currentVersion.value;
      lastCheckedAt.value = new Date().toISOString();

      if (result.available || result.agentRuntimeUpdate?.available) {
        applyCheckResult(result);
        if (openOnAvailable) openDialog();
        return result;
      }

      if (result.needsDirectory) {
        if (silent) return result;
        availableUpdate.value = null;
        status.value = "unavailable";
        errorMessage.value = "请先选择公司 SVN 更新目录";
        if (openOnError) openDialog();
        return result;
      }

      if (result.unavailable) {
        if (silent) return result;
        status.value = "unavailable";
        errorMessage.value = result.message || "桌面 SVN 更新器不可用";
        if (openOnError) openDialog();
        return result;
      }

      availableUpdate.value = null;
      lastCheckResult.value = result;
      agentRuntimeUpdate.value = result.agentRuntimeUpdate || null;
      isNoticeVisible.value = false;
      status.value = "current";
      return result;
    } catch (error) {
      if (silent) {
        status.value = previousStatus;
        errorMessage.value = previousError;
        return null;
      }
      status.value = "error";
      errorMessage.value = messageFromError(error);
      if (openOnError) openDialog();
      return null;
    }
  }


  async function startBackgroundListener() {
    if (backgroundListenerRequested) return;
    backgroundListenerRequested = true;
    const updater = await ensureAdapter();
    const unlisten = await updater.subscribeToAvailableUpdates?.((result) => {
      if (result?.available || result?.agentRuntimeUpdate?.available) applyCheckResult(result);
    });
    if (!backgroundListenerRequested) {
      unlisten?.();
      return;
    }
    backgroundUnlisten = unlisten || null;
  }

  function stopBackgroundListener() {
    backgroundListenerRequested = false;
    backgroundUnlisten?.();
    backgroundUnlisten = null;
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
    isNoticeVisible.value = false;
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

  async function pickUpdateDirectory() {
    const updater = await ensureAdapter();
    try {
      const result = await updater.pickDirectory();
      if (result) {
        await checkForUpdates({ openOnAvailable: true, openOnError: true });
      }
      return result;
    } catch (error) {
      status.value = "error";
      errorMessage.value = messageFromError(error);
      openDialog();
      return null;
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
    lastCheckResult,
    agentRuntimeUpdate,
    downloadedBytes,
    contentLength,
    downloadPercent,
    lastCheckedAt,
    errorMessage,
    isDialogOpen,
    isNoticeVisible,
    isBusy,
    title,
    canPickDirectory,
    openDialog,
    closeDialog,
    closeNotice,
    markAgentRuntimeHandled,
    checkForUpdates,
    startBackgroundListener,
    stopBackgroundListener,
    downloadAndInstall,
    pickUpdateDirectory,
    relaunch,
  };
}
