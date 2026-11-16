import test from "node:test";
import assert from "node:assert/strict";
import { createWallpaperStorage, WALLPAPER_STORAGE_KEY } from "./wallpaperStorage.js";

// Minimal event-driven IDB transaction fake. Writes stage until completion;
// abort rolls them back. Exercising the adapter (not just the state store)
// catches localStorage-before-IDB failure and publication ordering regressions.
function fixture() {
  let records = new Map([["custom", { revision: "old", kind: "image", blob: new Blob(["old"]) }]]);
  let raw = JSON.stringify({ settings: { id: "custom" }, revision: "old" });
  const controls = { failLocal: false, failWrite: false, failCommit: false };
  const log = [];
  const db = {
    close() {},
    transaction(_name, mode) {
      const staged = new Map(records);
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
          const request = (action, key) => {
            const req = {};
            queueMicrotask(() => {
              if (aborted) return;
              if (action !== "get" && controls.failWrite) {
                tx.onerror?.(); tx.abort(); return;
              }
              if (action === "get") { req.result = records.get(key); log.push(`read:${key}`); }
              else log.push(`${action}:${key}`);
              req.onsuccess?.();
              if (!finishScheduled) {
                finishScheduled = true;
                setTimeout(() => {
                  if (aborted) return;
                  if (controls.failCommit && mode === "readwrite") { tx.abort(); return; }
                  records = staged;
                  tx.oncomplete?.();
                }, 0);
              }
            });
            return req;
          };
          return {
            get: (key) => request("get", key),
            put(value, key) { staged.set(key, value); return request("put", key); },
            delete(key) { staged.delete(key); return request("delete", key); },
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
  return { storage, controls, log, get records() { return records; }, get blob() { return records.get("custom"); }, get raw() { return raw; } };
}
const replacement = () => ({
  metadata: { settings: { id: "custom" }, revision: "new" },
  customs: [{ id: "custom", name: "new.png", blob: new Blob(["new"], { type: "image/png" }), kind: "image", revision: "new" }],
});

test("storage writes ArrayBuffer/MIME and restores the Blob-facing API", async () => {
  const f = fixture();
  const next = replacement();
  assert.equal(await f.storage.mutate(() => next, next.customs[0]), next);
  assert.deepEqual(f.log, ["read:library", "read:custom", "put:custom", "put:library", "settings-written"]);
  assert.ok(f.blob.bytes instanceof ArrayBuffer);
  assert.equal(f.blob.blob, undefined);
  assert.equal(f.blob.mime, "image/png");
  assert.deepEqual(JSON.parse(f.raw), next.metadata);
  const stored = await f.storage.read();
  assert.ok(stored.customs[0].blob instanceof Blob);
  assert.equal(stored.customs[0].blob.type, "image/png");
  assert.equal(await stored.customs[0].blob.text(), "new");
  assert.equal(stored.customs[0].kind, next.customs[0].kind);
  assert.equal(stored.customs[0].revision, next.customs[0].revision);
  assert.equal(stored.customs[0].name, "new.png");
  const record = f.blob;
  await f.storage.mutate((current) => ({ ...current, metadata: { revision: "settings-only" } }));
  assert.equal(f.blob, record);
  f.storage.close();
});

test("library migration retains legacy bytes; sliders only read the index and publish settings", async () => {
  const f = fixture();
  const legacy = f.blob;
  const candidate = { id: "custom-added", name: "added.png", blob: new Blob(["added"], { type: "image/png" }), kind: "image", revision: "added" };
  await f.storage.mutate((current) => ({ ...current, customs: [...current.customs, candidate] }), candidate);
  assert.equal(f.blob, legacy);
  assert.deepEqual(f.records.get("library").map(({ id }) => id), ["custom", "custom-added"]);
  assert.deepEqual(f.log.filter((entry) => entry.startsWith("put:")), ["put:custom-added", "put:library"]);
  f.log.length = 0;
  for (let index = 0; index < 10; ++index) {
    await f.storage.mutate((current) => ({ ...current, metadata: { settings: { blur: index } } }));
  }
  assert.deepEqual(f.log, Array.from({ length: 10 }, () => ["read:library", "settings-written"]).flat());
  assert.equal(f.blob, legacy);
  f.log.length = 0;
  await f.storage.mutate((current) => ({ ...current, customs: current.customs.filter(({ id }) => id !== "custom-added") }));
  assert.equal(f.blob, legacy);
  assert.equal(f.records.has("custom-added"), false);
  assert.deepEqual(f.log, ["read:library", "delete:custom-added", "put:library", "settings-written"]);
  assert.equal((await f.storage.read()).customs[0].id, "custom");
  f.storage.close();
});

for (const failure of ["failLocal", "failWrite", "failCommit"]) {
  test(`${failure}: failed library deletion preserves all media and the index`, async () => {
    const f = fixture();
    const next = replacement();
    await f.storage.mutate(() => next, next.customs[0]);
    const before = { records: f.records, raw: f.raw };
    f.controls[failure] = true;
    await assert.rejects(f.storage.mutate((current) => ({ ...current, customs: [] })), /wallpaper.error.storage/);
    assert.equal(f.records, before.records);
    assert.equal(f.raw, before.raw);
    f.storage.close();
  });
}

test("legacy ArrayBuffer media restores with its original ID and no retained byte copy", async () => {
  const f = fixture();
  f.records.set("custom", { bytes: await new Blob(["legacy"]).arrayBuffer(), mime: "image/png", kind: "image", revision: "old" });
  const snapshot = await f.storage.read();
  assert.equal(snapshot.customs[0].id, "custom");
  assert.equal(await snapshot.customs[0].blob.text(), "legacy");
  assert.equal(snapshot.customs[0].bytes, undefined);
  f.storage.close();
});

test("malformed library and missing indexed media fail with localized errors", async () => {
  for (const index of [null, [{}], [{ id: "custom-absent", revision: "absent" }]]) {
    const f = fixture();
    f.records.set("library", index);
    await assert.rejects(f.storage.read(), /wallpaper.error.(storage|customMissing)/);
    f.storage.close();
  }
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
  next.customs[0].blob.arrayBuffer = async () => { throw new Error("read failed"); };
  await assert.rejects(f.storage.mutate(() => next, next.customs[0]), /wallpaper.error.storage/);
  assert.equal(f.blob, before);
  assert.deepEqual(f.log, []);
  f.storage.close();
});

// Opt-in real browser regression: WALLPAPER_BROWSER_TEST=1 node --test
// src/workbench/wallpaperStorage.test.js (requires installed Playwright engines).
test("Chromium and WebKit persist custom bytes, restore Blobs and synchronize the library", {
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
        await second.waitForFunction(() => wallpaper.active.value.id.startsWith("custom-") && wallpaper.customUrl.value);
        const previousUrl = await second.evaluate(() => wallpaper.customUrl.value);
        assert.equal(await first.evaluate(async () => wallpaper.importFile(await makePng("blue"))), true);
        await second.waitForFunction((old) => wallpaper.customUrl.value !== old, previousUrl);
        await second.reload();
        await initialize(second);
        assert.deepEqual(await second.evaluate(() => [wallpaper.customWallpapers.value.length, wallpaper.customKind.value, wallpaper.error.value]), [2, "image", ""]);
        assert.equal(await second.evaluate(async () => {
          const { createWallpaperStorage, WALLPAPER_DATABASE } = await import("/src/workbench/wallpaperStorage.js");
          const record = await new Promise((resolve, reject) => {
            const open = indexedDB.open(WALLPAPER_DATABASE, 1);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const tx = db.transaction("wallpaper", "readonly");
              const get = tx.objectStore("wallpaper").get(wallpaper.active.value.id);
              get.onsuccess = () => resolve(get.result);
              tx.oncomplete = () => db.close();
            };
          });
          const storage = createWallpaperStorage();
          const snapshot = await storage.read();
          storage.close();
          return record.bytes instanceof ArrayBuffer && !record.blob && record.mime === "image/png"
            && snapshot.customs.every(({ blob }) => blob instanceof Blob && blob.type === "image/png");
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
    await assert.rejects(f.storage.mutate(() => next, next.customs[0]), /wallpaper.error.storage/);
    assert.equal(f.blob, before.blob);
    assert.equal(f.raw, before.raw);
    f.storage.close();
  });
}

test("null mutation does not publish; legacy Blob records remain readable", async () => {
  const f = fixture();
  assert.equal(await f.storage.mutate(() => null), null);
  assert.deepEqual(f.log, ["read:library", "read:custom"]);
  const before = f.blob;
  assert.equal((await f.storage.read()).customs[0].blob, before.blob);
  await f.storage.mutate((current) => ({ ...current, metadata: { settings: { id: "none" }, revision: "reset" } }));
  assert.equal(f.blob, before);
  assert.deepEqual(f.log.filter((entry) => !entry.startsWith("read:")), ["put:library", "settings-written"]);
  await f.storage.mutate(() => ({ metadata: { settings: { id: "none" }, revision: "delete" }, customs: [] }));
  assert.equal(f.blob, undefined);
  assert.deepEqual((await f.storage.read()).customs, []);
  f.storage.close();
});
