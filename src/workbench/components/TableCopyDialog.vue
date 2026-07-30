<script setup>
import { ArrowRight, TriangleAlert } from "lucide-vue-next";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { useEscClose } from "../composables/useEscClose.js";
import { useConfirm } from "../composables/useConfirm.js";
import TableCopySelectionPanel from "./TableCopySelectionPanel.vue";

const props = defineProps({
  copy: { type: Object, required: true },
  connections: { type: Array, default: () => [] },
});

const emit = defineEmits(["close", "execute", "target-connection-change"]);

const isBusy = computed(() => props.copy.isBusy.value);
useEscClose(() => true, () => emit("close"), () => isBusy.value);
const { confirm } = useConfirm();

const sourceConnectionLabel = computed(() => {
  const conn = props.connections.find(
    (c) => String(c.id) === props.copy.dialog.sourceConnectionId
  );
  return conn?.label || conn?.host || props.copy.dialog.sourceConnectionId || "";
});

const targetConnectionLabel = computed(() => {
  const conn = props.connections.find(
    (c) => String(c.id) === props.copy.dialog.targetConnectionId
  );
  return conn?.label || conn?.host || props.copy.dialog.targetConnectionId || "";
});

const targetDatabases = computed(() => props.copy.targetDatabaseOptions.value || []);
const copiedRowCount = computed(() =>
  (props.copy.result.value?.copied || []).reduce(
    (total, table) => total + Number(table.rowCount || table.row_count || 0),
    0,
  )
);
const resultWarnings = computed(() =>
  Array.isArray(props.copy.result.value?.warnings)
    ? props.copy.result.value.warnings.filter(Boolean)
    : [],
);

/* ── Search / Virtual scroll state ── */
const searchQuery = ref("");
const viewportRef = ref(null);
const scrollTop = ref(0);
const viewportHeight = ref(380);
const ITEM_HEIGHT = 28;
const BUFFER = 6;

const sourceTables = computed(() => {
  const list = props.copy.sourceTableList.value || [];
  return list
    .map((t) => ({
      name: String(t.table_name ?? t ?? ""),
      comment: String(t.table_comment ?? ""),
    }))
    .filter((t) => t.name);
});

const filteredTables = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return sourceTables.value;
  return sourceTables.value.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.comment.toLowerCase().includes(q)
  );
});

const totalHeight = computed(() => filteredTables.value.length * ITEM_HEIGHT);

const virtualWindow = computed(() => {
  const total = filteredTables.value.length;
  const vh = viewportHeight.value || 380;
  const st = scrollTop.value;
  let start = Math.floor(st / ITEM_HEIGHT) - BUFFER;
  let end = Math.ceil((st + vh) / ITEM_HEIGHT) + BUFFER;
  start = Math.max(0, start);
  end = Math.min(total, end);
  return { start, end, total };
});

const visibleRows = computed(() =>
  filteredTables.value.slice(virtualWindow.value.start, virtualWindow.value.end)
);

const selectedCount = computed(() => props.copy.selectedTableNames.size);
const sourceTableCount = computed(() => (props.copy.sourceTableList.value || []).length);
const selectedTables = computed(() => {
  const selectedNames = props.copy.selectedTableNames;
  const tables = sourceTables.value.filter((table) => selectedNames.has(table.name));
  if (tables.length === selectedNames.size) return tables;

  const knownNames = new Set(tables.map((table) => table.name));
  selectedNames.forEach((name) => {
    if (!knownNames.has(name)) tables.push({ name, comment: "" });
  });
  return tables;
});
const selectionIsPartial = computed(
  () => selectedCount.value > 0 && selectedCount.value < sourceTableCount.value
);

// 禁用原因说明：disabled 按钮自身不显示 tooltip，通过包裹层的 title 告诉用户为什么点不了。
const sendDisabledReason = computed(() => {
  if (isBusy.value) return "正在发送表…";
  if (props.copy.dialog.sourceTableLoading || props.copy.dialog.targetDatabaseLoading) {
    return "正在读取表或数据库…";
  }
  if (!selectedCount.value) return "请先在左侧勾选要发送的表";
  if (!props.copy.dialog.targetConnectionId) return "请先选择目标连接";
  if (!props.copy.dialog.targetDatabase) return "请先选择目标数据库";
  return "";
});

// Local computed for the header "全选" checkbox. We cannot v-model bind
// directly to props.copy.selectAllTables: props are shallowReactive and a
// `v-model` write (`copy.selectAllTables = x`) assigns to the prop rather
// than invoking the computed ref's setter, so the setter would never run.
// Mirrors BatchExportDialog's allSelected pattern.
const allSelected = computed({
  get() {
    return sourceTableCount.value > 0 && selectedCount.value === sourceTableCount.value;
  },
  set(checked) {
    const names = props.copy.selectedTableNames;
    if (checked) {
      (props.copy.sourceTableList.value || []).forEach((t) => {
        names.add(String(t.table_name ?? t ?? ""));
      });
    } else {
      names.clear();
    }
  },
});

