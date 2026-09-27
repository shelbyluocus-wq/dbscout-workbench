<script setup>
import { t } from "../i18n/index.js";
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
      <span>{{ t('m_7bf17a5944f4') }}</span>
      <span>{{ loading ? t('m_346ff60e6c7c') : `${fonts.length} 个` }}</span>
    </div>

    <input
      ref="searchRef"
      v-model="query"
      class="wb-font-search"
      type="search"
      :aria-label="t('m_7a662df227d7')"
      :placeholder="t('m_7a662df227d7')"
      autocomplete="off"
      spellcheck="false"
      @keydown.down.prevent="focusList"
      @keydown.enter.prevent="chooseCustomQuery"
    />

    <label class="wb-font-weight-field">
      <span>{{ t('m_c69ead895a51') }}</span>
      <select :aria-label="t('m_918e7060d25b')" :value="weight" @change="chooseWeight">
        <option v-for="optionWeight in availableWeights" :key="optionWeight" :value="optionWeight">
          {{ fontWeightLabel(optionWeight) }}
        </option>
      </select>
    </label>

    <select
      ref="listRef"
      class="wb-font-family-list"
      size="7"
      :aria-label="t('m_9ded05466aed')"
      :value="selectedValue"
      @change="choose"
    >
      <option :value="DEFAULT_FONT_PREFERENCE">{{ t('m_04b77083689b') }}</option>
      <option
        v-for="font in filteredFonts"
        :key="font.family"
        :value="customFontPreference(font.family)"
      >
        {{ font.family }}
      </option>
      <option v-if="customQueryPreference" :value="customQueryPreference"> {{ t('m_736c5fd2d331') }}{{ customQueryFamily }}”
      </option>
      <option v-if="loading && !fonts.length" value="" disabled>{{ t('m_11a42d22579b') }}</option>
      <option
        v-else-if="!filteredFonts.length && !customQueryPreference && !error"
        value=""
        disabled
      >{{ t('m_98ed7474b881') }}</option>
    </select>

    <div v-if="error" class="wb-system-font-error" role="alert" :title="error">
      <span>{{ t('m_0217538fd34e') }}</span>
      <button type="button" @click="emit('retry')">{{ t('m_b8784c8dd563') }}</button>
    </div>
  </div>
</template>
