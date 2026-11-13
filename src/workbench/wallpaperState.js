import { computed, readonly, ref } from "vue";
import { createWallpaperStorage, WALLPAPER_STORAGE_KEY, wallpaperError } from "./wallpaperStorage.js";

export { WALLPAPER_STORAGE_KEY } from "./wallpaperStorage.js";
export const WALLPAPERS = Object.freeze([
  "night-launch", "silent-orbits", "dune-dawn", "planet-dawn",
  "indigo-folds", "dune-sphere", "ocean-clouds", "rose-quartz",
].map((id) => Object.freeze({
  id,
  labelKey: `wallpaper.builtin.${id}`,
  src: `/wallpapers/${id}.webp`,
  thumbnail: `/wallpapers/thumbnails/${id}.webp`,
})));
export const WALLPAPER_DEFAULTS = Object.freeze({ id: "none", visibility: 0.25, blur: 0, motion: false });
export const WALLPAPER_LIMITS = Object.freeze({ image: 20 * 1024 * 1024, video: 100 * 1024 * 1024 });
export const WALLPAPER_ERROR_KEYS = Object.freeze([
  "unsupportedType", "imageTooLarge", "videoTooLarge", "invalidFile", "decode", "playback",
  "storage", "settings", "unknownId", "customMissing",
].map((code) => `wallpaper.error.${code}`));
const ids = new Set(["none", "custom", ...WALLPAPERS.map(({ id }) => id)]);
const mimeKinds = { "image/png": "image", "image/jpeg": "image", "image/webp": "image", "video/mp4": "video" };
const clamp = (value, min, max, fallback) => typeof value === "number" && Number.isFinite(value)
  ? Math.max(min, Math.min(max, value)) : fallback;

// Visibility is a fraction; blur is CSS pixels (0–24). Unknown persisted values
// fall back to defaults. Callers change settings through methods, not ref writes.
export function normalizeWallpaperSettings(value = {}) {
  value = value && typeof value === "object" ? value : {};
  return {
    id: ids.has(value.id) ? value.id : "none",
    visibility: clamp(value.visibility, 0, 1, 0.25),
    blur: clamp(value.blur, 0, 24, 0),
    motion: typeof value.motion === "boolean" ? value.motion : false,
  };
}

export async function validateWallpaperFile(file) {
  const kind = mimeKinds[file?.type];
  if (!kind) throw wallpaperError("unsupportedType");
  if (!Number.isFinite(file.size) || file.size <= 0 || typeof file.slice !== "function") {
    throw wallpaperError("invalidFile");
  }
  if (file.size > WALLPAPER_LIMITS[kind]) throw wallpaperError(`${kind}TooLarge`);
  let bytes;
  try { bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer()); }
  catch { throw wallpaperError("invalidFile"); }
  const matches = (offset, values) => values.every((value, index) => bytes[offset + index] === value);
  const text = (offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length));
  let valid = false;
  if (file.type === "image/png") valid = matches(0, [137, 80, 78, 71, 13, 10, 26, 10]);
  if (file.type === "image/jpeg") valid = matches(0, [255, 216, 255]);
  if (file.type === "image/webp") valid = text(0, 4) === "RIFF" && text(8, 4) === "WEBP";
  if (file.type === "video/mp4" && bytes.length >= 16 && text(4, 4) === "ftyp") {
    const boxSize = new DataView(bytes.buffer).getUint32(0);
    const brand = /^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV)$/;
    if (boxSize >= 16 && boxSize <= bytes.length && boxSize <= file.size && boxSize % 4 === 0) {
      valid = brand.test(text(8, 4));
      for (let offset = 16; offset < boxSize; offset += 4) valid ||= brand.test(text(offset, 4));
    }
  }
  if (!valid) throw wallpaperError("invalidFile");
  return kind;
}

// A header is not proof of decodability. Wait for an actual image/frame, not
// video metadata. Temporary media elements/URLs are cleaned on every exit.
export function decodeWallpaperFile(file, kind, {
  document = globalThis.document,
  urls = globalThis.URL,
  timeoutMs = 15000,
  signal,
} = {}) {
  return new Promise((resolve, reject) => {
    let media;
    let url;
    let timer;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (media) {
        media.onload = media.onerror = media.onloadeddata = null;
        try {
          if (kind === "video") media.pause();
          media.removeAttribute("src");
          if (kind === "video") media.load();
        } catch { /* Cleanup must not mask the decode result. */ }
      }
      if (url) urls.revokeObjectURL(url);
      if (ok) resolve();
      else reject(wallpaperError("decode"));
    };
    const abort = () => finish(false);
    if (signal?.aborted) { finish(false); return; }
    try {
      media = document.createElement(kind === "video" ? "video" : "img");
      url = urls.createObjectURL(file);
      media.onerror = () => finish(false);
      if (kind === "video") {
        media.muted = true;
        media.playsInline = true;
        media.preload = "auto";
        media.onloadeddata = () => finish(media.videoWidth > 0 && media.videoHeight > 0
          && Number.isFinite(media.duration) && media.duration > 0);
      } else {
        media.onload = () => finish(media.naturalWidth > 0 && media.naturalHeight > 0);
      }
      timer = setTimeout(() => finish(false), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      media.src = url;
      if (kind === "video") media.load();
    } catch { finish(false); }
  });
}

