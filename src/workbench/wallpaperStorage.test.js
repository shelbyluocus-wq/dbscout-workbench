import test from "node:test";
import assert from "node:assert/strict";
import { createWallpaperStorage, WALLPAPER_STORAGE_KEY } from "./wallpaperStorage.js";

// Minimal event-driven IDB transaction fake. Writes stage until completion;
// abort rolls them back. Exercising the adapter (not just the state store)
// catches localStorage-before-IDB failure and publication ordering regressions.
function fixture() {
  let blob = { revision: "old", blob: new Blob(["old"]) };
  let raw = JSON.stringify({ settings: { id: "custom" }, revision: "old" });
  const controls = { failLocal: false, failWrite: false, failCommit: false };
  const log = [];
  const db = {
    close() {},
    transaction(_name, mode) {
      let staged = blob;
      let aborted = false;
      let finishScheduled = false;
      const tx = {
        error: null,
        abort() {
          if (aborted) return;
          aborted = true;
          queueMicrotask(() => tx.onabort?.());
        },
        objectStore() {
          const request = (action) => {
            const req = {};
            queueMicrotask(() => {
              if (aborted) return;
              if (action !== "get" && controls.failWrite) {
                tx.onerror?.(); tx.abort(); return;
              }
              if (action === "get") req.result = blob;
              else log.push("blob-written");
              req.onsuccess?.();
              if (!finishScheduled) {
                finishScheduled = true;
                setTimeout(() => {
                  if (aborted) return;
                  if (controls.failCommit && mode === "readwrite") { tx.abort(); return; }
                  blob = staged;
                  tx.oncomplete?.();
                }, 0);
              }
            });
            return req;
          };
          return {
            get: () => request("get"),
            put(value) { staged = value; return request("put"); },
            delete() { staged = null; return request("delete"); },
          };
        },
      };
      return tx;
    },
  };
  const local = {
    getItem(key) { assert.equal(key, WALLPAPER_STORAGE_KEY); return raw; },
    setItem(_key, value) {
      if (controls.failLocal) throw new Error("quota");
      log.push("settings-written"); raw = value;
    },
    removeItem() { raw = null; },
  };
  const storage = createWallpaperStorage({ getLocalStorage: () => local, getIndexedDB: () => ({
    open() {
      const req = { result: db };
      queueMicrotask(() => req.onsuccess());
      return req;
    },
  }) });
  return { storage, controls, log, get blob() { return blob; }, get raw() { return raw; } };
}
const replacement = () => ({
  metadata: { settings: { id: "custom" }, revision: "new" },
  custom: { blob: new Blob(["new"], { type: "image/png" }), kind: "image", revision: "new" },
});

test("storage writes ArrayBuffer/MIME and restores the Blob-facing API", async () => {
  const f = fixture();
  const next = replacement();
  assert.equal(await f.storage.mutate(() => next, next.custom), next);
  assert.deepEqual(f.log, ["blob-written", "settings-written"]);
  assert.ok(f.blob.bytes instanceof ArrayBuffer);
  assert.equal(f.blob.blob, undefined);
  assert.equal(f.blob.mime, "image/png");
  assert.deepEqual(JSON.parse(f.raw), next.metadata);
  const stored = await f.storage.read();
  assert.ok(stored.custom.blob instanceof Blob);
  assert.equal(stored.custom.blob.type, "image/png");
  assert.equal(await stored.custom.blob.text(), "new");
  assert.equal(stored.custom.kind, next.custom.kind);
  assert.equal(stored.custom.revision, next.custom.revision);
  const record = f.blob;
  await f.storage.mutate((current) => ({ ...current, metadata: { revision: "settings-only" } }));
  assert.equal(f.blob, record);
  f.storage.close();
});

test("peek returns saved settings without IndexedDB and never throws", () => {
  const f = fixture();
  assert.deepEqual(f.storage.peek(), { settings: { id: "custom" }, revision: "old" });
  f.storage.close();
  for (const local of [
    { getItem: () => null }, { getItem: () => "{broken" }, { getItem() { throw new Error("denied"); } },
  ]) {
    const storage = createWallpaperStorage({
      getLocalStorage: () => local, getIndexedDB() { throw new Error("IndexedDB must not be opened"); },
    });
    assert.equal(storage.peek(), null);
  }
  assert.equal(createWallpaperStorage({ getLocalStorage() { throw new Error("denied"); } }).peek(), null);
});

test("Blob conversion failures happen before any storage write", async () => {
  const f = fixture();
  const before = f.blob;
  const next = replacement();
  next.custom.blob.arrayBuffer = async () => { throw new Error("read failed"); };
  await assert.rejects(f.storage.mutate(() => next, next.custom), /wallpaper.error.storage/);
  assert.equal(f.blob, before);
  assert.deepEqual(f.log, []);
  f.storage.close();
});

