<script setup>
import { ArrowRight, ListFilter, TriangleAlert, X } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useEscClose } from "../composables/useEscClose.js";
import { normalizeTableComment, normalizeTableName } from "../utils/normalize.js";
import SyncExclusionTemplates from "./SyncExclusionTemplates.vue";

const props = defineProps({
  sync: {
    type: Object,
    required: true,
  },
});

const emit = defineEmits(["close", "preview", "execute", "cancel", "source-change", "target-change"]);

const RESTORED_STATUSES = new Set(["failed-restored", "failedRestored"]);
const RESTORE_FAILED_STATUSES = new Set(["restore-failed", "failedRestoreFailed", "failed-restore-failed"]);
const CANCELLED_RESTORED_STATUSES = new Set(["cancelledRestored", "cancelled-restored"]);
const CANCELLED_RESTORE_FAILED_STATUSES = new Set(["cancelledRestoreFailed", "cancelled-restore-failed"]);
const STAGE_LABELS = {
  preflight: "检查同步计划",
  backup: "创建本地安全快照",
  dropTarget: "清理目标库旧表",
  createTarget: "创建目标表结构",
  copyData: "复制表数据",
  verify: "逐表一致性校验",
  repair: "自动修复差异表",
  restore: "从本地快照恢复",
  finalize: "完成同步",
  completed: "同步完成",
  failed: "同步失败",
  cancelling: "正在停止同步",
  cancelled: "同步已停止",
};

const warnings = computed(() => {
  const list = props.sync.result.value?.warnings || [];
  return Array.isArray(list) ? list : [];
});

const syncSnapshotPath = computed(() => {
  const value = props.sync.result.value || {};
  return String(value.backupSnapshotPath || value.backup_snapshot_path || "");
});

/* ── Exclusion state ── */
const effectiveExclusions = computed(() => props.sync.effectiveExcludedTables.value);
const manualExclusions = computed(() => new Set(props.sync.dialog.excludedTables));
const templateSourceMap = computed(() => props.sync.templateExclusionSources.value);

function templateSourceTitle(tableName) {
  const sources = templateSourceMap.value.get(tableName);
  return sources?.length ? `来自模板：${sources.join("、")}` : "";
}

function isTemplateOnly(tableName) {
  return !manualExclusions.value.has(tableName) && templateSourceMap.value.has(tableName);
}

function toggleTable(tableName) {
  if (isTemplateOnly(tableName)) return;
  if (manualExclusions.value.has(tableName)) {
    props.sync.removeExcludedTable(tableName);
  } else {
    props.sync.addExcludedTable(tableName);
  }
}

function clearManualExclusions() {
  props.sync.setExcludedTables([]);
}

/* ── Catalog search + virtual scroll ── */
const searchQuery = ref("");
const viewportRef = ref(null);
const scrollTop = ref(0);
const viewportHeight = ref(360);
const dialogRef = ref(null);
const ITEM_HEIGHT = 28;
const BUFFER = 6;

const sourceTables = computed(() => {
  const list = props.sync.sourceTableList.value || [];
  return list
    .map((table) => ({
      name: String(normalizeTableName(table) || table?.name || table || ""),
      comment: String(normalizeTableComment(table) || ""),
    }))
    .filter((table) => table.name);
});

const filteredTables = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return sourceTables.value;
  return sourceTables.value.filter(
    (table) => table.name.toLowerCase().includes(query) || table.comment.toLowerCase().includes(query),
  );
});

const totalHeight = computed(() => filteredTables.value.length * ITEM_HEIGHT);

const virtualWindow = computed(() => {
  const total = filteredTables.value.length;
  const height = viewportHeight.value || 360;
  const start = Math.max(0, Math.floor(scrollTop.value / ITEM_HEIGHT) - BUFFER);
  const end = Math.min(total, Math.ceil((scrollTop.value + height) / ITEM_HEIGHT) + BUFFER);
  return { start, end, total };
});

const visibleRows = computed(() => filteredTables.value.slice(virtualWindow.value.start, virtualWindow.value.end));

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

