<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { Check, ChevronDown } from "lucide-vue-next";
import ToolbarActionIcon from "./ToolbarActionIcon.vue";

const props = defineProps({
  label: { type: String, required: true },
  icon: { type: String, default: "" },
  menuLabel: { type: String, default: "" },
  open: { type: Boolean, default: false },
  items: { type: Array, default: () => [] },
  primaryDisabled: { type: Boolean, default: false },
  menuDisabled: { type: Boolean, default: false },
  primaryOpensMenu: { type: Boolean, default: false },
  singleTrigger: { type: Boolean, default: false },
  active: { type: Boolean, default: false },
});

const emit = defineEmits(["primary", "toggle", "close", "select"]);
const theme = inject("theme", ref("light"));
const rootRef = ref(null);
const mainRef = ref(null);
const caretRef = ref(null);
const menuRef = ref(null);
const menuPosition = ref({ left: 8, top: 8, minWidth: 168 });
const menuId = `wb-toolbar-menu-${useId().replace(/:/g, "")}`;

const resolvedMenuLabel = computed(() => props.menuLabel || `${props.label}选项`);
const menuStyle = computed(() => ({
  left: `${menuPosition.value.left}px`,
  top: `${menuPosition.value.top}px`,
  minWidth: `${menuPosition.value.minWidth}px`,
}));

function updateMenuPosition() {
  const triggerRect = rootRef.value?.getBoundingClientRect?.();
  if (!triggerRect) return;

  const viewportWidth = globalThis.innerWidth || globalThis.document?.documentElement?.clientWidth || triggerRect.right;
  const viewportHeight = globalThis.innerHeight || globalThis.document?.documentElement?.clientHeight || triggerRect.bottom;
  const menuWidth = menuRef.value?.offsetWidth || Math.max(168, triggerRect.width);
  const menuHeight = menuRef.value?.offsetHeight || 44;
  const margin = 8;
  const gap = 6;
  const maxLeft = Math.max(margin, viewportWidth - menuWidth - margin);
  const belowTop = triggerRect.bottom + gap;
  const aboveTop = triggerRect.top - menuHeight - gap;

  menuPosition.value = {
    left: Math.min(Math.max(margin, triggerRect.right - menuWidth), maxLeft),
    top: belowTop + menuHeight <= viewportHeight - margin || aboveTop < margin
      ? Math.min(belowTop, Math.max(margin, viewportHeight - menuHeight - margin))
      : aboveTop,
    minWidth: Math.max(168, Math.ceil(triggerRect.width)),
  };
}

function enabledMenuItems() {
  return Array.from(menuRef.value?.querySelectorAll?.('[role^="menuitem"]:not(:disabled)') || []);
}

function focusMenuItem(index) {
  const items = enabledMenuItems();
  if (!items.length) return;
  const normalized = ((index % items.length) + items.length) % items.length;
  items[normalized].focus();
}

function focusRelativeMenuItem(delta) {
  const items = enabledMenuItems();
  if (!items.length) return;
  const current = items.indexOf(globalThis.document?.activeElement);
  focusMenuItem((current < 0 ? 0 : current) + delta);
}

function closeMenu({ restoreFocus = false } = {}) {
  emit("close");
  if (restoreFocus) nextTick(() => (props.singleTrigger ? mainRef.value : caretRef.value)?.focus());
}

function onMainClick() {
  if (props.primaryOpensMenu) {
    emit("toggle");
    return;
  }
  emit("close");
  emit("primary");
}

function onSelect(item) {
  if (item?.disabled) return;
  emit("select", item.id);
  closeMenu({ restoreFocus: true });
}

function onMenuKeydown(event) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    focusRelativeMenuItem(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    focusRelativeMenuItem(-1);
  } else if (event.key === "Home") {
    event.preventDefault();
    focusMenuItem(0);
  } else if (event.key === "End") {
    event.preventDefault();
    focusMenuItem(-1);
  }
}

function onDocumentPointerDown(event) {
  if (!props.open) return;
  const target = event.target;
  if (rootRef.value?.contains(target) || menuRef.value?.contains(target)) return;
  closeMenu();
}

function onDocumentFocusIn(event) {
  if (!props.open) return;
  const target = event.target;
  if (rootRef.value?.contains(target) || menuRef.value?.contains(target)) return;
  closeMenu();
}

