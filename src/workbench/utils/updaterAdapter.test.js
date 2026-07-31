import test from "node:test";
import assert from "node:assert/strict";

import {
  createBrowserUpdaterAdapter,
  createUpdaterAdapter,
  normalizeUpdate,
} from "./updaterAdapter.js";

test("browser updater adapter reports desktop SVN updater unavailable", async () => {
  const adapter = createBrowserUpdaterAdapter("not in Tauri");

  const result = await adapter.checkForUpdate();

  assert.equal(adapter.isDesktop, false);
  assert.equal(adapter.supportsDirectoryPicker, false);
  assert.equal(result.available, false);
  assert.equal(result.unavailable, true);
  assert.equal(result.message, "not in Tauri");
});

test("normalizes no-update responses with the current version", () => {
  assert.deepEqual(normalizeUpdate(null, "0.1.0"), {
    available: false,
    currentVersion: "0.1.0",
  });
});

test("normalizes SVN update metadata returned by Tauri commands", () => {
  const raw = {
    available: true,
    version: "0.2.0",
    currentVersion: "0.1.0",
    date: "2026-06-28T12:00:00Z",
    body: "Release notes",
    installerPath: "E:/updates/blackcat_0.2.0_x64-setup.exe",
    directory: "E:/updates",
    needsDirectory: false,
  };

  const result = normalizeUpdate(raw, "0.1.0");

  assert.equal(result.available, true);
  assert.equal(result.version, "0.2.0");
  assert.equal(result.currentVersion, "0.1.0");
  assert.equal(result.date, "2026-06-28T12:00:00Z");
  assert.equal(result.body, "Release notes");
  assert.equal(result.installerPath, "E:/updates/blackcat_0.2.0_x64-setup.exe");
  assert.equal(result.directory, "E:/updates");
  assert.equal(result.rawUpdate, raw);
});

test("normalizes an independently versioned AI runtime update", () => {
  const raw = {
    available: false,
    currentVersion: "0.1.0",
    agentRuntimeUpdate: {
      available: true,
      version: 7,
      size: 128 * 1024 * 1024,
    },
  };

  const result = normalizeUpdate(raw, "0.1.0");

  assert.deepEqual(result.agentRuntimeUpdate, {
    available: true,
    version: 7,
    size: 128 * 1024 * 1024,
  });
});

test("adapter delegates checks, folder selection, install, folder open, and relaunch", async () => {
  const events = [];
  const calls = [];
  let relaunched = false;
  const adapter = createUpdaterAdapter({
    currentVersion: "0.1.0",
    check: async () => ({
      available: true,
      version: "0.2.0",
      currentVersion: "0.1.0",
      installerPath: "E:/updates/blackcat_0.2.0_x64-setup.exe",
    }),
    pickDirectory: async () => ({ directory: "E:/updates" }),
    install: async (installerPath) => calls.push(["install", installerPath]),
    openDirectory: async (directory) => calls.push(["open", directory]),
    relaunch: async () => {
      relaunched = true;
    },
  });

  const update = await adapter.checkForUpdate();
  const picked = await adapter.pickDirectory();
  await adapter.downloadAndInstall(update, (event) => events.push(event.event));
  await adapter.openDirectory("E:/updates");
  await adapter.relaunch();

  assert.equal(adapter.isDesktop, true);
  assert.equal(adapter.supportsDirectoryPicker, true);
  assert.equal(update.version, "0.2.0");
  assert.equal(picked.directory, "E:/updates");
  assert.deepEqual(events, ["Started", "Progress", "Finished"]);
  assert.deepEqual(calls, [
    ["install", "E:/updates/blackcat_0.2.0_x64-setup.exe"],
    ["open", "E:/updates"],
  ]);
  assert.equal(relaunched, true);
});

test("adapter normalizes background update events", async () => {
  let emitUpdate = null;
  let stopped = false;
  const adapter = createUpdaterAdapter({
    currentVersion: "0.1.0",
    check: async () => ({ available: false, currentVersion: "0.1.0" }),
    subscribe(handler) {
      emitUpdate = handler;
      return () => {
        stopped = true;
      };
    },
    relaunch: async () => {},
  });
  let received = null;

  const unlisten = await adapter.subscribeToAvailableUpdates((update) => {
    received = update;
  });
  emitUpdate({ available: true, version: "0.2.0", installerPath: "E:/navicat/blackcat.exe" });

  assert.equal(received.available, true);
  assert.equal(received.version, "0.2.0");
  assert.equal(received.currentVersion, "0.1.0");
  unlisten();
  assert.equal(stopped, true);
});