let resizeObserver = null;
function observeViewport(element) {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (!element) return;
  viewportHeight.value = element.clientHeight || 360;
  scrollTop.value = element.scrollTop || 0;
  resizeObserver = new ResizeObserver(() => {
    viewportHeight.value = element.clientHeight || 360;
  });
  resizeObserver.observe(element);
}

onMounted(() => nextTick(() => observeViewport(viewportRef.value)));

onBeforeUnmount(() => {
  if (resizeObserver) resizeObserver.disconnect();
  if (rafId) cancelAnimationFrame(rafId);
});

watch(viewportRef, (element) => observeViewport(element));
watch(searchQuery, resetViewportScroll);
watch(
  () => props.sync.sourceTableList.value,
  () => {
    searchQuery.value = "";
    resetViewportScroll();
  },
);

/* ── Restore / progress ── */
const restoreResult = computed(() => {
  const value = props.sync.result.value || {};
  const status = String(value.status || "");
  const cancelled = CANCELLED_RESTORED_STATUSES.has(status) || CANCELLED_RESTORE_FAILED_STATUSES.has(status);
  if (!RESTORED_STATUSES.has(status) && !RESTORE_FAILED_STATUSES.has(status) && !cancelled) return null;
  return {
    status,
    snapshotPath: syncSnapshotPath.value,
    restored: RESTORED_STATUSES.has(status) || CANCELLED_RESTORED_STATUSES.has(status),
    cancelled,
  };
});

const isBusy = computed(() => ["previewing", "running", "cancelling", "restoring"].includes(props.sync.dialog.status));
useEscClose(() => true, () => emit("close"), () => isBusy.value, { dialogRef });
const progressStyle = computed(() => ({ "--wb-database-sync-progress-scale": props.sync.progressPercent.value / 100 }));
const stageLabel = computed(() => {
  if (props.sync.dialog.status === "restoring") return STAGE_LABELS.restore;
  return STAGE_LABELS[props.sync.dialog.progress.stage] || "准备同步";
});
const isIndeterminate = computed(() => !props.sync.dialog.progress.total || !props.sync.dialog.progress.done);
const hasRowProgress = computed(() => props.sync.dialog.progress.totalRows > 0 || props.sync.dialog.progress.completedRows > 0);
const showStatus = computed(
  () =>
    isBusy.value ||
    Boolean(restoreResult.value) ||
    ["cancelled", "succeeded", "failed"].includes(props.sync.dialog.status),
);
const clock = ref(Date.now());
const startedAt = ref(0);
const lastProgressAt = ref(0);
let clockTimer = null;

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

const elapsed = computed(() => formatDuration(startedAt.value ? (clock.value - startedAt.value) / 1000 : 0));
const lastUpdate = computed(() => {
  const seconds = lastProgressAt.value ? Math.floor((clock.value - lastProgressAt.value) / 1000) : 0;
  return seconds <= 1 ? "最近更新：刚刚" : `最近更新：${seconds} 秒前`;
});

function stopClock() {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
}

watch(
  isBusy,
  (busy) => {
    if (!busy) {
      stopClock();
      startedAt.value = 0;
      lastProgressAt.value = 0;
      return;
    }
    const now = Date.now();
    if (!startedAt.value) startedAt.value = now;
    if (!lastProgressAt.value) lastProgressAt.value = now;
    clock.value = now;
    if (!clockTimer) clockTimer = setInterval(() => (clock.value = Date.now()), 1000);
  },
  { immediate: true },
);

watch(
  () => [
    props.sync.dialog.progress.stage,
    props.sync.dialog.progress.currentTable,
    props.sync.dialog.progress.done,
    props.sync.dialog.progress.completedRows,
    props.sync.dialog.progress.message,
  ],
  () => {
    if (isBusy.value) lastProgressAt.value = Date.now();
  },
);

onBeforeUnmount(stopClock);

