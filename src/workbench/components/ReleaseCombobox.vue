<script setup>
// A text field with a styled suggestion list, in place of the browser's
// datalist (whose popup cannot follow the workspace's design): suggestions
// filter as you type, arrow keys move, Enter picks the highlighted one or
// the typed text, Escape closes the list without closing the workspace.
import { computed, nextTick, ref, useId, watch } from "vue";
import { Check } from "lucide-vue-next";

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
const active = ref(-1);
const listRef = ref(null);

const matches = computed(() => {
  const needle = props.modelValue.trim().toLowerCase();
  const list = needle ? props.options.filter((option) => option.toLowerCase().includes(needle)) : props.options;
  return list.slice(0, props.limit);
});
const activeId = computed(() => (open.value && active.value >= 0 ? `${id}-option-${active.value}` : undefined));

watch(matches, () => {
  active.value = matches.value.length ? Math.min(Math.max(active.value, 0), matches.value.length - 1) : -1;
});

function show() {
  if (props.disabled) return;
  open.value = true;
  if (active.value < 0 && matches.value.length) active.value = 0;
}

function scrollActive() {
  void nextTick(() => listRef.value?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }));
}

function pick(value) {
  emit("pick", value);
  open.value = false;
  active.value = -1;
}

function onInput(event) {
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
      :value="modelValue"
      :disabled="disabled"
      @input="onInput"
      @focus="show"
      @click="show"
      @keydown="onKeydown"
      @blur="onBlur"
    />
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
          :key="option"
          role="option"
          class="wb-rf-combobox-option"
          :aria-selected="index === active"
          @mousedown.prevent
          @mouseenter="active = index"
          @click="pick(option)"
        >
          <span class="wb-rf-code">{{ option }}</span>
          <Check v-if="index === active" :size="13" aria-hidden="true" />
        </li>
        <li v-if="!matches.length" class="wb-rf-combobox-empty" role="presentation">{{ emptyText }}</li>
      </ul>
    </Transition>
  </div>
</template>
