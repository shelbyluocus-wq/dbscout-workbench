import { reactive } from "vue";

// 选中单元格文本超过该长度（字符数，不含）时详情面板自动展开。
export const CELL_DETAIL_AUTO_EXPAND_LENGTH = 80;
const COLLAPSED_STORAGE_KEY = "dbscout_cell_detail_collapsed";

// 自动展开纯判定：文本长度 > 80 或含换行符时展开；空值/短文本不触发。
// 反向（自动收起）刻意不提供——收起只由用户手动触发。
export function shouldAutoExpandCellDetail(text) {
  if (text === null || text === undefined) return false;
  const value = String(text);
  return value.length > CELL_DETAIL_AUTO_EXPAND_LENGTH || value.includes("\n") || value.includes("\r");
}

// 与 usePaneResize 相同的 "1"/"0" localStorage 模式；默认收起。
export function loadCellDetailCollapsed(storage = globalThis?.localStorage) {
  try {
    const raw = storage?.getItem?.(COLLAPSED_STORAGE_KEY);
    return raw === null || raw === undefined ? true : raw === "1";
  } catch {
    return true;
  }
}

export function saveCellDetailCollapsed(collapsed, storage = globalThis?.localStorage) {
  try {
    storage?.setItem?.(COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    /* localStorage 不可用（隐私模式等）时静默忽略，收起态仅本次会话生效 */
  }
}

// 详情面板收起/展开状态工厂：手动开关 + 长文本自动展开，全部持久化。
// UI 组件只消费 state.collapsed 与这三个方法，不自行判定展开规则。
export function createCellDetailVisibility({ storage = globalThis?.localStorage } = {}) {
  const state = reactive({ collapsed: loadCellDetailCollapsed(storage) });

  function setCollapsed(next) {
    const value = Boolean(next);
    if (state.collapsed === value) return;
    state.collapsed = value;
    saveCellDetailCollapsed(value, storage);
  }

  function toggleCollapsed() {
    setCollapsed(!state.collapsed);
  }

  // 选中单元格变化时调用：仅在收起态且文本命中自动展开规则时展开；
  // 已展开时无论选中文本长短都不动（绝不自动收起）。
  function notifySelectedText(text) {
    if (state.collapsed && shouldAutoExpandCellDetail(text)) setCollapsed(false);
  }

  return { state, setCollapsed, toggleCollapsed, notifySelectedText };
}
