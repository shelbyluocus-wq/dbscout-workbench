import test from "node:test";
import assert from "node:assert/strict";

import { useUpdater, formatBytes, updateTitle } from "./composables/useUpdater.js";
import { createUpdaterAdapter } from "./utils/updaterAdapter.js";

function createAdapter({ result, installEvents = [], checkError = null, pickResult = null, subscribe = null } = {}) {
  return {
    isDesktop: true,
    supportsDirectoryPicker: true,
    currentVersion: "0.1.0",
    async checkForUpdate() {
      if (checkError) throw checkError;
      return result || { available: false, currentVersion: "0.1.0" };
    },
    async subscribeToAvailableUpdates(handler) {
      return subscribe?.(handler) || (() => {});
    },
    async pickDirectory() {
      return pickResult || { directory: "E:/updates" };
    },
    async downloadAndInstall(_update, onEvent) {
      for (const event of installEvents) onEvent(event);
    },
    async relaunch() {
      this.relaunched = true;
    },
  };
}

test("formatBytes renders compact byte labels", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
});

test("updateTitle describes visible SVN updater states", () => {
  assert.equal(updateTitle("idle"), "检查更新");
  assert.equal(updateTitle("checking"), "正在更新 SVN 目录");
  assert.equal(updateTitle("available", { version: "0.2.0" }), "发现新版本 0.2.0");
  assert.equal(updateTitle("downloading"), "正在启动安装包");
  assert.equal(updateTitle("current"), "已是最新版本");
});

test("checkForUpdates moves to current when no update exists", async () => {
  const updater = useUpdater(createAdapter());

  await updater.checkForUpdates();

  assert.equal(updater.status.value, "current");
  assert.equal(updater.currentVersion.value, "0.1.0");
  assert.equal(updater.availableUpdate.value, null);
  assert.ok(updater.lastCheckedAt.value);
});

test("checkForUpdates reports SVN updater unavailable in browser mode", async () => {
  const updater = useUpdater({
    isDesktop: false,
    currentVersion: "0.1.0",
    async checkForUpdate() {
      return {
        available: false,
        currentVersion: "0.1.0",
        unavailable: true,
        message: "桌面 SVN 更新器不可用",
      };
    },
  });

  await updater.checkForUpdates({ openOnError: true });

  assert.equal(updater.status.value, "unavailable");
  assert.equal(updater.errorMessage.value, "桌面 SVN 更新器不可用");
  assert.equal(updater.isDialogOpen.value, true);
});

test("checkForUpdates asks for SVN directory when none is configured", async () => {
  const updater = useUpdater(createAdapter({
    result: {
      available: false,
      currentVersion: "0.1.0",
      needsDirectory: true,
    },
  }));

  await updater.checkForUpdates({ openOnError: true });

  assert.equal(updater.status.value, "unavailable");
  assert.equal(updater.errorMessage.value, "请先选择公司 SVN 更新目录");
  assert.equal(updater.isDialogOpen.value, true);
});

test("checkForUpdates records available update and opens dialog when requested", async () => {
  const updater = useUpdater(createAdapter({
    result: {
      available: true,
      version: "0.2.0",
      currentVersion: "0.1.0",
      body: "Release notes",
      date: "2026-06-28T12:00:00Z",
      installerPath: "E:/updates/blackcat_0.2.0_x64-setup.exe",
    },
  }));

  await updater.checkForUpdates({ openOnAvailable: true });

  assert.equal(updater.status.value, "available");
  assert.equal(updater.availableUpdate.value.version, "0.2.0");
  assert.equal(updater.availableUpdate.value.installerPath, "E:/updates/blackcat_0.2.0_x64-setup.exe");
  assert.equal(updater.isDialogOpen.value, true);
});

test("install progress tracks synthetic events and install completion", async () => {
  const updater = useUpdater(createAdapter({
    result: {
      available: true,
      version: "0.2.0",
      currentVersion: "0.1.0",
      installerPath: "E:/updates/blackcat_0.2.0_x64-setup.exe",
    },
    installEvents: [
      { event: "Started", data: { contentLength: 100 } },
      { event: "Progress", data: { chunkLength: 25 } },
      { event: "Progress", data: { chunkLength: 75 } },
      { event: "Finished" },
    ],
  }));

  await updater.checkForUpdates();
  await updater.downloadAndInstall();

  assert.equal(updater.status.value, "installed");
  assert.equal(updater.downloadedBytes.value, 100);
  assert.equal(updater.contentLength.value, 100);
  assert.equal(updater.downloadPercent.value, 100);
});