const sourceTableCount = computed(() => props.sync.sourceTableOptions.value.length);
const syncedTableCount = computed(() => Math.max(0, sourceTableCount.value - effectiveExclusions.value.length));
// disabled 按钮自身不显示 tooltip，通过包裹层的 title 告诉用户为什么点不了（同 TableCopyDialog）。
const executeDisabledReason = computed(() => {
  if (isBusy.value) return "正在同步…";
  if (!props.sync.canExecute.value) return "请先选择不同的源库与目标库";
  return "使用当前配置开始覆盖同步";
});

function sourceChanged(event) {
  emit("source-change", event.target.value);
}

function targetChanged(event) {
  emit("target-change", event.target.value);
}
</script>

<template>
  <div class="wb-dialog-overlay">
    <section ref="dialogRef" class="wb-dialog wb-database-sync-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-database-sync-title" tabindex="-1">
      <!-- Header -->
      <header class="wb-dialog-header wb-database-sync-header">
        <div>
          <h2 id="wb-database-sync-title">覆盖同步数据库</h2>
          <p>用源库完整覆盖目标库的结构和数据，开始前会自动创建本地安全快照。</p>
        </div>
        <button type="button" class="wb-dialog-close" aria-label="关闭覆盖同步窗口" :disabled="isBusy" @click="emit('close')">×</button>
      </header>

      <div class="wb-database-sync-body">
        <!-- Route bar -->
        <div class="wb-database-sync-route">
          <div class="wb-database-sync-route-node">
            <span class="wb-database-sync-route-label">源库</span>
            <select :value="sync.dialog.sourceDatabase" :disabled="isBusy" aria-label="源数据库" @change="sourceChanged">
              <option value="" disabled>请选择源数据库</option>
              <option v-for="database in sync.sourceDatabaseOptions.value" :key="database" :value="database">{{ database }}</option>
            </select>
          </div>
          <span class="wb-database-sync-route-arrow" aria-hidden="true">
            <ArrowRight :size="15" />
          </span>
          <div class="wb-database-sync-route-node">
            <span class="wb-database-sync-route-label">目标库（将被覆盖）</span>
            <select :value="sync.dialog.targetDatabase" :disabled="isBusy" aria-label="目标数据库" @change="targetChanged">
              <option value="" disabled>请选择目标数据库</option>
              <option v-for="database in sync.availableTargetDatabases.value" :key="database" :value="database">{{ database }}</option>
            </select>
          </div>
        </div>

        <!-- Danger hint -->
        <div class="wb-database-sync-danger-hint">
          <TriangleAlert :size="13" aria-hidden="true" />
          <span>目标库内容将被源库完全覆盖；开始前会自动创建本地安全快照，失败可恢复。</span>
        </div>

        <!-- Two-column content -->
        <div class="wb-database-sync-content">
          <section class="wb-database-sync-catalog" aria-labelledby="wb-database-sync-catalog-title">
            <div class="wb-database-sync-toolbar">
              <div class="wb-database-sync-section-title">
                <strong id="wb-database-sync-catalog-title">源库表</strong>
                <span>{{ sourceTableCount }}</span>
              </div>
              <div class="wb-database-sync-search">
                <input
                  v-model="searchQuery"
                  type="search"
                  placeholder="搜索表名或备注…"
                  aria-label="搜索可排除的源库表"
                  autocomplete="off"
                  :disabled="isBusy"
                />
              </div>
            </div>

            <div v-if="filteredTables.length" class="wb-database-sync-columns">
              <span>排除</span>
              <span>表名</span>
              <span>备注</span>
            </div>

            <div
              v-if="filteredTables.length"
              ref="viewportRef"
              class="wb-database-sync-viewport"
              @scroll.passive="onScroll"
            >
              <div class="wb-database-sync-virtual" :style="{ height: totalHeight + 'px' }">
                <div
                  v-if="virtualWindow.start > 0"
                  :style="{ height: virtualWindow.start * ITEM_HEIGHT + 'px', flexShrink: 0 }"
                />

                <template v-for="row in visibleRows" :key="row.name">
                  <label
                    class="wb-database-sync-row"
                    :class="{ 'is-template': isTemplateOnly(row.name) }"
                    :title="isTemplateOnly(row.name) ? templateSourceTitle(row.name) : ''"
                  >
                    <input
                      type="checkbox"
                      :checked="manualExclusions.has(row.name) || isTemplateOnly(row.name)"
                      :disabled="isBusy || isTemplateOnly(row.name)"
                      :aria-label="`排除 ${row.name}`"
                      @change="toggleTable(row.name)"
                    />
                    <span class="wb-database-sync-row-name" :title="row.name">{{ row.name }}</span>
                    <span class="wb-database-sync-row-comment" :title="row.comment">{{ row.comment }}</span>
                  </label>
                </template>

                <div
                  v-if="virtualWindow.end < virtualWindow.total"
                  :style="{ height: (virtualWindow.total - virtualWindow.end) * ITEM_HEIGHT + 'px', flexShrink: 0 }"
                />
              </div>
            </div>

            <div v-else-if="!sourceTables.length" class="wb-database-sync-empty">
              <span>源库暂无表。</span>
            </div>
            <div v-else class="wb-database-sync-empty">
              <span>未找到匹配的表</span>
              <small>尝试调整搜索关键词</small>
            </div>
          </section>

          <aside class="wb-database-sync-sidebar">
            <section class="wb-database-sync-excluded" aria-labelledby="wb-database-sync-excluded-title">
              <header class="wb-database-sync-excluded-header">
                <div class="wb-database-sync-section-title">
                  <strong id="wb-database-sync-excluded-title">已排除的表</strong>
                  <span aria-live="polite">{{ effectiveExclusions.length }}</span>
                </div>
                <button
                  type="button"
                  class="wb-database-sync-excluded-clear"
                  :disabled="isBusy || !manualExclusions.size"
                  title="移除所有手动排除（模板提供的排除保持不变）"
                  @click="clearManualExclusions"
                >
                  清空
                </button>
              </header>

              <div v-if="effectiveExclusions.length" class="wb-database-sync-excluded-list" role="list" aria-label="当前已排除的表">
                <div
                  v-for="tableName in effectiveExclusions"
                  :key="tableName"
                  class="wb-database-sync-excluded-row"
                  :class="{ 'is-template': isTemplateOnly(tableName) }"
                  role="listitem"
                >
                  <span class="wb-database-sync-excluded-name" :title="tableName">{{ tableName }}</span>
                  <span
                    v-if="isTemplateOnly(tableName)"
                    class="wb-database-sync-excluded-source"
                    :title="templateSourceTitle(tableName)"
                  >模板</span>
                  <button
                    v-else
                    type="button"
                    :disabled="isBusy"
                    :aria-label="`移除排除 ${tableName}`"
                    :title="`移除 ${tableName}`"
                    @click="sync.removeExcludedTable(tableName)"
                  >
                    <X :size="13" aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div v-else class="wb-database-sync-excluded-empty" role="status">
                <ListFilter :size="22" aria-hidden="true" />
                <strong>未排除任何表</strong>
                <span>在左侧勾选要排除的表，或启用下方模板。</span>
              </div>
            </section>

            <SyncExclusionTemplates :sync="sync" :busy="isBusy" />
          </aside>
        </div>

        <!-- Status strip -->
        <div v-if="showStatus" class="wb-database-sync-status">
          <section v-if="['running', 'cancelling', 'restoring'].includes(sync.dialog.status)" class="wb-database-sync-progress-section">
            <div class="wb-database-sync-progress-heading">
              <strong><span class="wb-database-sync-activity" aria-hidden="true"></span>{{ stageLabel }}</strong>
              <span v-if="sync.dialog.progress.total">{{ sync.dialog.progress.done }} / {{ sync.dialog.progress.total }} 张表</span>
            </div>
            <div
              class="wb-database-sync-progress"
              :class="{ 'is-indeterminate': isIndeterminate }"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="isIndeterminate ? undefined : sync.progressPercent.value"
              :aria-valuetext="sync.dialog.progress.message || stageLabel"
              :style="progressStyle"
            >
              <span class="wb-database-sync-progress-fill"></span>
            </div>
            <p v-if="sync.dialog.progress.currentTable" class="wb-database-sync-current-table" :title="sync.dialog.progress.currentTable">
              当前表：<strong>{{ sync.dialog.progress.currentTable }}</strong>
            </p>
            <p v-if="hasRowProgress">数据行：{{ sync.dialog.progress.completedRows }} / {{ sync.dialog.progress.totalRows }}</p>
            <p v-if="sync.dialog.progress.message" class="wb-database-sync-muted">{{ sync.dialog.progress.message }}</p>
            <p class="wb-database-sync-progress-meta">已运行 {{ elapsed }} · {{ lastUpdate }}</p>
          </section>

          <section v-if="restoreResult" class="wb-database-sync-restore-result" :class="{ 'is-restored': restoreResult.restored }">
            <strong v-if="restoreResult.restored && restoreResult.cancelled">同步已停止，目标库已从本地安全快照恢复。</strong>
            <strong v-else-if="restoreResult.restored">同步失败，已从本地安全快照恢复目标库。</strong>
            <strong v-else-if="restoreResult.cancelled">同步已停止，但自动恢复失败，需要手动恢复。</strong>
            <strong v-else>同步失败且自动恢复失败，需要手动恢复。</strong>
            <p v-if="restoreResult.snapshotPath">本地安全快照：{{ restoreResult.snapshotPath }}</p>
            <p v-if="restoreResult.restored">目标库已从本地安全快照恢复，请检查错误信息后再重试。</p>
            <p v-else>请保留本地安全快照并进行人工恢复，确认目标库状态后再继续操作。</p>
          </section>

          <p v-if="sync.dialog.status === 'cancelled' && !restoreResult" class="wb-database-sync-muted">覆盖同步已停止，当前任务不会再继续处理。</p>

          <template v-if="sync.dialog.status === 'succeeded' && !restoreResult">
            <p class="wb-database-sync-success">
              <template v-if="effectiveExclusions.length">
                覆盖同步完成，已确认所有未排除表与源库一致；排除表保持目标库原状。
              </template>
              <template v-else>
                覆盖同步完成，已确认目标库与源库的基础表结构和数据完全相同。
              </template>
              <template v-if="syncSnapshotPath"> 本地安全快照已保存。</template>
            </p>
            <p v-if="syncSnapshotPath" class="wb-database-sync-muted" :title="syncSnapshotPath">
              快照路径：{{ syncSnapshotPath }}
            </p>
          </template>
          <p v-if="sync.dialog.status === 'failed'" class="wb-dialog-error">{{ sync.dialog.errorMessage }}</p>
        </div>
      </div>

      <!-- Footer -->
      <footer class="wb-dialog-actions wb-database-sync-footer">
        <div class="wb-database-sync-footer-left">
          <template v-if="sourceTableCount">
            将同步 <strong>{{ syncedTableCount }}</strong> 张表 · 排除 <strong>{{ effectiveExclusions.length }}</strong> 张
          </template>
          <template v-else>请选择不同的源库与目标库</template>
        </div>
        <div class="wb-database-sync-footer-right">
          <button v-if="!isBusy" type="button" @click="emit('close')">关闭</button>
          <button
            v-else
            type="button"
            :disabled="!sync.canCancel.value"
            @click="emit('cancel')"
          >
            {{ sync.dialog.status === 'cancelling' ? '正在停止…' : sync.dialog.status === 'restoring' ? '正在恢复…' : '停止同步' }}
          </button>
          <span class="wb-database-sync-execute-hint" :title="executeDisabledReason">
            <button
              type="button"
              class="wb-dialog-primary danger"
              :disabled="!sync.canExecute.value || isBusy"
              @click="emit('execute')"
            >
              开始覆盖同步
            </button>
          </span>
        </div>
      </footer>
    </section>
  </div>
</template>
