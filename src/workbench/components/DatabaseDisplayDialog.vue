<script setup>
import { t } from "../i18n/index.js";
import { computed, ref, watch } from "vue";
import {
  DATABASE_DECORATION_ICONS,
  DATABASE_TEXT_COLOR_PRESETS,
  databaseTextColorCss,
} from "../composables/databaseDecorationStore.js";
import { useEscClose } from "../composables/useEscClose.js";
import DatabaseColorPicker from "./DatabaseColorPicker.vue";
import { databaseDecorationIconComponent, databaseTableIconComponent } from "./databaseDecorationIcons.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  realName: { type: String, default: "" },
  alias: { type: String, default: "" },
  icon: { type: String, default: "database" },
  color: { type: String, default: "" },
  textColor: { type: String, default: "" },
});
const emit = defineEmits(["close", "save"]);

const aliasDraft = ref("");
const iconDraft = ref("database");
const colorDraft = ref("");
const textColorDraft = ref("");
const previewIcon = computed(() => databaseDecorationIconComponent(iconDraft.value));
const previewTableIcon = computed(() => databaseTableIconComponent(
  iconDraft.value !== "database" || colorDraft.value || textColorDraft.value
    ? { icon: iconDraft.value }
    : null,
));
const previewColor = computed(() => colorDraft.value || "var(--wb-secondary-text)");
const previewTextColor = computed(() => databaseTextColorCss(textColorDraft.value) || "var(--wb-text)");
const previewName = computed(() => aliasDraft.value.trim() || props.realName || "database");
const dialogRef = ref(null);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    aliasDraft.value = props.alias || "";
    iconDraft.value = DATABASE_DECORATION_ICONS.some((option) => option.id === props.icon) ? props.icon : "database";
    colorDraft.value = props.color || "";
    textColorDraft.value = props.textColor || "";
  },
  { immediate: true },
);

useEscClose(() => props.open, () => emit("close"), null, { dialogRef });

function resetMarker() {
  iconDraft.value = "database";
  colorDraft.value = "";
  textColorDraft.value = "";
}

function submit() {
  emit("save", {
    alias: aliasDraft.value,
    icon: iconDraft.value,
    color: colorDraft.value,
    textColor: textColorDraft.value,
  });
}
</script>

<template>
  <div v-if="open" class="wb-dialog-overlay">
    <form
      ref="dialogRef"
      class="wb-dialog wb-database-display-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wb-database-display-title"
      tabindex="-1"
      @submit.prevent="submit"
    >
      <header class="wb-dialog-header wb-database-display-header">
        <div class="wb-database-display-heading">
          <strong id="wb-database-display-title">{{ t('m_26405be9f416') }}</strong>
          <small>
            <span class="wb-database-display-realname">{{ realName }}</span> {{ t('m_95f3f880f33d') }} </small>
        </div>
        <button type="button" class="wb-dialog-close" :aria-label="t('m_c16631543b43')" @click="emit('close')">×</button>
      </header>

      <div class="wb-database-display-body">
        <section class="wb-database-display-section">
          <label class="wb-database-display-label" for="wb-database-alias-input">{{ t('m_2871d4fba1f4') }}</label>
          <input
            id="wb-database-alias-input"
            v-model="aliasDraft"
            class="wb-database-display-alias"
            type="text"
            :placeholder="t('m_61b7d536f5fa')"
            maxlength="60"
            autocomplete="off"
            autofocus
          />
        </section>

        <section class="wb-database-display-section">
          <span class="wb-database-display-label">{{ t('m_f57efbef3c73') }}</span>
          <div class="wb-database-marker-preview" aria-hidden="true">
            <div class="wb-database-marker-row">
              <span class="wb-database-marker-chevron"></span>
              <component :is="previewIcon" :size="15" :style="{ color: previewColor }" />
              <span class="wb-database-marker-name" :style="{ color: previewTextColor }">{{ previewName }}</span>
            </div>
            <div class="wb-database-marker-row is-child">
              <component :is="previewTableIcon" :size="15" :style="{ color: previewColor }" />
              <span :style="{ color: previewTextColor }">{{ t('m_7d95111891b3') }}</span>
            </div>
          </div>
        </section>

        <section class="wb-database-display-section">
          <span class="wb-database-display-label">{{ t('m_0d720eeea264') }}</span>
          <div class="wb-database-icon-options" role="radiogroup" :aria-label="t('m_e6f2f2ac73f2')">
            <button
              v-for="option in DATABASE_DECORATION_ICONS"
              :key="option.id"
              type="button"
              :class="{ 'is-active': iconDraft === option.id }"
              :aria-checked="iconDraft === option.id"
              :title="option.label"
              role="radio"
              @click="iconDraft = option.id"
            >
              <component :is="databaseDecorationIconComponent(option.id)" :size="15" aria-hidden="true" />
              <span>{{ option.label }}</span>
            </button>
          </div>
        </section>

        <section class="wb-database-display-section wb-database-display-colors">
          <DatabaseColorPicker v-model="colorDraft" :label="t('m_52c15454e268')" :hint="t('m_5b07d5e4ac53')" />
          <DatabaseColorPicker
            v-model="textColorDraft"
            :label="t('m_248e3cd3006a')"
            :hint="t('m_5b07d5e4ac53')"
            :presets="DATABASE_TEXT_COLOR_PRESETS"
            :custom-warning="t('m_265fd6b4d8e9')"
          />
        </section>
      </div>

      <footer class="wb-dialog-actions wb-database-display-actions">
        <button type="button" class="wb-database-display-reset" @click="resetMarker">{{ t('m_30ff0944adcf') }}</button>
        <span class="wb-database-display-actions-spacer"></span>
        <button type="button" @click="emit('close')">{{ t('m_2cd0f3be8738') }}</button>
        <button type="submit" class="wb-dialog-primary">{{ t('m_a3030bf8f16d') }}</button>
      </footer>
    </form>
  </div>
</template>
