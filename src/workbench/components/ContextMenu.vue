<script setup>
import { t } from "../i18n/index.js";
import { computed, ref, watch } from 'vue';
import {
  ArrowDownToLine,
  ArrowUpToLine,
  CircleSlash,
  ClipboardPaste,
  Columns2,
  Copy,
  DatabaseZap,
  FolderOpen,
  ListRestart,
  Minus,
  Pencil,
  PinOff,
  Plus,
  RefreshCw,
  Send,
  Snowflake,
  TableProperties,
  Trash2,
  Unplug,
} from "lucide-vue-next";
import { useShortcuts } from "../composables/useShortcuts.js";
import { formatShortcutForPlatform, isMacOSPlatform } from "../utils/desktopPlatform.js";
import { focusMenuItem, handleMenuKeydown } from "../utils/menuKeyboard.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  tableScoped: { type: Boolean, default: false },
  kind: { type: String, default: "general" },
  surface: { type: String, default: "general" },
  showClipboardActions: { type: Boolean, default: false },
  canCopy: { type: Boolean, default: false },
  canPaste: { type: Boolean, default: false },
  connectionId: { type: String, default: "" },
  database: { type: String, default: "" },
  tableName: { type: String, default: "" },
  rowReadOnly: { type: Boolean, default: false },
  canInsertCopiedRows: { type: Boolean, default: false },
  // True only when a data cell is selected on a nullable, non-PK column so the
  // "设为 NULL" action is meaningful (#5).
  canSetNull: { type: Boolean, default: false },
  canToggleHitResultPane: { type: Boolean, default: false },
  hitResultPaneOpen: { type: Boolean, default: false },
  // 「删除行」按钮文字：选中多行时由父组件传入「删除 X 行」。
  deleteLabel: { type: String, default: "删除行" },
  // ── Freeze panes ───────────────────────────────────────────────────────
  // 是否显示「冻结到此行 / 冻结到此列 / 冻结到此单元格」。父组件依据右键目标位置决定。
  canFreezeRow: { type: Boolean, default: false },
  canFreezeColumn: { type: Boolean, default: false },
  // 「冻结到此单元格」：同时冻结该单元格上方所有行 + 左侧所有列（Excel「冻结窗格」语义）。
  canFreezeCell: { type: Boolean, default: false },
  // 当前是否存在任意冻结（决定「取消冻结」是否显示）。
  hasFreeze: { type: Boolean, default: false },
  canResetColumnOrder: { type: Boolean, default: false },
  canEditComment: { type: Boolean, default: false },
  // 动态标签。
  freezeRowLabel: { type: String, default: "冻结到此行" },
  freezeColumnLabel: { type: String, default: "冻结到此列" },
  freezeCellLabel: { type: String, default: "冻结到此单元格" },
  // Sidebar table menus act on the whole selection when the clicked table is
  // part of it.
  tableCount: { type: Number, default: 1 },
  canDeleteTables: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'open-tables', 'delete-tables', 'copy', 'paste', 'refresh', 'open-design', 'sync-database', 'send-table', 'rename', 'rename-database', 'rename-connection', 'remove-connection', 'grid-row-insert-above', 'grid-row-insert-below', 'grid-row-paste-above', 'grid-row-delete', 'set-null', 'toggle-hit-result-pane', 'freeze-row', 'freeze-column', 'freeze-cell', 'freeze-top-row', 'freeze-first-column', 'unfreeze', 'reset-column-order', 'edit-comment']);

const showFreezeActions = computed(() => props.surface === "grid" || props.kind === "grid-row");
const showTableActions = computed(() => props.tableScoped && !["inspector", "detail"].includes(props.surface));
const showSidebarTableActions = computed(() => props.kind === "table" && props.surface === "sidebar");
const isGridMenu = computed(() => props.surface === "grid" || props.kind === "grid-row");
const shortcuts = useShortcuts();
// Hints only where the key does the same thing in that place: F2 renames a
// table in the sidebar but edits a cell in the grid, and Ctrl+D/F5 act on the
// open table rather than a sidebar row.
const shortcutHints = computed(() => ({
  open: "Enter",
  copy: formatShortcutForPlatform("Ctrl+C"),
  paste: formatShortcutForPlatform("Ctrl+V"),
  deleteRows: "Delete",
  deleteTables: isMacOSPlatform() ? formatShortcutForPlatform("Backspace") : "Delete",
  rename: showSidebarTableActions.value ? "F2" : "",
  design: isGridMenu.value ? formatShortcutForPlatform(shortcuts.get("openDesign")) : "",
  refresh: isGridMenu.value ? formatShortcutForPlatform(shortcuts.get("refresh")) : "",
}));
const menuRef = ref(null);

function handleKeydown(event) {
  handleMenuKeydown(event, menuRef.value, { close: () => emit("close") });
}

function focusFirstItem() {
  return focusMenuItem(menuRef.value, "first");
}

