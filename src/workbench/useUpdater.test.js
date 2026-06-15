import test from "node:test";
import assert from "node:assert/strict";

import { useUpdater, formatBytes, updateTitle } from "./composables/useUpdater.js";
import { createUpdaterAdapter } from "./utils/updaterAdapter.js";

function createAdapter({ result, installEvents = [], checkError = null } = {}) {
  return {
    isDesktop: true,
    currentVersion: "0.1.0",
    async checkForUpdate() {
      if (checkError) throw checkError;
      return result || { available: false, currentVersion: "0.1.0" };
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

test("updateTitle describes visible updater states", () => {
  assert.equal(updateTitle("idle"), "检查更新");
  assert.equal(updateTitle("checking"), "正在检查更新");
  assert.equal(updateTitle("available", { version: "0.2.0" }), "发现新版本 0.2.0");
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

test("checkForUpdates reports desktop updater unavailable in browser mode", async () => {
  const updater = useUpdater({
    isDesktop: false,
    currentVersion: "0.1.0",
    async checkForUpdate() {
      return {
        available: false,
        currentVersion: "0.1.0",
        unavailable: true,
        message: "桌面更新器不可用",
      };
    },
  });

  await updater.checkForUpdates({ openOnError: true });

  assert.equal(updater.status.value, "unavailable");
  assert.equal(updater.errorMessage.value, "桌面更新器不可用");
  assert.equal(updater.isDialogOpen.value, true);
});

test("checkForUpdates records available update and opens dialog when requested", async () => {
  const updater = useUpdater(createAdapter({
    result: {
      available: true,
      version: "0.2.0",
      currentVersion: "0.1.0",
      body: "Release notes",
      date: "2026-06-04T12:00:00Z",
      rawUpdate: { downloadAndInstall() {} },
    },
  }));

  await updater.checkForUpdates({ openOnAvailable: true });

  assert.equal(updater.status.value, "available");
  assert.equal(updater.availableUpdate.value.version, "0.2.0");
  assert.equal(updater.isDialogOpen.value, true);
});

test("download progress tracks content length and install completion", async () => {
  const updater = useUpdater(createAdapter({
    result: {
      available: true,
      version: "0.2.0",
      currentVersion: "0.1.0",
      rawUpdate: { downloadAndInstall() {} },
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

test("downloadAndInstall preserves Tauri update instances with private fields", async () => {
  class PrivateFieldUpdate {
    #installed = false;

    constructor() {
      this.version = "0.2.0";
      this.currentVersion = "0.1.0";
    }

    async downloadAndInstall(onEvent) {
      this.#installed = true;
      onEvent({ event: "Started", data: { contentLength: 1 } });
      onEvent({ event: "Progress", data: { chunkLength: 1 } });
      onEvent({ event: "Finished" });
    }

    get installed() {
      return this.#installed;
    }
  }

  const rawUpdate = new PrivateFieldUpdate();
  const updater = useUpdater(createUpdaterAdapter({
    currentVersion: "0.1.0",
    check: async () => rawUpdate,
    relaunch: async () => {},
  }));

  await updater.checkForUpdates();
  const didInstall = await updater.downloadAndInstall();

  assert.equal(didInstall, true);
  assert.equal(rawUpdate.installed, true);
  assert.equal(updater.status.value, "installed");
  assert.equal(updater.downloadPercent.value, 100);
});

test("manual check errors open the dialog and keep previous update metadata", async () => {
  const updater = useUpdater(createAdapter({
    result: {
      available: true,
      version: "0.2.0",
      currentVersion: "0.1.0",
      rawUpdate: { downloadAndInstall() {} },
    },
  }));
  await updater.checkForUpdates();
  updater.adapter.value = createAdapter({ checkError: new Error("network down") });

  await updater.checkForUpdates({ openOnError: true });

  assert.equal(updater.status.value, "error");
  assert.equal(updater.errorMessage.value, "network down");
  assert.equal(updater.availableUpdate.value.version, "0.2.0");
  assert.equal(updater.isDialogOpen.value, true);
});

test("manual check explains invalid remote release JSON as missing update manifest", async () => {
  const updater = useUpdater(createAdapter({
    checkError: new Error("Could not fetch a valid release JSON from the remote"),
  }));

  await updater.checkForUpdates({ openOnError: true });

  assert.equal(updater.status.value, "error");
  assert.equal(
    updater.errorMessage.value,
    "Gitee 更新源还没有发布有效的 latest.json，这不是“没有新版本”。请先按发布清单上传 latest.json。",
  );
  assert.equal(updater.isDialogOpen.value, true);
});
