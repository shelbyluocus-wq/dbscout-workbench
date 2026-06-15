<script setup>
import { computed, onBeforeUnmount, ref } from "vue";

const props = defineProps({
  column: { type: String, required: true },
  sort: { type: Object, default: null },
});

const emit = defineEmits(["apply-sort"]);

const open = ref(false);
const rootRef = ref(null);

const isSorted = computed(() => props.sort?.columnName === props.column);
const currentLabel = computed(() => {
  if (!isSorted.value) return "";
  return props.sort?.descending ? "降序" : "升序";
});

function closeMenu() {
  open.value = false;
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  document.removeEventListener("keydown", onDocumentKeydown);
}

function openMenu() {
  if (open.value) return;
  open.value = true;
  document.addEventListener("pointerdown", onDocumentPointerDown);
  document.addEventListener("keydown", onDocumentKeydown);
}

function toggleMenu() {
  if (open.value) closeMenu();
  else openMenu();
}

function onDocumentPointerDown(event) {
  if (rootRef.value?.contains?.(event.target)) return;
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

    <Transition name="wb-column-sort-menu">
      <menu v-if="open" class="wb-column-sort-menu" role="menu" @click.stop>
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
  </span>
</template>
