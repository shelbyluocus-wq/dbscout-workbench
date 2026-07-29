import { ref } from "vue";

const STORAGE_KEY = "dbscout_database_decorations";
const DEFAULT_ICON = "database";
const ICON_IDS = new Set(["database", "boxes", "shield", "flask", "rocket", "archive", "star", "cloud"]);
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export const DATABASE_DECORATION_ICONS = Object.freeze([
  { id: "database", label: "数据库" },
  { id: "boxes", label: "模块" },
  { id: "shield", label: "安全" },
  { id: "flask", label: "实验" },
  { id: "rocket", label: "生产" },
  { id: "archive", label: "归档" },
  { id: "star", label: "重点" },
  { id: "cloud", label: "云端" },
]);

export const DATABASE_DECORATION_COLORS = Object.freeze([
  "#64748b",
  "#0f766e",
  "#2563eb",
  "#7c3aed",
  "#b45309",
  "#c2410c",
  "#be123c",
  "#15803d",
]);

export const DATABASE_TEXT_COLOR_PRESETS = Object.freeze([
  { value: "preset:slate", label: "岩灰", cssColor: "var(--wb-database-name-slate)", light: "#475569", dark: "#cbd5e1" },
  { value: "preset:teal", label: "青绿", cssColor: "var(--wb-database-name-teal)", light: "#0f766e", dark: "#5eead4" },
  { value: "preset:blue", label: "蔚蓝", cssColor: "var(--wb-database-name-blue)", light: "#1d4ed8", dark: "#93c5fd" },
  { value: "preset:violet", label: "紫罗兰", cssColor: "var(--wb-database-name-violet)", light: "#6d28d9", dark: "#c4b5fd" },
  { value: "preset:amber", label: "琥珀", cssColor: "var(--wb-database-name-amber)", light: "#92400e", dark: "#fbbf24" },
  { value: "preset:orange", label: "橙色", cssColor: "var(--wb-database-name-orange)", light: "#9a3412", dark: "#fdba74" },
  { value: "preset:rose", label: "玫红", cssColor: "var(--wb-database-name-rose)", light: "#9f1239", dark: "#fda4af" },
  { value: "preset:green", label: "绿色", cssColor: "var(--wb-database-name-green)", light: "#166534", dark: "#86efac" },
]);

const TEXT_COLOR_PRESETS = new Map(DATABASE_TEXT_COLOR_PRESETS.map((preset) => [preset.value, preset]));

function readStorage(storage) {
  try {
    const value = JSON.parse(storage?.getItem(STORAGE_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeStorage(storage, value) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Local display preferences are best effort.
  }
}

function scopeKey(connectionId) {
  return String(connectionId || "default");
}

export function normalizeDatabaseDecoration(value = {}) {
  const icon = ICON_IDS.has(String(value.icon || "")) ? String(value.icon) : DEFAULT_ICON;
  const color = HEX_COLOR_PATTERN.test(String(value.color || "")) ? String(value.color).toLowerCase() : "";
  const requestedTextColor = String(value.textColor || "").toLowerCase();
  const textColor = TEXT_COLOR_PRESETS.has(requestedTextColor) || HEX_COLOR_PATTERN.test(requestedTextColor)
    ? requestedTextColor
    : "";
  return { icon, color, textColor };
}

export function databaseTextColorCss(value) {
  const normalized = String(value || "").toLowerCase();
  return TEXT_COLOR_PRESETS.get(normalized)?.cssColor || (HEX_COLOR_PATTERN.test(normalized) ? normalized : "");
}

export function resolveDatabaseDecoration(map, connectionId, database) {
  const raw = map?.[scopeKey(connectionId)]?.[String(database || "")];
  if (!raw || typeof raw !== "object") return null;
  const normalized = normalizeDatabaseDecoration(raw);
  return normalized.icon === DEFAULT_ICON && !normalized.color && !normalized.textColor ? null : normalized;
}

export function createDatabaseDecorationStore({ storage = globalThis.localStorage } = {}) {
  const decorations = ref(readStorage(storage));

  function getDatabaseDecoration(connectionId, database) {
    return resolveDatabaseDecoration(decorations.value, connectionId, database);
  }

  function setDatabaseDecoration(connectionId, database, value = {}) {
    const databaseName = String(database || "");
    if (!databaseName) return;
    const key = scopeKey(connectionId);
    const normalized = normalizeDatabaseDecoration(value);
    const next = { ...(decorations.value || {}) };
    const scope = { ...(next[key] || {}) };
    if (normalized.icon === DEFAULT_ICON && !normalized.color && !normalized.textColor) delete scope[databaseName];
    else scope[databaseName] = normalized;
    if (Object.keys(scope).length) next[key] = scope;
    else delete next[key];
    decorations.value = next;
    writeStorage(storage, next);
  }

  function pruneDatabaseDecorations(connectionId, databaseNames = []) {
    const key = scopeKey(connectionId);
    const scope = decorations.value?.[key];
    if (!scope || typeof scope !== "object") return;
    const allowed = new Set(databaseNames.map(String));
    const nextScope = Object.fromEntries(Object.entries(scope).filter(([name]) => allowed.has(name)));
    const next = { ...(decorations.value || {}) };
    if (Object.keys(nextScope).length) next[key] = nextScope;
    else delete next[key];
    decorations.value = next;
    writeStorage(storage, next);
  }

  function removeConnectionDecorations(connectionId) {
    const key = scopeKey(connectionId);
    if (decorations.value?.[key] == null) return;
    const next = { ...decorations.value };
    delete next[key];
    decorations.value = next;
    writeStorage(storage, next);
  }

  return {
    decorations,
    getDatabaseDecoration,
    setDatabaseDecoration,
    pruneDatabaseDecorations,
    removeConnectionDecorations,
  };
}

const sharedStore = createDatabaseDecorationStore();

export function useDatabaseDecorations() {
  return sharedStore;
}
