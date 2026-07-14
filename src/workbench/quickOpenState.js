const QUICK_OPEN_SIZE_KEY = "dbscout.quickOpen.size.v1";

export const QUICK_OPEN_DEFAULT_SIZE = Object.freeze({ width: 760, height: 520 });
export const QUICK_OPEN_MIN_SIZE = Object.freeze({ width: 560, height: 360 });
export const QUICK_OPEN_RESULT_BATCH_SIZE = 60;
export const QUICK_OPEN_MAX_MOUNTED_RESULTS = 120;

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
  return { mode: "auto", excludedTables: [] };
}

export function syncQuickOpenScopeResults(state) {
  if (!Array.isArray(state.excludedTables)) state.excludedTables = [];
  return state;
}

export function toggleQuickOpenScopeTable(state, tableName, checked) {
  const name = String(tableName || "");
  if (!name) return state;
  state.mode = "custom";
  const excluded = new Set(state.excludedTables);
  if (checked) excluded.delete(name);
  else excluded.add(name);
  state.excludedTables = [...excluded];
  return state;
}

export function resetQuickOpenScopeToResults(state) {
  state.mode = "auto";
  state.excludedTables = [];
  return state;
}

export function quickOpenScopeTableSelected(state, tableName, hasScopeQuery = false) {
  if (!hasScopeQuery) return true;
  return !state.excludedTables.includes(String(tableName || ""));
}

export function quickOpenIncludedTables(state, tableNames = [], hasScopeQuery = false) {
  if (!hasScopeQuery) return [];
  const excluded = new Set(state.excludedTables);
  return [...new Set(tableNames.map((name) => String(name || "")).filter(Boolean))]
    .filter((name) => !excluded.has(name));
}

export function quickOpenValueSearchDisabled(state, tableNames = [], hasScopeQuery = false) {
  if (!hasScopeQuery) return false;
  const excluded = new Set(state.excludedTables);
  return !tableNames.some((name) => {
    const normalized = String(name || "");
    return normalized && !excluded.has(normalized);
  });
}

function normalizedResultTotal(total) {
  return Math.max(0, Math.floor(Number(total) || 0));
}

export function createQuickOpenResultWindow(total = 0) {
  return {
    start: 0,
    size: Math.min(QUICK_OPEN_RESULT_BATCH_SIZE, normalizedResultTotal(total)),
  };
}

export function resetQuickOpenResultWindow(state, total = 0) {
  state.start = 0;
  state.size = Math.min(QUICK_OPEN_RESULT_BATCH_SIZE, normalizedResultTotal(total));
  return state;
}

export function quickOpenResultRange(state, total = 0) {
  const safeTotal = normalizedResultTotal(total);
  const size = Math.min(
    QUICK_OPEN_MAX_MOUNTED_RESULTS,
    Math.max(0, Math.floor(Number(state?.size) || 0)),
    safeTotal,
  );
  const start = Math.min(
    Math.max(0, safeTotal - size),
    Math.max(0, Math.floor(Number(state?.start) || 0)),
  );
  return { start, end: Math.min(safeTotal, start + size) };
}

export function advanceQuickOpenResultWindow(state, total = 0, direction = "down") {
  const safeTotal = normalizedResultTotal(total);
  const range = quickOpenResultRange(state, safeTotal);
  if (!safeTotal) return false;
  if (direction === "up") {
    if (range.start === 0) return false;
    state.start = Math.max(0, range.start - QUICK_OPEN_RESULT_BATCH_SIZE);
    state.size = Math.min(QUICK_OPEN_MAX_MOUNTED_RESULTS, safeTotal);
    return true;
  }
  if (range.end >= safeTotal) return false;
  if (range.end - range.start < QUICK_OPEN_MAX_MOUNTED_RESULTS) {
    state.size = Math.min(QUICK_OPEN_MAX_MOUNTED_RESULTS, safeTotal - range.start);
    return true;
  }
  state.start = Math.min(
    Math.max(0, safeTotal - QUICK_OPEN_MAX_MOUNTED_RESULTS),
    range.start + QUICK_OPEN_RESULT_BATCH_SIZE,
  );
  state.size = Math.min(QUICK_OPEN_MAX_MOUNTED_RESULTS, safeTotal);
  return true;
}

export function ensureQuickOpenResultMounted(state, index, total = 0) {
  const safeTotal = normalizedResultTotal(total);
  if (!safeTotal) return resetQuickOpenResultWindow(state, 0);
  const target = Math.max(0, Math.min(safeTotal - 1, Math.floor(Number(index) || 0)));
  let range = quickOpenResultRange(state, safeTotal);
  if (target >= range.start && target < range.end) return state;
  if (target >= range.end && range.start === 0 && range.end < QUICK_OPEN_MAX_MOUNTED_RESULTS) {
    state.size = Math.min(QUICK_OPEN_MAX_MOUNTED_RESULTS, safeTotal);
    range = quickOpenResultRange(state, safeTotal);
    if (target < range.end) return state;
  }
  const size = Math.min(
    QUICK_OPEN_MAX_MOUNTED_RESULTS,
    Math.max(QUICK_OPEN_RESULT_BATCH_SIZE, range.end - range.start),
    safeTotal,
  );
  const chunkStart = Math.floor(target / QUICK_OPEN_RESULT_BATCH_SIZE) * QUICK_OPEN_RESULT_BATCH_SIZE;
  state.start = Math.max(0, Math.min(safeTotal - size, chunkStart - (size - QUICK_OPEN_RESULT_BATCH_SIZE)));
  state.size = size;
  return state;
}
