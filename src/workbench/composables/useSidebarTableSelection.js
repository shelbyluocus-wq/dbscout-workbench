import { computed, reactive } from "vue";
import {
  createSelectionRecall,
  nextListSelection,
  selectionOpenPlan,
} from "../utils/listSelection.js";

function tableNameOf(table) {
  return String(table?.tableName || table?.table_name || "").trim();
}

/**
 * Multi-selection for the sidebar table list. A plain click still opens the
 * table right away; Ctrl/Cmd+click and Shift+click only build a selection,
 * which Enter, double-click, Delete and the context menu then act on. The
 * rules are the shared list rules, so the sidebar and the database home page
 * behave the same.
 *
 * @param {object} options
 * @param {import("vue").Ref<Array>} options.tables tables in display order
 * @param {import("vue").Ref<string>} options.activeTableName table of the active tab, used as the
 *   range anchor before the user has clicked anything in this list
 */
export function useSidebarTableSelection({ tables, activeTableName }) {
  const state = reactive({ names: [], anchor: "", focused: "" });
  const recall = createSelectionRecall();
  const order = computed(() => (Array.isArray(tables.value) ? tables.value : []).map(tableNameOf).filter(Boolean));
  const selectedSet = computed(() => new Set(state.names));
  const isMultiple = computed(() => state.names.length > 1);

  function anchorFor() {
    if (state.anchor && order.value.includes(state.anchor)) return state.anchor;
    const active = String(activeTableName.value || "");
    return order.value.includes(active) ? active : "";
  }

  function apply(name, event = {}) {
    const next = nextListSelection({
      order: order.value,
      selected: state.names,
      anchor: anchorFor(),
      name,
      event,
    });
    state.names = next.selected;
    state.anchor = next.anchor;
    state.focused = name;
  }

  /**
   * @returns {"open" | "select" | "ignore"} what the click should do
   */
  function click(name, event = {}) {
    if (!name) return "ignore";
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      recall.clear();
      apply(name, event);
      return "select";
    }
    // The second click of a double-click keeps the selection for the
    // double-click that follows.
    if (Number(event.detail) > 1) return "ignore";
    recall.remember(name, state.names);
    apply(name, {});
    return "open";
  }

  // The plan for a double-click: the whole selection when the row belongs to
  // one (restoring what the first click collapsed), otherwise nothing extra.
  function doubleClick(name) {
    const restored = recall.recall(name);
    if (restored) {
      state.names = restored;
      state.focused = name;
    }
    if (!isMultiple.value || !selectedSet.value.has(name)) return null;
    return selectionOpenPlan(name, state.names, order.value);
  }

  function openPlan(name = state.focused) {
    return selectionOpenPlan(name, state.names, order.value);
  }

  // Tables an action on `name` covers: the selection when `name` is part of
  // it, otherwise `name` alone (which then becomes the selection).
  function targets(name) {
    if (name && !selectedSet.value.has(name)) apply(name, {});
    return name ? [...state.names] : [];
  }

  // `from` is the row that has keyboard focus; it wins over remembered state
  // because Tab or a click elsewhere can move focus without selecting.
  function move(delta, { extend = false, from = "" } = {}) {
    const list = order.value;
    const amount = Number(delta) || 0;
    if (!list.length || !amount) return "";
    const active = String(activeTableName.value || "");
    const current = [from, state.focused, active].find((name) => name && list.includes(name)) || "";
    const index = list.indexOf(current);
    let nextIndex;
    if (!Number.isFinite(amount)) nextIndex = amount > 0 ? list.length - 1 : 0;
    else if (index < 0) nextIndex = amount > 0 ? 0 : list.length - 1;
    else nextIndex = Math.max(0, Math.min(list.length - 1, index + Math.trunc(amount)));
    const name = list[nextIndex];
    recall.clear();
    apply(name, extend ? { shiftKey: true } : {});
    return name;
  }

  function selectAll() {
    recall.clear();
    state.names = [...order.value];
    state.anchor = state.names[0] || "";
    if (!state.names.includes(state.focused)) state.focused = state.names.at(-1) || "";
  }

  function clear() {
    recall.clear();
    state.names = [];
    state.anchor = "";
    state.focused = "";
  }

  // Keeps only tables that still exist after the list reloads.
  function prune() {
    const valid = new Set(order.value);
    state.names = state.names.filter((name) => valid.has(name));
    if (!valid.has(state.anchor)) state.anchor = "";
    if (!valid.has(state.focused)) state.focused = "";
  }

  return {
    state,
    selectedSet,
    isMultiple,
    order,
    click,
    doubleClick,
    openPlan,
    targets,
    move,
    selectAll,
    clear,
    prune,
  };
}
