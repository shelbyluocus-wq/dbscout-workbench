<script setup>
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

const props = defineProps({
  copy: { type: Object, required: true },
  databases: { type: Array, default: () => [] },
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

const targetDatabases = computed(() => {
  if (!props.copy.dialog.targetConnectionId) return [];
  if (props.copy.dialog.targetConnectionId === props.copy.dialog.sourceConnectionId) {
    return props.databases.filter((db) => db !== props.copy.dialog.sourceDatabase);
  }
  return props.databases;
});

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

async function confirmAndExecute() {
  const names = [...props.copy.selectedTableNames].join(", ");
  const confirmed = await confirm({
    title: "发送所选表到目标库",
    message:
      `数量：${selectedCount.value} 张表\n` +
      `源：${props.copy.dialog.sourceDatabase}\n` +
      `目标：${props.copy.dialog.targetDatabase}\n` +
      `表：${names}\n\n` +
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
        <div class="wb-table-copy-route-target">
          <span class="wb-table-copy-route-label">目标</span>
          <select
            :value="copy.dialog.targetDatabase"
            :disabled="isBusy || !copy.dialog.targetConnectionId"
            aria-label="目标数据库"
            @change="copy.dialog.targetDatabase = $event.target.value"
          >
            <option value="" disabled>请选择目标数据库</option>
            <option v-for="db in targetDatabases" :key="db" :value="db">{{ db }}</option>
          </select>
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
            <span class="wb-table-copy-route-value">{{ sourceConnectionLabel }} / {{ copy.dialog.sourceDatabase }}</span>
          </div>
          <div
            v-if="!copy.dialog.targetDatabase"
            class="wb-table-copy-route-warning"
          >
            <span>注意</span>
            <span>请选择目标数据库</span>
          </div>
        </div>

        <!-- Target connection (hidden visually but kept for data flow) -->
        <label class="wb-dialog-field wb-table-copy-connection-field">
          <span>目标连接</span>
          <select
            :value="copy.dialog.targetConnectionId"
            :disabled="isBusy"
            aria-label="目标连接"
            @change="handleTargetConnectionChange"
          >
            <option value="" disabled>请选择目标连接</option>
            <option
              v-for="conn in copy.targetConnectionOptions.value.concat(
                connections.filter((c) => String(c.id) === copy.dialog.sourceConnectionId)
              )"
              :key="conn.id"
              :value="conn.id"
            >
              {{ conn.label || conn.host || conn.id }}
            </option>
          </select>
        </label>

        <!-- Toolbar -->
        <div class="wb-table-copy-toolbar">
          <label class="wb-table-copy-check">
            <input v-model="allSelected" type="checkbox" :disabled="isBusy || !sourceTableCount" />
            <span>全选</span>
          </label>
          <div class="wb-table-copy-search">
            <input
              v-model="searchQuery"
              type="text"
              placeholder="搜索表名或备注…"
              autocomplete="off"
              :disabled="isBusy"
            />
          </div>
          <div class="wb-table-copy-count">
            已选 <strong>{{ selectedCount }}</strong> / <strong>{{ sourceTableCount }}</strong>
          </div>
          <div class="wb-table-copy-actions">
            <button type="button" :disabled="isBusy || selectedCount === 0" @click="clearSelection">清空选择</button>
          </div>
        </div>

        <!-- Danger hint -->
        <div v-if="selectedCount > 50" class="wb-table-copy-danger-hint">
          <span>注意</span>
          <span>
            你选择了大量表（{{ selectedCount }} 个）。发送后会覆盖目标库的同名表结构。
          </span>
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
              <label
                class="wb-table-copy-row"
              >
                <input
                  type="checkbox"
                  :value="row.name"
                  :checked="copy.selectedTableNames.has(row.name)"
                  :disabled="isBusy"
                  @change="toggleTable(row.name)"
                />
                <span class="wb-table-copy-row-name">{{ row.name }}</span>
                <span class="wb-table-copy-row-comment">{{ row.comment }}</span>
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
        <div v-else-if="!sourceTableCount" class="wb-table-copy-empty">
          <span>暂无表数据。</span>
        </div>
        <div v-else class="wb-table-copy-empty">
          <span>未找到匹配的表</span>
          <small>尝试调整搜索关键词</small>
        </div>

        <!-- Status messages -->
        <p v-if="copy.dialog.status === 'succeeded'" class="wb-database-sync-success">
          发送完成。已复制 {{ copy.result.value?.copied?.length || 0 }} 张表。
        </p>
        <p v-if="copy.dialog.status === 'failed'" class="wb-dialog-error">
          {{ copy.dialog.errorMessage }}
        </p>
      </div>

      <!-- Footer -->
      <footer class="wb-dialog-actions wb-table-copy-footer">
        <div class="wb-table-copy-footer-left">
          <span>已选 {{ selectedCount }} / {{ sourceTableCount }} 个表</span>
        </div>
        <div class="wb-table-copy-footer-right">
          <button type="button" :disabled="isBusy" @click="emit('close')">取消</button>
          <button
            type="button"
            class="wb-database-sync-danger"
            :disabled="!copy.canExecute.value || isBusy"
            @click="confirmAndExecute"
          >
            发送所选表
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>