function onDocumentKeydown(event) {
  if (!props.open || event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  closeMenu({ restoreFocus: true });
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    updateMenuPosition();
    nextTick(() => {
      updateMenuPosition();
      focusMenuItem(0);
    });
  },
);

onMounted(() => {
  document.addEventListener("pointerdown", onDocumentPointerDown);
  document.addEventListener("focusin", onDocumentFocusIn);
  document.addEventListener("keydown", onDocumentKeydown, true);
  window.addEventListener("resize", updateMenuPosition);
  window.addEventListener("scroll", updateMenuPosition, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  document.removeEventListener("focusin", onDocumentFocusIn);
  document.removeEventListener("keydown", onDocumentKeydown, true);
  window.removeEventListener("resize", updateMenuPosition);
  window.removeEventListener("scroll", updateMenuPosition, true);
});
</script>

<template>
  <div
    ref="rootRef"
    class="wb-toolbar-split-button"
    :class="{ 'is-open': open, 'is-active': active, 'is-single-trigger': singleTrigger }"
  >
    <button
      v-if="singleTrigger"
      ref="mainRef"
      type="button"
      class="wb-toolbar-menu-button"
      :disabled="primaryDisabled || menuDisabled"
      aria-haspopup="menu"
      :aria-expanded="String(open)"
      :aria-controls="open ? menuId : undefined"
      :aria-label="`${resolvedMenuLabel}：${label}`"
      @click="onMainClick"
      @keydown.arrow-down.prevent="emit('toggle')"
    >
      <ToolbarActionIcon v-if="icon" :name="icon" />
      <span class="wb-toolbar-action-label">{{ label }}</span>
      <ChevronDown class="wb-toolbar-menu-button-caret" :size="12" aria-hidden="true" />
    </button>
    <button
      v-else
      ref="mainRef"
      type="button"
      class="wb-toolbar-split-button-main"
      :disabled="primaryDisabled"
      :aria-haspopup="primaryOpensMenu ? 'menu' : undefined"
      :aria-expanded="primaryOpensMenu ? String(open) : undefined"
      :aria-controls="primaryOpensMenu && open ? menuId : undefined"
      :aria-label="label"
      :title="label"
      @click="onMainClick"
    >
      <ToolbarActionIcon v-if="icon" :name="icon" />
      <span class="wb-toolbar-action-label">{{ label }}</span>
    </button>
    <button
      v-if="!singleTrigger"
      ref="caretRef"
      type="button"
      class="wb-toolbar-split-button-caret"
      :disabled="menuDisabled"
      aria-haspopup="menu"
      :aria-expanded="String(open)"
      :aria-controls="open ? menuId : undefined"
      :aria-label="`${label}更多选项`"
      @click="emit('toggle')"
      @keydown.arrow-down.prevent="emit('toggle')"
    >
      <ChevronDown :size="12" aria-hidden="true" />
    </button>

    <Teleport to="body">
      <Transition name="wb-toolbar-menu">
        <div
          v-if="open"
          :id="menuId"
          ref="menuRef"
          class="wb-toolbar-action-menu wb-floating-themed"
          :data-theme="theme"
          :style="menuStyle"
          role="menu"
          :aria-label="resolvedMenuLabel"
          @keydown="onMenuKeydown"
          @pointerdown.stop
        >
          <button
            v-for="item in items"
            :key="item.id"
            type="button"
            class="wb-toolbar-action-menu-item"
            :class="{ 'is-checked': item.checked, 'has-separator': item.separatorBefore }"
            :disabled="item.disabled"
            :role="item.checkable ? 'menuitemradio' : 'menuitem'"
            :aria-checked="item.checkable ? String(Boolean(item.checked)) : undefined"
            @click="onSelect(item)"
          >
            <span class="wb-toolbar-action-menu-icon" aria-hidden="true">
              <Check v-if="item.checked" :size="16" />
              <ToolbarActionIcon v-else-if="item.icon" :name="item.icon" :size="16" />
              <span v-else class="wb-toolbar-action-menu-icon-placeholder"></span>
            </span>
            <span class="wb-toolbar-action-menu-copy">
              <span class="wb-toolbar-action-menu-label">{{ item.label }}</span>
              <span v-if="item.hint" class="wb-toolbar-action-menu-hint">{{ item.hint }}</span>
            </span>
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
