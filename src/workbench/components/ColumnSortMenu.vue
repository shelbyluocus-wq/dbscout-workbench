<script setup>
import { t } from "../i18n/index.js";
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ArrowDown, ArrowUp, ChevronDown, Filter, Search, X } from "lucide-vue-next";
import { COLUMN_FILTER_OPERATORS, isNoValueOperator } from "../utils/columnFilter.js";

const props = defineProps({
  column: { type: String, required: true },
  sort: { type: Object, default: null },
  columnFilter: { type: Object, default: null },
  fetchDistinctValues: { type: Function, default: null },
});

const emit = defineEmits(["apply-sort", "apply-column-filter"]);

const theme = inject("theme", ref("light"));
const open = ref(false);
const rootRef = ref(null);
const menuRef = ref(null);
const menuPosition = ref({ left: 8, top: 8 });

const filterTab = ref("values");
const valueSearch = ref("");
const distinctItems = ref([]);
const distinctTruncated = ref(false);
const distinctLoading = ref(false);
const selectedValues = ref([]);
const selectedNull = ref(false);
const conditionOp = ref("contains");
const conditionValue = ref("");

let distinctSeq = 0;
let searchTimer = null;

const isSorted = computed(() => props.sort?.columnName === props.column);
const isFiltered = computed(() => Boolean(props.columnFilter));
const supportsFilter = computed(() => typeof props.fetchDistinctValues === "function");

const currentLabel = computed(() => {
  if (!isSorted.value) return "";
  return props.sort?.descending ? t("m_4b77c3546823") : t("m_ca715c0d8d83");
});

const menuStyle = computed(() => ({
  left: `${menuPosition.value.left}px`,
  top: `${menuPosition.value.top}px`,
}));

const selectedValueSet = computed(() => new Set(selectedValues.value));
const selectedCount = computed(() => selectedValues.value.length + (selectedNull.value ? 1 : 0));

const visibleDistinctItems = computed(() => {
  const items = [...distinctItems.value];
  if (!valueSearch.value.trim()) {
    const present = new Set(items.filter((i) => i.value !== null).map((i) => i.value));
    const hasNullItem = items.some((i) => i.value === null);
    if (selectedNull.value && !hasNullItem) {
      items.unshift({ value: null, count: 0 });
    }
    for (const val of selectedValues.value) {
      if (!present.has(val)) {
        items.push({ value: val, count: 0 });
      }
    }
  }
  return items;
});

const canApplyFilter = computed(() => {
  if (filterTab.value === "values") {
    return selectedCount.value > 0 || isFiltered.value;
  }
  if (!conditionOp.value) return false;
  if (isNoValueOperator(conditionOp.value)) return true;
  return conditionValue.value.length > 0;
});

function syncFilterDraftFromProp() {
  const rule = props.columnFilter;
  valueSearch.value = "";
  if (rule) {
    selectedValues.value = Array.isArray(rule.values) ? [...rule.values] : [];
    selectedNull.value = Boolean(rule.includeNull);
    conditionOp.value = rule.operator || "contains";
    conditionValue.value = rule.value || "";
    filterTab.value = rule.operator && !selectedValues.value.length && !selectedNull.value
      ? "condition"
      : "values";
  } else {
    selectedValues.value = [];
    selectedNull.value = false;
    conditionOp.value = "contains";
    conditionValue.value = "";
    filterTab.value = "values";
  }
}

async function loadDistinctValues() {
  if (!supportsFilter.value || !open.value) return;
  const seq = ++distinctSeq;
  distinctLoading.value = true;
  try {
    const result = await props.fetchDistinctValues(props.column, valueSearch.value.trim());
    if (seq !== distinctSeq || !open.value) return;
    distinctItems.value = Array.isArray(result?.values) ? result.values : [];
    distinctTruncated.value = Boolean(result?.truncated);
  } catch {
    if (seq !== distinctSeq || !open.value) return;
    distinctItems.value = [];
    distinctTruncated.value = false;
  } finally {
    if (seq === distinctSeq) {
      distinctLoading.value = false;
      nextTick(updateMenuPosition);
    }
  }
}

