<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, unref, watch } from "vue";
import { Check, Database, Keyboard, Plus, Search, Trash2, X } from "lucide-vue-next";

import { useAliases } from "../composables/aliasStore.js";
import { useHomeDatabaseFavoritesContext } from "../composables/homeDatabaseFavoritesContext.js";
import { isSafeInAppShortcut, shortcutComboFromEvent } from "../composables/useShortcuts.js";

const props = defineProps({
  paneId: { type: String, default: "" },
});

const context = useHomeDatabaseFavoritesContext();
const { connectionLabel, databaseLabel } = useAliases();
const panelRef = ref(null);
const pickerSearchRef = ref(null);
const shortcutEditorRef = ref(null);
const anchorElement = ref(null);
const panelVisible = ref(false);
const pickerOpen = ref(false);
const pickerLoading = ref(false);
const pickerConnectionId = ref("");
const pickerDatabase = ref("");
const pickerQuery = ref("");
const shortcutTargetKey = ref("");
const shortcutError = ref("");
const panelPosition = ref({ left: 8, top: 48 });
let hideTimer = null;

const favorites = computed(() => unref(context?.favorites) || []);
const connections = computed(() => unref(context?.connections) || []);
const currentConnectionId = computed(() => String(unref(context?.currentConnectionId) || ""));
const currentDatabase = computed(() => String(unref(context?.currentDatabase) || ""));
const currentDatabases = computed(() => unref(context?.databases) || []);
const theme = computed(() => unref(context?.theme) || "light");
const databasesByConnection = computed(() => context?.databasesByConnection || {});
const databaseFetchErrors = computed(() => context?.databaseFetchErrors || {});

const connectedConnections = computed(() => connections.value.filter((connection) => {
  const kind = String(connection?.kind || "mysql").toLowerCase();
  return connection?.connected === true && (kind === "mysql" || kind === "clickhouse");
}));

const selectedConnection = computed(() => (
  connectedConnections.value.find((connection) => String(connection.id) === pickerConnectionId.value) || null
));

const selectedConnectionDatabases = computed(() => databasesForConnection(pickerConnectionId.value));
const pickerDatabaseRows = computed(() => {
  const query = pickerQuery.value.trim().toLocaleLowerCase();
  return selectedConnectionDatabases.value
    .filter((database) => !query || databaseSearchText(pickerConnectionId.value, database).includes(query))
    .map((database) => ({
      database,
      label: databaseLabel(pickerConnectionId.value, database) || database,
      favorite: isFavorite(pickerConnectionId.value, database),
    }));
});

const canAddSelection = computed(() => Boolean(
  pickerConnectionId.value && pickerDatabase.value && !isFavorite(pickerConnectionId.value, pickerDatabase.value),
));

const panelStyle = computed(() => ({
  left: `${panelPosition.value.left}px`,
  top: `${panelPosition.value.top}px`,
}));

function entryKey(entry) {
  return `${String(entry?.connectionId || "")}\u001f${String(entry?.database || "")}`;
}

function connectionFor(connectionId) {
  return connections.value.find((connection) => String(connection?.id) === String(connectionId)) || null;
}

function displayedConnectionLabel(connectionId) {
  const connection = connectionFor(connectionId);
  return connectionLabel(connectionId, connection?.label || connectionId || "") || "未知连接";
}

function displayedDatabaseLabel(entry) {
  return databaseLabel(entry?.connectionId, entry?.database) || String(entry?.database || "");
}

function engineLabel(connection) {
  return String(connection?.kind || "mysql").toLowerCase() === "clickhouse" ? "CH" : "MySQL";
}

function isCurrent(entry) {
  return String(entry?.connectionId || "") === currentConnectionId.value && String(entry?.database || "") === currentDatabase.value;
}

function isConnected(entry) {
  return connectionFor(entry?.connectionId)?.connected === true;
}

function isFavorite(connectionId, database) {
  return favorites.value.some((entry) => (
    String(entry.connectionId || "") === String(connectionId || "") && String(entry.database || "") === String(database || "")
  ));
}

function databasesForConnection(connectionId) {
  const id = String(connectionId || "");
  if (!id) return [];
  const cached = databasesByConnection.value?.[id];
  if (Array.isArray(cached)) return cached;
  return id === currentConnectionId.value ? currentDatabases.value : [];
}

function databaseSearchText(connectionId, database) {
  return `${databaseLabel(connectionId, database) || ""} ${database || ""}`.toLocaleLowerCase();
}

function connectionDatabaseCount(connectionId) {
  return databasesForConnection(connectionId).length;
}

