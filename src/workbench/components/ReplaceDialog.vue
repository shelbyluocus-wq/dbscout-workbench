<script setup>
import { computed, nextTick, onMounted, ref } from "vue";
import { useEscClose } from "../composables/useEscClose.js";
import { useConfirm } from "../composables/useConfirm.js";
import { gridSelectionCount } from "../utils/gridCellSelection.js";

const props = defineProps({
  // focusedPaneState：当前焦点 pane 的能力注册表（搜索、替换、选区等）。
  paneState: { type: Object, required: true },
  invokeWorkbench: { type: Function, required: true },
});

const emit = defineEmits(["close", "replaced-all"]);

const isBusy = ref(false);
useEscClose(() => true, () => emit("close"), () => isBusy.value);
const { confirm } = useConfirm();

const findInputRef = ref(null);
const query = ref("");
const replacement = ref("");
const caseSensitive = ref(false);
const feedback = ref({ kind: "", text: "" });

const findText = computed(() => query.value.trim());
const hasTab = computed(() => Boolean(props.paneState.activeDataTab));

// Excel 语义：多选单元格时只在选区内替换，否则范围为整张表（含未加载页）。
const selectionRange = computed(() => {
  const range = props.paneState.selectedRange;
  const tab = props.paneState.activeDataTab;
  if (!range || !tab || range.tabId !== tab.id) return null;
  return gridSelectionCount(range) > 1 ? range : null;
});
const selectionCellCount = computed(() => (selectionRange.value ? gridSelectionCount(selectionRange.value) : 0));
const scopeIsSelection = computed(() => Boolean(selectionRange.value));

const canNavigate = computed(() => hasTab.value && !scopeIsSelection.value && Boolean(findText.value) && !isBusy.value);
const canReplaceAll = computed(() => hasTab.value && Boolean(findText.value) && !isBusy.value);

function setFeedback(kind, text) {
  feedback.value = { kind, text };
}

// 查找词与网格当前搜索一致且已有命中时直接跳到下一个，否则重新执行搜索。
async function findNext() {
  if (!canNavigate.value) return;
  isBusy.value = true;
  setFeedback("", "");
  try {
    if (props.paneState.activeSearchQuery === findText.value && props.paneState.hasSearchMatches) {
      await props.paneState.goToNextSearchMatch?.();
    } else {
      await props.paneState.runTableSearch?.(findText.value);
    }
  } finally {
    isBusy.value = false;
  }
}

async function replaceCurrent() {
  if (!canNavigate.value) return;
  // 还没有命中时，第一次点击等同"查找下一个"（Excel 行为）。
  if (!(props.paneState.activeSearchQuery === findText.value && props.paneState.hasSearchMatches)) {
    await findNext();
    return;
  }
  isBusy.value = true;
  setFeedback("", "");
  try {
    const result = await props.paneState.replaceActiveSearchMatch?.({
      query: findText.value,
      replacement: replacement.value,
      caseSensitive: caseSensitive.value,
    });
    if (!result?.ok) setFeedback("error", result?.reason || "替换失败");
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
      `该操作会记录审计日志，可通过备份/回滚功能恢复。`,
    confirmText: "全部替换",
    cancelText: "取消",
  });
  if (!confirmed) return;
  const result = await props.invokeWorkbench("replace_in_table", { request: { ...request, dryRun: false } });
  const replacedCellsCount = Number(result?.replacedCells) || 0;
  const replacedRowsCount = Number(result?.replacedRows) || 0;
  setFeedback("success", `已替换 ${replacedCellsCount} 处，涉及 ${replacedRowsCount} 行，可按 Ctrl+Z 撤销`);
  emit("replaced-all", {
    tab,
    patches: Array.isArray(result?.patches) ? result.patches : [],
    replacedCells: replacedCellsCount,
    replacedRows: replacedRowsCount,
  });
}

async function replaceAll() {
  if (!canReplaceAll.value) return;
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

onMounted(() => nextTick(() => findInputRef.value?.focus()));
</script>

<template>
  <div class="wb-dialog-overlay" @click.self="!isBusy && emit('close')">
    <section
      class="wb-dialog wb-replace-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="查找替换"
    >
      <header class="wb-dialog-header">
        <strong class="wb-replace-title">查找替换</strong>
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

      <div class="wb-dialog-body wb-replace-body">
        <div class="wb-replace-scope" :class="scopeIsSelection ? 'is-selection' : 'is-table'">
          <template v-if="scopeIsSelection">
            范围：选区内 <strong>{{ selectionCellCount }}</strong> 个单元格（仅替换选中内容）
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
            @keydown.enter.prevent="findNext"
          />
        </label>
        <label class="wb-dialog-field wb-replace-field">
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

        <p v-if="scopeIsSelection" class="wb-replace-hint">
          已多选单元格：仅支持「全部替换」，替换范围限于选区。
        </p>
        <p v-if="feedback.text" class="wb-replace-feedback" :class="`is-${feedback.kind || 'info'}`">
          {{ feedback.text }}
        </p>
      </div>

      <footer class="wb-dialog-actions wb-replace-footer">
        <div class="wb-replace-footer-left">
          <button type="button" :disabled="!canNavigate" @click="findNext">查找下一个</button>
          <button type="button" :disabled="!canNavigate" @click="replaceCurrent">替换</button>
        </div>
        <div class="wb-replace-footer-right">
          <button type="button" :disabled="isBusy" @click="emit('close')">关闭</button>
          <button
            type="button"
            class="wb-replace-all-button"
            :disabled="!canReplaceAll"
            @click="replaceAll"
          >
            全部替换
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>
