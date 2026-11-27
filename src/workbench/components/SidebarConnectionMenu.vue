<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  ArrowLeft,
  Check,
  Database,
  Folder,
  FolderInput,
  FolderOutput,
  FolderPlus,
  Pencil,
  Plug,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  Unplug,
} from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { formatShortcutForPlatform, isMacOSPlatform } from "../utils/desktopPlatform.js";
import { focusMenuItem, handleMenuKeydown } from "../utils/menuKeyboard.js";

// The sidebar's menu for connection rows and connection-group rows. "Move to
// group" opens the group list in place of the menu, at the same spot.
const props = defineProps({
  open: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  kind: { type: String, default: "connection" },
  theme: { type: String, default: "light" },
  // { id, label, closed, closable, groupId }
  connection: { type: Object, default: null },
  // { id, name, openCount, closedCount }
  group: { type: Object, default: null },
  groups: { type: Array, default: () => [] },
  focusOnOpen: { type: Boolean, default: false },
});

const emit = defineEmits(["select", "close"]);

const menuRef = ref(null);
const view = ref("main");
const position = ref({ left: "0px", top: "0px" });
const deleteKey = isMacOSPlatform() ? formatShortcutForPlatform("Backspace") : "Delete";

async function place({ focus = false } = {}) {
  position.value = { left: `${props.x}px`, top: `${props.y}px` };
  await nextTick();
  const menu = menuRef.value;
  if (!menu) return;
  const bounds = menu.getBoundingClientRect();
  position.value = {
    left: `${Math.max(8, Math.min(props.x, globalThis.innerWidth - bounds.width - 8))}px`,
    top: `${Math.max(8, Math.min(props.y, globalThis.innerHeight - bounds.height - 8))}px`,
  };
  if (focus) focusMenuItem(menu);
}

watch(() => [props.open, props.x, props.y, props.kind], ([open]) => {
  view.value = "main";
  if (open) void place({ focus: props.focusOnOpen });
}, { immediate: true });

function choose(action, payload = {}) {
  emit("select", { action, ...payload });
}

function showGroups() {
  view.value = "groups";
  void place({ focus: true });
}

function showMain() {
  view.value = "main";
  void place({ focus: true });
}

function onKeydown(event) {
  if (view.value === "groups" && (event.key === "ArrowLeft" || event.key === "Backspace")) {
    event.preventDefault();
    event.stopPropagation();
    showMain();
    return;
  }
  handleMenuKeydown(event, menuRef.value, { close: () => emit("close", { restoreFocus: true }) });
}

function onDocumentPointerDown(event) {
  if (!menuRef.value?.contains?.(event.target)) emit("close", { restoreFocus: false });
}

function onDocumentKeydown(event) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  emit("close", { restoreFocus: true });
}

function onWindowChange() {
  emit("close", { restoreFocus: false });
}

watch(() => props.open, (open) => {
  const method = open ? "addEventListener" : "removeEventListener";
  document[method]("pointerdown", onDocumentPointerDown, true);
  document[method]("keydown", onDocumentKeydown, true);
  globalThis[method]?.("resize", onWindowChange);
  globalThis[method]?.("blur", onWindowChange);
}, { immediate: true });

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  document.removeEventListener("keydown", onDocumentKeydown, true);
  globalThis.removeEventListener?.("resize", onWindowChange);
  globalThis.removeEventListener?.("blur", onWindowChange);
});
</script>

