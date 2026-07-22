<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useEscClose } from "../composables/useEscClose.js";
import { useConfirm } from "../composables/useConfirm.js";
import { gridSelectionCount } from "../utils/gridCellSelection.js";
import { findSearchRanges, highlightSearchRanges, contiguousSearchPreview } from "../utils/searchMatch.js";

const props = defineProps({
  // focusedPaneState：当前焦点 pane 的能力注册表（选区、定位、替换等）。
  paneState: { type: Object, required: true },
  invokeWorkbench: { type: Function, required: true },
  // "find" | "replace"：打开时停在哪一页（Ctrl+F / Ctrl+H）。
  initialTab: { type: String, default: "find" },
});

const emit = defineEmits(["close", "replaced-all"]);

const isBusy = ref(false);
useEscClose(() => true, () => emit("close"), () => isBusy.value);
const { confirm } = useConfirm();

const activeTab = ref(props.initialTab === "replace" ? "replace" : "find");
watch(() => props.initialTab, (tab) => {
  activeTab.value = tab === "replace" ? "replace" : "find";
});

const findInputRef = ref(null);
const query = ref("");
const replacement = ref("");
const caseSensitive = ref(false);
const feedback = ref({ kind: "", text: "" });

const findText = computed(() => query.value.trim());
const hasTab = computed(() => Boolean(props.paneState.activeDataTab));

// Excel 语义：多选单元格时只在选区内查找替换，否则范围为整张表（含未加载页）。
const selectionRange = computed(() => {
  const range = props.paneState.selectedRange;
  const tab = props.paneState.activeDataTab;
  if (!range || !tab || range.tabId !== tab.id) return null;
  return gridSelectionCount(range) > 1 ? range : null;
});
const selectionCellCount = computed(() => (selectionRange.value ? gridSelectionCount(selectionRange.value) : 0));
const scopeIsSelection = computed(() => Boolean(selectionRange.value));

/* ── 命中结果列表 ── */
const matches = ref([]);
const activeIndex = ref(-1);
const listLoading = ref(false);
const listError = ref("");
const totalCells = ref(0);
const totalOccurrences = ref(0);
const truncated = ref(false);
let listTimer = null;
let listSeq = 0;

const columnLabelByName = computed(() => {
  const map = new Map();
  for (const column of props.paneState.activeColumns || []) {
    const name = String(column?.column_name ?? column?.columnName ?? "");
    if (!name) continue;
    const comment = String(column?.column_comment ?? column?.columnComment ?? "").trim();
    map.set(name, comment || name);
  }
  return map;
});

function columnLabel(name) {
  return columnLabelByName.value.get(name) || name;
}

function identityLabel(rowIdentity) {
  const entries = Object.entries(rowIdentity || {});
  if (!entries.length) return "（新增行）";
  return entries.map(([key, value]) => `${key}=${value ?? "NULL"}`).join(" + ");
}

function matchPreviewHtml(match) {
  const preview = contiguousSearchPreview(match.value, findText.value, 72);
  return highlightSearchRanges(preview, findSearchRanges(preview, findText.value, { caseSensitive: caseSensitive.value }));
}

const activeMatch = computed(() => (activeIndex.value >= 0 ? matches.value[activeIndex.value] || null : null));

const listSummary = computed(() => {
  if (!findText.value) return "";
  if (!totalCells.value) return "没有匹配内容";
  const base = scopeIsSelection.value
    ? `选区内命中 ${totalCells.value} 个单元格（共 ${totalOccurrences.value} 处）`
    : `共 ${totalOccurrences.value} 处，涉及 ${totalCells.value} 个单元格`;
  return truncated.value ? `${base}，仅显示前 ${matches.value.length} 条` : base;
});

function applySelectionList() {
  const items = props.paneState.listSelectionMatches?.({
    query: findText.value,
    caseSensitive: caseSensitive.value,
  }) || [];
  matches.value = items;
  totalCells.value = items.length;
  totalOccurrences.value = items.reduce((sum, item) => sum + item.occurrences, 0);
  truncated.value = false;
  listError.value = "";
}

