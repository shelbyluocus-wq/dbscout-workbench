<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import { ArrowLeft, Check, Folder, FolderInput, FolderOutput, FolderPlus, Palette, Pencil, PinOff, Plus, Ungroup } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useActivityRailSort } from "../composables/useActivityRailSort.js";
import { retainPointerActivationChrome } from "../pointerActivationChrome.js";
import { readDatabaseDrop } from "../utils/databaseDragPayload.js";
import { isContextMenuKey } from "../utils/listSelection.js";
import { focusMenuItem, handleMenuKeydown } from "../utils/menuKeyboard.js";
import { railGroupIdFromKey } from "../utils/railDatabaseGroups.js";
import RailDatabaseTile from "./RailDatabaseTile.vue";
import RailDatabaseGroupTile from "./RailDatabaseGroupTile.vue";
import RailDatabaseGroupFlyout from "./RailDatabaseGroupFlyout.vue";
import RailDatabaseAppearancePopover from "./RailDatabaseAppearancePopover.vue";

const props = defineProps({
  // Every database on the rail, grouped or not.
  items: { type: Array, default: () => [] },
  // The rail's top level: `{ kind: "db", id, item }` and `{ kind: "group", id, groupId, name, items, current, hint }`.
  layout: { type: Array, default: () => [] },
  // Groups a database can move to: `{ id, name }`.
  groups: { type: Array, default: () => [] },
  label: { type: String, default: "" },
  theme: { type: String, default: "light" },
  pendingDrop: { type: Object, default: null },
  dropHover: { type: Boolean, default: false },
});

const emit = defineEmits([
  "select",
  "reorder",
  "unpin",
  "appearance",
  "appearance-reset",
  "sort-phase",
  "drop",
  "group-create",
  "group-move",
  "group-rename",
  "group-dissolve",
  "group-reorder",
]);

const sortGroupRef = ref(null);
const sort = useActivityRailSort({
  items: toRef(props, "layout"),
  container: sortGroupRef,
  onReorder: ({ sourceId, targetId, position }) => emit("reorder", sourceId, targetId, { position }),
  // A tile held over a folder drops into it.
  canDropInto: (source, target) => source?.kind === "db" && target?.kind === "group",
  onDropInto: ({ sourceId, targetId }) => {
    const item = props.items.find((entry) => entry.id === sourceId);
    if (item) emit("group-move", item, railGroupIdFromKey(targetId));
  },
});

onBeforeUnmount(sort.dispose);

const pointerActivatedIds = ref(new Set());

function pointerActivated(entry) {
  return pointerActivatedIds.value.has(entry.id);
}

function retainPointerChrome(entry, event) {
  const retained = retainPointerActivationChrome(event, () => {
    if (!pointerActivatedIds.value.has(entry.id)) return;
    const next = new Set(pointerActivatedIds.value);
    next.delete(entry.id);
    pointerActivatedIds.value = next;
  });
  if (!retained) return;
  const next = new Set(pointerActivatedIds.value);
  next.add(entry.id);
  pointerActivatedIds.value = next;
}

function selectItem(item, event) {
  retainPointerChrome(item, event);
  if (sort.consumeClick()) return;
  hideTip();
  emit("select", item, event);
}

function selectFromFlyout(item, event) {
  closeFlyout({ restoreFocus: false });
  emit("select", item, event);
}

function sortableClass(entry) {
  return {
    "is-rail-dragging": sort.isLifted(entry),
    "is-rail-settling": sort.isSettling(entry),
    "is-rail-dropping-into": sort.isSettlingInto(entry),
    "is-pointer-activated": pointerActivated(entry),
  };
}

function sortableStyle(entry, index) {
  const shift = sort.shiftFor(entry, index);
  return shift ? { "--wb-rail-sort-shift": `${shift}px` } : undefined;
}

function isDropExisting(item) {
  return Boolean(
    props.dropHover
    && props.pendingDrop
    && String(item.connectionId) === String(props.pendingDrop.connectionId)
    && String(item.database) === String(props.pendingDrop.database),
  );
}

const showDropSlot = computed(() => Boolean(
  props.pendingDrop
  && !props.items.some((item) => (
    String(item.connectionId) === String(props.pendingDrop.connectionId)
    && String(item.database) === String(props.pendingDrop.database)
  )),
));