watch(valueSearch, () => {
  if (!open.value || filterTab.value !== "values") return;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    void loadDistinctValues();
  }, 180);
});

watch(filterTab, (nextTab) => {
  if (!open.value) return;
  if (nextTab === "values" && !distinctItems.value.length && !distinctLoading.value) {
    void loadDistinctValues();
  }
  nextTick(updateMenuPosition);
});

function updateMenuPosition() {
  const triggerRect = rootRef.value?.getBoundingClientRect?.();
  if (!triggerRect) return;

  const viewportWidth = globalThis.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = globalThis.innerHeight || document.documentElement.clientHeight;
  const menuWidth = menuRef.value?.offsetWidth || (supportsFilter.value ? 248 : 112);
  const menuHeight = menuRef.value?.offsetHeight || (supportsFilter.value ? 310 : 86);
  const margin = 8;
  const gap = 4;
  const belowTop = triggerRect.bottom + gap;
  const aboveTop = triggerRect.top - menuHeight - gap;

  menuPosition.value = {
    left: Math.min(
      Math.max(margin, triggerRect.right - menuWidth),
      Math.max(margin, viewportWidth - menuWidth - margin),
    ),
    top: belowTop + menuHeight <= viewportHeight - margin || aboveTop < margin
      ? Math.min(belowTop, Math.max(margin, viewportHeight - menuHeight - margin))
      : aboveTop,
  };
}

function closeMenu() {
  open.value = false;
  distinctSeq += 1;
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  document.removeEventListener("keydown", onDocumentKeydown);
  window.removeEventListener("resize", updateMenuPosition);
  window.removeEventListener("scroll", updateMenuPosition, true);
}

function openMenu() {
  if (open.value) return;
  open.value = true;
  if (supportsFilter.value) {
    syncFilterDraftFromProp();
    distinctItems.value = [];
    distinctTruncated.value = false;
    if (filterTab.value === "values") {
      void loadDistinctValues();
    }
  }
  document.addEventListener("pointerdown", onDocumentPointerDown);
  document.addEventListener("keydown", onDocumentKeydown);
  window.addEventListener("resize", updateMenuPosition);
  window.addEventListener("scroll", updateMenuPosition, true);
  updateMenuPosition();
  nextTick(updateMenuPosition);
}

function toggleMenu() {
  if (open.value) closeMenu();
  else openMenu();
}

function onDocumentPointerDown(event) {
  if (rootRef.value?.contains?.(event.target) || menuRef.value?.contains?.(event.target)) return;
  closeMenu();
}

function onDocumentKeydown(event) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closeMenu();
}

function apply(direction) {
  emit("apply-sort", direction);
  closeMenu();
}

function toggleValueOption(item) {
  if (item.value === null) {
    selectedNull.value = !selectedNull.value;
    return;
  }
  const next = new Set(selectedValues.value);
  if (next.has(item.value)) next.delete(item.value);
  else next.add(item.value);
  selectedValues.value = Array.from(next);
}

function selectAllVisible() {
  const next = new Set(selectedValues.value);
  for (const item of visibleDistinctItems.value) {
    if (item.value === null) selectedNull.value = true;
    else next.add(item.value);
  }
  selectedValues.value = Array.from(next);
}

function invertVisibleSelection() {
  const next = new Set(selectedValues.value);
  for (const item of visibleDistinctItems.value) {
    if (item.value === null) {
      selectedNull.value = !selectedNull.value;
    } else if (next.has(item.value)) {
      next.delete(item.value);
    } else {
      next.add(item.value);
    }
  }
  selectedValues.value = Array.from(next);
}

function clearDraftValues() {
  selectedValues.value = [];
  selectedNull.value = false;
}

