<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { t } from "../i18n/index.js";
import { normalizeRailText, RAIL_DATABASE_ICON_IDS } from "../utils/railDatabaseGlyph.js";
import { railDatabaseIconComponent } from "./railDatabaseIcons.js";
import DatabaseColorPicker from "./DatabaseColorPicker.vue";
import RailDatabaseTile from "./RailDatabaseTile.vue";

const props = defineProps({
  open: { type: Boolean, default: false },
  anchorRect: { type: Object, default: null },
  item: { type: Object, default: null },
  theme: { type: String, default: "light" },
});

const emit = defineEmits(["update", "reset", "close"]);

const panelRef = ref(null);
defineExpose({ panel: panelRef });
const position = ref({ left: "0px", top: "0px" });
const mode = ref("text");

const resolvedIconId = computed(() => (
  props.item?.glyph?.kind === "icon" ? props.item.glyph.id : ""
));

const colorValue = computed({
  get: () => props.item?.custom?.color || "",
  set: (value) => emitUpdate({ color: value }),
});

function emitUpdate(change) {
  if (!props.item) return;
  emit("update", {
    connectionId: props.item.connectionId,
    database: props.item.database,
    ...change,
  });
}

const textComposing = ref(false);

function applyTextValue(target) {
  const value = normalizeRailText(target.value);
  target.value = value;
  emitUpdate({ text: value });
}

function onTextInput(event) {
  if (textComposing.value || event.isComposing) return;
  applyTextValue(event.target);
}

function onTextCompositionStart() {
  textComposing.value = true;
}

function onTextCompositionEnd(event) {
  textComposing.value = false;
  applyTextValue(event.target);
}

function setMode(next) {
  mode.value = next;
  if (next === "text" && props.item?.glyph?.kind !== "text") {
    emitUpdate({ text: props.item?.autoText || "" });
  }
}

function pickIcon(id) {
  emitUpdate({ icon: id });
}

watch(() => props.open, async (open) => {
  if (!open) return;
  mode.value = props.item?.glyph?.kind === "icon" ? "icon" : "text";
  const rect = props.anchorRect;
  position.value = {
    left: `${(rect?.right || 0) + 8}px`,
    top: `${rect?.top || 8}px`,
  };
  await nextTick();
  const bounds = panelRef.value?.getBoundingClientRect?.();
  if (bounds) {
    position.value = {
      left: `${Math.max(8, Math.min((rect?.right || 0) + 8, globalThis.innerWidth - bounds.width - 8))}px`,
      top: `${Math.max(8, Math.min(rect?.top || 8, globalThis.innerHeight - bounds.height - 8))}px`,
    };
  }
  panelRef.value?.querySelector?.("button, input")?.focus?.({ preventScroll: true });
}, { immediate: true });
</script>

<template>
  <Teleport to="body">
    <section
      v-if="open && item"
      ref="panelRef"
      class="wb-rail-db-popover wb-floating-themed"
      :data-theme="theme"
      :style="position"
      role="dialog"
      :aria-label="t('railDatabase.appearanceTitle')"
      @click.stop
      @contextmenu.prevent.stop
    >
      <header class="wb-rail-db-popover-head">
        <RailDatabaseTile :glyph="item.glyph" :color="item.color" :ink="item.ink" />
        <span class="wb-rail-db-popover-name">
          <strong>{{ item.label }}</strong>
          <small>{{ item.connectionLabel }}</small>
        </span>
      </header>

      <div class="wb-rail-db-mode" role="group" :aria-label="t('railDatabase.modeLabel')">
        <button type="button" :aria-pressed="mode === 'text'" @click="setMode('text')">
          {{ t("railDatabase.modeText") }}
        </button>
        <button type="button" :aria-pressed="mode === 'icon'" @click="setMode('icon')">
          {{ t("railDatabase.modeIcon") }}
        </button>
      </div>

      <div v-if="mode === 'text'" class="wb-rail-db-field">
        <label class="wb-rail-db-field-label">
          {{ t("railDatabase.textLabel") }}
          <input
            :value="item.custom.text"
            type="text"
            autocomplete="off"
            :placeholder="t('railDatabase.textPlaceholder', { text: item.autoText })"
            @input="onTextInput"
            @compositionstart="onTextCompositionStart"
            @compositionend="onTextCompositionEnd"
          />
        </label>
        <small class="wb-rail-db-field-hint">{{ t("railDatabase.textHint") }}</small>
      </div>

      <div v-else class="wb-rail-db-field">
        <span class="wb-rail-db-field-label">{{ t("railDatabase.iconLabel") }}</span>
        <div class="wb-rail-db-icon-grid" role="group" :aria-label="t('railDatabase.iconLabel')">
          <button
            v-for="id in RAIL_DATABASE_ICON_IDS"
            :key="id"
            type="button"
            :title="t(`railDatabase.icon.${id}`)"
            :aria-label="t(`railDatabase.icon.${id}`)"
            :aria-pressed="resolvedIconId === id"
            @click="pickIcon(id)"
          >
            <component :is="railDatabaseIconComponent(id)" :size="15" :stroke-width="2" aria-hidden="true" />
          </button>
        </div>
      </div>

      <DatabaseColorPicker
        v-model="colorValue"
        :label="t('railDatabase.colorLabel')"
        :auto-label="t('railDatabase.colorAuto')"
      />

      <footer class="wb-rail-db-popover-foot">
        <button type="button" class="wb-rail-db-reset" @click="emit('reset')">
          {{ t("railDatabase.reset") }}
        </button>
      </footer>
    </section>
  </Teleport>
</template>
