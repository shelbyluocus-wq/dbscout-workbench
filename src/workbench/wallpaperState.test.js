import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  createWallpaperState, decodeWallpaperFile, normalizeWallpaperSettings, validateWallpaperFile,
  WALLPAPERS, WALLPAPER_APPEARANCES, WALLPAPER_DEFAULTS, WALLPAPER_LIMITS, WALLPAPER_STORAGE_KEY,
} from "./wallpaperState.js";
import { createWallpaperStorage } from "./wallpaperStorage.js";

const png = () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], { type: "image/png" });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function memoryStorage() {
  let snapshot = { metadata: null, custom: null };
  let queue = Promise.resolve();
  return {
    fail: false,
    get snapshot() { return snapshot; },
    peek() { return snapshot.metadata; },
    set snapshot(value) { snapshot = value; },
    async read() { await queue; return snapshot; },
    mutate(change) {
      const job = queue.then(() => {
        if (this.fail) throw new Error("quota error containing private file path");
        const result = change(snapshot);
        if (result) snapshot = result;
        return result;
      });
      queue = job.catch(() => {});
      return job;
    },
  };
}
function fixture(options = {}) {
  const active = new Set();
  const revoked = [];
  let counter = 0;
  const urls = {
    createObjectURL() { const url = `blob:test-${++counter}`; active.add(url); return url; },
    revokeObjectURL(url) { active.delete(url); revoked.push(url); },
  };
  const events = new EventTarget();
  const storage = options.storage || memoryStorage();
  const state = createWallpaperState({ storage, urls, eventTarget: events, decode: async () => {}, ...options });
  return { state, storage, active, revoked, events };
}
function storageEvent(target) {
  const event = new Event("storage");
  event.key = WALLPAPER_STORAGE_KEY;
  target.dispatchEvent(event);
}

test("registry, defaults and bounded settings contract", () => {
  assert.deepEqual(WALLPAPERS.map(({ id, suits }) => `${suits}:${id}`), [
    "light:mist-ridges", "light:frost-folds", ":dune-dawn", ":ocean-clouds",
    "dark:night-ridges", "dark:indigo-folds", "dark:dune-night", ":night-launch", ":silent-orbits", ":planet-dawn",
    ":dune-sphere", ":rose-quartz",
  ]);
  for (const entry of WALLPAPERS) {
    assert.equal(entry.src, `/wallpapers/${entry.id}.webp`);
    assert.equal(entry.thumbnail, `/wallpapers/thumbnails/${entry.id}.webp`);
    assert.ok(existsSync(new URL(`../../public${entry.src}`, import.meta.url)), entry.src);
    assert.ok(existsSync(new URL(`../../public${entry.thumbnail}`, import.meta.url)), entry.thumbnail);
    if (!entry.pair) continue;
    const partner = WALLPAPERS.find(({ id }) => id === entry.pair);
    assert.equal(partner.pair, entry.id);
    assert.notEqual(partner.suits, entry.suits);
  }
  // The recommended pair suits its appearance and belongs together.
  for (const appearance of WALLPAPER_APPEARANCES) {
    assert.equal(WALLPAPERS.find(({ id }) => id === WALLPAPER_DEFAULTS[appearance].id).suits, appearance);
  }
  assert.equal(WALLPAPERS.find(({ id }) => id === WALLPAPER_DEFAULTS.light.id).pair, WALLPAPER_DEFAULTS.dark.id);
  assert.deepEqual(normalizeWallpaperSettings(null), WALLPAPER_DEFAULTS);
  assert.notEqual(normalizeWallpaperSettings(null).light, WALLPAPER_DEFAULTS.light);
  assert.deepEqual(normalizeWallpaperSettings({
    light: { id: "unknown", visibility: 12, blur: -1 }, dark: { id: "dune-night", visibility: "0.2", blur: 25 }, motion: "yes",
  }), {
    light: { id: "none", visibility: 1, blur: 0 }, dark: { id: "dune-night", visibility: 0.6, blur: 24 }, motion: false,
  });
  assert.equal(normalizeWallpaperSettings({ blur: Infinity }).light.blur, 0);
  assert.equal(normalizeWallpaperSettings({ blur: 25 }).dark.blur, 24);
});

