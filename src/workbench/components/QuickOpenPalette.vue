<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { buildSchemaSearchResults } from "../workspaceState.js";
import { columnName } from "../utils/normalize.js";
import { highlightSearchText } from "../utils/searchMatch.js";

const props = defineProps({
  visible: { type: Boolean, default: false },
  query: { type: String, default: "" },
  connectionId: { type: String, default: "" },
  database: { type: String, default: "" },
  tables: { type: Array, default: () => [] },
  schema: { type: Array, default: () => [] },
});

const emit = defineEmits([
  "update:visible",
  "update:query",
  "open-table",
]);

const inputRef = ref(null);
const listRef = ref(null);
const selectedIndex = ref(0);

const hasQuery = computed(() => props.query.trim().length > 0);
const results = computed(() => {
  if (!props.visible) return [];
  return buildSchemaSearchResults(props.schema, props.query.trim());
});
const visibleResults = computed(() => (hasQuery.value ? results.value : []));

function tableName(table) {
  return table?.tableName || table?.table_name || "";
}
function tableComment(table) {
  return table?.tableComment || table?.table_comment || "";
}
function columnComment(column) {
  return column?.column_comment || column?.columnComment || "";
}
function matchKindLabel(kind) {
  return {
    tableName: "表名",
    tableComment: "表备注",
    columnName: "字段",
    columnComment: "字段备注",
  }[kind] || "结构";
}
function columnHitLabel(column, result) {
  return matchKindLabel(column?.searchMatchKind || result?.matchKind || "columnName");
}
function highlight(value) {
  return highlightSearchText(value, props.query);
}

watch(visibleResults, (list) => {
  selectedIndex.value = list.length ? 0 : -1;
});

watch(() => props.visible, async (open) => {
  if (!open) {
    emit("update:query", "");
    selectedIndex.value = 0;
    return;
  }
  await nextTick();
  inputRef.value?.focus?.();
  inputRef.value?.select?.();
});

function close() {
  emit("update:visible", false);
}

function activate(result) {
  if (!result) return;
  const table = result.table?.raw || result.table;
  if (!table) return;
  emit("open-table", { table, matchResult: result });
  close();
}

function ensureSelectedVisible() {
  nextTick(() => {
    const list = listRef.value;
    if (!list) return;
    const item = list.querySelector('[data-active="true"]');
    if (item) item.scrollIntoView({ block: "nearest" });
  });
}

function handleKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!visibleResults.value.length) return;
    selectedIndex.value = (selectedIndex.value + 1) % visibleResults.value.length;
    ensureSelectedVisible();
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!visibleResults.value.length) return;
    selectedIndex.value =
      (selectedIndex.value - 1 + visibleResults.value.length) % visibleResults.value.length;
    ensureSelectedVisible();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const item = visibleResults.value[selectedIndex.value];
    activate(item);
  }
}

function onOverlayMouseDown(event) {
  // 点击遮罩空白处关闭；点击浮层内部不处理
  if (event.target === event.currentTarget) close();
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="wb-quick-open-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="快速打开表"
      @mousedown="onOverlayMouseDown"
    >
      <div class="wb-quick-open" @mousedown.stop>
        <div class="wb-quick-open-header">
          <span class="wb-quick-open-scope" aria-hidden="true">
            {{ database || "当前数据库" }}
          </span>
          <input
            ref="inputRef"
            :value="query"
            autocomplete="off"
            spellcheck="false"
            :placeholder="tables.length ? '输入表名、备注或字段以快速打开' : '当前数据库暂无表'"
            aria-label="搜索表"
            aria-controls="wb-quick-open-list"
            @input="emit('update:query', $event.target.value)"
            @keydown="handleKeydown"
          />
          <button
            type="button"
            class="wb-quick-open-close"
            aria-label="关闭"
            tabindex="-1"
            @click="close"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3 3l8 8M11 3L3 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <ul
          v-if="hasQuery && visibleResults.length"
          id="wb-quick-open-list"
          ref="listRef"
          class="wb-quick-open-results"
          role="listbox"
        >
          <li
            v-for="(result, index) in visibleResults"
            :key="result.key"
            role="option"
            :aria-selected="index === selectedIndex ? 'true' : 'false'"
            :data-active="index === selectedIndex ? 'true' : 'false'"
            class="wb-quick-open-item"
            :class="{ 'is-selected': index === selectedIndex }"
            @mousemove="selectedIndex = index"
            @click="activate(result)"
          >
            <span class="wb-quick-open-item-copy">
              <span class="wb-quick-open-item-title">
                <span class="wb-table-name" v-html="highlight(tableName(result.table))"></span>
                <span class="wb-quick-open-hit-badge">{{ matchKindLabel(result.matchKind) }}</span>
              </span>
              <span v-if="tableComment(result.table)" class="wb-table-comment">
                <span class="wb-search-hit-label">表备注</span>
                <span v-html="highlight(tableComment(result.table))"></span>
              </span>
              <span
                v-for="column in result.visibleColumns"
                :key="columnName(column)"
                class="wb-column-hit"
              >
                <span class="wb-search-hit-label">{{ columnHitLabel(column, result) }}</span>
                <span class="wb-column-hit-name" v-html="highlight(columnName(column))"></span>
                <template v-if="columnComment(column)">
                  <span class="wb-column-hit-comment" v-html="highlight(columnComment(column))"></span>
                </template>
              </span>
              <span v-if="result.hiddenColumnCount" class="wb-column-hit is-overflow">
                还有 {{ result.hiddenColumnCount }} 个字段命中
              </span>
            </span>
          </li>
        </ul>
        <p v-else-if="hasQuery && !visibleResults.length" class="wb-quick-open-empty">
          没有匹配的表或字段
        </p>
        <p v-else-if="!tables.length" class="wb-quick-open-empty">
          当前数据库暂无表
        </p>
        <p v-else class="wb-quick-open-empty">
          输入关键词搜索表名、备注或字段
        </p>

        <footer class="wb-quick-open-footer">
          <span class="wb-quick-open-hint">
            <kbd>↑</kbd><kbd>↓</kbd> 选择
            <kbd>Enter</kbd> 打开
            <kbd>Esc</kbd> 关闭
          </span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
