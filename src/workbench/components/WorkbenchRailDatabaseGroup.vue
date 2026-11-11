<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import { Palette, PinOff, Plus } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useActivityRailSort } from "../composables/useActivityRailSort.js";
import { retainPointerActivationChrome } from "../pointerActivationChrome.js";
import { focusMenuItem, handleMenuKeydown } from "../utils/menuKeyboard.js";
import RailDatabaseTile from "./RailDatabaseTile.vue";
import RailDatabaseAppearancePopover from "./RailDatabaseAppearancePopover.vue";

const props = defineProps({
  items: { type: Array, default: () => [] },
  label: { type: String, default: "" },
  theme: { type: String, default: "light" },
  pendingDrop: { type: Object, default: null },
  dropHover: { type: Boolean, default: false },
});

const emit = defineEmits(["select", "reorder", "unpin", "appearance", "appearance-reset", "sort-phase"]);

const sortGroupRef = ref(null);
const sort = useActivityRailSort({
  items: toRef(props, "items"),
  container: sortGroupRef,
  onReorder: ({ sourceId, targetId, position }) => emit("reorder", sourceId, targetId, { position }),
});

onBeforeUnmount(sort.dispose);

const pointerActivatedIds = ref(new Set());

function pointerActivated(item) {
  return pointerActivatedIds.value.has(item.id);
}

function retainPointerChrome(item, event) {
  const retained = retainPointerActivationChrome(event, () => {
    if (!pointerActivatedIds.value.has(item.id)) return;
    const next = new Set(pointerActivatedIds.value);
    next.delete(item.id);
    pointerActivatedIds.value = next;
  });
  if (!retained) return;
  const next = new Set(pointerActivatedIds.value);
  next.add(item.id);
  pointerActivatedIds.value = next;
}

function selectItem(item, event) {
  retainPointerChrome(item, event);
  if (sort.consumeClick()) return;
  hideTip();
  emit("select", item, event);
}

function sortableClass(item) {
  return {
    "is-rail-dragging": sort.isLifted(item),
    "is-rail-settling": sort.isSettling(item),
    "is-pointer-activated": pointerActivated(item),
  };
}