/**
 * Framework-facing store, independently constructible for tests.
 * Async actions return Promise<boolean> (false = failed or superseded), never raw
 * browser errors. `source` is a URL string or ""; customKind is "image" /
 * "video" / "" and is available even when custom is not selected.
 * Reset selects none and restores defaults but retains the custom Blob.
 * Initialization is scheduled, not awaited by the shell; ready is optional.
 * All mutation decisions run inside the storage adapter's serialized transaction.
 */
export function createWallpaperState({
  storage = createWallpaperStorage(),
  decode = decodeWallpaperFile,
  urls = globalThis.URL,
  eventTarget = globalThis.window,
  schedule = (run) => setTimeout(run, 0),
  revision = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
} = {}) {
  const settings = ref({ ...WALLPAPER_DEFAULTS });
  const customUrl = ref("");
  const customKind = ref("");
  const busy = ref(false);
  const error = ref("");
  let customRevision = "";
  let epoch = 0;
  let disposed = false;
  let controller;
  let refreshController;
  let refreshSequence = 0;
  let refreshPending = false;
  const source = computed(() => settings.value.id === "custom" ? customUrl.value
    : WALLPAPERS.find(({ id }) => id === settings.value.id)?.src || "");
  const localizedError = (cause) => WALLPAPER_ERROR_KEYS.includes(cause?.message)
    ? cause.message : "wallpaper.error.storage";
  const isCurrent = (token) => !disposed && token === epoch;
  const release = (url) => { if (url) urls.revokeObjectURL(url); };

  function install(snapshot, url) {
    const nextSettings = normalizeWallpaperSettings(snapshot.metadata?.settings);
    if (nextSettings.id === "custom" && !snapshot.custom) throw wallpaperError("customMissing");
    const oldUrl = customUrl.value;
    settings.value = nextSettings;
    customUrl.value = url;
    customKind.value = snapshot.custom?.kind || "";
    customRevision = snapshot.custom?.revision || "";
    if (oldUrl !== url) release(oldUrl);
  }

  async function prepare(snapshot, signal) {
    if (!snapshot.custom) return "";
    if (snapshot.custom.revision === customRevision && customUrl.value) return customUrl.value;
    const kind = await validateWallpaperFile(snapshot.custom.blob);
    if (kind !== snapshot.custom.kind) throw wallpaperError("invalidFile");
    await decode(snapshot.custom.blob, kind, { signal });
    if (signal?.aborted || disposed) return "";
    return urls.createObjectURL(snapshot.custom.blob);
  }

  async function refresh() {
    if (disposed) return false;
    if (busy.value) { refreshPending = true; return false; }
    refreshController?.abort();
    const refreshAbort = new AbortController();
    refreshController = refreshAbort;
    const sequence = ++refreshSequence;
    const token = epoch;
    let url = "";
    try {
      const snapshot = await storage.read();
      if (!isCurrent(token) || sequence !== refreshSequence) return false;
      // Retained media is optional while a builtin/none is selected. Do not
      // let an unsupported video codec block restoring the saved appearance.
      // Keep an already decoded URL only if it belongs to this exact revision;
      // otherwise defer decoding until the user explicitly selects custom.
      url = normalizeWallpaperSettings(snapshot.metadata?.settings).id === "custom"
        ? await prepare(snapshot, refreshAbort.signal)
        : snapshot.custom?.revision === customRevision ? customUrl.value : "";
      if (!isCurrent(token) || sequence !== refreshSequence) {
        if (url !== customUrl.value) release(url);
        return false;
      }
      install(snapshot, url);
      error.value = "";
      return true;
    } catch (cause) {
      if (url !== customUrl.value) release(url);
      if (isCurrent(token) && sequence === refreshSequence) error.value = localizedError(cause);
      return false;
    }
  }

  function begin() {
    refreshController?.abort();
    controller?.abort();
    controller = new AbortController();
    busy.value = true;
    error.value = "";
    return { token: ++epoch, signal: controller.signal };
  }

  async function change(makeChange, file, discardCustom = false) {
    if (disposed) return false;
    const { token, signal } = begin();
    let candidateUrl = "";
    let candidate;
    try {
      if (file !== undefined) {
        const kind = await validateWallpaperFile(file);
        if (!isCurrent(token)) return false;
        await decode(file, kind, { signal });
        if (!isCurrent(token)) return false;
        candidateUrl = urls.createObjectURL(file);
        candidate = { blob: file, kind, revision: revision() };
      }
      // Decode before writing if custom will be shown. Selecting a builtin or
      // resetting must not wait for (or be blocked by) a damaged retained Blob.
      const before = await storage.read();
      if (!isCurrent(token)) return false;
      const planned = makeChange(normalizeWallpaperSettings(before.metadata?.settings), before.custom, candidate);
      if (!candidateUrl && !discardCustom) {
        candidateUrl = planned.settings.id === "custom" ? await prepare(before, signal)
          : before.custom?.revision === customRevision ? customUrl.value : "";
      }
      if (!isCurrent(token)) return false;
      const snapshot = await storage.mutate((current) => {
        if (!isCurrent(token)) return null;
        // Another window replaced custom while we were decoding. Retry rather
        // than publish settings with a URL belonging to the previous Blob.
        if (!candidate && !discardCustom && current.custom?.revision !== before.custom?.revision) {
          throw wallpaperError("storage");
        }
        const next = makeChange(normalizeWallpaperSettings(current.metadata?.settings), current.custom, candidate);
        if (next.settings.id === "custom" && !next.custom) throw wallpaperError("customMissing");
        return { metadata: { settings: next.settings, revision: revision() }, custom: next.custom };
      }, candidate);
      if (!snapshot) return false;
      if (disposed) return false;
      // A transaction already in flight commits before any newer transaction;
      // do not drop its durable result just because a new intent has started.
      install(snapshot, snapshot.custom ? candidateUrl : "");
      if (snapshot.custom) candidateUrl = ""; // Ownership transferred to store.
      return true;
    } catch (cause) {
      if (isCurrent(token)) error.value = localizedError(cause);
      return false;
    } finally {
      if (candidateUrl !== customUrl.value) release(candidateUrl);
      if (isCurrent(token)) {
        busy.value = false;
        if (refreshPending) {
          refreshPending = false;
          void refresh();
        }
      }
    }
  }

  const select = (id) => change((current, custom) => {
    if (!ids.has(id)) throw wallpaperError("unknownId");
    return { settings: { ...current, id }, custom };
  });
  const updateSettings = (patch = {}) => change((current, custom) => {
    // Selection has its own validated action. Do not accept arbitrary metadata.
    const { visibility = current.visibility, blur = current.blur, motion = current.motion } = patch || {};
    return { settings: normalizeWallpaperSettings({ ...current, visibility, blur, motion }), custom };
  });
  const reset = () => change((_current, custom) => ({ settings: { ...WALLPAPER_DEFAULTS }, custom }));
  const importFile = (file) => change((current, _custom, candidate) => ({
    settings: { ...current, id: "custom" }, custom: candidate,
  }), file ?? null);
  const removeCustom = () => change((current) => ({
    settings: { ...current, id: current.id === "custom" ? "none" : current.id }, custom: null,
  }), undefined, true);

  // Canvas/media consumers report localized failures without mutating the
  // readonly ref. Unknown text is rejected; an empty key explicitly clears it.
  function reportError(key) {
    if (disposed || (key !== "" && !WALLPAPER_ERROR_KEYS.includes(key))) return false;
    error.value = key;
    return true;
  }

  function onStorage(event) {
    if (event.key !== WALLPAPER_STORAGE_KEY && event.key !== null) return;
    // Read the current persisted revision, never the event's possibly stale
    // payload. A revision changes even when the selected ID stays "custom".
    void refresh();
  }
  eventTarget?.addEventListener("storage", onStorage);
  const ready = new Promise((resolve) => schedule(() => {
    if (disposed || epoch !== 0) resolve(false);
    else resolve(refresh());
  }));
  function dispose() {
    if (disposed) return;
    disposed = true;
    ++epoch;
    refreshController?.abort();
    controller?.abort();
    busy.value = false;
    eventTarget?.removeEventListener("storage", onStorage);
    eventTarget?.removeEventListener("pagehide", onPageHide);
    release(customUrl.value);
    customUrl.value = "";
    customKind.value = "";
    storage.close?.();
  }
  function onPageHide(event) { if (!event.persisted) dispose(); }
  eventTarget?.addEventListener("pagehide", onPageHide);
  return {
    settings: readonly(settings), customUrl: readonly(customUrl), customKind: readonly(customKind),
    busy: readonly(busy), error: readonly(error), source,
    select, updateSettings, reset, importFile, removeCustom, reportError, ready, refresh, dispose,
  };
}
