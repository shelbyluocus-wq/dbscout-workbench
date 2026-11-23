import { normalizeTableName } from "../utils/normalize.js";

export const TABLE_MODIFIED_TIME_REFRESH_INTERVAL_MS = 60_000;
export const TABLE_MODIFIED_TIMES_UPDATED_EVENT = "table-modified-times-updated";

const NO_MODIFIED_TIME = Symbol("no-modified-time");

function modifiedTimeOf(table) {
  if (Object.hasOwn(table || {}, "modified_at")) return table.modified_at;
  if (Object.hasOwn(table || {}, "modifiedAt")) return table.modifiedAt;
  return NO_MODIFIED_TIME;
}

function modifiedSourceOf(table) {
  if (Object.hasOwn(table || {}, "modified_source")) return table.modified_source ?? null;
  if (Object.hasOwn(table || {}, "modifiedSource")) return table.modifiedSource ?? null;
  return undefined;
}

function modifiedActorOf(table) {
  if (Object.hasOwn(table || {}, "modified_actor")) return table.modified_actor ?? null;
  if (Object.hasOwn(table || {}, "modifiedActor")) return table.modifiedActor ?? null;
  return undefined;
}

export function mergeTableModifiedTimes(currentTables = [], latestTables = []) {
  const latestByName = new Map(
    (Array.isArray(latestTables) ? latestTables : [])
      .map((table) => [
        normalizeTableName(table),
        {
          modifiedAt: modifiedTimeOf(table),
          modifiedSource: modifiedSourceOf(table),
          modifiedActor: modifiedActorOf(table),
        },
      ])
      .filter(([name, info]) => name && info.modifiedAt !== NO_MODIFIED_TIME),
  );
  let updatedCount = 0;
  const nextTables = (Array.isArray(currentTables) ? currentTables : []).map((table) => {
    const name = normalizeTableName(table);
    if (!latestByName.has(name)) return table;
    const latest = latestByName.get(name);
    const currentModifiedAt = modifiedTimeOf(table);
    const nextModifiedAt = latest.modifiedAt || (currentModifiedAt !== NO_MODIFIED_TIME ? currentModifiedAt : latest.modifiedAt);
    const currentSource = modifiedSourceOf(table) ?? null;
    const nextSource = latest.modifiedSource !== undefined ? latest.modifiedSource : currentSource;
    const currentActor = modifiedActorOf(table) ?? null;
    const nextActor = latest.modifiedActor !== undefined ? latest.modifiedActor : currentActor;

    if (
      currentModifiedAt !== NO_MODIFIED_TIME
      && currentModifiedAt === nextModifiedAt
      && currentSource === nextSource
      && currentActor === nextActor
    ) {
      return table;
    }
    updatedCount += 1;
    const next = {
      ...table,
      modified_at: nextModifiedAt,
      modifiedAt: nextModifiedAt,
    };
    if (latest.modifiedSource !== undefined || currentSource !== null) {
      next.modified_source = nextSource;
      next.modifiedSource = nextSource;
    }
    if (latest.modifiedActor !== undefined || currentActor !== null) {
      next.modified_actor = nextActor;
      next.modifiedActor = nextActor;
    }
    return next;
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
