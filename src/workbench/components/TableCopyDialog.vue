<script setup>
import { t } from "../i18n/index.js";
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
import WorkbenchSelect from "./WorkbenchSelect.vue";

const props = defineProps({
  copy: { type: Object, required: true },
  connections: { type: Array, default: () => [] },
});

const emit = defineEmits(["close", "execute", "target-connection-change"]);

const isBusy = computed(() => props.copy.isBusy.value);
const confirming = ref(false);
const dialogRef = ref(null);
useEscClose(() => true, () => emit("close"), () => isBusy.value || confirming.value, { dialogRef });
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
function handleTargetConnectionChange(value) {
  emit("target-connection-change", value);
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
function confirmationTableNames() {
  const names = selectedTables.value.map((table) => table.name);
  if (names.length <= CONFIRM_TABLE_PREVIEW_LIMIT) return names;
  return [
    ...names.slice(0, CONFIRM_TABLE_PREVIEW_LIMIT),
    `…另有 ${names.length - CONFIRM_TABLE_PREVIEW_LIMIT} 张表`,
  ];
}

const isOverwriteMode = computed(() => props.copy.dialog.mode === "overwrite");
const isStructureOnly = computed(() => Boolean(props.copy.dialog.structureOnly));

async function confirmAndExecute() {
  confirming.value = true;
  try {
    const scopeLabel = isStructureOnly.value ? t("tableCopy.scopeStructureOnly") : t("tableCopy.scopeStructureAndData");
    const confirmed = await confirm({
      title: isOverwriteMode.value ? "覆盖发送所选表" : "发送所选表到目标库",
      message:
        `从：${sourceConnectionLabel.value} / ${props.copy.dialog.sourceDatabase}\n` +
        `到：${targetConnectionLabel.value} / ${props.copy.dialog.targetDatabase}\n` +
        `方式：${scopeLabel}\n` +
        `共 ${selectedCount.value} 张表`,
      items: confirmationTableNames(),
      note: isOverwriteMode.value
        ? (isStructureOnly.value
          ? t("tableCopy.confirmOverwriteStructureNote")
          : "目标库中的同名表将被源表的结构和数据完全替换，此操作不可撤销。")
        : (isStructureOnly.value
          ? t("tableCopy.confirmCopyStructureNote")
          : "目标库中的重名表不受影响，将自动添加 _copy 后缀创建副本。"),
      confirmText: isOverwriteMode.value ? "覆盖发送" : "发送",
      cancelText: "取消",
      danger: isOverwriteMode.value,
    });
    if (confirmed) emit("execute");
  } finally {
    confirming.value = false;
  }
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
  <div class="wb-dialog-overlay">
    <section
      ref="dialogRef"
      class="wb-dialog wb-table-copy-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="t('m_9ddb4fb54fcc')"
      tabindex="-1"
    >
      <!-- Header -->
      <header class="wb-dialog-header wb-table-copy-header">
        <div>
          <h2>{{ t('m_9ddb4fb54fcc') }}</h2>
          <p>{{ t('m_a712f27f8ec8') }}</p>
        </div>
        <button
          type="button"
          class="wb-dialog-close"
          :aria-label="t('m_2a8d4d081bda')"
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
            <span class="wb-table-copy-route-label">{{ t('m_f4e2ebc162b2') }}</span>
            <div class="wb-table-copy-route-info">
              <strong :title="sourceConnectionLabel">{{ sourceConnectionLabel }}</strong>
              <span :title="copy.dialog.sourceDatabase">{{ copy.dialog.sourceDatabase }}</span>
            </div>
          </div>
          <span class="wb-table-copy-route-arrow" aria-hidden="true">
            <ArrowRight :size="15" />
          </span>
          <div class="wb-table-copy-route-node is-target">
            <span class="wb-table-copy-route-label">{{ t('m_57060c88a36b') }}</span>
            <div class="wb-table-copy-target-selects">
              <WorkbenchSelect
                :model-value="copy.dialog.targetConnectionId"
                :options="copy.targetConnectionOptions.value.map((conn) => ({ value: String(conn.id), label: conn.label || conn.host || String(conn.id) }))"
                :aria-label="t('m_37b9835a7d78')"
                :placeholder="t('m_4c90fc42fd94')"
                :disabled="isBusy"
                @change="handleTargetConnectionChange"
              />
              <WorkbenchSelect
                v-model="copy.dialog.targetDatabase"
                :options="targetDatabases"
                :aria-label="t('m_6c7424a6b8a4')"
                :placeholder="copy.dialog.targetDatabaseLoading ? t('m_ad78b6232786') : t('m_287e8652c4ad')"
                :disabled="isBusy || !copy.dialog.targetConnectionId || copy.dialog.targetDatabaseLoading"
                :monospace="true"
              />
            </div>
            <p v-if="copy.dialog.targetDatabaseError" class="wb-table-copy-route-warning"> {{ t('m_84a1faa717d8') }}{{ copy.dialog.targetDatabaseError }}
            </p>
          </div>
        </div>

        <!-- Send mode -->
        <div class="wb-table-copy-mode" role="radiogroup" :aria-label="t('m_a4406e917060')">
          <label
            class="wb-table-copy-mode-option"
            :class="{ 'is-active': copy.dialog.mode === 'copy' }"
          >
            <input
              v-model="copy.dialog.mode"
              type="radio"
              value="copy"
              :disabled="isBusy"
            />
            <span class="wb-table-copy-mode-text">
              <strong>{{ t('m_f6825f1e73a1') }}</strong>
              <small>{{ t('m_6a9cebbef50a') }}</small>
            </span>
          </label>
          <label
            class="wb-table-copy-mode-option"
            :class="{ 'is-active': copy.dialog.mode === 'overwrite' }"
          >
            <input
              v-model="copy.dialog.mode"
              type="radio"
              value="overwrite"
              :disabled="isBusy"
            />
            <span class="wb-table-copy-mode-text">
              <strong>{{ t('m_6956048f974f') }}</strong>
              <small>{{ t('m_07a32b9c7861') }}</small>
            </span>
          </label>
        </div>

        <label class="wb-table-copy-structure-only">
          <input
            v-model="copy.dialog.structureOnly"
            type="checkbox"
            :disabled="isBusy"
          />
          <span>
            <strong>{{ t('tableCopy.structureOnly') }}</strong>
            <small>{{ t('tableCopy.structureOnlyHint') }}</small>
          </span>
        </label>

        <div class="wb-table-copy-content">
          <section class="wb-table-copy-catalog" aria-labelledby="wb-table-copy-catalog-title">
            <!-- Toolbar -->
            <div class="wb-table-copy-toolbar">
              <div class="wb-table-copy-section-title">
                <strong id="wb-table-copy-catalog-title">{{ t('m_f974e44668ed') }}</strong>
                <span>{{ sourceTableCount }}</span>
              </div>
              <div class="wb-table-copy-search">
                <input
                  v-model="searchQuery"
                  type="text"
                  :placeholder="t('m_42cfb91efcb1')"
                  :aria-label="t('m_7efe69240055')"
                  autocomplete="off"
                  :disabled="isBusy"
                />
              </div>
            </div>

            <!-- Danger hint -->
            <div v-if="selectedCount > 50" class="wb-table-copy-danger-hint">
              <TriangleAlert :size="13" aria-hidden="true" />
              <span>{{ t('m_3f4ebc4aad97') }} {{ selectedCount }} {{ t('m_f44e6e9a942f') }}</span>
            </div>

            <!-- Column header -->
            <div v-if="filteredTables.length" class="wb-table-copy-columns">
              <label class="wb-table-copy-check" :title="t('m_3a5040b68abf')">
                <input
                  v-model="allSelected"
                  type="checkbox"
                  :indeterminate="selectionIsPartial"
                  :disabled="isBusy || !sourceTableCount"
                  :aria-label="t('m_3a5040b68abf')"
                />
              </label>
              <span>{{ t('m_699c6d62a836') }}</span>
              <span>{{ t('m_daede9881787') }}</span>
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
              <span>{{ t('m_86be2828b82d') }}</span>
            </div>
            <div v-else-if="!sourceTableCount" class="wb-table-copy-empty">
              <span>{{ t('m_a9d739e0ab1f') }}</span>
            </div>
            <div v-else class="wb-table-copy-empty">
              <span>{{ t('m_f16bdd20e5a1') }}</span>
              <small>{{ t('m_da5e3101a989') }}</small>
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
            {{ isStructureOnly ? t('tableCopy.structureCopied', { count: copy.result.value?.copied?.length || 0 }) : `${t('m_1243c70e0c7c')} ${copy.result.value?.copied?.length || 0} ${t('m_08c0d40c3ef3')}${copiedRowCount} ${t('m_a27a3956cf9c')}` }}
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
          <span>{{ t('m_54f6a4c3417f') }} <strong>{{ selectedCount }}</strong> {{ t('m_a2b22d3a5ca3') }}</span>
        </div>
        <div class="wb-table-copy-footer-right">
          <button type="button" :disabled="isBusy" @click="emit('close')">{{ t('m_2cd0f3be8738') }}</button>
          <span class="wb-table-copy-send-hint" :title="sendDisabledReason">
            <button
              type="button"
              class="wb-dialog-primary"
              :disabled="!copy.canExecute.value || isBusy"
              @click="confirmAndExecute"
            > {{ t('m_2c69c0bcb53b') }} </button>
          </span>
        </div>
      </footer>
    </section>
  </div>
</template>
