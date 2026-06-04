import { APP_VERSION } from "../appVersion.js";

export function normalizeUpdate(update, currentVersion = APP_VERSION) {
  if (!update) {
    return {
      available: false,
      currentVersion,
    };
  }

  return {
    available: true,
    version: update.version,
    currentVersion: update.currentVersion || currentVersion,
    date: update.date || null,
    body: update.body || "",
    rawUpdate: update,
  };
}

export function createBrowserUpdaterAdapter(message = "桌面更新器不可用") {
  return {
    isDesktop: false,
    currentVersion: APP_VERSION,
    async checkForUpdate() {
      return {
        available: false,
        currentVersion: APP_VERSION,
        unavailable: true,
        message,
      };
    },
    async downloadAndInstall() {
      throw new Error(message);
    },
    async relaunch() {
      throw new Error("桌面重启不可用");
    },
  };
}

export function createUpdaterAdapter({
  check,
  relaunch,
  currentVersion = APP_VERSION,
} = {}) {
  if (typeof check !== "function" || typeof relaunch !== "function") {
    return createBrowserUpdaterAdapter();
  }

  return {
    isDesktop: true,
    currentVersion,
    async checkForUpdate() {
      return normalizeUpdate(await check(), currentVersion);
    },
    async downloadAndInstall(update, onEvent) {
      if (!update?.rawUpdate?.downloadAndInstall) {
        throw new Error("没有可安装的更新");
      }
      await update.rawUpdate.downloadAndInstall(onEvent);
    },
    async relaunch() {
      await relaunch();
    },
  };
}

export async function createTauriUpdaterAdapter() {
  if (!globalThis.__TAURI_INTERNALS__) {
    return createBrowserUpdaterAdapter();
  }

  try {
    const [{ check }, { relaunch }] = await Promise.all([
      import("@tauri-apps/plugin-updater"),
      import("@tauri-apps/plugin-process"),
    ]);
    return createUpdaterAdapter({ check, relaunch });
  } catch (error) {
    return createBrowserUpdaterAdapter(`加载桌面更新器失败：${String(error)}`);
  }
}
