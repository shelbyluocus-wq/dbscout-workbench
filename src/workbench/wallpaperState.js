import { computed, readonly, ref } from "vue";
import { createWallpaperStorage, WALLPAPER_STORAGE_KEY, wallpaperError } from "./wallpaperStorage.js";

export { WALLPAPER_STORAGE_KEY } from "./wallpaperStorage.js";
export const WALLPAPER_APPEARANCES = Object.freeze(["light", "dark"]);
// suits: the appearance in which a picture shows at full strength, because
// frame text stays readable over all of it (see wallpaperTone.js); "" for
// pictures that are dimmed in both. pair: its counterpart for the other
// appearance.
export const WALLPAPERS = Object.freeze([
  ["mist-ridges", "light", "night-ridges"], ["frost-folds", "light", "indigo-folds"],
  ["dune-dawn", "", "dune-night"], ["ocean-clouds"],
  ["night-ridges", "dark", "mist-ridges"], ["indigo-folds", "dark", "frost-folds"],
  ["dune-night", "dark", "dune-dawn"], ["night-launch"], ["silent-orbits"], ["planet-dawn"],
  ["dune-sphere"], ["rose-quartz"],
].map(([id, suits = "", pair = ""]) => Object.freeze({
  id,
  suits,
  pair,
  labelKey: `wallpaper.builtin.${id}`,
  src: `/wallpapers/${id}.webp`,
  thumbnail: `/wallpapers/thumbnails/${id}.webp`,
})));
// Where the picture shows: "window" also behind the content panes, under a
// veil the person sets (contentReveal: 0 = as veiled as "frame", 1 = the
// lightest veil that still separates content from the picture); "frame" only
// in the title bar, rail, sidebar and tab strips.
export const WALLPAPER_SCOPES = Object.freeze(["window", "frame"]);
// Each appearance keeps its own picture, visibility and blur; the recommended
// pair is what a new installation and Reset show. Scope, content reveal and
// motion are shared by both appearances.
export const WALLPAPER_DEFAULTS = Object.freeze({
  light: Object.freeze({ id: "frost-folds", visibility: 1, blur: 0 }),
  dark: Object.freeze({ id: "indigo-folds", visibility: 0.48, blur: 0 }),
  motion: false,
  scope: "window",
  contentReveal: 0.56,
});
const defaults = () => ({
  light: { ...WALLPAPER_DEFAULTS.light }, dark: { ...WALLPAPER_DEFAULTS.dark },
  motion: false, scope: WALLPAPER_DEFAULTS.scope, contentReveal: WALLPAPER_DEFAULTS.contentReveal,
});
export const WALLPAPER_LIMITS = Object.freeze({ image: 20 * 1024 * 1024, video: 100 * 1024 * 1024 });
export const WALLPAPER_ERROR_KEYS = Object.freeze([
  "unsupportedType", "imageTooLarge", "videoTooLarge", "invalidFile", "decode", "playback",
  "storage", "settings", "unknownId", "customMissing",
].map((code) => `wallpaper.error.${code}`));
const ids = new Set(["none", ...WALLPAPERS.map(({ id }) => id)]);
const isCustom = (id) => typeof id === "string" && /^custom(?:-[a-zA-Z0-9-]+)?$/.test(id);
const validId = (id) => ids.has(id) || isCustom(id);
const newRevision = () => globalThis.crypto?.randomUUID?.()
  || "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (letter) => {
    const value = Math.floor(Math.random() * 16);
    return (letter === "x" ? value : (value & 3) | 8).toString(16);
  });
const mimeKinds = { "image/png": "image", "image/jpeg": "image", "image/webp": "image", "video/mp4": "video" };
const clamp = (value, min, max, fallback) => typeof value === "number" && Number.isFinite(value)
  ? Math.max(min, Math.min(max, value)) : fallback;

const isAppearance = (value) => WALLPAPER_APPEARANCES.includes(value);
const selectedCustoms = (settings) => new Set(WALLPAPER_APPEARANCES
  .map((appearance) => settings[appearance].id).filter(isCustom));
function normalizeAppearance(value, fallbackVisibility) {
  value = value && typeof value === "object" ? value : {};
  return {
    id: validId(value.id) ? value.id : "none",
    visibility: clamp(value.visibility, 0, 1, fallbackVisibility),
    blur: clamp(value.blur, 0, 24, 0),
  };
}