const hasContent = computed(() => props.layout.length > 0 || Boolean(props.pendingDrop));

// ── A database dragged from the sidebar onto a folder pins into it ─────────
const dropGroupId = ref("");

function onGroupDragOver(entry, event) {
  if (!props.pendingDrop) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  dropGroupId.value = entry.groupId;
}

function onGroupDragLeave(entry, event) {
  if (event.relatedTarget && event.currentTarget?.contains?.(event.relatedTarget)) return;
  if (dropGroupId.value === entry.groupId) dropGroupId.value = "";
}

function onGroupDrop(entry, event) {
  const payload = readDatabaseDrop(event);
  dropGroupId.value = "";
  if (!payload) return;
  event.preventDefault();
  event.stopPropagation();
  emit("drop", { ...payload, groupId: entry.groupId });
}

watch(() => props.pendingDrop, (value) => {
  if (!value) dropGroupId.value = "";
});

function groupClass(entry) {
  return {
    "is-current": entry.current,
    "is-open": flyoutGroupId.value === entry.groupId,
    "is-drop-into": sort.isDropInto(entry) || dropGroupId.value === entry.groupId,
  };
}

// ── New tiles bounce in ────────────────────────────────────────────────────
const knownIds = ref(new Set(props.layout.map((entry) => entry.id)));
const newIds = ref(new Set());
let newIdsTimer = 0;

watch(() => props.layout.map((entry) => entry.id), (ids) => {
  const added = ids.filter((id) => !knownIds.value.has(id));
  knownIds.value = new Set(ids);
  if (!added.length) return;
  const next = new Set(newIds.value);
  added.forEach((id) => next.add(id));
  newIds.value = next;
  clearTimeout(newIdsTimer);
  newIdsTimer = setTimeout(() => { newIds.value = new Set(); }, 400);
});

const overflowing = ref(false);

function measureOverflow() {
  const element = sortGroupRef.value;
  overflowing.value = Boolean(element && element.scrollHeight > element.clientHeight + 1);
}

// ── Tooltip ───────────────────────────────────────────────────────────────
const tip = ref(null);
const tipKind = ref("");
const tipStyle = ref({ left: "0px", top: "0px" });

function showTip(content, target, kind) {
  if (sort.phase.value !== "idle" || menu.value || popoverItem.value || flyoutGroupId.value) return;
  const rect = target?.getBoundingClientRect?.();
  if (!rect) return;
  tip.value = content;
  tipKind.value = kind;
  tipStyle.value = {
    left: `${rect.right + 8}px`,
    top: `${rect.top + rect.height / 2}px`,
  };
}

function hideTip() {
  tip.value = null;
}

function tileTip(item) {
  return {
    title: item.label,
    shortcut: item.shortcutLabel,
    lines: [item.hint, item.realName !== item.label ? item.realName : ""].filter(Boolean),
  };
}

function groupTip(entry) {
  return { title: entry.name, shortcut: "", lines: [entry.hint] };
}

function onTipEnter(content, event) {
  showTip(content, event.currentTarget, "hover");
}

function onTipFocus(content, event) {
  if (event.target?.matches?.(":focus-visible")) showTip(content, event.target, "focus");
}

const tipVisible = computed(() => Boolean(tip.value && !menu.value && !popoverItem.value && !flyoutGroupId.value));

// ── Folder flyout ─────────────────────────────────────────────────────────
const flyoutRef = ref(null);
const flyoutGroupId = ref("");
const flyoutAnchor = ref(null);
const flyoutAnchorRect = ref(null);
const flyoutRename = ref(false);
const flyoutFocus = ref(false);
const flyoutGroup = computed(() => (
  props.layout.find((entry) => entry.kind === "group" && entry.groupId === flyoutGroupId.value) || null
));

function groupButton(groupId) {
  return sortGroupRef.value?.querySelector?.(`[data-wb-rail-group="${groupId}"]`) || null;
}

function openFlyout(groupId, { rename = false, focus = false } = {}) {
  const anchor = groupButton(groupId);
  if (!anchor) return;
  hideTip();
  closeMenu();
  flyoutAnchor.value = anchor;
  flyoutAnchorRect.value = anchor.getBoundingClientRect();
  flyoutRename.value = rename;
  flyoutFocus.value = focus;
  flyoutGroupId.value = groupId;
}

