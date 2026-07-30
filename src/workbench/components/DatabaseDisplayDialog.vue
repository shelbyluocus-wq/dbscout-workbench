<script setup>
import { Archive, Boxes, Cloud, Database, FlaskConical, Rocket, ShieldCheck, Star, Table2 } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import {
  DATABASE_DECORATION_ICONS,
  DATABASE_TEXT_COLOR_PRESETS,
  databaseTextColorCss,
} from "../composables/databaseDecorationStore.js";
import { useEscClose } from "../composables/useEscClose.js";
import DatabaseColorPicker from "./DatabaseColorPicker.vue";

const props = defineProps({
  open: { type: Boolean, default: false },
  realName: { type: String, default: "" },
  alias: { type: String, default: "" },
  icon: { type: String, default: "database" },
  color: { type: String, default: "" },
  textColor: { type: String, default: "" },
});
const emit = defineEmits(["close", "save"]);

const iconComponents = Object.freeze({
  database: Database,
  boxes: Boxes,
  shield: ShieldCheck,
  flask: FlaskConical,
  rocket: Rocket,
  archive: Archive,
  star: Star,
  cloud: Cloud,
});
const aliasDraft = ref("");
const iconDraft = ref("database");
const colorDraft = ref("");
const textColorDraft = ref("");
const previewIcon = computed(() => iconComponents[iconDraft.value] || Database);
const previewColor = computed(() => colorDraft.value || "var(--wb-secondary-text)");
const previewTextColor = computed(() => databaseTextColorCss(textColorDraft.value) || "var(--wb-text)");
const previewName = computed(() => aliasDraft.value.trim() || props.realName || "database");

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    aliasDraft.value = props.alias || "";
    iconDraft.value = iconComponents[props.icon] ? props.icon : "database";
    colorDraft.value = props.color || "";
    textColorDraft.value = props.textColor || "";
  },
  { immediate: true },
);

useEscClose(() => props.open, () => emit("close"));

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
  <div v-if="open" class="wb-dialog-overlay" @click.self="emit('close')">
    <form
      class="wb-dialog wb-database-display-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wb-database-display-title"
      @submit.prevent="submit"
    >
      <header class="wb-dialog-header wb-database-display-header">
        <div class="wb-database-display-heading">
          <strong id="wb-database-display-title">数据库名称与标记</strong>
          <small>
            <span class="wb-database-display-realname">{{ realName }}</span>
            · 仅修改本地显示
          </small>
        </div>
        <button type="button" class="wb-dialog-close" aria-label="关闭数据库名称与标记" @click="emit('close')">×</button>
      </header>

      <div class="wb-database-display-body">
        <section class="wb-database-display-section">
          <label class="wb-database-display-label" for="wb-database-alias-input">本地别名</label>
          <input
            id="wb-database-alias-input"
            v-model="aliasDraft"
            class="wb-database-display-alias"
            type="text"
            placeholder="留空显示真实库名"
            maxlength="60"
            autocomplete="off"
            autofocus
          />
        </section>

        <section class="wb-database-display-section">
          <span class="wb-database-display-label">树形预览</span>
          <div class="wb-database-marker-preview" aria-hidden="true">
            <div class="wb-database-marker-row">
              <span class="wb-database-marker-chevron"></span>
              <component :is="previewIcon" :size="15" :style="{ color: previewColor }" />
              <span class="wb-database-marker-name" :style="{ color: previewTextColor }">{{ previewName }}</span>
            </div>
            <div class="wb-database-marker-row is-child">
              <Table2 :size="15" :style="{ color: previewColor }" />
              <span>子表继承图标与图标色</span>
            </div>
          </div>
        </section>

        <section class="wb-database-display-section">
          <span class="wb-database-display-label">图标</span>
          <div class="wb-database-icon-options" role="radiogroup" aria-label="数据库图标">
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
              <component :is="iconComponents[option.id]" :size="15" aria-hidden="true" />
              <span>{{ option.label }}</span>
            </button>
          </div>
        </section>

        <section class="wb-database-display-section wb-database-display-colors">
          <DatabaseColorPicker v-model="colorDraft" label="图标颜色" hint="数据库与子表图标" />
          <DatabaseColorPicker
            v-model="textColorDraft"
            label="名称颜色"
            hint="仅数据库名称"
            :presets="DATABASE_TEXT_COLOR_PRESETS"
            custom-warning="自定义颜色不会随主题切换，请确认明暗模式下都清晰"
          />
        </section>
      </div>

      <footer class="wb-dialog-actions wb-database-display-actions">
        <button type="button" class="wb-database-display-reset" @click="resetMarker">恢复默认标记</button>
        <span class="wb-database-display-actions-spacer"></span>
        <button type="button" @click="emit('close')">取消</button>
        <button type="submit" class="wb-dialog-primary">保存</button>
      </footer>
    </form>
  </div>
</template>