test("reportError accepts localized media errors only and never changes selection", async () => {
  const { state } = fixture();
  await state.ready;
  await state.select("rose-quartz");
  for (const key of ["wallpaper.error.decode", "wallpaper.error.playback"]) {
    assert.equal(state.reportError(key), true);
    assert.equal(state.error.value, key);
  }
  assert.equal(state.reportError("private browser failure"), false);
  assert.equal(state.error.value, "wallpaper.error.playback");
  assert.equal(state.active.value.id, "rose-quartz");
  assert.equal(state.reportError(""), true);
  assert.equal(state.error.value, "");
  await state.updateSettings({ blur: 40 });
  assert.equal(state.active.value.blur, 24);
  state.dispose();
  assert.equal(state.reportError("wallpaper.error.decode"), false);
});

test("MIME, bounded header magic, empty input and exact binary size limits", async () => {
  assert.equal(await validateWallpaperFile(png()), "image");
  assert.equal(await validateWallpaperFile(new Blob([new Uint8Array([255, 216, 255])], { type: "image/jpeg" })), "image");
  assert.equal(await validateWallpaperFile(new Blob(["RIFFxxxxWEBP"], { type: "image/webp" })), "image");
  const mp4 = new Blob([new Uint8Array([0, 0, 0, 20]), "ftypisom", new Uint8Array(4), "mp42"], { type: "video/mp4" });
  assert.equal(await validateWallpaperFile(mp4), "video");
  await assert.rejects(validateWallpaperFile(new Blob(["RIFFxxxxWEBP"], { type: "image/png" })), /wallpaper.error.invalidFile/);
  await assert.rejects(validateWallpaperFile(new Blob(["<svg/>"], { type: "image/svg+xml" })), /wallpaper.error.unsupportedType/);
  await assert.rejects(validateWallpaperFile(new Blob([], { type: "image/png" })), /wallpaper.error.invalidFile/);
  for (const [kind, blob] of [["image", png()], ["video", mp4]]) {
    const file = { type: blob.type, size: WALLPAPER_LIMITS[kind], slice: (...args) => blob.slice(...args) };
    assert.equal(await validateWallpaperFile(file), kind);
    await assert.rejects(validateWallpaperFile({ ...file, size: file.size + 1 }), new RegExp(`wallpaper.error.${kind}TooLarge`));
  }
});

test("selection, settings, import, retained reset, removal and URL cleanup", async () => {
  const { state, storage, active, revoked } = fixture();
  await state.ready;
  assert.equal(state.source.value, "/wallpapers/mist-ridges.webp");
  assert.equal(await state.select("night-launch"), true);
  assert.equal(state.source.value, "/wallpapers/night-launch.webp");
  await state.updateSettings({ visibility: 0.6, blur: 5, motion: true, id: "custom", secret: "ignored" });
  assert.equal(state.active.value.id, "night-launch");
  assert.equal(state.settings.value.light.secret, undefined);
  assert.equal(await state.importFile(png()), true);
  assert.equal(state.customKind.value, "image");
  const firstUrl = state.source.value;
  await state.importFile(png());
  assert.notEqual(state.source.value, firstUrl);
  assert.ok(revoked.includes(firstUrl));
  assert.equal(active.size, 1);
  assert.ok(storage.snapshot.custom.blob instanceof Blob);
  assert.ok(JSON.stringify(storage.snapshot.metadata).length < 300);
  await state.reset();
  assert.deepEqual(state.settings.value, WALLPAPER_DEFAULTS);
  assert.ok(state.customUrl.value);
  assert.equal(state.source.value, "/wallpapers/mist-ridges.webp");
  await state.select("custom");
  await state.removeCustom();
  assert.equal(state.active.value.id, "none");
  assert.equal(state.customKind.value, "");
  assert.equal(storage.snapshot.custom, null);
  assert.equal(active.size, 0);
  assert.equal(await state.select("custom"), false);
  assert.equal(state.error.value, "wallpaper.error.customMissing");
  await state.select("ocean-clouds");
  await state.removeCustom();
  assert.equal(state.active.value.id, "ocean-clouds");
  state.dispose();
});