async function applyTableList(seq) {
  const tab = props.paneState.activeDataTab;
  if (!tab?.sessionId) return;
  listLoading.value = true;
  listError.value = "";
  try {
    const result = await props.invokeWorkbench("find_in_table", {
      request: {
        sessionId: tab.sessionId,
        query: findText.value,
        caseSensitive: caseSensitive.value,
        limit: 500,
      },
    });
    if (seq !== listSeq) return;
    matches.value = Array.isArray(result?.matches) ? result.matches : [];
    totalCells.value = Number(result?.totalCells) || 0;
    totalOccurrences.value = Number(result?.totalOccurrences) || 0;
    truncated.value = Boolean(result?.truncated);
  } catch (error) {
    if (seq !== listSeq) return;
    matches.value = [];
    totalCells.value = 0;
    totalOccurrences.value = 0;
    truncated.value = false;
    listError.value = String(error?.message || error);
  } finally {
    if (seq === listSeq) listLoading.value = false;
  }
}

function scheduleListRefresh() {
  activeIndex.value = -1;
  if (listTimer) {
    clearTimeout(listTimer);
    listTimer = null;
  }
  const seq = ++listSeq;
  if (!findText.value || !hasTab.value) {
    matches.value = [];
    totalCells.value = 0;
    totalOccurrences.value = 0;
    truncated.value = false;
    listError.value = "";
    listLoading.value = false;
    return;
  }
  if (scopeIsSelection.value) {
    applySelectionList();
    return;
  }
  listLoading.value = true;
  listTimer = setTimeout(() => {
    listTimer = null;
    void applyTableList(seq);
  }, 350);
}

watch(
  [
    findText,
    caseSensitive,
    scopeIsSelection,
    selectionCellCount,
    // 选区内容只在选区范围内影响列表；整表范围内跳转产生的选区变化（单元格
    // 收拢）不能触发列表刷新，否则当前命中下标会被重置、替换永远只导航。
    () => (scopeIsSelection.value ? props.paneState.selectedRange : null),
  ],
  scheduleListRefresh,
  { immediate: true },
);

onBeforeUnmount(() => {
  if (listTimer) clearTimeout(listTimer);
});

/* ── 导航与跳转 ── */
const canNavigate = computed(() => hasTab.value && matches.value.length > 0 && !isBusy.value);

async function jumpToMatch(index) {
  const match = matches.value[index];
  if (!match) return;
  activeIndex.value = index;
  await props.paneState.locateListMatch?.(match);
}

async function goToNext() {
  if (!canNavigate.value) return;
  await jumpToMatch((activeIndex.value + 1) % matches.value.length);
}

async function goToPrevious() {
  if (!canNavigate.value) return;
  await jumpToMatch((activeIndex.value - 1 + matches.value.length) % matches.value.length);
}

function setFeedback(kind, text) {
  feedback.value = { kind, text };
}

/* ── 替换 ── */
const canReplace = computed(() => hasTab.value && Boolean(findText.value) && !isBusy.value);

async function replaceCurrent() {
  if (!canReplace.value) return;
  if (!activeMatch.value) {
    await goToNext();
    return;
  }
  const index = activeIndex.value;
  const match = activeMatch.value;
  isBusy.value = true;
  setFeedback("", "");
  try {
    const result = await props.paneState.replaceListMatch?.({
      match,
      query: findText.value,
      replacement: replacement.value,
      caseSensitive: caseSensitive.value,
    });
    if (!result?.ok) {
      setFeedback("error", result?.reason || "替换失败");
      return;
    }
    if (result.replaced > 0) {
      // 局部刷新列表项：剩余命中归零则移除，否则更新值与处数。
      if (scopeIsSelection.value) {
        applySelectionList();
      } else {
        const stillMatches = findSearchRanges(result.newValue, findText.value, { caseSensitive: caseSensitive.value }).length;
        if (stillMatches > 0) {
          matches.value[index] = { ...match, value: result.newValue, occurrences: stillMatches };
          totalOccurrences.value -= result.replaced - stillMatches;
        } else {
          matches.value.splice(index, 1);
          totalCells.value -= 1;
          totalOccurrences.value -= result.replaced;
        }
      }
    }
    // 前进到下一个命中（列表缩短后同一下标即下一条）。
    if (matches.value.length) {
      await jumpToMatch(Math.min(index, matches.value.length - 1));
    } else {
      activeIndex.value = -1;
    }
  } finally {
    isBusy.value = false;
  }
}