function cancelScheduledHide() {
  if (hideTimer != null) globalThis.clearTimeout?.(hideTimer);
  hideTimer = null;
}

function updatePanelPosition() {
  const rect = anchorElement.value?.getBoundingClientRect?.();
  if (!rect) return;
  const width = Math.min(336, Math.max(280, (globalThis.innerWidth || 360) - 16));
  const maxLeft = Math.max(8, (globalThis.innerWidth || rect.right + width) - width - 8);
  panelPosition.value = {
    left: Math.min(Math.max(8, rect.left), maxLeft),
    top: Math.max(8, rect.bottom + 6),
  };
}

function show(anchor, { focusPanel = false } = {}) {
  if (!context || pickerOpen.value) return;
  cancelScheduledHide();
  if (anchor) anchorElement.value = anchor;
  updatePanelPosition();
  panelVisible.value = true;
  nextTick(() => {
    updatePanelPosition();
    if (focusPanel) panelRef.value?.querySelector?.("button:not(:disabled)")?.focus?.();
  });
}

function hide() {
  cancelScheduledHide();
  panelVisible.value = false;
  shortcutTargetKey.value = "";
  shortcutError.value = "";
}

function scheduleHide() {
  cancelScheduledHide();
  hideTimer = globalThis.setTimeout?.(() => hide(), 180);
}

async function openPicker() {
  hide();
  pickerOpen.value = true;
  pickerQuery.value = "";
  pickerDatabase.value = "";
  const preferred = connectedConnections.value.find((connection) => String(connection.id) === currentConnectionId.value);
  pickerConnectionId.value = String(preferred?.id || connectedConnections.value[0]?.id || "");
  pickerLoading.value = true;
  try {
    await context?.loadDatabases?.();
  } finally {
    pickerLoading.value = false;
    ensurePickerSelection();
    nextTick(() => pickerSearchRef.value?.focus?.());
  }
}

function closePicker({ restorePanel = false } = {}) {
  pickerOpen.value = false;
  pickerQuery.value = "";
  pickerDatabase.value = "";
  if (restorePanel && anchorElement.value?.isConnected) show(anchorElement.value);
}

function ensurePickerSelection() {
  const rows = pickerDatabaseRows.value;
  if (rows.some((row) => row.database === pickerDatabase.value && !row.favorite)) return;
  pickerDatabase.value = rows.find((row) => !row.favorite)?.database || "";
}

function selectPickerConnection(connectionId) {
  pickerConnectionId.value = String(connectionId || "");
  pickerQuery.value = "";
  pickerDatabase.value = "";
  ensurePickerSelection();
  nextTick(() => pickerSearchRef.value?.focus?.());
}

function selectPickerDatabase(row) {
  if (row.favorite) return;
  pickerDatabase.value = row.database;
}

function confirmPicker() {
  if (!canAddSelection.value) return;
  const result = context?.addFavorite?.({
    connectionId: pickerConnectionId.value,
    database: pickerDatabase.value,
  });
  if (result?.ok === false) return;
  closePicker({ restorePanel: true });
}

async function openFavorite(entry) {
  if (!entry?.database || !connectionFor(entry.connectionId)) return;
  hide();
  await context?.openDatabase?.({ ...entry, paneId: props.paneId });
}

function removeFavorite(entry) {
  context?.removeFavorite?.(entry);
  if (shortcutTargetKey.value === entryKey(entry)) {
    shortcutTargetKey.value = "";
    shortcutError.value = "";
  }
}

function beginShortcutCapture(entry) {
  shortcutTargetKey.value = entryKey(entry);
  shortcutError.value = "";
  nextTick(() => {
    const element = Array.isArray(shortcutEditorRef.value) ? shortcutEditorRef.value[0] : shortcutEditorRef.value;
    element?.focus?.();
  });
}

function cancelShortcutCapture() {
  shortcutTargetKey.value = "";
  shortcutError.value = "";
}

function clearShortcut(entry) {
  const result = context?.setShortcut?.({ ...entry, shortcut: "" });
  if (result?.ok === false) {
    shortcutError.value = result.error || "清除快捷键失败";
    return;
  }
  cancelShortcutCapture();
}

function captureShortcut(entry, event) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancelShortcutCapture();
    return;
  }
  const combo = shortcutComboFromEvent(event);
  if (!combo) return;
  event.preventDefault();
  event.stopPropagation();
  if (!isSafeInAppShortcut(combo)) {
    shortcutError.value = "请使用 Ctrl 或 Alt 组合键，或 F1–F12";
    return;
  }
  const result = context?.setShortcut?.({ ...entry, shortcut: combo });
  if (result?.ok === false) {
    shortcutError.value = result.error || "快捷键冲突";
    return;
  }
  cancelShortcutCapture();
}

