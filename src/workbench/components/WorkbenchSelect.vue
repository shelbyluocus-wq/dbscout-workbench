<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { Check, ChevronDown, Search } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useEscClose } from "../composables/useEscClose.js";
import {
  computeSelectPopoverPosition,
  filterSelectOptions,
  normalizeSelectOptions,
} from "../utils/selectPopover.js";

const props = defineProps({
  modelValue: { type: String, default: "" },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: "" },
  ariaLabel: { type: String, default: "" },
  disabled: { type: Boolean, default: false },
  searchable: { type: [Boolean, String], default: "auto" },
  emptyText: { type: String, default: "" },
  monospace: { type: Boolean, default: false },
});

const emit = defineEmits(["update:modelValue", "change"]);

const id = useId();
const open = ref(false);
const query = ref("");
const activeIndex = ref(-1);
const triggerRef = ref(null);
const menuRef = ref(null);
const listRef = ref(null);
const searchInputRef = ref(null);
const placement = ref("bottom");
const menuPos = ref({ left: 0, top: 0, bottom: null, width: 220, maxHeight: 260 });

const normalizedOptions = computed(() => normalizeSelectOptions(props.options));
const filteredOptions = computed(() => filterSelectOptions(normalizedOptions.value, query.value));
const showSearch = computed(() => {
  if (props.searchable === true) return true;
  if (props.searchable === false) return false;
  return normalizedOptions.value.length > 8;
});
const selectedOption = computed(() =>
  normalizedOptions.value.find((item) => item.value === String(props.modelValue ?? "")) || null,
);
const displayLabel = computed(() => selectedOption.value?.label || props.placeholder || "");
const isPlaceholder = computed(() => !selectedOption.value && Boolean(props.placeholder));
const resolvedEmptyText = computed(() => props.emptyText || t("select.empty"));

const menuStyle = computed(() => ({
  left: `${menuPos.value.left}px`,
  width: `${menuPos.value.width}px`,
  ...(menuPos.value.top != null ? { top: `${menuPos.value.top}px` } : {}),
  ...(menuPos.value.bottom != null ? { bottom: `${menuPos.value.bottom}px` } : {}),
}));

const listStyle = computed(() => ({
  maxHeight: `${menuPos.value.maxHeight}px`,
}));

function updatePosition() {
  const trigger = triggerRef.value;
  if (!trigger || typeof trigger.getBoundingClientRect !== "function") return;
  const rect = trigger.getBoundingClientRect();
  const next = computeSelectPopoverPosition(rect, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  placement.value = next.placement;
  menuPos.value = {
    left: next.left,
    width: next.width,
    maxHeight: next.maxHeight,
    top: next.top ?? null,
    bottom: next.bottom ?? null,
  };
}

function close({ restoreTriggerFocus = false } = {}) {
  if (!open.value) return;
  open.value = false;
  query.value = "";
  activeIndex.value = -1;
  if (restoreTriggerFocus) {
    void nextTick(() => triggerRef.value?.focus?.());
  }
}

useEscClose(() => open.value, () => close({ restoreTriggerFocus: true }), null, {
  dialogRef: menuRef,
  modal: false,
  restoreFocus: false,
});

function scrollToOption(selector) {
  void nextTick(() => {
    const el = listRef.value?.querySelector(selector);
    el?.scrollIntoView?.({ block: "nearest" });
  });
}

async function openMenu() {
  if (props.disabled) return;
  query.value = "";
  updatePosition();
  open.value = true;
  const currentIdx = filteredOptions.value.findIndex((item) => item.value === String(props.modelValue ?? ""));
  activeIndex.value = currentIdx >= 0 ? currentIdx : (filteredOptions.value.length ? 0 : -1);
  await nextTick();
  updatePosition();
  if (showSearch.value) {
    searchInputRef.value?.focus?.();
  }
  scrollToOption("[data-selected='true']");
}

function toggleMenu() {
  if (props.disabled) return;
  if (open.value) close();
  else void openMenu();
}

function selectOption(option) {
  if (!option || option.disabled) return;
  const value = option.value;
  const changed = value !== String(props.modelValue ?? "");
  emit("update:modelValue", value);
  if (changed) emit("change", value);
  close({ restoreTriggerFocus: true });
}

watch(filteredOptions, (list) => {
  if (!open.value) return;
  if (!list.length) {
    activeIndex.value = -1;
    return;
  }
  const currentIdx = list.findIndex((item) => item.value === String(props.modelValue ?? ""));
  activeIndex.value = currentIdx >= 0 ? currentIdx : Math.min(Math.max(activeIndex.value, 0), list.length - 1);
});

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close();
  },
);

