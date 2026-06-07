<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";

const props = defineProps({
  copy: { type: Object, required: true },
  databases: { type: Array, default: () => [] },
  connections: { type: Array, default: () => [] },
});

const emit = defineEmits(["close", "execute", "target-connection-change"]);

const isBusy = computed(() => props.copy.isBusy.value);

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

/* ── Search / Collapse / Virtual scroll state ── */
const searchQuery = ref("");
const collapsedGroups = reactive(new Set());
const viewportRef = ref(null);
const scrollTop = ref(0);
const viewportHeight = ref(380);
const ITEM_HEIGHT = 28;
const BUFFER = 6;
const MAX_LIST_HEIGHT = 380;

/* ── Group tables by prefix ── */
const tableGroups = computed(() => {
  const list = props.copy.sourceTableList.value || [];
  const map = new Map();
  list.forEach((t) => {
    const name = String(t.table_name ?? t ?? "");
    const comment = String(t.table_comment ?? "");
    if (!name) return;

    // Extract prefix: db01_config_0001 → config
    let prefix = "其他";
    const m = name.match(/^[a-zA-Z0-9]+_([a-zA-Z0-9]+)_/);
    if (m) prefix = m[1];
    else {
      const m2 = name.match(/^([a-zA-Z]+)/);
      if (m2) prefix = m2[1];
    }

    if (!map.has(prefix)) {
      map.set(prefix, { prefix, title: prefix, tables: [] });
    }
    map.get(prefix).tables.push({ name, comment });
  });
  return Array.from(map.values()).sort((a, b) => a.prefix.localeCompare(b.prefix));
});

const filteredGroups = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) {
    return tableGroups.value.map((g) => ({ ...g, tables: g.tables.slice() }));
  }
  return tableGroups.value
    .map((g) => ({
      ...g,
      tables: g.tables.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.comment.toLowerCase().includes(q)
      ),
    }))
    .filter((g) => g.tables.length > 0);
});

const visibleItems = computed(() => {
  const items = [];
  filteredGroups.value.forEach((g) => {
    items.push({ type: "group", prefix: g.prefix, title: g.title, count: g.tables.length });
    if (!collapsedGroups.has(g.prefix)) {
      g.tables.forEach((t) => items.push({ type: "row", ...t, group: g.prefix }));
    }
  });
  return items;
});

const totalHeight = computed(() => visibleItems.value.length * ITEM_HEIGHT);

const virtualWindow = computed(() => {
  const total = visibleItems.value.length;
  const vh = viewportHeight.value || MAX_LIST_HEIGHT;
  const st = scrollTop.value;
  let start = Math.floor(st / ITEM_HEIGHT) - BUFFER;
  let end = Math.ceil((st + vh) / ITEM_HEIGHT) + BUFFER;
  start = Math.max(0, start);
  end = Math.min(total, end);
  return { start, end, total };
});

const selectedCount = computed(() => props.copy.selectedTableNames.size);
const sourceTableCount = computed(() => (props.copy.sourceTableList.value || []).length);

function isGroupSelected(prefix) {
  const g = tableGroups.value.find((x) => x.prefix === prefix);
  if (!g) return false;
  return g.tables.every((t) => props.copy.selectedTableNames.has(t.name));
}

function isGroupIndeterminate(prefix) {
  const g = tableGroups.value.find((x) => x.prefix === prefix);
  if (!g) return false;
  const sel = g.tables.filter((t) => props.copy.selectedTableNames.has(t.name)).length;
  return sel > 0 && sel < g.tables.length;
}

/* ── Event handlers ── */
function handleTargetConnectionChange(event) {
  emit("target-connection-change", event.target.value);
}

function toggleCollapse(prefix) {
  if (collapsedGroups.has(prefix)) collapsedGroups.delete(prefix);
  else collapsedGroups.add(prefix);
}

function toggleGroup(prefix) {
  const g = tableGroups.value.find((x) => x.prefix === prefix);
  if (!g) return;
  const allSel = isGroupSelected(prefix);
  g.tables.forEach((t) => {
    if (allSel) props.copy.selectedTableNames.delete(t.name);
    else props.copy.selectedTableNames.add(t.name);
  });
}

function toggleTable(name) {
  props.copy.toggleTable(name);
}

function expandAllGroups() {
  collapsedGroups.clear();
}

function collapseAllGroups() {
  tableGroups.value.forEach((g) => collapsedGroups.add(g.prefix));
}

function clearSelection() {
  props.copy.selectedTableNames.clear();
}