test("invalid files, decode errors and storage failure preserve current selection and Blob", async () => {
  let failDecode = false;
  const { state, storage, active } = fixture({ decode: async () => { if (failDecode) throw new Error("wallpaper.error.decode"); } });
  await state.ready;
  await state.importFile(png());
  const before = storage.snapshot;
  const url = state.source.value;
  failDecode = true;
  assert.equal(await state.importFile(png()), false);
  assert.equal(state.error.value, "wallpaper.error.decode");
  failDecode = false;
  storage.fail = true;
  for (const action of [() => state.importFile(png()), () => state.removeCustom(), () => state.reset(), () => state.select("dune-dawn")]) {
    assert.equal(await action(), false);
    assert.equal(state.error.value, "wallpaper.error.storage");
    assert.equal(state.source.value, url);
    assert.equal(storage.snapshot, before);
    assert.equal(active.size, 1);
  }
  storage.fail = false;
  assert.equal(await state.select("unknown"), false);
  assert.equal(state.error.value, "wallpaper.error.unknownId");
  state.dispose();
  assert.equal(active.size, 0);
});

test("latest intent wins slow imports; stale failures do not replace newer error/state", async () => {
  const gate = deferred();
  let calls = 0;
  const { state, active } = fixture({ decode: () => ++calls === 1 ? gate.promise : Promise.resolve() });
  await state.ready;
  const oldImport = state.importFile(png());
  await tick();
  assert.equal(state.busy.value, true);
  await state.select("silent-orbits");
  gate.resolve();
  assert.equal(await oldImport, false);
  assert.equal(state.active.value.id, "silent-orbits");
  assert.equal(state.busy.value, false);
  assert.equal(state.error.value, "");
  assert.equal(active.size, 0);
  state.dispose();
});

test("two imports completing out of order only keep the latest", async () => {
  const gate = deferred();
  let calls = 0;
  const { state, storage, active } = fixture({ decode: () => ++calls === 1 ? gate.promise : Promise.resolve() });
  await state.ready;
  const first = state.importFile(png());
  await tick();
  const latest = png();
  assert.equal(await state.importFile(latest), true);
  gate.resolve();
  assert.equal(await first, false);
  assert.equal(storage.snapshot.custom.blob, latest);
  assert.equal(active.size, 1);
  state.dispose();
});

test("initialization is deferred and cannot overwrite an immediate selection", async () => {
  let initialize;
  const { state } = fixture({ schedule: (run) => { initialize = run; } });
  assert.deepEqual(state.settings.value, WALLPAPER_DEFAULTS);
  await state.select("rose-quartz");
  initialize();
  await state.ready;
  assert.equal(state.active.value.id, "rose-quartz");
  state.dispose();
});

test("cross-window sync reloads same-ID custom replacements and revokes old URLs", async () => {
  const storage = memoryStorage();
  const first = fixture({ storage });
  const second = fixture({ storage });
  await Promise.all([first.state.ready, second.state.ready]);
  await first.state.importFile(png());
  storageEvent(second.events);
  await tick();
  const oldUrl = second.state.source.value;
  assert.ok(oldUrl);
  await first.state.importFile(png());
  storageEvent(second.events);
  await tick();
  assert.notEqual(second.state.source.value, oldUrl);
  assert.ok(second.revoked.includes(oldUrl));
  await first.state.updateSettings({ visibility: 0.9 });
  await second.state.updateSettings({ blur: 7 });
  assert.equal(storage.snapshot.metadata.settings.light.visibility, 0.9);
  storageEvent(first.events);
  await tick();
  assert.equal(first.state.settings.value.light.blur, 7);
  await first.state.removeCustom();
  storageEvent(second.events);
  await tick();
  assert.equal(second.state.source.value, "");
  assert.equal(second.active.size, 0);
  first.state.dispose();
  second.state.dispose();
});