function closeFlyout({ restoreFocus = false } = {}) {
  if (!flyoutGroupId.value) return;
  flyoutGroupId.value = "";
  if (restoreFocus) flyoutAnchor.value?.focus?.({ preventScroll: true });
}

function toggleFlyout(entry, event) {
  retainPointerChrome(entry, event);
  if (sort.consumeClick()) return;
  if (flyoutGroupId.value === entry.groupId) closeFlyout();
  // A click from the keyboard (Enter/Space) moves focus into the list.
  else openFlyout(entry.groupId, { focus: event?.detail === 0 });
}

watch(flyoutGroup, (group) => {
  if (flyoutGroupId.value && !group) closeFlyout();
  else if (group) flyoutAnchorRect.value = groupButton(group.groupId)?.getBoundingClientRect?.() || flyoutAnchorRect.value;
});

// A group made from a tile opens with its name ready to type.
let renameAfterCreate = "";

watch(() => props.layout, (layout) => {
  if (!renameAfterCreate) return;
  const created = layout.find((entry) => entry.kind === "group" && entry.items.some((item) => item.id === renameAfterCreate));
  renameAfterCreate = "";
  if (created) nextTick(() => openFlyout(created.groupId, { rename: true }));
});

// ── Menus: tiles (on the rail or in a folder) and folders ─────────────────
// `{ kind: "db" | "group", item?, group?, view: "main" | "groups" }`
const menu = ref(null);
const menuAnchor = ref(null);
const menuRef = ref(null);
const menuPosition = ref({ left: "0px", top: "0px" });
let menuPoint = null;

async function placeMenu({ focus = false } = {}) {
  await nextTick();
  if (!menu.value || !menuRef.value || !menuPoint) return;
  const bounds = menuRef.value.getBoundingClientRect();
  menuPosition.value = {
    left: `${Math.max(8, Math.min(menuPoint.left, globalThis.innerWidth - bounds.width - 8))}px`,
    top: `${Math.max(8, Math.min(menuPoint.top, globalThis.innerHeight - bounds.height - 8))}px`,
  };
  if (focus) focusMenuItem(menuRef.value);
}

function openMenu(target, event, { fromFlyout = false, keyboard = false } = {}) {
  hideTip();
  if (!fromFlyout) closeFlyout();
  menu.value = { ...target, view: "main", fromFlyout };
  menuAnchor.value = event.currentTarget;
  const rect = menuAnchor.value?.getBoundingClientRect?.();
  if (!rect) return;
  menuPoint = fromFlyout && !keyboard
    ? { left: event.clientX, top: event.clientY }
    : { left: rect.right + 8, top: rect.top };
  menuPosition.value = { left: `${menuPoint.left}px`, top: `${menuPoint.top}px` };
  void placeMenu({ focus: true });
}

function openTileMenu(item, event, options) {
  openMenu({ kind: "db", item }, event, options);
}

function openGroupMenu(entry, event) {
  openMenu({ kind: "group", group: entry }, event);
}

function onTileKeydown(item, event) {
  if (!isContextMenuKey(event)) return;
  event.preventDefault();
  openTileMenu(item, event, { keyboard: true });
}

function onGroupKeydown(entry, event) {
  if (isContextMenuKey(event)) openGroupMenu(entry, event);
  else if (event.key === "F2" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    openFlyout(entry.groupId, { rename: true });
  } else return;
  event.preventDefault();
  event.stopPropagation();
}

function closeMenu({ restoreFocus = false } = {}) {
  menu.value = null;
  if (restoreFocus) menuAnchor.value?.focus?.({ preventScroll: true });
}

function onMenuKeydown(event) {
  if (menu.value?.view === "groups" && (event.key === "ArrowLeft" || event.key === "Backspace")) {
    event.preventDefault();
    event.stopPropagation();
    showMenuView("main");
    return;
  }
  handleMenuKeydown(event, menuRef.value, { close: () => closeMenu({ restoreFocus: true }) });
}

function showMenuView(view) {
  if (!menu.value) return;
  menu.value = { ...menu.value, view };
  void placeMenu({ focus: true });
}

