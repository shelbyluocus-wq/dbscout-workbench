// Remembered open/closed state of the relation page's sections. The graph
// keeps its own options (see relationGraph.js); these cover the row and table
// lists and the rejected group, which starts closed.

export const RELATION_PANEL_STORAGE_KEY = "dbscout_relation_panel_sections";
export const DEFAULT_RELATION_PANEL_SECTIONS = Object.freeze({ row: true, table: true, rejected: false });

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function normalize(saved) {
  const sections = { ...DEFAULT_RELATION_PANEL_SECTIONS };
  for (const key of Object.keys(sections)) {
    if (typeof saved?.[key] === "boolean") sections[key] = saved[key];
  }
  return sections;
}

export function loadRelationPanelSections(storage = defaultStorage()) {
  try {
    const saved = JSON.parse(storage?.getItem(RELATION_PANEL_STORAGE_KEY) || "null");
    return normalize(saved && typeof saved === "object" ? saved : null);
  } catch {
    return { ...DEFAULT_RELATION_PANEL_SECTIONS };
  }
}

export function saveRelationPanelSections(sections, storage = defaultStorage()) {
  try {
    storage?.setItem(RELATION_PANEL_STORAGE_KEY, JSON.stringify(normalize(sections)));
  } catch {
    // Storage may be full or blocked; the state still applies this session.
  }
}