test("late refresh does not overwrite user action; disposed imports cannot persist", async () => {
  const storage = memoryStorage();
  const gate = deferred();
  let deferRead = false;
  const adapter = { ...storage, read: async () => deferRead ? gate.promise : storage.read() };
  const { state, active } = fixture({ storage: adapter });
  await state.ready;
  deferRead = true;
  const refresh = state.refresh();
  deferRead = false;
  await state.select("indigo-folds");
  gate.resolve({ metadata: { settings: { id: "dune-dawn" } }, custom: null });
  await refresh;
  assert.equal(state.active.value.id, "indigo-folds");
  state.dispose();
  assert.equal(await state.importFile(png()), false);
  assert.equal(active.size, 0);
});

test("missing custom restoration reports a localized error and removal repairs it", async () => {
  const storage = memoryStorage();
  storage.snapshot = { metadata: { settings: { id: "custom" } }, custom: null };
  const { state } = fixture({ storage });
  await state.ready;
  assert.equal(state.source.value, "");
  assert.equal(state.error.value, "wallpaper.error.customMissing");
  assert.equal(await state.removeCustom(), true);
  assert.equal(state.error.value, "");
  assert.deepEqual([state.settings.value.light.id, state.settings.value.dark.id], ["none", "none"]);
  state.dispose();
});

test("each appearance keeps its own wallpaper; the shell picks which one shows", async () => {
  const { state, storage } = fixture();
  await state.ready;
  assert.equal(state.appearance.value, "light");
  assert.equal(state.source.value, "/wallpapers/mist-ridges.webp");
  assert.equal(await state.select("dune-night", "dark"), true);
  assert.equal(state.active.value.id, "mist-ridges");
  assert.equal(state.settings.value.dark.id, "dune-night");
  await state.updateSettings({ visibility: 0.3, blur: 9, motion: true }, "dark");
  assert.deepEqual(state.settings.value.light, WALLPAPER_DEFAULTS.light);
  assert.deepEqual(state.settings.value.dark, { id: "dune-night", visibility: 0.3, blur: 9 });
  assert.equal(state.settings.value.motion, true);
  state.setAppearance("dark");
  assert.equal(state.source.value, "/wallpapers/dune-night.webp");
  assert.equal(state.active.value.blur, 9);
  state.setAppearance("sepia");
  assert.equal(state.appearance.value, "dark");
  await state.select("none");
  assert.equal(state.source.value, "");
  assert.equal(state.settings.value.light.id, "mist-ridges");
  await state.importFile(png(), "light");
  assert.equal(state.settings.value.light.id, "custom");
  assert.equal(state.source.value, "");
  await state.select("custom");
  assert.ok(state.source.value.startsWith("blob:"));
  await state.removeCustom();
  assert.deepEqual([state.settings.value.light.id, state.settings.value.dark.id], ["none", "none"]);
  assert.deepEqual(storage.snapshot.metadata.settings, {
    light: { id: "none", visibility: 0.6, blur: 0 }, dark: { id: "none", visibility: 0.3, blur: 9 }, motion: true,
  });
  state.dispose();
});

test("a theme switch during a slow import keeps the change on the appearance it started for", async () => {
  const gate = deferred();
  const { state } = fixture({ decode: () => gate.promise });
  await state.ready;
  const pending = state.importFile(png());
  await tick();
  state.setAppearance("dark");
  gate.resolve();
  assert.equal(await pending, true);
  assert.equal(state.settings.value.light.id, "custom");
  assert.equal(state.settings.value.dark.id, "night-ridges");
  state.dispose();
});

