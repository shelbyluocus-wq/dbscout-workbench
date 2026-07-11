<script setup>
import { computed, inject, nextTick, onBeforeUnmount, ref } from "vue";

const props = defineProps({
  column: { type: String, required: true },
  sort: { type: Object, default: null },
});

const emit = defineEmits(["apply-sort"]);

const theme = inject("theme", ref("light"));
const open = ref(false);
const rootRef = ref(null);
const menuRef = ref(null);
const menuPosition = ref({ left: 8, top: 8 });

const isSorted = computed(() => props.sort?.columnName === props.column);
const currentLabel = computed(() => {
  if (!isSorted.value) return "";
  return props.sort?.descending ? "降序" : "升序";
});
const menuStyle = computed(() => ({
  left: `${menuPosition.value.left}px`,
  top: `${menuPosition.value.top}px`,
}));

function updateMenuPosition() {
  const triggerRect = rootRef.value?.getBoundingClientRect?.();
  if (!triggerRect) return;

  const viewportWidth = globalThis.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = globalThis.innerHeight || document.documentElement.clientHeight;
  const menuWidth = menuRef.value?.offsetWidth || 112;
  const menuHeight = menuRef.value?.offsetHeight || 86;
  const margin = 8;
  const gap = 4;
  const belowTop = triggerRect.bottom + gap;
  const aboveTop = triggerRect.top - menuHeight - gap;

  menuPosition.value = {
    left: Math.min(
      Math.max(margin, triggerRect.right - menuWidth),
      Math.max(margin, viewportWidth - menuWidth - margin),
    ),
    top: belowTop + menuHeight <= viewportHeight - margin || aboveTop < margin
      ? Math.min(belowTop, Math.max(margin, viewportHeight - menuHeight - margin))
      : aboveTop,
  };
}

function closeMenu() {
  open.value = false;
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  document.removeEventListener("keydown", onDocumentKeydown);
  window.removeEventListener("resize", updateMenuPosition);
  window.removeEventListener("scroll", updateMenuPosition, true);
}

function openMenu() {
  if (open.value) return;
  open.value = true;
  document.addEventListener("pointerdown", onDocumentPointerDown);
  document.addEventListener("keydown", onDocumentKeydown);
  window.addEventListener("resize", updateMenuPosition);
  window.addEventListener("scroll", updateMenuPosition, true);
  updateMenuPosition();
  nextTick(updateMenuPosition);
}

function toggleMenu() {
  if (open.value) closeMenu();
  else openMenu();
}

function onDocumentPointerDown(event) {
  if (rootRef.value?.contains?.(event.target) || menuRef.value?.contains?.(event.target)) return;
  closeMenu();
}

function onDocumentKeydown(event) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closeMenu();
}

function apply(direction) {
  emit("apply-sort", direction);
  closeMenu();
}

onBeforeUnmount(closeMenu);
</script>

<template>
  <span
    ref="rootRef"
    class="wb-column-sort"
    :class="{ 'is-open': open, 'is-sorted': isSorted }"
    @click.stop
    @mousedown.stop
  >
    <button
      type="button"
      class="wb-column-sort-trigger"
      :class="{ 'is-sorted': isSorted }"
      :title="`${column} 排序`"
      :aria-label="`${column} 排序菜单`"
      :aria-expanded="open ? 'true' : 'false'"
      aria-haspopup="menu"
      @click.stop="toggleMenu"
    >
      <span class="wb-column-sort-icon" aria-hidden="true">▾</span>
      <span v-if="currentLabel" class="wb-column-sort-state">{{ currentLabel }}</span>
    </button>

    <Teleport to="body">
      <Transition name="wb-column-sort-menu">
        <menu
          v-if="open"
          ref="menuRef"
          class="wb-column-sort-menu wb-floating-themed"
          :data-theme="theme"
          :style="menuStyle"
          role="menu"
          @click.stop
          @pointerdown.stop
        >
          <button
            type="button"
            role="menuitem"
            :class="{ active: isSorted && !sort?.descending }"
            @click="apply('ascending')"
          >升序排序</button>
          <button
            type="button"
            role="menuitem"
            :class="{ active: isSorted && sort?.descending }"
            @click="apply('descending')"
          >降序排序</button>
          <button
            type="button"
            role="menuitem"
            :disabled="!isSorted"
            @click="apply('none')"
          >移除排序</button>
        </menu>
      </Transition>
    </Teleport>
  </span>
</template>