const menuItemLive = computed(() => (
  menu.value?.kind === "db" ? props.items.find((item) => item.id === menu.value.item.id) || null : null
));

function menuAction(action, groupId = "") {
  const target = menu.value;
  const item = menuItemLive.value;
  closeMenu();
  if (!target) return;
  if (target.kind === "group") {
    if (action === "rename") openFlyout(target.group.groupId, { rename: true });
    else if (action === "dissolve") emit("group-dissolve", target.group.groupId);
    return;
  }
  if (!item) return;
  if (action === "appearance") openAppearance(item);
  else if (action === "unpin") emit("unpin", item);
  else if (action === "create") {
    renameAfterCreate = item.id;
    closeFlyout();
    emit("group-create", item);
  } else if (action === "move") emit("group-move", item, groupId);
  else if (action === "leave") emit("group-move", item, "");
}

// ── Appearance popover ────────────────────────────────────────────────────
const popoverItem = ref(null);
const popoverAnchor = ref(null);
const popoverAnchorRect = ref(null);
const popoverRef = ref(null);

const popoverLiveItem = computed(() => (
  props.items.find((item) => item.id === popoverItem.value?.id) || null
));

function openAppearance(item) {
  popoverAnchor.value = menuAnchor.value;
  popoverAnchorRect.value = menuAnchor.value?.getBoundingClientRect?.() || null;
  popoverItem.value = item;
}

function closePopover({ restoreFocus = true } = {}) {
  popoverItem.value = null;
  if (restoreFocus) popoverAnchor.value?.focus?.({ preventScroll: true });
}

watch(popoverLiveItem, (item) => {
  if (popoverItem.value && !item) closePopover({ restoreFocus: false });
});

function surfaceElement(target) {
  const value = target?.value;
  return value?.panel || value?.$el || null;
}

function onDocumentPointerDown(event) {
  const target = event.target;
  const inMenu = menuRef.value?.contains?.(target);
  if (menu.value && !inMenu && !menuAnchor.value?.contains?.(target)) closeMenu();
  if (popoverItem.value && !surfaceElement(popoverRef)?.contains?.(target) && !popoverAnchor.value?.contains?.(target)) {
    closePopover({ restoreFocus: false });
  }
  if (
    flyoutGroupId.value
    && !inMenu
    && !surfaceElement(flyoutRef)?.contains?.(target)
    && !flyoutAnchor.value?.contains?.(target)
    && !surfaceElement(popoverRef)?.contains?.(target)
  ) {
    closeFlyout();
  }
}

function onDocumentKeydown(event) {
  if (event.key !== "Escape") return;
  if (popoverItem.value) closePopover();
  else if (menu.value) closeMenu({ restoreFocus: true });
  else if (flyoutGroupId.value) closeFlyout({ restoreFocus: true });
  else return;
  event.preventDefault();
  event.stopPropagation();
}

function onWindowResize() {
  closeMenu();
  closePopover({ restoreFocus: false });
  closeFlyout();
  measureOverflow();
}

watch(() => sort.phase.value, (phase) => {
  emit("sort-phase", phase);
  if (phase !== "idle") {
    hideTip();
    closeMenu();
    closePopover({ restoreFocus: false });
    closeFlyout();
  }
}, { immediate: true });

watch(() => props.layout.length, () => nextTick(measureOverflow));

watch(sortGroupRef, (element, _previous, onCleanup) => {
  if (!element) return;
  measureOverflow();
  if (typeof ResizeObserver !== "function") return;
  const observer = new ResizeObserver(measureOverflow);
  observer.observe(element);
  onCleanup(() => observer.disconnect());
}, { flush: "post" });

onMounted(() => {
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeydown, true);
  globalThis.addEventListener?.("resize", onWindowResize);
});

onBeforeUnmount(() => {
  clearTimeout(newIdsTimer);
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  document.removeEventListener("keydown", onDocumentKeydown, true);
  globalThis.removeEventListener?.("resize", onWindowResize);
});
</script>