test("saved settings show from the first frame; single-wallpaper settings carry over to both appearances", async () => {
  const storage = memoryStorage();
  storage.snapshot = { metadata: { settings: { id: "indigo-folds", visibility: 0.4, blur: 3, motion: true } }, custom: null };
  const { state } = fixture({ storage, schedule() {} });
  const carried = { id: "indigo-folds", visibility: 0.4, blur: 3 };
  assert.deepEqual(state.settings.value, { light: carried, dark: carried, motion: true });
  assert.equal(state.source.value, "/wallpapers/indigo-folds.webp");
  state.dispose();
  assert.deepEqual(normalizeWallpaperSettings({}), {
    light: { id: "none", visibility: 0.25, blur: 0 }, dark: { id: "none", visibility: 0.25, blur: 0 }, motion: false,
  });
  assert.deepEqual(normalizeWallpaperSettings({ light: { id: "frost-folds" } }), {
    light: { id: "frost-folds", visibility: 0.6, blur: 0 }, dark: { id: "none", visibility: 0.6, blur: 0 }, motion: false,
  });
});
for (const id of ["none", "night-launch"]) {
  test(`startup and cross-window ${id} restoration ignore undecodable retained video`, async () => {
    const storage = memoryStorage();
    const blob = new Blob([new Uint8Array([0, 0, 0, 20]), "ftypisom", new Uint8Array(4), "mp42"], { type: "video/mp4" });
    const custom = { blob, kind: "video", revision: "unsupported-codec" };
    const saved = {
      light: { id, visibility: 0.7, blur: 12 }, dark: { id: "none", visibility: 0.5, blur: 0 }, motion: true,
    };
    storage.snapshot = { metadata: { settings: saved }, custom };
    let decodeCalls = 0;
    const { state, events, active, revoked } = fixture({ storage, decode: async (_blob, kind) => {
      ++decodeCalls;
      if (kind === "video") throw new Error("wallpaper.error.decode");
    } });
    assert.equal(await state.ready, true);
    assert.deepEqual(state.settings.value, saved);
    assert.equal(state.source.value, id === "none" ? "" : "/wallpapers/night-launch.webp");
    assert.equal(state.customKind.value, "video");
    assert.equal(state.customUrl.value, "");
    assert.equal(state.error.value, "");
    assert.equal(decodeCalls, 0);
    assert.equal(storage.snapshot.custom, custom);

    // Selecting the retained file still validates it without losing appearance.
    assert.equal(await state.select("custom"), false);
    assert.equal(state.error.value, "wallpaper.error.decode");
    assert.deepEqual(state.settings.value, saved);
    assert.equal(storage.snapshot.custom, custom);
    assert.equal(decodeCalls, 1);

    // A valid replacement is possible; a later remote selection must revoke
    // its obsolete URL without decoding the remotely retained broken video.
    assert.equal(await state.importFile(png()), true);
    const oldUrl = state.customUrl.value;
    const callsBeforeSync = decodeCalls;
    storage.snapshot = { metadata: { settings: saved }, custom };
    storageEvent(events);
    await tick();
    assert.deepEqual(state.settings.value, saved);
    assert.equal(state.source.value, id === "none" ? "" : "/wallpapers/night-launch.webp");
    assert.equal(state.error.value, "");
    assert.equal(state.customKind.value, "video");
    assert.equal(decodeCalls, callsBeforeSync);
    assert.equal(storage.snapshot.custom, custom);
    assert.ok(revoked.includes(oldUrl));
    assert.equal(active.size, 0);
    assert.equal(await state.removeCustom(), true);
    assert.equal(storage.snapshot.custom, null);
    assert.deepEqual(state.settings.value, saved);
    state.dispose();
  });
}