// Opt-in real browser regression: WALLPAPER_BROWSER_TEST=1 node --test
// src/workbench/wallpaperStorage.test.js (requires installed Playwright engines).
test("Chromium and WebKit persist custom bytes, restore Blobs and synchronize replacement", {
  skip: process.env.WALLPAPER_BROWSER_TEST !== "1", timeout: 120000,
}, async () => {
  const { createServer } = await import("vite");
  const { chromium, webkit } = await import("playwright");
  const server = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0 }, logLevel: "silent" });
  await server.listen();
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch({ headless: true });
      try {
        const context = await browser.newContext();
        await context.route("**/__wallpaper-test", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
        const pages = await Promise.all([context.newPage(), context.newPage()]);
        const initialize = async (page) => page.evaluate(async () => {
          const { createWallpaperState } = await import("/src/workbench/wallpaperState.js");
          window.wallpaper = createWallpaperState();
          await wallpaper.ready;
          window.makePng = async (color) => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 8;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 8, 8);
            return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
          };
        });
        for (const page of pages) {
          await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__wallpaper-test`);
          await initialize(page);
        }
        const [first, second] = pages;
        assert.equal(await first.evaluate(async () => wallpaper.importFile(await makePng("red"))), true, engine.name());
        await second.waitForFunction(() => wallpaper.active.value.id === "custom" && wallpaper.customUrl.value);
        const previousUrl = await second.evaluate(() => wallpaper.customUrl.value);
        assert.equal(await first.evaluate(async () => wallpaper.importFile(await makePng("blue"))), true);
        await second.waitForFunction((old) => wallpaper.customUrl.value !== old, previousUrl);
        await second.reload();
        await initialize(second);
        assert.deepEqual(await second.evaluate(() => [wallpaper.active.value.id, wallpaper.customKind.value, wallpaper.error.value]), ["custom", "image", ""]);
        assert.equal(await second.evaluate(async () => {
          const { createWallpaperStorage, WALLPAPER_DATABASE } = await import("/src/workbench/wallpaperStorage.js");
          const record = await new Promise((resolve, reject) => {
            const open = indexedDB.open(WALLPAPER_DATABASE, 1);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const tx = db.transaction("wallpaper", "readonly");
              const get = tx.objectStore("wallpaper").get("custom");
              get.onsuccess = () => resolve(get.result);
              tx.oncomplete = () => db.close();
            };
          });
          const storage = createWallpaperStorage();
          const snapshot = await storage.read();
          storage.close();
          return record.bytes instanceof ArrayBuffer && !record.blob && record.mime === "image/png"
            && snapshot.custom.blob instanceof Blob && snapshot.custom.blob.type === "image/png";
        }), true);
        assert.equal(await first.evaluate(async () => {
          const { createWallpaperState } = await import("/src/workbench/wallpaperState.js");
          const { createWallpaperStorage } = await import("/src/workbench/wallpaperStorage.js");
          const storage = createWallpaperStorage({ getLocalStorage: () => ({
            getItem: (key) => localStorage.getItem(key),
            setItem() { throw new Error("quota"); },
          }) });
          const state = createWallpaperState({ storage });
          await state.ready;
          const old = state.source.value;
          const result = await state.importFile(await makePng("green"));
          const retained = !result && state.source.value === old && state.error.value === "wallpaper.error.storage";
          state.dispose();
          return retained;
        }), true);
        await first.evaluate(() => wallpaper.removeCustom());
        await second.waitForFunction(() => wallpaper.active.value.id === "none" && !wallpaper.customUrl.value);
      } finally { await browser.close(); }
    }
  } finally { await server.close(); }
});

for (const failure of ["failLocal", "failWrite", "failCommit"]) {
  test(`${failure}: failed replacement preserves previous Blob and metadata`, async () => {
    const f = fixture();
    const before = { blob: f.blob, raw: f.raw };
    f.controls[failure] = true;
    const next = replacement();
    await assert.rejects(f.storage.mutate(() => next, next.custom), /wallpaper.error.storage/);
    assert.equal(f.blob, before.blob);
    assert.equal(f.raw, before.raw);
    f.storage.close();
  });
}

test("null mutation does not publish; legacy Blob records remain readable", async () => {
  const f = fixture();
  assert.equal(await f.storage.mutate(() => null), null);
  assert.deepEqual(f.log, []);
  const before = f.blob;
  assert.equal((await f.storage.read()).custom, before);
  await f.storage.mutate((current) => ({ ...current, metadata: { settings: { id: "none" }, revision: "reset" } }));
  assert.equal(f.blob, before);
  assert.deepEqual(f.log, ["settings-written"]);
  await f.storage.mutate(() => ({ metadata: { settings: { id: "none" }, revision: "delete" }, custom: null }));
  assert.equal(f.blob, null);
  f.storage.close();
});