function handleDocumentPointerDown(event) {
  if (!panelVisible.value) return;
  const target = event.target;
  if (anchorElement.value?.contains?.(target) || panelRef.value?.contains?.(target)) return;
  hide();
}

function handleViewportChange() {
  if (panelVisible.value) updatePanelPosition();
}

watch([pickerDatabaseRows, favorites], ensurePickerSelection, { deep: true });

onMounted(() => {
  document.addEventListener("pointerdown", handleDocumentPointerDown, true);
  globalThis.addEventListener?.("resize", handleViewportChange);
});

onBeforeUnmount(() => {
  cancelScheduledHide();
  document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
  globalThis.removeEventListener?.("resize", handleViewportChange);
});

defineExpose({ show, hide, scheduleHide });
</script>

<template>
  <Teleport to="body">
    <section
      v-if="panelVisible"
      ref="panelRef"
      class="wb-home-favorites-panel wb-floating-themed"
      :data-theme="theme"
      :style="panelStyle"
      role="menu"
      aria-label="收藏数据库"
      @pointerenter="cancelScheduledHide"
      @pointerleave="scheduleHide"
      @focusin="cancelScheduledHide"
      @focusout="scheduleHide"
      @keydown.esc.stop.prevent="hide"
    >
      <header class="wb-home-favorites-header">
        <span>收藏数据库</span>
        <small>快速切换</small>
      </header>

      <div v-if="favorites.length" class="wb-home-favorites-list">
        <div
          v-for="entry in favorites"
          :key="entryKey(entry)"
          class="wb-home-favorite-item"
          :class="{ 'is-current': isCurrent(entry), 'is-disconnected': !isConnected(entry) }"
        >
          <button
            type="button"
            class="wb-home-favorite-open"
            role="menuitem"
            :disabled="!connectionFor(entry.connectionId)"
            :title="`${displayedConnectionLabel(entry.connectionId)} / ${entry.database}`"
            @click="openFavorite(entry)"
          >
            <span class="wb-home-favorite-db-icon" aria-hidden="true"><Database :size="15" /></span>
            <span class="wb-home-favorite-copy">
              <strong>{{ displayedDatabaseLabel(entry) }}</strong>
              <small>{{ displayedConnectionLabel(entry.connectionId) }}</small>
            </span>
            <span v-if="isCurrent(entry)" class="wb-home-favorite-state">当前</span>
            <span v-else-if="!isConnected(entry)" class="wb-home-favorite-state is-warning">需重连</span>
          </button>
          <button
            type="button"
            class="wb-home-favorite-shortcut"
            :title="entry.shortcut ? `修改快捷键 ${entry.shortcut}` : '设置应用内快捷键'"
            :aria-label="entry.shortcut ? `修改 ${displayedDatabaseLabel(entry)} 的快捷键` : `设置 ${displayedDatabaseLabel(entry)} 的快捷键`"
            @click="beginShortcutCapture(entry)"
          >
            <kbd v-if="entry.shortcut">{{ entry.shortcut }}</kbd>
            <Keyboard v-else :size="15" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="wb-home-favorite-remove"
            :aria-label="`移除收藏 ${displayedDatabaseLabel(entry)}`"
            title="移除收藏"
            @click="removeFavorite(entry)"
          ><Trash2 :size="14" aria-hidden="true" /></button>

          <div
            v-if="shortcutTargetKey === entryKey(entry)"
            ref="shortcutEditorRef"
            class="wb-home-favorite-shortcut-editor"
            tabindex="0"
            data-wb-shortcut-capture="true"
            @keydown="captureShortcut(entry, $event)"
          >
            <span><Keyboard :size="14" aria-hidden="true" />按下新的组合键</span>
            <button v-if="entry.shortcut" type="button" @click="clearShortcut(entry)">清除</button>
            <button type="button" @click="cancelShortcutCapture">取消</button>
            <small v-if="shortcutError">{{ shortcutError }}</small>
          </div>
        </div>
      </div>

      <div v-else class="wb-home-favorites-empty">
        <span class="wb-home-favorites-empty-icon" aria-hidden="true"><Database :size="20" /></span>
        <strong>把常用数据库放在这里</strong>
        <small>从首页标签快速切换连接和数据库</small>
      </div>

      <button type="button" class="wb-home-favorites-add" role="menuitem" @click="openPicker">
        <Plus :size="15" aria-hidden="true" />
        <span>{{ favorites.length ? "添加数据库" : "添加收藏数据库" }}</span>
      </button>
    </section>

    <div
      v-if="pickerOpen"
      class="wb-home-favorite-picker-overlay wb-floating-themed"
      :data-theme="theme"
      @mousedown.self="closePicker()"
      @keydown.esc.stop.prevent="closePicker()"
    >
      <section class="wb-home-favorite-picker" role="dialog" aria-modal="true" aria-labelledby="wb-home-favorite-picker-title">
        <header class="wb-home-favorite-picker-header">
          <div>
            <strong id="wb-home-favorite-picker-title">收藏数据库</strong>
            <small>选择一个已连接的 MySQL 或 ClickHouse 数据库</small>
          </div>
          <button type="button" aria-label="关闭" @click="closePicker()"><X :size="17" aria-hidden="true" /></button>
        </header>

        <div v-if="connectedConnections.length" class="wb-home-favorite-picker-body">
          <nav class="wb-home-favorite-connections" aria-label="已连接的数据库服务">
            <button
              v-for="connection in connectedConnections"
              :key="connection.id"
              type="button"
              :class="{ 'is-selected': String(connection.id) === pickerConnectionId }"
              @click="selectPickerConnection(connection.id)"
            >
              <span class="wb-home-favorite-engine">{{ engineLabel(connection) }}</span>
              <span class="wb-home-favorite-connection-copy">
                <strong>{{ displayedConnectionLabel(connection.id) }}</strong>
                <small>{{ connection.host }}:{{ connection.port }}</small>
              </span>
              <span class="wb-home-favorite-count">{{ connectionDatabaseCount(connection.id) }}</span>
            </button>
          </nav>

          <section class="wb-home-favorite-databases" aria-label="数据库列表">
            <header>
              <div>
                <strong>{{ displayedConnectionLabel(pickerConnectionId) }}</strong>
                <small>{{ selectedConnection ? engineLabel(selectedConnection) : "" }}</small>
              </div>
              <label class="wb-home-favorite-search">
                <Search :size="14" aria-hidden="true" />
                <input
                  ref="pickerSearchRef"
                  v-model="pickerQuery"
                  type="search"
                  autocomplete="off"
                  placeholder="筛选数据库"
                  aria-label="筛选数据库"
                />
              </label>
            </header>

            <div v-if="pickerLoading && !pickerDatabaseRows.length" class="wb-home-favorite-picker-status">正在读取数据库…</div>
            <div v-else-if="databaseFetchErrors[pickerConnectionId]" class="wb-home-favorite-picker-status is-error">
              {{ databaseFetchErrors[pickerConnectionId].message || "数据库读取失败" }}
            </div>
            <div v-else-if="pickerDatabaseRows.length" class="wb-home-favorite-database-list" role="listbox" aria-label="选择数据库">
              <button
                v-for="row in pickerDatabaseRows"
                :key="row.database"
                type="button"
                role="option"
                :aria-selected="row.database === pickerDatabase ? 'true' : 'false'"
                :disabled="row.favorite"
                :class="{ 'is-selected': row.database === pickerDatabase, 'is-favorite': row.favorite }"
                @click="selectPickerDatabase(row)"
                @dblclick="selectPickerDatabase(row); confirmPicker()"
              >
                <Database :size="15" aria-hidden="true" />
                <span>
                  <strong>{{ row.label }}</strong>
                  <small v-if="row.label !== row.database">{{ row.database }}</small>
                </span>
                <em v-if="row.favorite"><Check :size="13" aria-hidden="true" />已收藏</em>
              </button>
            </div>
            <div v-else class="wb-home-favorite-picker-status">
              {{ pickerQuery ? "没有匹配的数据库" : "该连接暂无可用数据库" }}
            </div>
          </section>
        </div>

        <div v-else class="wb-home-favorite-picker-empty">
          <Database :size="24" aria-hidden="true" />
          <strong>当前没有已连接的数据库服务</strong>
          <span>请先在左侧连接一个 MySQL 或 ClickHouse 服务，再回来添加收藏。</span>
        </div>

        <footer class="wb-home-favorite-picker-footer">
          <span v-if="pickerDatabase">
            将收藏 <strong>{{ databaseLabel(pickerConnectionId, pickerDatabase) || pickerDatabase }}</strong>
          </span>
          <span v-else>请选择具体数据库</span>
          <div>
            <button type="button" @click="closePicker()">取消</button>
            <button type="button" class="is-primary" :disabled="!canAddSelection" @click="confirmPicker">添加收藏</button>
          </div>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
