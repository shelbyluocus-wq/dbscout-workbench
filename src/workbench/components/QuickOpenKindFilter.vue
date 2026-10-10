<script setup>
import { t } from "../i18n/index.js";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useEscClose } from "../composables/useEscClose.js";
import { searchKindLabel } from "../utils/searchKindLabels.js";

const props = defineProps({
  modelValue: { type: String, default: "all" },
  theme: { type: String, default: "light" },
});

const emit = defineEmits(["update:modelValue"]);

const options = computed(() => ["all", "tableName", "tableComment", "columnName", "columnComment"]
  .map((value) => ({ value, label: searchKindLabel(value) })));

const triggerRef = ref(null);
const menuRef = ref(null);
const open = ref(false);
const menuPosition = ref({ left: 0, top: 0, width: 124 });
const menuId = "wb-quick-open-kind-filter-menu";
const currentOption = computed(() => options.value.find((option) => option.value === props.modelValue) || options.value[0]);
const menuStyle = computed(() => ({
  left: `${menuPosition.value.left}px`,
  top: `${menuPosition.value.top}px`,
  minWidth: `${menuPosition.value.width}px`,
}));

function updateMenuPosition() {
  const rect = triggerRef.value?.getBoundingClientRect?.();
  if (!rect) return;
  const width = Math.max(124, rect.width);
  const viewportWidth = globalThis.innerWidth || 1024;
  const viewportHeight = globalThis.innerHeight || 768;
  const estimatedHeight = options.value.length * 29 + 8;
  const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
  const top = rect.bottom + estimatedHeight + 8 <= viewportHeight
    ? rect.bottom + 4
    : Math.max(8, rect.top - estimatedHeight - 4);
  menuPosition.value = { left, top, width };
}

function setOpen(next) {
  open.value = Boolean(next);
  if (open.value) nextTick(updateMenuPosition);
}

function toggleMenu() {
  setOpen(!open.value);
}

function choose(value) {
  emit("update:modelValue", value);
  setOpen(false);
  nextTick(() => triggerRef.value?.focus?.());
}

function closeAndFocus() {
  setOpen(false);
  nextTick(() => triggerRef.value?.focus?.());
}

useEscClose(() => open.value, closeAndFocus, null, { dialogRef: menuRef });

function onTriggerKeydown(event) {
  if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setOpen(true);
  } else if (event.key === "Escape") {
    event.preventDefault();
    setOpen(false);
  }
}

function onDocumentPointerDown(event) {
  if (!open.value) return;
  const path = event.composedPath?.() || [];
  if (path.includes(triggerRef.value) || path.includes(menuRef.value)) return;
  setOpen(false);
}

watch(open, (isOpen) => {
  if (isOpen) {
    globalThis.document?.addEventListener?.("pointerdown", onDocumentPointerDown, true);
    globalThis.addEventListener?.("resize", updateMenuPosition);
    globalThis.addEventListener?.("scroll", updateMenuPosition, true);
  } else {
    globalThis.document?.removeEventListener?.("pointerdown", onDocumentPointerDown, true);
    globalThis.removeEventListener?.("resize", updateMenuPosition);
    globalThis.removeEventListener?.("scroll", updateMenuPosition, true);
  }
});

onBeforeUnmount(() => {
  globalThis.document?.removeEventListener?.("pointerdown", onDocumentPointerDown, true);
  globalThis.removeEventListener?.("resize", updateMenuPosition);
  globalThis.removeEventListener?.("scroll", updateMenuPosition, true);
});
</script>

<template>
  <div class="wb-quick-open-kind-filter">
    <button
      ref="triggerRef"
      type="button"
      class="wb-quick-open-kind-filter-trigger"
      :class="{ 'is-active': modelValue !== 'all', 'is-open': open }"
      aria-haspopup="listbox"
      :aria-controls="menuId"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-label="t('search.kindFilterAria', { kind: currentOption.label })"
      :title="t('m_2aee15f9baab')"
      @click="toggleMenu"
      @keydown="onTriggerKeydown"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M1.5 2.25h9L7 6.2v3.1L5 10.2v-4z" />
      </svg>
      <span>{{ currentOption.label }}</span>
      <svg class="wb-quick-open-kind-filter-caret" width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2 3.25 4.5 5.75 7 3.25" />
      </svg>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        :id="menuId"
        ref="menuRef"
        class="wb-quick-open-kind-filter-menu wb-floating-themed"
        :data-theme="theme"
        :style="menuStyle"
        role="listbox"
        :aria-label="t('m_515fc5fb89b6')"
        tabindex="-1"
        @pointerdown.stop
        @keydown.esc.prevent.stop="closeAndFocus"
      >
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          class="wb-quick-open-kind-filter-option"
          :class="{ 'is-selected': option.value === modelValue }"
          role="option"
          :aria-selected="option.value === modelValue ? 'true' : 'false'"
          @click="choose(option.value)"
        >
          <span>{{ option.label }}</span>
          <svg v-if="option.value === modelValue" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m2.25 6 2.25 2.25L9.75 3" />
          </svg>
        </button>
      </div>
    </Teleport>
  </div>
</template>
