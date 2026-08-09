import { normalizeTableName } from "../utils/normalize.js";

export const TABLE_MODIFIED_TIME_REFRESH_INTERVAL_MS = 60_000;

const NO_MODIFIED_TIME = Symbol("no-modified-time");

function modifiedTimeOf(table) {
  if (Object.hasOwn(table || {}, "modified_at")) return table.modified_at;
  if (Object.hasOwn(table || {}, "modifiedAt")) return table.modifiedAt;
  return NO_MODIFIED_TIME;
}

export function mergeTableModifiedTimes(currentTables = [], latestTables = []) {
  const latestByName = new Map(
    (Array.isArray(latestTables) ? latestTables : [])
      .map((table) => [normalizeTableName(table), modifiedTimeOf(table)])
      .filter(([name, modifiedAt]) => name && modifiedAt !== NO_MODIFIED_TIME),
  );
  let updatedCount = 0;
  const nextTables = (Array.isArray(currentTables) ? currentTables : []).map((table) => {
    const name = normalizeTableName(table);
    if (!latestByName.has(name)) return table;
    const modifiedAt = latestByName.get(name);
    const currentModifiedAt = modifiedTimeOf(table);
    if (currentModifiedAt !== NO_MODIFIED_TIME && currentModifiedAt === modifiedAt) return table;
    updatedCount += 1;
    return {
      ...table,
      modified_at: modifiedAt,
      modifiedAt,
    };
  });
  return {
    tables: updatedCount > 0 ? nextTables : currentTables,
    updatedCount,
  };
}

export function createTableModifiedTimeAutoRefresh({
  refresh,
  getSource,
  intervalMs = TABLE_MODIFIED_TIME_REFRESH_INTERVAL_MS,
  now = () => Date.now(),
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (timer) => globalThis.clearTimeout(timer),
} = {}) {
  const safeIntervalMs = Math.max(1, Number(intervalMs) || TABLE_MODIFIED_TIME_REFRESH_INTERVAL_MS);
  let active = false;
  let refreshing = false;
  let timer = null;
  let nextRefreshAt = 0;
  let generation = 0;

  function schedule(currentGeneration) {
    if (!active || currentGeneration !== generation) return;
    const delay = Math.max(0, nextRefreshAt - now());
    timer = setTimer(() => {
      timer = null;
      void run(currentGeneration);
    }, delay);
  }

  async function run(currentGeneration) {
    if (!active || currentGeneration !== generation) return;
    const currentTime = now();
    do {
      nextRefreshAt += safeIntervalMs;
    } while (nextRefreshAt <= currentTime);
    schedule(currentGeneration);

    if (refreshing || typeof refresh !== "function") return;
    const source = typeof getSource === "function" ? getSource() : null;
    if (!source?.connectionId || !source?.database) return;

    refreshing = true;
    try {
      await refresh(source);
    } catch {
      // Automatic metadata refresh is intentionally invisible and retries on the next interval.
    } finally {
      refreshing = false;
    }
  }

  function start() {
    if (active) return;
    active = true;
    generation += 1;
    nextRefreshAt = now() + safeIntervalMs;
    schedule(generation);
  }

  function stop() {
    if (!active && timer == null) return;
    active = false;
    generation += 1;
    if (timer != null) clearTimer(timer);
    timer = null;
  }

  return { start, stop };
}