async function replaceAllInSelection() {
  const result = await props.paneState.replaceCellsInSelection?.({
    query: findText.value,
    replacement: replacement.value,
    caseSensitive: caseSensitive.value,
  });
  if (!result) return;
  if (!result.ok) {
    setFeedback("error", result.reason || "选区替换失败");
  } else if (result.cells > 0) {
    setFeedback("success", `已在选区内替换 ${result.cells} 个单元格（共 ${result.replaced} 处），可按 Ctrl+Z 撤销`);
  } else {
    setFeedback("", "选区内没有匹配的内容");
  }
  scheduleListRefresh();
}

async function replaceAllInTable() {
  const tab = props.paneState.activeDataTab;
  if (!tab?.sessionId) {
    setFeedback("error", "当前表会话不可用");
    return;
  }
  const request = {
    sessionId: tab.sessionId,
    query: findText.value,
    replacement: replacement.value,
    caseSensitive: caseSensitive.value,
    dryRun: true,
  };
  const preview = await props.invokeWorkbench("replace_in_table", { request });
  const cells = Number(preview?.replacedCells) || 0;
  const rows = Number(preview?.replacedRows) || 0;
  if (!cells) {
    setFeedback("", "整张表中没有匹配的内容");
    return;
  }
  const confirmed = await confirm({
    title: "全部替换",
    message:
      `将在整张表中把「${findText.value}」替换为「${replacement.value}」。\n` +
      `共 ${cells} 处，涉及 ${rows} 行（包括未加载的行）。\n\n` +
      `该操作会记录审计日志，可通过备份/回滚功能恢复，也可按 Ctrl+Z 撤销。`,
    confirmText: "全部替换",
    cancelText: "取消",
  });
  if (!confirmed) return;
  const result = await props.invokeWorkbench("replace_in_table", { request: { ...request, dryRun: false } });
  const replacedCellsCount = Number(result?.replacedCells) || 0;
  const replacedRowsCount = Number(result?.replacedRows) || 0;
  setFeedback("success", `已替换 ${replacedCellsCount} 处，涉及 ${replacedRowsCount} 行，可按 Ctrl+Z 撤销`);
  scheduleListRefresh();
  emit("replaced-all", {
    tab,
    patches: Array.isArray(result?.patches) ? result.patches : [],
    replacedCells: replacedCellsCount,
    replacedRows: replacedRowsCount,
  });
}

async function replaceAll() {
  if (!canReplace.value) return;
  isBusy.value = true;
  setFeedback("", "");
  try {
    if (scopeIsSelection.value) await replaceAllInSelection();
    else await replaceAllInTable();
  } catch (error) {
    setFeedback("error", String(error?.message || error));
  } finally {
    isBusy.value = false;
  }
}

function switchTab(tab) {
  activeTab.value = tab;
  nextTick(() => findInputRef.value?.focus());
}

onMounted(() => nextTick(() => findInputRef.value?.focus()));
</script>