function handleKeydown(event) {
  if (props.disabled) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!open.value) {
      void openMenu();
      return;
    }
    const list = filteredOptions.value;
    if (!list.length) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    activeIndex.value = (activeIndex.value + step + list.length) % list.length;
    scrollToOption("[data-active='true']");
    return;
  }
  if (event.key === "Enter" && open.value) {
    event.preventDefault();
    const chosen = filteredOptions.value[activeIndex.value];
    if (chosen) selectOption(chosen);
    return;
  }
  if (event.key === "Escape" && open.value) {
    event.preventDefault();
    event.stopPropagation();
    close({ restoreTriggerFocus: true });
  }
}

function onGlobalPointerDown(event) {
  if (!open.value) return;
  const target = event.target;
  if (triggerRef.value?.contains?.(target) || menuRef.value?.contains?.(target)) return;
  close();
}

function onViewportChange(event) {
  if (!open.value) return;
  if (event?.type === "scroll" && menuRef.value?.contains?.(event.target)) return;
  updatePosition();
}

watch(open, (isOpen) => {
  if (typeof window === "undefined") return;
  if (isOpen) {
    window.addEventListener("pointerdown", onGlobalPointerDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
  } else {
    window.removeEventListener("pointerdown", onGlobalPointerDown, true);
    window.removeEventListener("resize", onViewportChange);
    window.removeEventListener("scroll", onViewportChange, true);
  }
});

onBeforeUnmount(() => {
  if (typeof window === "undefined") return;
  window.removeEventListener("pointerdown", onGlobalPointerDown, true);
  window.removeEventListener("resize", onViewportChange);
  window.removeEventListener("scroll", onViewportChange, true);
});
</script>

<template>
  <div class="wb-select" :class="{ 'is-open': open, 'is-disabled': disabled, 'is-mono': monospace }">
    <button
      :id="`${id}-trigger`"
      ref="triggerRef"
      type="button"
      class="wb-select-trigger"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="`${id}-listbox`"
      :aria-label="ariaLabel || placeholder"
      :disabled="disabled"
      @click="toggleMenu"
      @keydown="handleKeydown"
    >
      <span class="wb-select-value" :class="{ 'is-placeholder': isPlaceholder }">
        {{ displayLabel }}
      </span>
      <ChevronDown :size="13" class="wb-select-caret" aria-hidden="true" />
    </button>

    <Teleport defer to=".mysql-workbench">
      <div
        v-if="open"
        ref="menuRef"
        class="wb-select-popover"
        :class="[`is-${placement}`, { 'is-mono': monospace }]"
        :style="menuStyle"
        tabindex="-1"
        @keydown="handleKeydown"
      >
        <div v-if="showSearch" class="wb-select-search-wrap">
          <Search :size="13" class="wb-select-search-icon" aria-hidden="true" />
          <input
            ref="searchInputRef"
            v-model="query"
            type="text"
            class="wb-select-search"
            :placeholder="t('select.searchPlaceholder')"
            :aria-label="t('select.searchPlaceholder')"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <ul
          :id="`${id}-listbox`"
          ref="listRef"
          class="wb-select-list"
          role="listbox"
          :aria-label="ariaLabel || placeholder"
          :style="listStyle"
        >
          <li
            v-for="(option, index) in filteredOptions"
            :key="option.value + '::' + index"
            role="option"
            class="wb-select-option"
            :class="{
              'is-selected': option.value === String(modelValue ?? ''),
              'is-active': index === activeIndex,
              'is-disabled': option.disabled,
            }"
            :data-selected="option.value === String(modelValue ?? '') ? 'true' : undefined"
            :data-active="index === activeIndex ? 'true' : undefined"
            :aria-selected="option.value === String(modelValue ?? '')"
            @mouseenter="activeIndex = index"
            @mousedown.prevent
            @click="selectOption(option)"
          >
            <span class="wb-select-option-label">{{ option.label }}</span>
            <span v-if="option.detail || option.value === String(modelValue ?? '')" class="wb-select-option-meta">
              <span v-if="option.detail" class="wb-select-option-detail">{{ option.detail }}</span>
              <Check v-if="option.value === String(modelValue ?? '')" :size="13" class="wb-select-option-check" aria-hidden="true" />
            </span>
          </li>
          <li v-if="!filteredOptions.length" class="wb-select-empty" role="presentation">
            {{ resolvedEmptyText }}
          </li>
        </ul>
      </div>
    </Teleport>
  </div>
</template>
