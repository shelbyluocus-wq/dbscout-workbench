<script setup>
import { computed, ref, watch } from "vue";
import {
  DEFAULT_FONT_PREFERENCE,
  DEFAULT_FONT_WEIGHT,
  FONT_WEIGHT_OPTIONS,
  customFontFamily,
  customFontPreference,
  fontWeightLabel,
  fontPreferenceLabel,
  normalizeCustomFontFamily,
  normalizeFontPreference,
  normalizeFontWeight,
} from "../composables/useFontPreference.js";

const props = defineProps({
  modelValue: { type: String, default: DEFAULT_FONT_PREFERENCE },
  weight: { type: Number, default: DEFAULT_FONT_WEIGHT },
  fonts: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  error: { type: String, default: "" },
});

const emit = defineEmits(["update:modelValue", "update:weight", "retry"]);

const query = ref("");
const searchRef = ref(null);
const listRef = ref(null);

const normalizedQuery = computed(() => query.value.trim().toLocaleLowerCase());
const filteredFonts = computed(() => {
  if (!normalizedQuery.value) return props.fonts;
  return props.fonts.filter((font) => font.family.toLocaleLowerCase().includes(normalizedQuery.value));
});
const exactMatch = computed(() =>
  props.fonts.some((font) => font.family.toLocaleLowerCase() === normalizedQuery.value),
);
const customQueryFamily = computed(() => normalizeCustomFontFamily(query.value));
const customQueryPreference = computed(() => {
  if (!customQueryFamily.value || exactMatch.value) return "";
  return customFontPreference(customQueryFamily.value);
});
const selectedValue = computed(() => {
  const preference = normalizeFontPreference(props.modelValue);
  if (preference === DEFAULT_FONT_PREFERENCE) return preference;
  return customFontPreference(customFontFamily(preference) || fontPreferenceLabel(preference));
});
const selectedFamily = computed(() => customFontFamily(selectedValue.value));
const selectedFont = computed(() => {
  const family = selectedFamily.value.toLocaleLowerCase();
  return family ? props.fonts.find((font) => font.family.toLocaleLowerCase() === family) : null;
});
const availableWeights = computed(() => {
  if (selectedFont.value?.weights?.length) return selectedFont.value.weights;
  return FONT_WEIGHT_OPTIONS.map((option) => option.value);
});

function choose(event) {
  const value = event.target.value;
  if (!value) return;
  emit("update:modelValue", normalizeFontPreference(value));
}

function focusList() {
  listRef.value?.focus?.();
}

function chooseCustomQuery() {
  if (!customQueryPreference.value) return;
  emit("update:modelValue", customQueryPreference.value);
}

function chooseWeight(event) {
  emit("update:weight", normalizeFontWeight(event.target.value));
}

function focus() {
  searchRef.value?.focus?.();
}

function closestAvailableWeight(weight, available) {
  return available.reduce((closest, candidate) => {
    const candidateDistance = Math.abs(candidate - weight);
    const closestDistance = Math.abs(closest - weight);
    return candidateDistance < closestDistance ? candidate : closest;
  }, available[0] || DEFAULT_FONT_WEIGHT);
}

watch(
  [availableWeights, () => props.weight],
  ([weights, weight]) => {
    if (!weights.length || weights.includes(weight)) return;
    emit("update:weight", closestAvailableWeight(weight, weights));
  },
  { immediate: true },
);

defineExpose({ focus });
</script>

<template>
  <div class="wb-system-font-picker">
    <div class="wb-system-font-picker-meta">
      <span>本机字体</span>
      <span>{{ loading ? "读取中…" : `${fonts.length} 个` }}</span>
    </div>

    <input
      ref="searchRef"
      v-model="query"
      class="wb-font-search"
      type="search"
      aria-label="搜索本机字体"
      placeholder="搜索本机字体"
      autocomplete="off"
      spellcheck="false"
      @keydown.down.prevent="focusList"
      @keydown.enter.prevent="chooseCustomQuery"
    />

    <label class="wb-font-weight-field">
      <span>字重</span>
      <select aria-label="界面字体字重" :value="weight" @change="chooseWeight">
        <option v-for="optionWeight in availableWeights" :key="optionWeight" :value="optionWeight">
          {{ fontWeightLabel(optionWeight) }}
        </option>
      </select>
    </label>

    <select
      ref="listRef"
      class="wb-font-family-list"
      size="7"
      aria-label="本机字体列表"
      :value="selectedValue"
      @change="choose"
    >
      <option :value="DEFAULT_FONT_PREFERENCE">系统默认</option>
      <option
        v-for="font in filteredFonts"
        :key="font.family"
        :value="customFontPreference(font.family)"
      >
        {{ font.family }}
      </option>
      <option v-if="customQueryPreference" :value="customQueryPreference">
        使用 “{{ customQueryFamily }}”
      </option>
      <option v-if="loading && !fonts.length" value="" disabled>正在读取本机字体…</option>
      <option
        v-else-if="!filteredFonts.length && !customQueryPreference && !error"
        value=""
        disabled
      >没有匹配字体</option>
    </select>

    <div v-if="error" class="wb-system-font-error" role="alert" :title="error">
      <span>本机字体读取失败</span>
      <button type="button" @click="emit('retry')">重试</button>
    </div>
  </div>
</template>