// Visibility is a fraction of what the picture can show while frame text stays
// readable (see wallpaperTone.js); blur is CSS pixels (0–24). Nothing saved
// yields the recommended pair. Settings saved by the single-wallpaper version
// ({ id, visibility, blur }) apply to both appearances. Unknown values fall
// back per field. Callers change settings through methods, not ref writes.
export function normalizeWallpaperSettings(value) {
  if (!value || typeof value !== "object") return defaults();
  const shared = {
    motion: typeof value.motion === "boolean" ? value.motion : false,
    scope: WALLPAPER_SCOPES.includes(value.scope) ? value.scope : WALLPAPER_DEFAULTS.scope,
    contentReveal: clamp(value.contentReveal, 0, 1, WALLPAPER_DEFAULTS.contentReveal),
  };
  if ("light" in value || "dark" in value) {
    return {
      light: normalizeAppearance(value.light, WALLPAPER_DEFAULTS.light.visibility),
      dark: normalizeAppearance(value.dark, WALLPAPER_DEFAULTS.dark.visibility),
      ...shared,
    };
  }
  const single = normalizeAppearance(value, 0.25);
  return { light: single, dark: { ...single }, ...shared };
}

// Opacity of the content veil (the workspace colour over the picture). The
// frame-only scope keeps the original near-solid sheet.
export const WALLPAPER_FRAME_VEIL = 0.9;
export const WALLPAPER_MIN_VEIL = 0.12;
export function wallpaperContentVeil({ scope, contentReveal }) {
  if (scope !== "window") return WALLPAPER_FRAME_VEIL;
  const veil = WALLPAPER_FRAME_VEIL - (WALLPAPER_FRAME_VEIL - WALLPAPER_MIN_VEIL) * contentReveal;
  return Math.round(veil * 1000) / 1000;
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
 * browser errors. `appearance` is the appearance on screen (set by the shell);
 * `active` and `source` (a URL string or "") follow it; `contentVeil` is the
 * opacity of the workspace colour over the picture behind content panes. select, updateSettings
 * and importFile take the appearance to change and default to the one on
 * screen. customWallpapers is a readonly ref of { id, name, kind, url } entries.
 * customUrl/customKind describe only the active appearance's custom wallpaper.
 * Reset restores the recommended pair but retains the entire custom library.
 * Initialization is scheduled, not awaited by the shell; ready is optional.
 * All mutation decisions run inside the storage adapter's serialized transaction.
 */
export function createWallpaperState({
  storage = createWallpaperStorage(),
  decode = decodeWallpaperFile,
  urls = globalThis.URL,
  eventTarget = globalThis.window,
  schedule = (run) => setTimeout(run, 0),
  revision = newRevision,
} = {}) {
  // The small settings record is readable synchronously, so a bundled picture
  // is on screen from the first frame; selected custom media joins after decode.
  const settings = ref(normalizeWallpaperSettings(storage.peek?.()?.settings));
  const appearance = ref("light");
  const customWallpapers = ref([]);
  let media = new Map();
  const busy = ref(false);
  const error = ref("");
  let epoch = 0;
  let disposed = false;
  let controller;
  let refreshController;
  let refreshSequence = 0;
  let refreshPending = false;
  const active = computed(() => settings.value[appearance.value]);
  const activeCustom = computed(() => customWallpapers.value.find(({ id }) => id === active.value.id));
  const customUrl = computed(() => activeCustom.value?.url || "");
  const customKind = computed(() => activeCustom.value?.kind || "");
  const source = computed(() => isCustom(active.value.id) ? customUrl.value
    : WALLPAPERS.find(({ id }) => id === active.value.id)?.src || "");
  const contentVeil = computed(() => wallpaperContentVeil(settings.value));
  const target = (value) => isAppearance(value) ? value : appearance.value;
  const localizedError = (cause) => WALLPAPER_ERROR_KEYS.includes(cause?.message)
    ? cause.message : "wallpaper.error.storage";
  const isCurrent = (token) => !disposed && token === epoch;
  const release = (url) => { if (url) urls.revokeObjectURL(url); };

  const library = (snapshot) => snapshot.customs || (snapshot.custom
    ? [{ ...snapshot.custom, id: "custom", name: snapshot.custom.name || snapshot.custom.blob?.name || "" }] : []);
  function checkSelection(nextSettings, customs) {
    const available = new Set(customs.map(({ id }) => id));
    for (const id of selectedCustoms(nextSettings)) {
      if (!available.has(id)) throw wallpaperError("customMissing");
    }
  }
  function cleanup(prepared) {
    const retained = new Set([...media.values()].map(({ url }) => url));
    for (const { url } of prepared.values()) if (!retained.has(url)) release(url);
  }
  function install(snapshot, prepared) {
    const nextSettings = normalizeWallpaperSettings(snapshot.metadata?.settings);
    const customs = library(snapshot);
    checkSelection(nextSettings, customs);
    const next = new Map();
    // A concurrent window may add unselected files after preparation. They do
    // not need decoding; object URLs are cheap handles, not decoded images.
    for (const custom of customs) {
      const cached = prepared.get(custom.id) || media.get(custom.id);
      const entry = cached?.revision === custom.revision ? cached
        : { revision: custom.revision, url: urls.createObjectURL(custom.blob), decoded: false };
      prepared.set(custom.id, entry); // Caller cleans up even if a later URL creation fails.
      next.set(custom.id, entry);
    }
    const previous = media;
    media = next;
    customWallpapers.value = customs.map(({ id, name = "", kind }) => ({ id, name, kind, url: next.get(id).url }));
    settings.value = nextSettings;
    cleanup(previous);
  }

  async function prepare(customs, nextSettings, signal, prepared, candidate) {
    checkSelection(nextSettings, customs);
    const selected = selectedCustoms(nextSettings);
    for (const custom of customs) {
      const cached = media.get(custom.id);
      const entry = cached?.revision === custom.revision ? { ...cached } : {
        revision: custom.revision, url: "", decoded: custom === candidate,
      };
      if (selected.has(custom.id) && !entry.decoded) {
        const kind = await validateWallpaperFile(custom.blob);
        if (kind !== custom.kind) throw wallpaperError("invalidFile");
        await decode(custom.blob, kind, { signal });
        entry.decoded = true;
      }
      if (signal.aborted || disposed) return;
      if (!entry.url) entry.url = urls.createObjectURL(custom.blob);
      prepared.set(custom.id, entry);
    }
  }

  async function refresh({ keepError = false } = {}) {
    if (disposed) return false;
    if (busy.value) { refreshPending = true; return false; }
    refreshController?.abort();
    const refreshAbort = new AbortController();
    refreshController = refreshAbort;
    const sequence = ++refreshSequence;
    const token = epoch;
    const prepared = new Map();
    try {
      const snapshot = await storage.read();
      if (!isCurrent(token) || sequence !== refreshSequence) return false;
      await prepare(library(snapshot), normalizeWallpaperSettings(snapshot.metadata?.settings), refreshAbort.signal, prepared);
      if (!isCurrent(token) || sequence !== refreshSequence) return false;
      install(snapshot, prepared);
      if (!keepError) error.value = "";
      return true;
    } catch (cause) {
      if (isCurrent(token) && sequence === refreshSequence) error.value = localizedError(cause);
      return false;
    } finally { cleanup(prepared); }
  }

  function begin() {
    refreshController?.abort();
    controller?.abort();
    controller = new AbortController();
    busy.value = true;
    error.value = "";
    return { token: ++epoch, signal: controller.signal };
  }

  // optimistic: settings to show at once (slider drags, picking a bundled
  // picture) instead of after the write; a failed write puts the saved
  // settings back.
  async function change(makeChange, file, optimistic) {
    if (disposed) return false;
    const { token, signal } = begin();
    const shown = settings.value;
    if (optimistic) settings.value = optimistic;
    const prepared = new Map();
    let candidate;
    let failed = false;
    try {
      if (file !== undefined) {
        const kind = await validateWallpaperFile(file);
        if (!isCurrent(token)) return false;
        await decode(file, kind, { signal });
        if (!isCurrent(token)) return false;
        candidate = { id: `custom-${revision()}`, name: typeof file.name === "string" ? file.name : "", blob: file, kind, revision: revision() };
      }
      // Decode before writing if custom will be shown. Selecting a builtin or
      // resetting must not wait for (or be blocked by) a damaged retained Blob.
      const before = await storage.read();
      if (!isCurrent(token)) return false;
      const planned = makeChange(normalizeWallpaperSettings(before.metadata?.settings), library(before), candidate);
      await prepare(planned.customs, planned.settings, signal, prepared, candidate);
      if (!isCurrent(token)) return false;
      const snapshot = await storage.mutate((current) => {
        if (!isCurrent(token)) return null;
        const next = makeChange(normalizeWallpaperSettings(current.metadata?.settings), library(current), candidate);
        checkSelection(next.settings, next.customs);
        // Never publish a selected Blob that changed while it was decoding.
        // Unrelated additions/deletions are merged from this transaction.
        for (const id of selectedCustoms(next.settings)) {
          const custom = next.customs.find((entry) => entry.id === id);
          if (prepared.get(id)?.revision !== custom.revision) throw wallpaperError("storage");
        }
        return { metadata: { settings: next.settings, revision: revision() }, customs: next.customs };
      }, candidate);
      if (!snapshot) return false;
      if (disposed) return false;
      // Do not overwrite newer optimistic settings with a late commit. Its
      // durable library changes are picked up after the latest action finishes.
      if (!isCurrent(token)) {
        if (busy.value) refreshPending = true;
        else void refresh({ keepError: true });
        return false;
      }
      install(snapshot, prepared);
      return true;
    } catch (cause) {
      if (isCurrent(token)) {
        error.value = localizedError(cause);
        failed = true;
        if (optimistic) settings.value = shown;
      }
      return false;
    } finally {
      cleanup(prepared);
      if (isCurrent(token)) {
        busy.value = false;
        if (refreshPending || (failed && optimistic)) {
          refreshPending = false;
          void refresh({ keepError: failed });
        }
      }
    }
  }

  // The appearance is fixed when the action starts: a theme switch during a
  // slow decode must not move the change to the other appearance.
  const select = (id, appearanceToChange) => {
    const key = target(appearanceToChange);
    const plan = (current) => ({ ...current, [key]: { ...current[key], id } });
    // Custom media is shown only after its decode, so it is never optimistic.
    const optimistic = ids.has(id) ? plan(settings.value) : undefined;
    return change((current, customs) => {
      if (!validId(id)) throw wallpaperError("unknownId");
      return { settings: plan(current), customs };
    }, undefined, optimistic);
  };
  const updateSettings = (patch = {}, appearanceToChange) => {
    const key = target(appearanceToChange);
    const plan = (current) => {
      // Selection has its own validated action. Do not accept arbitrary metadata.
      const {
        visibility = current[key].visibility, blur = current[key].blur, motion = current.motion,
        scope = current.scope, contentReveal = current.contentReveal,
      } = patch || {};
      return normalizeWallpaperSettings({
        ...current, [key]: { ...current[key], visibility, blur }, motion, scope, contentReveal,
      });
    };
    return change((current, customs) => ({ settings: plan(current), customs }), undefined, plan(settings.value));
  };
  const reset = () => change((_current, customs) => ({ settings: defaults(), customs }));
  const importFile = (file, appearanceToChange) => {
    const key = target(appearanceToChange);
    return change((current, customs, candidate) => ({
      settings: { ...current, [key]: { ...current[key], id: candidate.id } }, customs: [...customs, candidate],
    }), file ?? null);
  };
  const removeCustom = (id = active.value.id) => change((current, customs) => {
    if (!isCustom(id)) throw wallpaperError("unknownId");
    const without = (entry) => entry.id === id ? { ...entry, id: "none" } : entry;
    return {
      settings: { ...current, light: without(current.light), dark: without(current.dark) },
      customs: customs.filter((entry) => entry.id !== id),
    };
  });
  function setAppearance(value) {
    if (!disposed && isAppearance(value)) appearance.value = value;
  }

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
    // payload. A revision changes even when the selected ID stays the same.
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
    const previous = media;
    media = new Map();
    cleanup(previous);
    customWallpapers.value = [];
    storage.close?.();
  }
  function onPageHide(event) { if (!event.persisted) dispose(); }
  eventTarget?.addEventListener("pagehide", onPageHide);
  return {
    settings: readonly(settings), appearance: readonly(appearance), active,
    customWallpapers: readonly(customWallpapers), customUrl, customKind,
    busy: readonly(busy), error: readonly(error), source, contentVeil,
    select, updateSettings, reset, importFile, removeCustom, setAppearance, reportError, ready, refresh, dispose,
  };
}