test("reset and builtin selection can escape a retained undecodable custom Blob", async () => {
  const storage = memoryStorage();
  storage.snapshot = {
    metadata: { settings: { id: "custom" } },
    custom: { blob: png(), kind: "image", revision: "broken" },
  };
  const { state } = fixture({ storage, decode: async () => { throw new Error("wallpaper.error.decode"); } });
  await state.ready;
  assert.equal(state.error.value, "wallpaper.error.decode");
  assert.equal(await state.reset(), true);
  assert.deepEqual(state.settings.value, WALLPAPER_DEFAULTS);
  assert.ok(storage.snapshot.custom);
  assert.equal(await state.select("planet-dawn"), true);
  assert.equal(await state.removeCustom(), true);
  assert.equal(state.active.value.id, "planet-dawn");
  state.dispose();
});

test("dispose cancels an in-flight decode and storage events are detached", async () => {
  let aborted = false;
  const { state, events, storage, active } = fixture({
    decode: (_file, _kind, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("wallpaper.error.decode"));
      }, { once: true });
    }),
  });
  await state.ready;
  const pending = state.importFile(png());
  await tick();
  state.dispose();
  assert.equal(await pending, false);
  assert.equal(aborted, true);
  assert.equal(storage.snapshot.custom, null);
  assert.equal(state.busy.value, false);
  storageEvent(events);
  await tick();
  assert.equal(active.size, 0);
});

function decoderFixture(kind, outcome) {
  const cleaned = [];
  const media = {
    naturalWidth: 1, naturalHeight: 1, videoWidth: 2, videoHeight: 2, duration: 1,
    removeAttribute: (key) => cleaned.push(key), pause: () => cleaned.push("pause"), load() {},
    set src(_value) {
      queueMicrotask(() => {
        if (outcome === "error") this.onerror?.();
        if (outcome === "success") (kind === "image" ? this.onload : this.onloadeddata)?.();
        if (outcome === "metadata") this.onloadedmetadata?.();
      });
    },
  };
  return {
    cleaned, media,
    options: {
      document: { createElement: () => media }, timeoutMs: 10,
      urls: { createObjectURL: () => "blob:decode", revokeObjectURL: (url) => cleaned.push(url) },
    },
  };
}
for (const kind of ["image", "video"]) {
  test(`DOM ${kind} decoder cleans up success, failure, timeout and abort`, async () => {
    for (const outcome of ["success", "error", "metadata", "abort"]) {
      const { options, cleaned } = decoderFixture(kind, outcome);
      const controller = new AbortController();
      const promise = decodeWallpaperFile(png(), kind, { ...options, signal: controller.signal });
      if (outcome === "abort") controller.abort();
      if (outcome === "success") await promise;
      else await assert.rejects(promise, /wallpaper.error.decode/);
      assert.ok(cleaned.includes("src"));
      assert.equal(cleaned.filter((value) => value === "blob:decode").length, 1);
      if (kind === "video") assert.ok(cleaned.includes("pause"));
    }
  });
}

test("storage unavailable and blocked open errors are localized and retryable", async () => {
  const storage = createWallpaperStorage({ getIndexedDB() { throw new Error("denied"); } });
  await assert.rejects(storage.read(), /wallpaper.error.storage/);
  await assert.rejects(storage.mutate(() => null), /wallpaper.error.storage/);
  storage.close();
  await assert.rejects(storage.read(), /wallpaper.error.storage/);
  let closed = false;
  const request = { result: { close() { closed = true; } } };
  const blocked = createWallpaperStorage({ getIndexedDB: () => ({ open() {
    queueMicrotask(() => { request.onblocked(); request.onsuccess(); });
    return request;
  } }) });
  await assert.rejects(blocked.read(), /wallpaper.error.storage/);
  assert.equal(closed, true);
  blocked.close();
});
