import { APP_VERSION } from "../appVersion.js";

const BROWSER_UPDATER_MESSAGE = "桌面 SVN 更新器不可用";

export function normalizeUpdate(update, currentVersion = APP_VERSION) {
  if (!update) {
    return {
      available: false,
      currentVersion,
    };
  }

  return {
    available: Boolean(update.available),
    version: update.version || null,
    currentVersion: update.currentVersion || currentVersion,
    date: update.date || null,
    body: update.body || "",
    installerPath: update.installerPath || null,
    directory: update.directory || null,
    needsDirectory: Boolean(update.needsDirectory),
    unavailable: Boolean(update.unavailable),
    message: update.message || "",
    rawUpdate: update,
  };
}

export function createBrowserUpdaterAdapter(message = BROWSER_UPDATER_MESSAGE) {
  return {
    isDesktop: false,
    currentVersion: APP_VERSION,
    supportsDirectoryPicker: false,
    async checkForUpdate() {
      return {
        available: false,
        currentVersion: APP_VERSION,
        unavailable: true,
        message,
      };
    },
    async pickDirectory() {
      throw new Error(message);
    },
    async downloadAndInstall() {
      throw new Error(message);
    },
    async openDirectory() {
      throw new Error(message);
    },
    async relaunch() {
      throw new Error("桌面重启不可用");
    },
  };
}

export function createUpdaterAdapter({
  check,
  pickDirectory,
  install,
  openDirectory,
  relaunch,
  currentVersion = APP_VERSION,
} = {}) {
  if (typeof check !== "function" || typeof relaunch !== "function") {
    return createBrowserUpdaterAdapter();
  }

  return {
    isDesktop: true,
    currentVersion,
    supportsDirectoryPicker: typeof pickDirectory === "function",
    async checkForUpdate() {
      return normalizeUpdate(await check(), currentVersion);
    },
    async pickDirectory() {
      if (typeof pickDirectory !== "function") {
        throw new Error("当前版本不能选择 SVN 更新目录");
      }
      return pickDirectory();
    },
    async downloadAndInstall(update, onEvent) {
      if (!update?.installerPath && !update?.rawUpdate?.installerPath) {
        throw new Error("没有可安装的更新");
      }
      if (typeof install !== "function") {
        throw new Error("当前版本不能启动安装包");
      }
      onEvent?.({ event: "Started", data: { contentLength: 1 } });
      await install(update.installerPath || update.rawUpdate.installerPath);
      onEvent?.({ event: "Progress", data: { chunkLength: 1 } });
      onEvent?.({ event: "Finished" });
    },
    async openDirectory(path) {
      if (typeof openDirectory !== "function") return;
      await openDirectory(path);
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
    const [{ invoke }, { relaunch }] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/plugin-process"),
    ]);
    return createUpdaterAdapter({
      check: () => invoke("svn_update_check"),
      pickDirectory: () => invoke("svn_update_pick_directory"),
      install: (installerPath) => invoke("svn_update_install", { installerPath }),
      openDirectory: (path) => invoke("svn_update_open_directory", { path }),
      relaunch,
    });
  } catch (error) {
    return createBrowserUpdaterAdapter(`加载桌面 SVN 更新器失败: ${String(error)}`);
  }
}
