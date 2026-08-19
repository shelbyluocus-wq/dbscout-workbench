export function createTableComparisonFullscreen() {
  return {
    isFullscreen: false,
    focusedSheet: "",
    restoreTable: null,
  };
}

export function resetTableComparisonFullscreen() {
  return createTableComparisonFullscreen();
}

export function isTableStage(state) {
  return Boolean(state?.isFullscreen && state.focusedSheet);
}

export function isTableFullscreenFocused(state, sheetName) {
  return Boolean(isTableStage(state) && state.focusedSheet === sheetName);
}

export function applyExitFullscreen(state) {
  return {
    state: createTableComparisonFullscreen(),
    restoreTable: state?.restoreTable ?? null,
  };
}

export function toggleGlobalFullscreen(state) {
  if (state?.isFullscreen) return applyExitFullscreen(state);
  return {
    state: {
      isFullscreen: true,
      focusedSheet: state?.focusedSheet || "",
      restoreTable: state?.restoreTable ?? null,
    },
    restoreTable: null,
  };
}

export function toggleTableFullscreen(state, sheetName, currentTable) {
  if (!sheetName) return { state: { ...state }, restoreTable: null };
  if (isTableFullscreenFocused(state, sheetName)) return applyExitFullscreen(state);
  return {
    state: {
      isFullscreen: true,
      focusedSheet: sheetName,
      restoreTable: state?.restoreTable === null ? currentTable : state.restoreTable,
    },
    restoreTable: null,
  };
}

export function applyTableSelectionToFullscreen(state, sheetName) {
  if (!state?.focusedSheet) return { ...state };
  if (!sheetName) {
    return {
      isFullscreen: state.isFullscreen,
      focusedSheet: "",
      restoreTable: null,
    };
  }
  return {
    ...state,
    focusedSheet: sheetName,
  };
}
