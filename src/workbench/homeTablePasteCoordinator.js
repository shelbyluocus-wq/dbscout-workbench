function normalizeDatabaseSource(source = {}) {
  return {
    connectionId: String(source?.connectionId || ""),
    database: String(source?.database || ""),
  };
}

export function isSameDatabaseSource(left, right) {
  const normalizedLeft = normalizeDatabaseSource(left);
  const normalizedRight = normalizeDatabaseSource(right);
  return Boolean(
    normalizedLeft.connectionId
    && normalizedLeft.database
    && normalizedLeft.connectionId === normalizedRight.connectionId
    && normalizedLeft.database === normalizedRight.database,
  );
}

export function createHomeTablePasteCoordinator({
  getCommittedSource = () => ({}),
  onWaitForNavigation = () => {},
} = {}) {
  let navigation = null;
  let navigationSequence = 0;
  let pastePromise = null;

  function trackNavigation(target, promise) {
    const record = {
      id: ++navigationSequence,
      target: normalizeDatabaseSource(target),
      promise: Promise.resolve(promise),
    };
    navigation = record;

    const clearIfCurrent = () => {
      if (navigation?.id === record.id) navigation = null;
    };
    record.promise.then(clearIfCurrent, clearIfCurrent);
    return record.promise;
  }

  async function runWhenReady(target, action) {
    if (pastePromise) return { ok: false, reason: "paste-pending" };

    const normalizedTarget = normalizeDatabaseSource(target);
    const task = (async () => {
      const matchingNavigation = navigation && isSameDatabaseSource(navigation.target, normalizedTarget)
        ? navigation
        : null;
      if (matchingNavigation) {
        onWaitForNavigation(normalizedTarget);
        const opened = await matchingNavigation.promise;
        if (opened !== true) return { ok: false, reason: "navigation-failed" };
      }

      if (!isSameDatabaseSource(getCommittedSource(), normalizedTarget)) {
        return { ok: false, reason: "target-not-ready" };
      }

      return { ok: true, value: await action(normalizedTarget) };
    })();
    pastePromise = task;

    try {
      return await task;
    } finally {
      if (pastePromise === task) pastePromise = null;
    }
  }

  return {
    trackNavigation,
    runWhenReady,
    isPasting: () => Boolean(pastePromise),
  };
}
