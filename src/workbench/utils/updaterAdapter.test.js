import test from "node:test";
import assert from "node:assert/strict";

import {
  createBrowserUpdaterAdapter,
  createUpdaterAdapter,
  normalizeUpdate,
} from "./updaterAdapter.js";

test("browser updater adapter reports desktop updater unavailable", async () => {
  const adapter = createBrowserUpdaterAdapter("not in Tauri");

  const result = await adapter.checkForUpdate();

  assert.equal(adapter.isDesktop, false);
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

test("normalizes update metadata returned by Tauri", () => {
  const raw = {
    version: "0.2.0",
    currentVersion: "0.1.0",
    date: "2026-06-04T12:00:00Z",
    body: "Release notes",
    downloadAndInstall() {},
  };

  const result = normalizeUpdate(raw, "0.1.0");

  assert.equal(result.available, true);
  assert.equal(result.version, "0.2.0");
  assert.equal(result.currentVersion, "0.1.0");
  assert.equal(result.date, "2026-06-04T12:00:00Z");
  assert.equal(result.body, "Release notes");
  assert.equal(result.rawUpdate, raw);
});

test("adapter delegates checks and installs to injected Tauri functions", async () => {
  const events = [];
  const rawUpdate = {
    version: "0.2.0",
    currentVersion: "0.1.0",
    async downloadAndInstall(onEvent) {
      onEvent({ event: "Started", data: { contentLength: 10 } });
      onEvent({ event: "Progress", data: { chunkLength: 10 } });
      onEvent({ event: "Finished" });
    },
  };
  let relaunched = false;
  const adapter = createUpdaterAdapter({
    currentVersion: "0.1.0",
    check: async () => rawUpdate,
    relaunch: async () => {
      relaunched = true;
    },
  });

  const update = await adapter.checkForUpdate();
  await adapter.downloadAndInstall(update, (event) => events.push(event.event));
  await adapter.relaunch();

  assert.equal(adapter.isDesktop, true);
  assert.equal(update.version, "0.2.0");
  assert.deepEqual(events, ["Started", "Progress", "Finished"]);
  assert.equal(relaunched, true);
});