function submitFilter() {
  if (!canApplyFilter.value) return;
  if (filterTab.value === "values") {
    if (selectedCount.value === 0) {
      emit("apply-column-filter", null);
    } else {
      emit("apply-column-filter", {
        column: props.column,
        values: [...selectedValues.value],
        includeNull: selectedNull.value,
        operator: "",
        value: "",
      });
    }
  } else {
    emit("apply-column-filter", {
      column: props.column,
      values: [],
      includeNull: false,
      operator: conditionOp.value,
      value: isNoValueOperator(conditionOp.value) ? "" : conditionValue.value,
    });
  }
  closeMenu();
}

function clearFilter() {
  emit("apply-column-filter", null);
  closeMenu();
}

function valueOptionLabel(value) {
  if (value === null) return t("grid.columnFilter.emptyValue");
  if (value === "") return '""';
  return value;
}

onBeforeUnmount(closeMenu);
</script>

<template>
  <span
    ref="rootRef"
    class="wb-column-sort"
    :class="{ 'is-open': open, 'is-sorted': isSorted, 'is-filtered': isFiltered }"
    @click.stop
    @mousedown.stop
  >
    <button
      type="button"
      class="wb-column-sort-trigger"
      :class="{ 'is-sorted': isSorted, 'is-filtered': isFiltered }"
      :title="t('grid.sortColumn', { column })"
      :aria-label="t('grid.sortColumnMenu', { column })"
      :aria-expanded="open ? 'true' : 'false'"
      aria-haspopup="menu"
      @click.stop="toggleMenu"
    >
      <span class="wb-column-sort-icon" aria-hidden="true">
        <ArrowUp v-if="isSorted && !sort?.descending" :size="13" :stroke-width="2.3" />
        <ArrowDown v-else-if="isSorted" :size="13" :stroke-width="2.3" />
        <Filter v-else-if="isFiltered" :size="12" :stroke-width="2.2" />
        <ChevronDown v-else :size="13" :stroke-width="2" />
      </span>
      <Filter
        v-if="isSorted && isFiltered"
        class="wb-column-sort-filter-badge"
        :size="11"
        :stroke-width="2.2"
        aria-hidden="true"
      />
      <span v-if="currentLabel" class="wb-column-sort-state">{{ currentLabel }}</span>
    </button>

    <Teleport to="body">
      <Transition name="wb-column-sort-menu">
        <menu
          v-if="open"
          ref="menuRef"
          class="wb-column-sort-menu wb-floating-themed"
          :class="{ 'has-filter': supportsFilter }"
          :data-theme="theme"
          :style="menuStyle"
          role="menu"
          @click.stop
          @pointerdown.stop
        >
          <div class="wb-column-sort-actions">
            <button
              type="button"
              role="menuitem"
              :class="{ active: isSorted && !sort?.descending }"
              @click="apply('ascending')"
            ><ArrowUp :size="13" :stroke-width="2" aria-hidden="true" />{{ t('m_4eee42bb07d1') }}</button>
            <button
              type="button"
              role="menuitem"
              :class="{ active: isSorted && sort?.descending }"
              @click="apply('descending')"
            ><ArrowDown :size="13" :stroke-width="2" aria-hidden="true" />{{ t('m_d587546d90f2') }}</button>
            <button
              type="button"
              role="menuitem"
              :disabled="!isSorted"
              @click="apply('none')"
            ><X :size="13" :stroke-width="2" aria-hidden="true" />{{ t('m_acae948f157d') }}</button>
          </div>

          <template v-if="supportsFilter">
            <div class="wb-column-menu-divider" role="separator"></div>
            <div class="wb-column-filter-section">
              <div class="wb-column-filter-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  class="wb-column-filter-tab"
                  :class="{ 'is-active': filterTab === 'values' }"
                  :aria-selected="filterTab === 'values'"
                  @click="filterTab = 'values'"
                >{{ t('grid.columnFilter.byValues') }}</button>
                <button
                  type="button"
                  role="tab"
                  class="wb-column-filter-tab"
                  :class="{ 'is-active': filterTab === 'condition' }"
                  :aria-selected="filterTab === 'condition'"
                  @click="filterTab = 'condition'"
                >{{ t('grid.columnFilter.byCondition') }}</button>
              </div>

              <div v-if="filterTab === 'values'" class="wb-column-filter-values">
                <div class="wb-column-filter-search">
                  <Search :size="12" aria-hidden="true" />
                  <input
                    v-model="valueSearch"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    :placeholder="t('grid.columnFilter.searchValues')"
                  />
                  <button
                    v-if="valueSearch"
                    type="button"
                    class="wb-column-filter-search-clear"
                    :aria-label="t('m_ee32f25f7050')"
                    @click="valueSearch = ''"
                  ><X :size="11" aria-hidden="true" /></button>
                </div>
                <div class="wb-column-filter-quick">
                  <button type="button" @click="selectAllVisible">{{ t('grid.columnFilter.selectAll') }}</button>
                  <button type="button" @click="invertVisibleSelection">{{ t('grid.columnFilter.invert') }}</button>
                  <button type="button" :disabled="selectedCount === 0" @click="clearDraftValues">{{ t('grid.columnFilter.clearSelection') }}</button>
                  <span v-if="selectedCount > 0" class="wb-column-filter-selected-count">{{ selectedCount }}</span>
                </div>
                <div class="wb-column-filter-list">
                  <div v-if="distinctLoading" class="wb-column-filter-empty">{{ t('grid.columnFilter.loading') }}</div>
                  <div v-else-if="!visibleDistinctItems.length" class="wb-column-filter-empty">{{ t('grid.columnFilter.noValues') }}</div>
                  <label
                    v-for="item in visibleDistinctItems"
                    v-else
                    :key="item.value === null ? '__NULL__' : `v:${item.value}`"
                    class="wb-column-filter-option"
                    :class="{ 'is-null': item.value === null }"
                  >
                    <input
                      type="checkbox"
                      :checked="item.value === null ? selectedNull : selectedValueSet.has(item.value)"
                      @change="toggleValueOption(item)"
                    />
                    <span class="wb-column-filter-option-text" :title="valueOptionLabel(item.value)">{{ valueOptionLabel(item.value) }}</span>
                    <span v-if="item.count > 0" class="wb-column-filter-option-count">{{ item.count }}</span>
                  </label>
                </div>
                <p v-if="distinctTruncated && !distinctLoading" class="wb-column-filter-truncated">
                  {{ t('grid.columnFilter.truncatedHint') }}
                </p>
              </div>

              <div v-else class="wb-column-filter-condition">
                <select v-model="conditionOp" class="wb-column-filter-select">
                  <option v-for="op in COLUMN_FILTER_OPERATORS" :key="op" :value="op">
                    {{ t(`grid.columnFilter.op.${op}`) }}
                  </option>
                </select>
                <input
                  v-if="!isNoValueOperator(conditionOp)"
                  v-model="conditionValue"
                  type="text"
                  class="wb-column-filter-input"
                  autocomplete="off"
                  spellcheck="false"
                  :placeholder="t('grid.columnFilter.valuePlaceholder')"
                  @keydown.enter.prevent="submitFilter"
                />
              </div>

              <div class="wb-column-filter-footer">
                <button
                  v-if="isFiltered"
                  type="button"
                  class="wb-column-filter-reset"
                  @click="clearFilter"
                >{{ t('grid.columnFilter.clear') }}</button>
                <button
                  type="button"
                  class="wb-column-filter-apply"
                  :disabled="!canApplyFilter"
                  @click="submitFilter"
                >{{ t('grid.columnFilter.apply') }}</button>
              </div>
            </div>
          </template>
        </menu>
      </Transition>
    </Teleport>
  </span>
</template>
