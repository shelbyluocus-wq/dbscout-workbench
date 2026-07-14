const QUICK_OPEN_SIZE_KEY = "dbscout.quickOpen.size.v1";

export const QUICK_OPEN_DEFAULT_SIZE = Object.freeze({ width: 760, height: 520 });
export const QUICK_OPEN_MIN_SIZE = Object.freeze({ width: 560, height: 360 });

function finiteDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizedViewport(viewport = {}) {
  return {
    width: Math.max(320, finiteDimension(viewport.width) || QUICK_OPEN_DEFAULT_SIZE.width),
    height: Math.max(240, finiteDimension(viewport.height) || QUICK_OPEN_DEFAULT_SIZE.height),
  };
}

export function clampQuickOpenSize(size = {}, viewport = {}) {
  const { width: safeWidth, height: safeHeight } = normalizedViewport(viewport);
  const maxWidth = Math.max(Math.min(QUICK_OPEN_MIN_SIZE.width, safeWidth - 24), safeWidth - 24);
  const maxHeight = Math.max(Math.min(QUICK_OPEN_MIN_SIZE.height, safeHeight - 24), safeHeight - 24);
  const minWidth = Math.min(QUICK_OPEN_MIN_SIZE.width, maxWidth);
  const minHeight = Math.min(QUICK_OPEN_MIN_SIZE.height, maxHeight);
  return {
    width: Math.round(Math.min(maxWidth, Math.max(minWidth, finiteDimension(size.width) || QUICK_OPEN_DEFAULT_SIZE.width))),
    height: Math.round(Math.min(maxHeight, Math.max(minHeight, finiteDimension(size.height) || QUICK_OPEN_DEFAULT_SIZE.height))),
  };
}

export function loadQuickOpenSize(storage = globalThis?.localStorage, viewport = {}) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(QUICK_OPEN_SIZE_KEY) || "null");
    if (parsed?.version === 2) {
      const currentViewport = normalizedViewport(viewport);
      const widthRatio = Number(parsed.widthRatio);
      const heightRatio = Number(parsed.heightRatio);
      if (
        Number.isFinite(widthRatio) && widthRatio > 0
        && Number.isFinite(heightRatio) && heightRatio > 0
      ) {
        return clampQuickOpenSize({
          width: currentViewport.width * widthRatio,
          height: currentViewport.height * heightRatio,
        }, currentViewport);
      }
      return clampQuickOpenSize(QUICK_OPEN_DEFAULT_SIZE, currentViewport);
    }
    if (parsed?.version !== 1) return clampQuickOpenSize(QUICK_OPEN_DEFAULT_SIZE, viewport);
    return clampQuickOpenSize(parsed, viewport);
  } catch {
    return clampQuickOpenSize(QUICK_OPEN_DEFAULT_SIZE, viewport);
  }
}

export function saveQuickOpenSize(size, storage = globalThis?.localStorage, viewport = {
  width: globalThis?.innerWidth,
  height: globalThis?.innerHeight,
}) {
  try {
    const currentViewport = normalizedViewport(viewport);
    const safeSize = clampQuickOpenSize(size, currentViewport);
    storage?.setItem?.(QUICK_OPEN_SIZE_KEY, JSON.stringify({
      version: 2,
      widthRatio: safeSize.width / currentViewport.width,
      heightRatio: safeSize.height / currentViewport.height,
    }));
  } catch {
    // Local preferences must never make Quick Open unusable.
  }
}

export function scaleQuickOpenSize(size, previousViewport = {}, nextViewport = {}) {
  const previous = normalizedViewport(previousViewport);
  const next = normalizedViewport(nextViewport);
  return clampQuickOpenSize({
    width: (finiteDimension(size.width) || QUICK_OPEN_DEFAULT_SIZE.width) * next.width / previous.width,
    height: (finiteDimension(size.height) || QUICK_OPEN_DEFAULT_SIZE.height) * next.height / previous.height,
  }, next);
}

export function createQuickOpenScopeState() {
  return { mode: "auto", selectedTables: [] };
}

export function syncQuickOpenScopeResults(state, tableNames = [], hasScopeQuery = false) {
  const available = [...new Set(tableNames.map((name) => String(name || "")).filter(Boolean))];
  if (state.mode === "auto") {
    state.selectedTables = hasScopeQuery ? available : [];
    return state;
  }
  return state;
}

export function toggleQuickOpenScopeTable(state, tableName, checked) {
  const name = String(tableName || "");
  if (!name) return state;
  state.mode = "custom";
  const selected = new Set(state.selectedTables);
  if (checked) selected.add(name);
  else selected.delete(name);
  state.selectedTables = [...selected];
  return state;
}

export function resetQuickOpenScopeToResults(state, tableNames = [], hasScopeQuery = false) {
  state.mode = "auto";
  state.selectedTables = hasScopeQuery
    ? [...new Set(tableNames.map((name) => String(name || "")).filter(Boolean))]
    : [];
  return state;
}

export function quickOpenIncludedTables(state, hasScopeQuery = false) {
  return hasScopeQuery ? [...state.selectedTables] : [];
}

export function quickOpenValueSearchDisabled(state, hasScopeQuery = false) {
  return hasScopeQuery && state.selectedTables.length === 0;
}