<template>
  <Teleport to="body">
    <menu
      v-if="open"
      ref="menuRef"
      class="wb-context-menu wb-sidebar-connection-menu wb-floating-themed"
      :class="{ 'is-group-list': view === 'groups' }"
      :data-theme="theme"
      :style="position"
      role="menu"
      tabindex="-1"
      :aria-label="kind === 'group' ? t('connectionGroup.menuLabel', { name: group?.name || '' }) : t('connectionGroup.connectionMenuLabel', { name: connection?.label || '' })"
      @keydown="onKeydown"
      @contextmenu.prevent.stop
    >
      <template v-if="kind === 'group' && group">
        <button type="button" role="menuitem" :disabled="!group.closedCount" @click="choose('group-open-all')">
          <Plug :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("connectionGroup.openAll") }}
        </button>
        <button type="button" role="menuitem" :disabled="!group.openCount" @click="choose('group-close-all')">
          <Unplug :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("connectionGroup.closeAll") }}
        </button>
        <hr class="wb-context-separator" role="separator" />
        <button type="button" role="menuitem" @click="choose('group-rename')">
          <Pencil :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("connectionGroup.rename") }}<kbd class="wb-context-shortcut" aria-hidden="true">F2</kbd>
        </button>
        <button type="button" role="menuitem" class="danger" @click="choose('group-delete')">
          <Trash2 :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("connectionGroup.delete") }}<kbd class="wb-context-shortcut" aria-hidden="true">{{ deleteKey }}</kbd>
        </button>
      </template>

      <template v-else-if="connection && view === 'groups'">
        <button type="button" role="menuitem" class="wb-sidebar-connection-menu-back" @click="showMain">
          <ArrowLeft :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("connectionGroup.moveTo") }}
        </button>
        <hr class="wb-context-separator" role="separator" />
        <button
          v-for="item in groups"
          :key="item.id"
          type="button"
          role="menuitemradio"
          :aria-checked="item.id === connection.groupId ? 'true' : 'false'"
          @click="choose('move-to', { groupId: item.id })"
        >
          <Folder :size="14" class="wb-context-icon" aria-hidden="true" />
          <span class="wb-sidebar-connection-menu-name">{{ item.name }}</span>
          <Check v-if="item.id === connection.groupId" :size="14" class="wb-context-check" aria-hidden="true" />
        </button>
        <hr class="wb-context-separator" role="separator" />
        <button type="button" role="menuitem" @click="choose('new-group')">
          <FolderPlus :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("connectionGroup.newGroupWith") }}
        </button>
      </template>

      <template v-else-if="connection">
        <button v-if="connection.closed" type="button" role="menuitem" @click="choose('open')">
          <Plug :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("connectionGroup.openConnection") }}<kbd class="wb-context-shortcut" aria-hidden="true">Enter</kbd>
        </button>
        <button v-else-if="connection.closable" type="button" role="menuitem" @click="choose('close')">
          <Unplug :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("connectionGroup.closeConnection") }}
        </button>
        <button v-if="!connection.closed && connection.canManageDatabase" type="button" role="menuitem" @click="choose('new-database')">
          <Database :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("databaseManage.createAction") }}
        </button>
        <button v-if="connection.editable" type="button" role="menuitem" @click="choose('edit')">
          <SlidersHorizontal :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("connection.editAction") }}
        </button>
        <hr v-if="connection.closed || connection.closable || connection.editable" class="wb-context-separator" role="separator" />
        <button v-if="groups.length" type="button" role="menuitem" aria-haspopup="menu" @click="showGroups">
          <FolderInput :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("connectionGroup.moveToEllipsis") }}
        </button>
        <button v-else type="button" role="menuitem" @click="choose('new-group')">
          <FolderPlus :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("connectionGroup.newGroupWith") }}
        </button>
        <button v-if="connection.groupId" type="button" role="menuitem" @click="choose('ungroup')">
          <FolderOutput :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("connectionGroup.removeFromGroup") }}
        </button>
        <hr class="wb-context-separator" role="separator" />
        <button type="button" role="menuitem" @click="choose('rename')">
          <Pencil :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("m_d35464f7ca6b") }}<kbd class="wb-context-shortcut" aria-hidden="true">F2</kbd>
        </button>
        <button v-if="!connection.closed" type="button" role="menuitem" @click="choose('refresh')">
          <RefreshCw :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("m_aee887434131") }}
        </button>
        <hr class="wb-context-separator" role="separator" />
        <button type="button" role="menuitem" class="danger" @click="choose('remove')">
          <Trash2 :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("m_e4e4e0ad5de1") }}<kbd class="wb-context-shortcut" aria-hidden="true">{{ deleteKey }}</kbd>
        </button>
      </template>
    </menu>
  </Teleport>
</template>