test("downloadAndInstall delegates to SVN adapter install function", async () => {
  const installed = [];
  const updater = useUpdater(createUpdaterAdapter({
    currentVersion: "0.1.0",
    check: async () => ({
      available: true,
      version: "0.2.0",
      currentVersion: "0.1.0",
      installerPath: "E:/updates/blackcat_0.2.0_x64-setup.exe",
    }),
    install: async (installerPath) => installed.push(installerPath),
    relaunch: async () => {},
  }));

  await updater.checkForUpdates();
  const didInstall = await updater.downloadAndInstall();

  assert.equal(didInstall, true);
  assert.deepEqual(installed, ["E:/updates/blackcat_0.2.0_x64-setup.exe"]);
  assert.equal(updater.status.value, "installed");
  assert.equal(updater.downloadPercent.value, 100);
});

test("manual check errors open the dialog and keep previous update metadata", async () => {
  const updater = useUpdater(createAdapter({
    result: {
      available: true,
      version: "0.2.0",
      currentVersion: "0.1.0",
      installerPath: "E:/updates/blackcat_0.2.0_x64-setup.exe",
    },
  }));
  await updater.checkForUpdates();
  updater.adapter.value = createAdapter({ checkError: new Error("svn conflict") });

  await updater.checkForUpdates({ openOnError: true });

  assert.equal(updater.status.value, "error");
  assert.equal(updater.errorMessage.value, "svn conflict");
  assert.equal(updater.availableUpdate.value.version, "0.2.0");
  assert.equal(updater.isDialogOpen.value, true);
});

test("silent startup errors leave the visible updater state unchanged", async () => {
  const updater = useUpdater(createAdapter({ checkError: new Error("working copy locked") }));

  await updater.checkForUpdates({ silent: true });

  assert.equal(updater.status.value, "idle");
  assert.equal(updater.errorMessage.value, "");
  assert.equal(updater.isDialogOpen.value, false);
  assert.equal(updater.isNoticeVisible.value, false);
});

test("each background detection shows the persistent update notice again", async () => {
  let backgroundHandler = null;
  let unlistenCalls = 0;
  const updater = useUpdater(createAdapter({
    subscribe(handler) {
      backgroundHandler = handler;
      return () => {
        unlistenCalls += 1;
      };
    },
  }));

  await updater.startBackgroundListener();
  backgroundHandler({
    available: true,
    version: "0.2.0",
    currentVersion: "0.1.0",
    installerPath: "E:/updates/blackcat_0.2.0_x64-setup.exe",
  });
  assert.equal(updater.isNoticeVisible.value, true);

  updater.closeNotice();
  assert.equal(updater.isNoticeVisible.value, false);

  backgroundHandler({
    available: true,
    version: "0.2.0",
    currentVersion: "0.1.0",
    installerPath: "E:/updates/blackcat_0.2.0_x64-setup.exe",
  });
  assert.equal(updater.isNoticeVisible.value, true);

  updater.stopBackgroundListener();
  assert.equal(unlistenCalls, 1);
});

test("pickUpdateDirectory rechecks after the user selects a folder", async () => {
  let checks = 0;
  const updater = useUpdater({
    isDesktop: true,
    supportsDirectoryPicker: true,
    currentVersion: "0.1.0",
    async checkForUpdate() {
      checks += 1;
      return checks === 1
        ? { available: false, currentVersion: "0.1.0", needsDirectory: true }
        : {
            available: true,
            version: "0.2.0",
            currentVersion: "0.1.0",
            installerPath: "E:/updates/blackcat_0.2.0_x64-setup.exe",
          };
    },
    async pickDirectory() {
      return { directory: "E:/updates" };
    },
  });

  await updater.checkForUpdates({ openOnError: true });
  await updater.pickUpdateDirectory();

  assert.equal(updater.status.value, "available");
  assert.equal(updater.availableUpdate.value.version, "0.2.0");
  assert.equal(checks, 2);
});
