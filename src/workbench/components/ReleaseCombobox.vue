<script setup>
// A text field with a styled suggestion list, in place of the browser's
// datalist (whose popup cannot follow the workspace's design). Opening a
// filled field shows every option; typing filters. Arrow keys move, Enter
// picks the highlighted one or the typed text, Escape closes the list
// without closing the workspace.
import { computed, nextTick, ref, useId, watch } from "vue";
import { Check, ChevronDown } from "lucide-vue-next";
import { suggestionMatches } from "../utils/suggestionList.js";

const props = defineProps({
  modelValue: { type: String, default: "" },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: "" },
  label: { type: String, default: "" },
  disabled: { type: Boolean, default: false },
  emptyText: { type: String, default: "" },
  limit: { type: Number, default: 80 },
});

const emit = defineEmits(["update:modelValue", "pick"]);
const id = useId();
const open = ref(false);
const browsing = ref(false);
const active = ref(-1);
const listRef = ref(null);

function choiceOf(option) {
  if (option && typeof option === "object") {
    return { value: String(option.value ?? ""), label: String(option.label ?? option.value ?? "") };
  }
  const text = String(option ?? "");
  return { value: text, label: text };
}

const matches = computed(() => suggestionMatches(props.options, props.modelValue, { browsing: browsing.value, limit: props.limit }).map(choiceOf));
const shown = computed(() => {
  if (open.value && !browsing.value) return props.modelValue;
  const known = props.options.map(choiceOf).find((option) => option.value === props.modelValue);
  return known ? known.label : props.modelValue;
});
const activeId = computed(() => (open.value && active.value >= 0 ? `${id}-option-${active.value}` : undefined));

watch(matches, () => {
  active.value = matches.value.length ? Math.min(Math.max(active.value, 0), matches.value.length - 1) : -1;
});

function show({ browse = false } = {}) {
  if (props.disabled) return;
  if (browse) browsing.value = true;
  open.value = true;
  const current = matches.value.findIndex((option) => option.value === props.modelValue);
  if (current >= 0) active.value = current;
  else if (active.value < 0 && matches.value.length) active.value = 0;
  void nextTick(() => listRef.value?.querySelector("[data-current='true']")?.scrollIntoView?.({ block: "nearest" }));
}

function toggle() {
  if (props.disabled) return;
  if (open.value) {
    open.value = false;
    browsing.value = false;
    active.value = -1;
    return;
  }
  show({ browse: true });
}

function scrollActive() {
  void nextTick(() => listRef.value?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }));
}

function pick(option) {
  const choice = choiceOf(option);
  emit("update:modelValue", choice.value);
  emit("pick", choice.value);
  open.value = false;
  browsing.value = false;
  active.value = -1;
}

function onInput(event) {
  browsing.value = false;
  emit("update:modelValue", event.target.value);
  show();
}

function onKeydown(event) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!open.value) {
      show();
      return;
    }
    const step = event.key === "ArrowDown" ? 1 : -1;
    const count = matches.value.length;
    if (count) active.value = (active.value + step + count) % count;
    scrollActive();
  } else if (event.key === "Enter") {
    event.preventDefault();
    const choice = open.value && active.value >= 0 ? matches.value[active.value] : props.modelValue.trim();
    if (choice) pick(choice);
  } else if (event.key === "Escape" && open.value) {
    // Only the list closes; the workspace stays open.
    event.preventDefault();
    event.stopPropagation();
    open.value = false;
    browsing.value = false;
  }
}

function onBlur(event) {
  if (listRef.value?.contains(event.relatedTarget)) return;
  open.value = false;
}
</script>

<template>
  <div class="wb-rf-combobox" :class="{ 'is-open': open && (matches.length || emptyText) }">
    <input
      :id="`${id}-input`"
      class="wb-rf-input wb-rf-code"
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      aria-autocomplete="list"
      :aria-expanded="open"
      :aria-controls="`${id}-list`"
      :aria-activedescendant="activeId"
      :aria-label="label || placeholder"
      :placeholder="placeholder"
      :value="shown"
      :disabled="disabled"
      @input="onInput"
      @focus="show({ browse: true })"
      @click="show({ browse: true })"
      @keydown="onKeydown"
      @blur="onBlur"
    />
    <button type="button" class="wb-rf-combobox-caret" tabindex="-1" :disabled="disabled" :aria-label="label || placeholder" @mousedown.prevent @click="toggle">
      <ChevronDown :size="14" aria-hidden="true" />
    </button>
    <Transition name="wb-rf-pop">
      <ul
        v-if="open && (matches.length || emptyText)"
        :id="`${id}-list`"
        ref="listRef"
        class="wb-rf-combobox-list"
        role="listbox"
        :aria-label="label || placeholder"
      >
        <li
          v-for="(option, index) in matches"
          :id="`${id}-option-${index}`"
          :key="option.value"
          role="option"
          class="wb-rf-combobox-option"
          :data-current="option.value === modelValue ? 'true' : undefined"
          :aria-selected="index === active"
          @mousedown.prevent
          @mouseenter="active = index"
          @click="pick(option)"
        >
          <span>{{ option.label }}</span>
          <Check v-if="index === active" :size="13" aria-hidden="true" />
        </li>
        <li v-if="!matches.length" class="wb-rf-combobox-empty" role="presentation">{{ emptyText }}</li>
      </ul>
    </Transition>
  </div>
</template>