<template>
  <div class="wb-dialog-overlay" @click.self="!isBusy && emit('close')">
    <section
      class="wb-dialog wb-find-replace-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="查找替换"
    >
      <header class="wb-find-replace-header">
        <nav class="wb-find-replace-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            class="wb-find-replace-tab"
            :class="{ 'is-active': activeTab === 'find' }"
            :aria-selected="activeTab === 'find'"
            @click="switchTab('find')"
          >
            查找
          </button>
          <button
            type="button"
            role="tab"
            class="wb-find-replace-tab"
            :class="{ 'is-active': activeTab === 'replace' }"
            :aria-selected="activeTab === 'replace'"
            @click="switchTab('replace')"
          >
            替换
          </button>
        </nav>
        <button
          type="button"
          class="wb-dialog-close"
          aria-label="关闭查找替换"
          :disabled="isBusy"
          @click="emit('close')"
        >
          ×
        </button>
      </header>

      <div class="wb-dialog-body wb-find-replace-body">
        <div class="wb-replace-scope" :class="scopeIsSelection ? 'is-selection' : 'is-table'">
          <template v-if="scopeIsSelection">
            范围：选区内 <strong>{{ selectionCellCount }}</strong> 个单元格（含新增行）
          </template>
          <template v-else>
            范围：整张表（包括未加载的行）
          </template>
        </div>

        <label class="wb-dialog-field wb-replace-field">
          <span>查找内容</span>
          <input
            ref="findInputRef"
            v-model="query"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :disabled="isBusy"
            @keydown.enter.prevent="goToNext"
          />
        </label>
        <label v-if="activeTab === 'replace'" class="wb-dialog-field wb-replace-field">
          <span>替换为</span>
          <input
            v-model="replacement"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :disabled="isBusy"
            @keydown.enter.prevent="replaceCurrent"
          />
        </label>

        <label class="wb-replace-option">
          <input v-model="caseSensitive" type="checkbox" :disabled="isBusy" />
          <span>区分大小写</span>
        </label>

        <div class="wb-find-results" :class="{ 'is-loading': listLoading }">
          <div v-if="listError" class="wb-find-results-empty">{{ listError }}</div>
          <div v-else-if="findText && !matches.length && !listLoading" class="wb-find-results-empty">
            没有匹配内容
          </div>
          <div v-else-if="!findText" class="wb-find-results-empty">输入查找内容后显示全部命中</div>
          <template v-else>
            <button
              v-for="(match, index) in matches"
              :key="`${identityLabel(match.rowIdentity)}|${match.columnName}|${index}`"
              type="button"
              class="wb-find-result-row"
              :class="{ 'is-active': index === activeIndex }"
              @click="jumpToMatch(index)"
            >
              <span class="wb-find-result-identity" :title="identityLabel(match.rowIdentity)">
                {{ identityLabel(match.rowIdentity) }}
              </span>
              <span class="wb-find-result-column" :title="match.columnName">{{ columnLabel(match.columnName) }}</span>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <span class="wb-find-result-value" v-html="matchPreviewHtml(match)" />
              <span v-if="match.occurrences > 1" class="wb-find-result-count">×{{ match.occurrences }}</span>
            </button>
          </template>
        </div>
        <p v-if="listSummary" class="wb-find-results-summary">{{ listSummary }}</p>

        <p v-if="feedback.text" class="wb-replace-feedback" :class="`is-${feedback.kind || 'info'}`">
          {{ feedback.text }}
        </p>
      </div>

      <footer class="wb-dialog-actions wb-replace-footer">
        <div class="wb-replace-footer-left">
          <button type="button" :disabled="!canNavigate" @click="goToPrevious">上一个</button>
          <button type="button" :disabled="!canNavigate" @click="goToNext">下一个</button>
        </div>
        <div class="wb-replace-footer-right">
          <template v-if="activeTab === 'replace'">
            <button type="button" :disabled="!canReplace" @click="replaceCurrent">替换</button>
            <button
              type="button"
              class="wb-replace-all-button"
              :disabled="!canReplace"
              @click="replaceAll"
            >
              全部替换
            </button>
          </template>
          <button type="button" :disabled="isBusy" @click="emit('close')">关闭</button>
        </div>
      </footer>
    </section>
  </div>
</template>
