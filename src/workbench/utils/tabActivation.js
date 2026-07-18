function clonePosition(position) {
  return position ? { ...position } : null;
}

function cloneRange(range) {
  if (!range) return null;
  const cloned = {
    ...range,
    anchor: clonePosition(range.anchor),
    focus: clonePosition(range.focus),
  };
  if (range.shiftAnchor) cloned.shiftAnchor = clonePosition(range.shiftAnchor);
  if (Array.isArray(range.toggledCells)) cloned.toggledCells = range.toggledCells.map(clonePosition).filter(Boolean);
  return cloned;
}

function cloneEditorState(state) {
  if (!state) return null;
  return {
    selectedCell: clonePosition(state.selectedCell),
    selectedRange: cloneRange(state.selectedRange),
    selectedInsertCell: clonePosition(state.selectedInsertCell),
    selectedInsertRow: clonePosition(state.selectedInsertRow),
    textDraft: String(state.textDraft || ""),
  };
}

export function tableTabViewRevision(tab) {
  return Math.max(0, Math.floor(Number(tab?.tableViewRevision) || 0));
}

export function captureTableTabViewState(tab, { scrollTop = 0, scrollLeft = 0, editor = null } = {}) {
  if (!tab?.id) return null;
  const state = {
    revision: tableTabViewRevision(tab),
    scrollTop: Math.max(0, Number(scrollTop) || 0),
    scrollLeft: Math.max(0, Number(scrollLeft) || 0),
    editor: cloneEditorState(editor),
  };
  tab.tableViewState = state;
  return state;
}

export function readTableTabViewState(tab) {
  const state = tab?.tableViewState;
  if (!state || Number(state.revision) !== tableTabViewRevision(tab)) return null;
  return {
    revision: state.revision,
    scrollTop: Math.max(0, Number(state.scrollTop) || 0),
    scrollLeft: Math.max(0, Number(state.scrollLeft) || 0),
    editor: cloneEditorState(state.editor),
  };
}

export function resetTableTabViewState(tab) {
  if (!tab) return 0;
  tab.tableViewRevision = tableTabViewRevision(tab) + 1;
  tab.tableViewState = null;
  return tab.tableViewRevision;
}
