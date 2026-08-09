const DEFAULT_MAX_BACKGROUND_PER_SOURCE = 2;
const SOURCE_SEPARATOR = "\u001f";

// Automatic table work still completes, but no more than two jobs per database
// can occupy the shared five-connection read pool. New background jobs also
// wait while a first-page open is in flight, leaving foreground capacity free.

function sourceKey({ connectionId = "", database = "" } = {}) {
  return `${String(connectionId || "").trim()}${SOURCE_SEPARATOR}${String(database || "").trim()}`;
}

export function createDatabaseWorkPriority({
  maxBackgroundPerSource = DEFAULT_MAX_BACKGROUND_PER_SOURCE,
} = {}) {
  const backgroundLimit = Math.max(
    1,
    Math.floor(Number(maxBackgroundPerSource) || DEFAULT_MAX_BACKGROUND_PER_SOURCE),
  );
  const lanes = new Map();
  let disposed = false;

  function laneFor(source) {
    const key = sourceKey(source);
    let lane = lanes.get(key);
    if (!lane) {
      lane = {
        foregroundCount: 0,
        activeBackgroundCount: 0,
        backgroundQueue: [],
      };
      lanes.set(key, lane);
    }
    return { key, lane };
  }

  function cleanupLane(key, lane) {
    if (
      lanes.get(key) === lane
      && lane.foregroundCount === 0
      && lane.activeBackgroundCount === 0
      && lane.backgroundQueue.length === 0
    ) {
      lanes.delete(key);
    }
  }

  function finishBackground(key, lane) {
    lane.activeBackgroundCount = Math.max(0, lane.activeBackgroundCount - 1);
    drainLane(key, lane);
    cleanupLane(key, lane);
  }

  function startBackground(key, lane, entry) {
    queueMicrotask(() => {
      if (disposed) {
        entry.resolve(undefined);
        finishBackground(key, lane);
        return;
      }
      if (lane.foregroundCount > 0) {
        lane.activeBackgroundCount = Math.max(0, lane.activeBackgroundCount - 1);
        lane.backgroundQueue.unshift(entry);
        return;
      }

      let result;
      try {
        result = entry.task();
      } catch (error) {
        entry.reject(error);
        finishBackground(key, lane);
        return;
      }
      Promise.resolve(result)
        .then(entry.resolve, entry.reject)
        .finally(() => finishBackground(key, lane));
    });
  }

  function drainLane(key, lane) {
    if (disposed || lane.foregroundCount > 0) return;
    while (
      lane.foregroundCount === 0
      && lane.activeBackgroundCount < backgroundLimit
      && lane.backgroundQueue.length > 0
    ) {
      const entry = lane.backgroundQueue.shift();
      lane.activeBackgroundCount += 1;
      startBackground(key, lane, entry);
    }
  }

  function beginForeground(source) {
    if (disposed) return () => {};
    const { key, lane } = laneFor(source);
    lane.foregroundCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lane.foregroundCount = Math.max(0, lane.foregroundCount - 1);
      drainLane(key, lane);
      cleanupLane(key, lane);
    };
  }

  function runBackground(source, task) {
    if (typeof task !== "function") return Promise.reject(new TypeError("background task is required"));
    if (disposed) return Promise.resolve(undefined);
    const { key, lane } = laneFor(source);
    return new Promise((resolve, reject) => {
      lane.backgroundQueue.push({ task, resolve, reject });
      drainLane(key, lane);
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [key, lane] of lanes) {
      const queued = lane.backgroundQueue.splice(0);
      queued.forEach((entry) => entry.resolve(undefined));
      cleanupLane(key, lane);
    }
  }

  return {
    beginForeground,
    runBackground,
    dispose,
  };
}
