// 右侧栏（备注 / AI）按页面记忆展开状态：表数据页、首页默认展开，SQL、表设计等默认收起；
// 用户手动开合后按页面类型持久化。空间紧张时先自动收起右侧栏，把宽度让给主内容区，
// 紧张期间用户手动展开会被临时尊重，恢复宽裕后清除。
export const INSPECTOR_VISIBILITY_KEY = "dbscout_inspector_visibility";
export const INSPECTOR_MAIN_COMFORT_WIDTH = 780;

const SURFACES = ["data", "home", "aux", "ai"];
const DEFAULT_COLLAPSED = { data: false, home: false, aux: true, ai: false };

export function inspectorSurfaceFor({ mode, tabKind } = {}) {
  if (mode === "ai") return "ai";
  if (tabKind === "home") return "home";
  return !tabKind || tabKind === "data" ? "data" : "aux";
}

export function readInspectorPrefs(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(INSPECTOR_VISIBILITY_KEY) || "{}");
    return Object.fromEntries(
      SURFACES.filter((surface) => typeof parsed?.[surface] === "boolean").map((surface) => [surface, parsed[surface]]),
    );
  } catch {
    return {};
  }
}

export function writeInspectorPrefs(prefs, storage = globalThis.localStorage) {
  try {
    storage?.setItem(INSPECTOR_VISIBILITY_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore quota / privacy errors */
  }
}

export function isInspectorSpaceTight({ viewportWidth, sidebarSpace, inspectorWidth }) {
  const viewport = Number(viewportWidth) || 0;
  if (viewport <= 0) return false;
  return viewport - (Number(sidebarSpace) || 0) - (Number(inspectorWidth) || 0) < INSPECTOR_MAIN_COMFORT_WIDTH;
}

export function resolveInspectorCollapsed({ surface, prefs = {}, tight = false, tightOverrides = {} }) {
  const key = SURFACES.includes(surface) ? surface : "data";
  const preferred = typeof prefs[key] === "boolean" ? prefs[key] : DEFAULT_COLLAPSED[key];
  if (preferred) return true;
  if (!tight) return false;
  return typeof tightOverrides[key] === "boolean" ? tightOverrides[key] : true;
}