/* ── Event handlers ── */
function handleTargetConnectionChange(event) {
  emit("target-connection-change", event.target.value);
}

function toggleTable(name) {
  props.copy.toggleTable(name);
}

function clearSelection() {
  props.copy.selectedTableNames.clear();
}

function removeSelectedTable(name) {
  props.copy.selectedTableNames.delete(name);
}

const CONFIRM_TABLE_PREVIEW_LIMIT = 8;
function confirmationTableSummary() {
  const names = selectedTables.value.map((table) => table.name);
  const preview = names.slice(0, CONFIRM_TABLE_PREVIEW_LIMIT).join("、");
  const remaining = names.length - CONFIRM_TABLE_PREVIEW_LIMIT;
  return remaining > 0 ? `${preview}，另有 ${remaining} 张` : preview;
}

async function confirmAndExecute() {
  const confirmed = await confirm({
    title: "发送所选表到目标库",
    message:
      `数量：${selectedCount.value} 张表\n` +
      `源：${sourceConnectionLabel.value} / ${props.copy.dialog.sourceDatabase}\n` +
      `目标：${targetConnectionLabel.value} / ${props.copy.dialog.targetDatabase}\n` +
      `表：${confirmationTableSummary()}\n\n` +
      `重名表将自动添加 _copy 后缀。`,
    confirmText: "发送",
    cancelText: "取消",
  });
  if (!confirmed) return;
  emit("execute");
}

/* ── Scroll / Resize ── */
let rafId = 0;
function onScroll() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (viewportRef.value) scrollTop.value = viewportRef.value.scrollTop;
  });
}

function resetViewportScroll() {
  scrollTop.value = 0;
  if (viewportRef.value) viewportRef.value.scrollTop = 0;
}

let ro = null;
function observeViewport(element) {
  if (ro) {
    ro.disconnect();
    ro = null;
  }
  if (!element) return;
  viewportHeight.value = element.clientHeight || 380;
  scrollTop.value = element.scrollTop || 0;
  ro = new ResizeObserver(() => {
    viewportHeight.value = element.clientHeight || 380;
  });
  ro.observe(element);
}

onMounted(() => nextTick(() => observeViewport(viewportRef.value)));

onBeforeUnmount(() => {
  if (ro) ro.disconnect();
  if (rafId) cancelAnimationFrame(rafId);
});

watch(viewportRef, (element) => {
  observeViewport(element);
});

/* ── Reset when table list changes ── */
watch(
  () => props.copy.sourceTableList.value,
  () => {
    searchQuery.value = "";
    resetViewportScroll();
  }
);

/* ── Search reset scroll ── */
watch(searchQuery, () => {
  resetViewportScroll();
});
</script>

