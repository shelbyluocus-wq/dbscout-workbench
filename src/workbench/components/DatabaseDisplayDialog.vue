<script setup>
import { Archive, Boxes, Cloud, Database, FlaskConical, Rocket, ShieldCheck, Star } from "lucide-vue-next";
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
    <form class="wb-dialog wb-database-display-dialog" role="dialog" aria-modal="true" aria-labelledby="wb-database-display-title" @submit.prevent="submit">
      <header class="wb-dialog-header">
        <div>
          <strong id="wb-database-display-title">数据库名称与标记</strong>
          <small>{{ realName }} · 仅修改本地显示</small>
        </div>
        <button type="button" class="wb-dialog-close" aria-label="关闭数据库名称与标记" @click="emit('close')">×</button>
      </header>

      <label class="wb-dialog-field">
        <span>本地别名</span>
        <input v-model="aliasDraft" placeholder="留空显示真实库名" maxlength="60" autofocus />
      </label>

      <fieldset class="wb-database-marker-fieldset">
        <legend>树形标记</legend>
        <div class="wb-database-marker-preview">
          <component :is="previewIcon" :size="18" :style="{ color: previewColor }" aria-hidden="true" />
          <span :style="{ color: previewTextColor }">{{ aliasDraft.trim() || realName }}</span>
          <small>子表继承图标和图标色；名称色仅作用于数据库名称</small>
        </div>
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
            <component :is="iconComponents[option.id]" :size="16" aria-hidden="true" />
            <span>{{ option.label }}</span>
          </button>
        </div>
        <div class="wb-database-color-settings">
          <DatabaseColorPicker v-model="colorDraft" label="图标颜色" hint="数据库与子表图标" />
          <DatabaseColorPicker
            v-model="textColorDraft"
            label="名称颜色"
            hint="仅数据库名称"
            :presets="DATABASE_TEXT_COLOR_PRESETS"
            custom-warning="自定义颜色不会随主题切换，请确认明暗模式下都清晰"
          />
        </div>
      </fieldset>

      <footer class="wb-dialog-actions wb-database-display-actions">
        <button type="button" @click="resetMarker">恢复默认标记</button>
        <span></span>
        <button type="button" @click="emit('close')">取消</button>
        <button type="submit" class="wb-dialog-primary">保存</button>
      </footer>
    </form>
  </div>
</template>