function sortableStyle(item, index) {
  const shift = sort.shiftFor(item, index);
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

const hasContent = computed(() => props.items.length > 0 || Boolean(props.pendingDrop));

const knownIds = ref(new Set(props.items.map((item) => item.id)));
const newIds = ref(new Set());
let newIdsTimer = 0;

watch(() => props.items.map((item) => item.id), (ids) => {
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

const tipItem = ref(null);
const tipKind = ref("");
const tipStyle = ref({ left: "0px", top: "0px" });

function showTip(item, target, kind) {
  if (sort.phase.value !== "idle" || menuItem.value || popoverItem.value) return;
  const rect = target?.getBoundingClientRect?.();
  if (!rect) return;
  tipItem.value = item;
  tipKind.value = kind;
  tipStyle.value = {
    left: `${rect.right + 8}px`,
    top: `${rect.top + rect.height / 2}px`,
  };
}

function hideTip() {
  tipItem.value = null;
}

function onButtonEnter(item, event) {
  showTip(item, event.currentTarget, "hover");
}

function onButtonFocus(item, event) {
  if (event.target?.matches?.(":focus-visible")) showTip(item, event.target, "focus");
}

const tipVisible = computed(() => Boolean(tipItem.value && !menuItem.value && !popoverItem.value));

const menuItem = ref(null);
const menuAnchor = ref(null);
const menuRef = ref(null);
const menuPosition = ref({ left: "0px", top: "0px" });

async function openMenu(item, event) {
  hideTip();
  menuItem.value = item;
  menuAnchor.value = event.currentTarget;
  const rect = menuAnchor.value?.getBoundingClientRect?.();
  if (!rect) return;
  menuPosition.value = { left: `${rect.right + 8}px`, top: `${rect.top}px` };
  await nextTick();
  if (!menuItem.value || !menuRef.value) return;
  const bounds = menuRef.value.getBoundingClientRect();
  menuPosition.value = {
    left: `${Math.max(8, Math.min(rect.right + 8, globalThis.innerWidth - bounds.width - 8))}px`,
    top: `${Math.max(8, Math.min(rect.top, globalThis.innerHeight - bounds.height - 8))}px`,
  };
  focusMenuItem(menuRef.value);
}

function closeMenu({ restoreFocus = false } = {}) {
  menuItem.value = null;
  if (restoreFocus) menuAnchor.value?.focus?.({ preventScroll: true });
}

function onMenuKeydown(event) {
  handleMenuKeydown(event, menuRef.value, { close: () => closeMenu({ restoreFocus: true }) });
}

const popoverItem = ref(null);
const popoverAnchor = ref(null);
const popoverAnchorRect = ref(null);
const popoverRef = ref(null);

const popoverLiveItem = computed(() => (
  props.items.find((item) => item.id === popoverItem.value?.id) || null
));

function openAppearance() {
  const item = menuItem.value;
  popoverAnchor.value = menuAnchor.value;
  popoverAnchorRect.value = menuAnchor.value?.getBoundingClientRect?.() || null;
  closeMenu();
  if (!item) return;
  popoverItem.value = item;
}

function closePopover({ restoreFocus = true } = {}) {
  popoverItem.value = null;
  if (restoreFocus) popoverAnchor.value?.focus?.({ preventScroll: true });
}

watch(popoverLiveItem, (item) => {
  if (popoverItem.value && !item) closePopover({ restoreFocus: false });
});

function selectUnpin() {
  const item = menuItem.value;
  closeMenu();
  if (item) emit("unpin", item);
}

function popoverElement() {
  const target = popoverRef.value;
  return target?.panel || target?.$el || null;
}

function onDocumentPointerDown(event) {
  const target = event.target;
  if (menuItem.value && !menuRef.value?.contains?.(target) && !menuAnchor.value?.contains?.(target)) {
    closeMenu();
  }
  if (popoverItem.value && !popoverElement()?.contains?.(target) && !popoverAnchor.value?.contains?.(target)) {
    closePopover({ restoreFocus: false });
  }
}

function onDocumentKeydown(event) {
  if (event.key !== "Escape") return;
  if (popoverItem.value) {
    event.preventDefault();
    event.stopPropagation();
    closePopover();
    return;
  }
  if (menuItem.value) {
    event.preventDefault();
    event.stopPropagation();
    closeMenu({ restoreFocus: true });
  }
}

function onWindowResize() {
  closeMenu();
  closePopover({ restoreFocus: false });
  measureOverflow();
}

watch(() => sort.phase.value, (phase) => {
  emit("sort-phase", phase);
  if (phase !== "idle") {
    hideTip();
    closeMenu();
    closePopover({ restoreFocus: false });
  }
}, { immediate: true });

watch(() => props.items.length, () => nextTick(measureOverflow));

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
      @scroll="hideTip"
    >
      <button
        v-for="(item, index) in items"
        :key="item.id"
        type="button"
        class="wb-activity-rail-btn wb-rail-db-btn is-sortable"
        :class="[
          sortableClass(item),
          {
            'is-current': item.current,
            'is-disconnected': item.disconnected || item.missing,
            'is-drop-existing': isDropExisting(item),
            'is-new': newIds.has(item.id),
          },
        ]"
        :style="sortableStyle(item, index)"
        :data-wb-rail-sort-id="item.id"
        :data-wb-rail-database="item.database"
        :aria-label="item.label"
        :aria-describedby="`wb-rail-db-hint-${index}`"
        :aria-current="item.current ? 'true' : undefined"
        :disabled="item.missing"
        @pointerdown="sort.onPointerDown(item, $event)"
        @keydown.alt.up.prevent="sort.moveByKeyboard(item, -1)"
        @keydown.alt.down.prevent="sort.moveByKeyboard(item, 1)"
        @click="selectItem(item, $event)"
        @pointerenter="onButtonEnter(item, $event)"
        @pointerleave="hideTip"
        @focus="onButtonFocus(item, $event)"
        @blur="hideTip"
        @contextmenu.prevent.stop="openMenu(item, $event)"
      >
        <RailDatabaseTile :glyph="item.glyph" :color="item.color" :ink="item.ink" />
        <span :id="`wb-rail-db-hint-${index}`" class="wb-visually-hidden">{{ item.hint }}</span>
      </button>

      <span v-if="showDropSlot" class="wb-rail-db-slot" :class="{ 'is-hover': dropHover }" aria-hidden="true">
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
          <strong>{{ tipItem.label }}</strong>
          <kbd v-if="tipItem.shortcutLabel">{{ tipItem.shortcutLabel }}</kbd>
        </span>
        <span class="wb-activity-rail-tip-hint">{{ tipItem.hint }}</span>
        <span v-if="tipItem.realName !== tipItem.label" class="wb-activity-rail-tip-hint">{{ tipItem.realName }}</span>
      </span>
    </Teleport>

    <Teleport to="body">
      <menu
        v-if="menuItem"
        ref="menuRef"
        class="wb-context-menu wb-rail-db-menu wb-floating-themed"
        :data-theme="theme"
        :style="menuPosition"
        role="menu"
        :aria-label="t('railDatabase.menuLabel', { name: menuItem.label })"
        tabindex="-1"
        @keydown="onMenuKeydown"
        @click.stop
        @contextmenu.prevent.stop
      >
        <button type="button" role="menuitem" @click="openAppearance">
          <Palette :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("railDatabase.changeIcon") }}
        </button>
        <button type="button" role="menuitem" @click="selectUnpin">
          <PinOff :size="14" class="wb-context-icon" aria-hidden="true" />{{ t("railDatabase.unpin") }}
        </button>
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