<template>
  <div class="wb-dialog-overlay" @click.self="!isBusy && emit('close')">
    <section
      class="wb-dialog wb-table-copy-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="发送表"
    >
      <!-- Header -->
      <header class="wb-dialog-header wb-table-copy-header">
        <div>
          <h2>发送表</h2>
          <p>复制完整表结构和数据，重名时自动创建副本。</p>
        </div>
        <button
          type="button"
          class="wb-dialog-close"
          aria-label="关闭发送窗口"
          :disabled="isBusy"
          @click="emit('close')"
        >
          ×
        </button>
      </header>

      <div class="wb-dialog-body wb-table-copy-body">
        <!-- Route bar -->
        <div class="wb-table-copy-route">
          <div class="wb-table-copy-route-node">
            <span class="wb-table-copy-route-label">源</span>
            <div class="wb-table-copy-route-info">
              <strong :title="sourceConnectionLabel">{{ sourceConnectionLabel }}</strong>
              <span :title="copy.dialog.sourceDatabase">{{ copy.dialog.sourceDatabase }}</span>
            </div>
          </div>
          <span class="wb-table-copy-route-arrow" aria-hidden="true">
            <ArrowRight :size="15" />
          </span>
          <div class="wb-table-copy-route-node is-target">
            <span class="wb-table-copy-route-label">目标</span>
            <div class="wb-table-copy-target-selects">
              <select
                :value="copy.dialog.targetConnectionId"
                :disabled="isBusy"
                aria-label="目标连接"
                @change="handleTargetConnectionChange"
              >
                <option value="" disabled>请选择 MySQL 连接</option>
                <option
                  v-for="conn in copy.targetConnectionOptions.value"
                  :key="conn.id"
                  :value="conn.id"
                >
                  {{ conn.label || conn.host || conn.id }}
                </option>
              </select>
              <select
                :value="copy.dialog.targetDatabase"
                :disabled="isBusy || !copy.dialog.targetConnectionId || copy.dialog.targetDatabaseLoading"
                aria-label="目标数据库"
                @change="copy.dialog.targetDatabase = $event.target.value"
              >
                <option value="" disabled>
                  {{ copy.dialog.targetDatabaseLoading ? "正在读取数据库…" : "请选择目标数据库" }}
                </option>
                <option v-for="db in targetDatabases" :key="db" :value="db">{{ db }}</option>
              </select>
            </div>
            <p v-if="copy.dialog.targetDatabaseError" class="wb-table-copy-route-warning">
              目标连接不可用：{{ copy.dialog.targetDatabaseError }}
            </p>
          </div>
        </div>

        <div class="wb-table-copy-content">
          <section class="wb-table-copy-catalog" aria-labelledby="wb-table-copy-catalog-title">
            <!-- Toolbar -->
            <div class="wb-table-copy-toolbar">
              <div class="wb-table-copy-section-title">
                <strong id="wb-table-copy-catalog-title">全部表</strong>
                <span>{{ sourceTableCount }}</span>
              </div>
              <div class="wb-table-copy-search">
                <input
                  v-model="searchQuery"
                  type="text"
                  placeholder="搜索表名或备注…"
                  aria-label="搜索可发送的表"
                  autocomplete="off"
                  :disabled="isBusy"
                />
              </div>
            </div>

            <!-- Danger hint -->
            <div v-if="selectedCount > 50" class="wb-table-copy-danger-hint">
              <TriangleAlert :size="13" aria-hidden="true" />
              <span>已选择 {{ selectedCount }} 张表，跨连接复制可能需要较长时间。</span>
            </div>

            <!-- Column header -->
            <div v-if="filteredTables.length" class="wb-table-copy-columns">
              <label class="wb-table-copy-check" title="全选">
                <input
                  v-model="allSelected"
                  type="checkbox"
                  :indeterminate="selectionIsPartial"
                  :disabled="isBusy || !sourceTableCount"
                  aria-label="全选"
                />
              </label>
              <span>表名</span>
              <span>备注</span>
            </div>

            <!-- Virtual scroll viewport -->
            <div
              v-if="filteredTables.length"
              ref="viewportRef"
              class="wb-table-copy-viewport"
              @scroll.passive="onScroll"
            >
              <div class="wb-table-copy-virtual" :style="{ height: totalHeight + 'px' }">
                <!-- Top spacer -->
                <div
                  v-if="virtualWindow.start > 0"
                  :style="{ height: virtualWindow.start * ITEM_HEIGHT + 'px', flexShrink: 0 }"
                />

                <!-- Visible rows -->
                <template v-for="row in visibleRows" :key="row.name">
                  <label class="wb-table-copy-row">
                    <input
                      type="checkbox"
                      :value="row.name"
                      :checked="copy.selectedTableNames.has(row.name)"
                      :disabled="isBusy"
                      @change="toggleTable(row.name)"
                    />
                    <span class="wb-table-copy-row-name" :title="row.name">{{ row.name }}</span>
                    <span class="wb-table-copy-row-comment" :title="row.comment">{{ row.comment }}</span>
                  </label>
                </template>

                <!-- Bottom spacer -->
                <div
                  v-if="virtualWindow.end < virtualWindow.total"
                  :style="{ height: (virtualWindow.total - virtualWindow.end) * ITEM_HEIGHT + 'px', flexShrink: 0 }"
                />
              </div>
            </div>

            <!-- Empty state -->
            <div v-else-if="copy.dialog.sourceTableLoading" class="wb-table-copy-empty">
              <span>正在读取源表…</span>
            </div>
            <div v-else-if="!sourceTableCount" class="wb-table-copy-empty">
              <span>暂无表数据。</span>
            </div>
            <div v-else class="wb-table-copy-empty">
              <span>未找到匹配的表</span>
              <small>尝试调整搜索关键词</small>
            </div>
          </section>

          <TableCopySelectionPanel
            :tables="selectedTables"
            :busy="isBusy"
            @remove="removeSelectedTable"
            @clear="clearSelection"
          />
        </div>

        <!-- Status messages -->
        <div
          v-if="copy.dialog.status === 'succeeded' || copy.dialog.status === 'failed' || resultWarnings.length"
          class="wb-table-copy-status"
        >
          <p v-if="copy.dialog.status === 'succeeded'" class="wb-database-sync-success">
            发送完成。已复制 {{ copy.result.value?.copied?.length || 0 }} 张表、{{ copiedRowCount }} 行数据。
          </p>
          <p
            v-for="warning in resultWarnings"
            :key="warning"
            class="wb-database-sync-warning wb-database-sync-warning-line"
          >
            {{ warning }}
          </p>
          <p v-if="copy.dialog.status === 'failed'" class="wb-dialog-error">
            {{ copy.dialog.errorMessage }}
          </p>
        </div>
      </div>

      <!-- Footer -->
      <footer class="wb-dialog-actions wb-table-copy-footer">
        <div class="wb-table-copy-footer-left">
          <span>将发送 <strong>{{ selectedCount }}</strong> 张表</span>
        </div>
        <div class="wb-table-copy-footer-right">
          <button type="button" :disabled="isBusy" @click="emit('close')">取消</button>
          <span class="wb-table-copy-send-hint" :title="sendDisabledReason">
            <button
              type="button"
              class="wb-dialog-primary"
              :disabled="!copy.canExecute.value || isBusy"
              @click="confirmAndExecute"
            >
              发送所选表
            </button>
          </span>
        </div>
      </footer>
    </section>
  </div>
</template>