<template>
  <template v-if="hasContent">
    <span class="wb-activity-rail-separator" aria-hidden="true"></span>

    <div
      ref="sortGroupRef"
      class="wb-activity-rail-group wb-rail-db-group"
      :class="{ 'is-overflowing': overflowing }"
      role="group"
      :aria-label="label"
      @scroll="hideTip(); closeFlyout()"
    >
      <template v-for="(entry, index) in layout" :key="entry.id">
        <button
          v-if="entry.kind === 'db'"
          type="button"
          class="wb-activity-rail-btn wb-rail-db-btn is-sortable"
          :class="[
            sortableClass(entry),
            {
              'is-current': entry.item.current,
              'is-disconnected': entry.item.disconnected || entry.item.missing,
              'is-drop-existing': isDropExisting(entry.item),
              'is-new': newIds.has(entry.id),
            },
          ]"
          :style="sortableStyle(entry, index)"
          :data-wb-rail-sort-id="entry.id"
          :data-wb-rail-database="entry.item.database"
          :aria-label="entry.item.label"
          :aria-describedby="`wb-rail-db-hint-${index}`"
          :aria-current="entry.item.current ? 'true' : undefined"
          :disabled="entry.item.missing"
          @pointerdown="sort.onPointerDown(entry, $event)"
          @keydown.alt.up.prevent="sort.moveByKeyboard(entry, -1)"
          @keydown.alt.down.prevent="sort.moveByKeyboard(entry, 1)"
          @keydown="onTileKeydown(entry.item, $event)"
          @click="selectItem(entry.item, $event)"
          @pointerenter="onTipEnter(tileTip(entry.item), $event)"
          @pointerleave="hideTip"
          @focus="onTipFocus(tileTip(entry.item), $event)"
          @blur="hideTip"
          @contextmenu.prevent.stop="openTileMenu(entry.item, $event)"
        >
          <RailDatabaseTile :glyph="entry.item.glyph" :color="entry.item.color" :ink="entry.item.ink" />
          <span :id="`wb-rail-db-hint-${index}`" class="wb-visually-hidden">{{ entry.item.hint }}</span>
        </button>
        <button
          v-else
          type="button"
          class="wb-activity-rail-btn wb-rail-db-btn wb-rail-db-group-btn is-sortable"
          :class="[sortableClass(entry), groupClass(entry), { 'is-new': newIds.has(entry.id) }]"
          :style="sortableStyle(entry, index)"
          :data-wb-rail-sort-id="entry.id"
          :data-wb-rail-group="entry.groupId"
          :aria-label="entry.name"
          :aria-describedby="`wb-rail-db-hint-${index}`"
          aria-haspopup="dialog"
          :aria-expanded="flyoutGroupId === entry.groupId ? 'true' : 'false'"
          @pointerdown="sort.onPointerDown(entry, $event)"
          @keydown.alt.up.prevent="sort.moveByKeyboard(entry, -1)"
          @keydown.alt.down.prevent="sort.moveByKeyboard(entry, 1)"
          @keydown="onGroupKeydown(entry, $event)"
          @click="toggleFlyout(entry, $event)"
          @pointerenter="onTipEnter(groupTip(entry), $event)"
          @pointerleave="hideTip"
          @focus="onTipFocus(groupTip(entry), $event)"
          @blur="hideTip"
          @contextmenu.prevent.stop="openGroupMenu(entry, $event)"
          @dragover="onGroupDragOver(entry, $event)"
          @dragleave="onGroupDragLeave(entry, $event)"
          @drop="onGroupDrop(entry, $event)"
        >
          <RailDatabaseGroupTile :items="entry.items" />
          <span :id="`wb-rail-db-hint-${index}`" class="wb-visually-hidden">{{ entry.hint }}</span>
        </button>
      </template>

      <span v-if="showDropSlot" class="wb-rail-db-slot" :class="{ 'is-hover': dropHover && !dropGroupId }" aria-hidden="true">
        <Plus :size="14" :stroke-width="2" />
      </span>
    </div>

    <Teleport to="body">
      <span
        v-if="tipVisible"
        class="wb-activity-rail-tip wb-rail-db-tip wb-floating-themed"
        :class="{ 'is-focus': tipKind === 'focus' }"
        :data-theme="theme"
        :style="tipStyle"
        aria-hidden="true"
      >
        <span class="wb-activity-rail-tip-title">
          <strong>{{ tip.title }}</strong>
          <kbd v-if="tip.shortcut">{{ tip.shortcut }}</kbd>
        </span>
        <span v-for="line in tip.lines" :key="line" class="wb-activity-rail-tip-hint">{{ line }}</span>
      </span>
    </Teleport>

    <RailDatabaseGroupFlyout
      ref="flyoutRef"
      :open="Boolean(flyoutGroup)"
      :anchor-rect="flyoutAnchorRect"
      :group="flyoutGroup"
      :theme="theme"
      :rename-on-open="flyoutRename"
      :focus-on-open="flyoutFocus"
      @select="selectFromFlyout"
      @menu="(item, event) => openTileMenu(item, event, { fromFlyout: true })"
      @reorder="(groupId, sourceId, targetId, options) => emit('group-reorder', groupId, sourceId, targetId, options)"
      @rename="(groupId, name) => emit('group-rename', groupId, name)"
    />

    <Teleport to="body">
      <menu
        v-if="menu"
        ref="menuRef"
        class="wb-context-menu wb-rail-db-menu wb-floating-themed"
        :data-theme="theme"
        :style="menuPosition"
        role="menu"
        :aria-label="menu.kind === 'group' ? t('railDatabase.groupMenuLabel', { name: menu.group.name }) : t('railDatabase.menuLabel', { name: menu.item.label })"
        tabindex="-1"
        @keydown="onMenuKeydown"
        @click.stop
        @contextmenu.prevent.stop
      >
        <template v-if="menu.kind === 'group'">
          <button type="button" role="menuitem" @click="menuAction('rename')">
            <Pencil :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("railDatabase.groupRename") }}<kbd class="wb-context-shortcut" aria-hidden="true">F2</kbd>
          </button>
          <button type="button" role="menuitem" @click="menuAction('dissolve')">
            <Ungroup :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("railDatabase.groupDissolve") }}
          </button>
        </template>
        <template v-else-if="menuItemLive && menu.view === 'groups'">
          <button type="button" role="menuitem" class="wb-rail-db-menu-back" @click="showMenuView('main')">
            <ArrowLeft :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("railDatabase.moveToGroup") }}
          </button>
          <hr class="wb-context-separator" role="separator" />
          <button
            v-for="group in groups"
            :key="group.id"
            type="button"
            role="menuitemradio"
            :aria-checked="group.id === menuItemLive.groupId ? 'true' : 'false'"
            @click="menuAction('move', group.id)"
          >
            <Folder :size="14" class="wb-context-icon" aria-hidden="true" />
            <span class="wb-rail-db-menu-name">{{ group.name }}</span>
            <Check v-if="group.id === menuItemLive.groupId" :size="14" class="wb-context-check" aria-hidden="true" />
          </button>
          <hr class="wb-context-separator" role="separator" />
          <button type="button" role="menuitem" @click="menuAction('create')">
            <FolderPlus :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("railDatabase.groupCreate") }}
          </button>
        </template>
        <template v-else-if="menuItemLive">
          <button type="button" role="menuitem" @click="menuAction('appearance')">
            <Palette :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("railDatabase.changeIcon") }}
          </button>
          <hr class="wb-context-separator" role="separator" />
          <button v-if="groups.length" type="button" role="menuitem" aria-haspopup="menu" @click="showMenuView('groups')">
            <FolderInput :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("railDatabase.moveToGroupEllipsis") }}
          </button>
          <button v-else type="button" role="menuitem" @click="menuAction('create')">
            <FolderPlus :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("railDatabase.groupCreate") }}
          </button>
          <button v-if="menuItemLive.groupId" type="button" role="menuitem" @click="menuAction('leave')">
            <FolderOutput :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("railDatabase.leaveGroup") }}
          </button>
          <hr class="wb-context-separator" role="separator" />
          <button type="button" role="menuitem" @click="menuAction('unpin')">
            <PinOff :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("railDatabase.unpin") }}
          </button>
        </template>
      </menu>
    </Teleport>

    <RailDatabaseAppearancePopover
      ref="popoverRef"
      :open="Boolean(popoverLiveItem)"
      :anchor-rect="popoverAnchorRect"
      :item="popoverLiveItem"
      :theme="theme"
      @update="(payload) => emit('appearance', payload)"
      @reset="popoverLiveItem && emit('appearance-reset', popoverLiveItem)"
      @close="closePopover()"
    />
  </template>
</template>