defineExpose({ focusFirstItem });
const showTransferActions = computed(() => showTableActions.value || props.kind === "database");
const insertRowCount = ref(1);
const normalizedInsertRowCount = computed(() => Math.max(1, Math.min(99, Math.floor(Number(insertRowCount.value) || 1))));

watch(() => props.open, (open) => {
  if (open && props.kind === "grid-row") insertRowCount.value = 1;
});

function stepInsertRowCount(delta) {
  insertRowCount.value = Math.max(1, Math.min(99, normalizedInsertRowCount.value + delta));
}

function commitInsertRowCount() {
  insertRowCount.value = normalizedInsertRowCount.value;
}

function emitSyncDatabase() {
  emit('sync-database', {
    kind: props.kind,
    connectionId: props.connectionId,
    database: props.database,
  });
}

const contextMenuStyle = computed(() => ({
  left: `${props.x}px`,
  top: `${props.y}px`,
}));
</script>

<template>
  <menu
    v-if="open"
    ref="menuRef"
    class="wb-context-menu"
    :class="{ 'wb-input-context-menu': surface === 'input' }"
    :style="contextMenuStyle"
    role="menu"
    tabindex="-1"
    :aria-label="t('m_1a94fed1be72')"
    @mousedown.stop="surface === 'input' && $event.preventDefault()"
    @click.stop
    @contextmenu.prevent.stop
    @keydown="handleKeydown"
  >
    <template v-if="canEditComment">
      <button type="button" role="menuitem" @click="emit('edit-comment')"><Pencil :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_2d22af42a79f') }}</button>
      <hr v-if="surface !== 'input'" class="wb-context-separator" role="separator" />
    </template>
    <template v-if="showClipboardActions">
      <button type="button" role="menuitem" :disabled="!canCopy" @click="emit('copy')"><Copy :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_63d90d977348') }}<kbd class="wb-context-shortcut" aria-hidden="true">{{ shortcutHints.copy }}</kbd></button>
      <button type="button" role="menuitem" :disabled="!canPaste" @click="emit('paste')"><ClipboardPaste :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_335179267471') }}<kbd class="wb-context-shortcut" aria-hidden="true">{{ shortcutHints.paste }}</kbd></button>
      <button v-if="canSetNull && surface === 'grid' && kind !== 'grid-row'" type="button" role="menuitem" @click="emit('set-null')"><CircleSlash :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_cb818676f2e1') }}</button>
      <hr v-if="surface !== 'input'" class="wb-context-separator" role="separator" />
    </template>
    <!-- 行操作组 -->
    <template v-if="kind === 'grid-row' && !rowReadOnly">
      <div class="wb-context-insert-count" role="group" :aria-label="t('m_82a6458dac05')">
        <span>{{ t('m_82a6458dac05') }}</span>
        <span class="wb-context-count-control">
          <button type="button" class="wb-context-count-step" :aria-label="t('m_ad2fc8dd1f96')" :disabled="normalizedInsertRowCount <= 1" @click.stop="stepInsertRowCount(-1)"><Minus :size="12" aria-hidden="true" /></button>
          <input
            :value="insertRowCount"
            type="number"
            min="1"
            max="99"
            inputmode="numeric"
            :aria-label="t('m_82a6458dac05')"
            @input="insertRowCount = $event.target.value"
            @blur="commitInsertRowCount"
            @keydown.stop
            @click.stop
          />
          <button type="button" class="wb-context-count-step" :aria-label="t('m_ca4c4074c035')" :disabled="normalizedInsertRowCount >= 99" @click.stop="stepInsertRowCount(1)"><Plus :size="12" aria-hidden="true" /></button>
        </span>
      </div>
      <button type="button" role="menuitem" @click="emit('grid-row-insert-above', normalizedInsertRowCount)"><ArrowUpToLine :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_48e4de4ac636') }} {{ normalizedInsertRowCount }} {{ t('m_4cc7b00050cb') }}</button>
      <button type="button" role="menuitem" @click="emit('grid-row-insert-below', normalizedInsertRowCount)"><ArrowDownToLine :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_5232ad2f35aa') }} {{ normalizedInsertRowCount }} {{ t('m_4cc7b00050cb') }}</button>
      <button v-if="canInsertCopiedRows" type="button" role="menuitem" @click="emit('grid-row-paste-above')"><ClipboardPaste :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_9b8d86c405fe') }}</button>
      <button v-if="canSetNull" type="button" role="menuitem" @click="emit('set-null')"><CircleSlash :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_cb818676f2e1') }}</button>
      <button type="button" role="menuitem" class="danger" @click="emit('grid-row-delete')"><Trash2 :size="14" class="wb-context-icon" aria-hidden="true" />{{ deleteLabel }}<kbd class="wb-context-shortcut" aria-hidden="true">{{ shortcutHints.deleteRows }}</kbd></button>
      <hr v-if="tableScoped || canFreezeRow || canFreezeColumn || canFreezeCell || hasFreeze" class="wb-context-separator" role="separator" />
    </template>
    <!-- 冻结窗格组：在表格/行右键时出现，按位置冻结（Excel 语义） -->
    <template v-if="showFreezeActions">
      <button v-if="canFreezeCell" type="button" role="menuitem" @click="emit('freeze-cell')"><Snowflake :size="14" class="wb-context-icon" aria-hidden="true" />{{ freezeCellLabel }}</button>
      <button v-if="canFreezeRow" type="button" role="menuitem" @click="emit('freeze-row')"><Snowflake :size="14" class="wb-context-icon" aria-hidden="true" />{{ freezeRowLabel }}</button>
      <button v-if="canFreezeColumn" type="button" role="menuitem" @click="emit('freeze-column')"><Snowflake :size="14" class="wb-context-icon" aria-hidden="true" />{{ freezeColumnLabel }}</button>
      <button v-if="!canFreezeCell && !canFreezeRow && !canFreezeColumn" type="button" role="menuitem" @click="emit('freeze-top-row')"><Snowflake :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_d1ec96b9a1c9') }}</button>
      <button v-if="!canFreezeCell && !canFreezeRow && !canFreezeColumn" type="button" role="menuitem" @click="emit('freeze-first-column')"><Snowflake :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_e6f957238ec6') }}</button>
      <button v-if="hasFreeze" type="button" role="menuitem" @click="emit('unfreeze')"><PinOff :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_0592dd0b34a5') }}</button>
      <button v-if="canResetColumnOrder" type="button" role="menuitem" @click="emit('reset-column-order')"><ListRestart :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_3ac8482b6eb7') }}</button>
      <hr v-if="showTableActions" class="wb-context-separator" role="separator" />
    </template>
    <!-- 表操作组 -->
    <button v-if="showSidebarTableActions" type="button" role="menuitem" @click="emit('open-tables')"><FolderOpen :size="14" class="wb-context-icon" aria-hidden="true" />{{ tableCount > 1 ? t('home.openTables', { count: tableCount }) : t('m_bf8ef131aa2d') }}<kbd class="wb-context-shortcut" aria-hidden="true">{{ shortcutHints.open }}</kbd></button>
    <button v-if="showTableActions" type="button" role="menuitem" @click="emit('open-design')"><TableProperties :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_d9a122ddc940') }}<kbd v-if="shortcutHints.design" class="wb-context-shortcut" aria-hidden="true">{{ shortcutHints.design }}</kbd></button>
    <button v-if="showTableActions" type="button" role="menuitem" @click="emit('rename')"><Pencil :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_0d0cbac2eee5') }}<kbd v-if="shortcutHints.rename" class="wb-context-shortcut" aria-hidden="true">{{ shortcutHints.rename }}</kbd></button>
    <button v-if="showTransferActions" type="button" role="menuitem" @click="emit('send-table')"><Send :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_8f211e16faf2') }}</button>
    <button v-if="showTransferActions" type="button" role="menuitem" @click="emitSyncDatabase"><DatabaseZap :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_623281e9dfdb') }}</button>
    <button v-if="showTableActions && canToggleHitResultPane" type="button" role="menuitem" @click="emit('toggle-hit-result-pane')"><Columns2 :size="14" class="wb-context-icon" aria-hidden="true" />{{ hitResultPaneOpen ? t('m_5d43a2115ed9') : t('m_d7898968a0a2') }}</button>
    <hr v-if="showTableActions || kind === 'database' || kind === 'connection'" class="wb-context-separator" role="separator" />
    <!-- 通用操作组 -->
    <button v-if="kind === 'connection'" type="button" role="menuitem" @click="emit('rename-connection')"><Pencil :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_d35464f7ca6b') }}</button>
    <button v-if="kind === 'database'" type="button" role="menuitem" @click="emit('rename-database')"><Pencil :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_1a4af72dce0e') }}</button>
    <button v-if="surface !== 'input'" type="button" role="menuitem" @click="emit('refresh')"><RefreshCw :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_aee887434131') }}<kbd v-if="shortcutHints.refresh" class="wb-context-shortcut" aria-hidden="true">{{ shortcutHints.refresh }}</kbd></button>
    <!-- 危险操作放最后 -->
    <button v-if="showSidebarTableActions" type="button" role="menuitem" class="danger" :disabled="!canDeleteTables" @click="emit('delete-tables')"><Trash2 :size="14" class="wb-context-icon" aria-hidden="true" />{{ tableCount > 1 ? t('home.deleteTables', { count: tableCount }) : t('m_d545721cef25') }}<kbd class="wb-context-shortcut" aria-hidden="true">{{ shortcutHints.deleteTables }}</kbd></button>
    <button v-if="kind === 'connection'" type="button" role="menuitem" class="danger" @click="emit('remove-connection')"><Unplug :size="14" class="wb-context-icon" aria-hidden="true" />{{ t('m_e4e4e0ad5de1') }}</button>
  </menu>
</template>