function confirmAndExecute() {
  const names = [...props.copy.selectedTableNames].join(", ");
  const confirmed = globalThis.confirm(
    `确定要将 ${selectedCount.value} 张表发送到目标库？\n\n` +
      `源：${props.copy.dialog.sourceDatabase}\n` +
      `目标：${props.copy.dialog.targetDatabase}\n` +
      `表：${names}\n\n` +
      `重名表将自动添加 _copy 后缀。`
  );
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

let ro = null;
onMounted(() => {
  nextTick(() => {
    if (viewportRef.value) {
      viewportHeight.value = viewportRef.value.clientHeight || MAX_LIST_HEIGHT;
      scrollTop.value = viewportRef.value.scrollTop || 0;
      viewportRef.value.addEventListener("scroll", onScroll, { passive: true });
      ro = new ResizeObserver(() => {
        if (viewportRef.value) viewportHeight.value = viewportRef.value.clientHeight;
      });
      ro.observe(viewportRef.value);
    }
  });
});

onBeforeUnmount(() => {
  if (viewportRef.value) viewportRef.value.removeEventListener("scroll", onScroll);
  if (ro) ro.disconnect();
  if (rafId) cancelAnimationFrame(rafId);
});

/* ── Reset when table list changes ── */
watch(
  () => props.copy.sourceTableList.value,
  () => {
    searchQuery.value = "";
    collapsedGroups.clear();
    if (viewportRef.value) viewportRef.value.scrollTop = 0;
  }
);

/* ── Search reset scroll ── */
watch(searchQuery, () => {
  if (viewportRef.value) viewportRef.value.scrollTop = 0;
});
</script>

<template>
  <div class="wb-dialog-overlay" @click.self="!isBusy && emit('close')">
    <section
      class="wb-dialog wb-table-copy-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wb-table-copy-title"
    >
      <!-- Header -->
      <header class="wb-dialog-header">
        <strong id="wb-table-copy-title">发送表结构</strong>
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
          <span class="wb-table-copy-route-arrow" aria-hidden="true">→</span>
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
          <div
            v-if="!copy.dialog.targetDatabase"
            class="wb-table-copy-route-warning"
          >
            <span aria-hidden="true">⚠</span>
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
          <div class="wb-table-copy-search">
            <input
              v-model="searchQuery"
              type="text"
              placeholder="搜索表名或注释..."
              autocomplete="off"
              :disabled="isBusy"
            />
          </div>
          <div class="wb-table-copy-count">
            已选 <strong>{{ selectedCount }}</strong> / <strong>{{ sourceTableCount }}</strong>
          </div>
          <div class="wb-table-copy-actions">
            <button type="button" :disabled="isBusy" @click="expandAllGroups">全部展开</button>
            <button type="button" :disabled="isBusy" @click="collapseAllGroups">全部折叠</button>
            <button type="button" :disabled="isBusy || selectedCount === 0" @click="clearSelection">清空选择</button>
          </div>
        </div>

        <!-- Danger hint -->
        <div v-if="selectedCount > 50" class="wb-table-copy-danger-hint">
          <span aria-hidden="true">⚠</span>
          <span>
            你选择了大量表（{{ selectedCount }} 个）。确认发送将覆盖目标库的同名表结构。
          </span>
        </div>

        <!-- Virtual scroll viewport -->
        <div
          v-if="visibleItems.length"
          ref="viewportRef"
          class="wb-table-copy-viewport"
        >
          <div class="wb-table-copy-virtual" :style="{ height: totalHeight + 'px' }">
            <!-- Top spacer -->
            <div
              v-if="virtualWindow.start > 0"
              :style="{ height: virtualWindow.start * ITEM_HEIGHT + 'px', flexShrink: 0 }"
            />

            <!-- Visible rows -->
            <template v-for="idx in virtualWindow.end - virtualWindow.start" :key="idx">
              <div
                v-if="visibleItems[virtualWindow.start + idx - 1]?.type === 'group'"
                class="wb-table-copy-group-header"
                :class="{ 'is-collapsed': collapsedGroups.has(visibleItems[virtualWindow.start + idx - 1].prefix) }"
                role="button"
                tabindex="0"
                @click="toggleCollapse(visibleItems[virtualWindow.start + idx - 1].prefix)"
              >
                <span class="wb-table-copy-chevron" aria-hidden="true" />
                <input
                  type="checkbox"
                  class="wb-table-copy-group-checkbox"
                  :checked="isGroupSelected(visibleItems[virtualWindow.start + idx - 1].prefix)"
                  :indeterminate="isGroupIndeterminate(visibleItems[virtualWindow.start + idx - 1].prefix)"
                  :aria-label="`选择 ${visibleItems[virtualWindow.start + idx - 1].title} 全部表`"
                  @click.stop="toggleGroup(visibleItems[virtualWindow.start + idx - 1].prefix)"
                />
                <span class="wb-table-copy-group-title">{{ visibleItems[virtualWindow.start + idx - 1].title }}</span>
                <span class="wb-table-copy-group-meta">{{ visibleItems[virtualWindow.start + idx - 1].count }} 个表</span>
              </div>

              <label
                v-else
                class="wb-table-copy-row"
              >
                <input
                  type="checkbox"
                  :value="visibleItems[virtualWindow.start + idx - 1].name"
                  :checked="copy.selectedTableNames.has(visibleItems[virtualWindow.start + idx - 1].name)"
                  :disabled="isBusy"
                  @change="toggleTable(visibleItems[virtualWindow.start + idx - 1].name)"
                />
                <span class="wb-table-copy-row-name">{{ visibleItems[virtualWindow.start + idx - 1].name }}</span>
                <span class="wb-table-copy-row-comment">{{ visibleItems[virtualWindow.start + idx - 1].comment }}</span>
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
          <small>尝试调整搜索关键词或展开分组</small>
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
            确认发送
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>
