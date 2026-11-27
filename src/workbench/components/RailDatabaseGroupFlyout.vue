<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Check, Pencil } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useActivityRailSort } from "../composables/useActivityRailSort.js";
import { RAIL_GROUP_NAME_MAX_LENGTH } from "../utils/railDatabaseGroups.js";
import RailDatabaseTile from "./RailDatabaseTile.vue";

// The list a rail folder opens: its databases with their full names and
// connections. Rows open on click, reorder by press-and-drag or Alt+Arrow,
// and carry the same menu as the rail tiles.
const props = defineProps({
  open: { type: Boolean, default: false },
  anchorRect: { type: Object, default: null },
  // A rail layout group: { groupId, name, items }.
  group: { type: Object, default: null },
  theme: { type: String, default: "light" },
  renameOnOpen: { type: Boolean, default: false },
  focusOnOpen: { type: Boolean, default: false },
});

const emit = defineEmits(["select", "menu", "reorder", "rename", "close"]);

const panelRef = ref(null);
const listRef = ref(null);
const nameInputRef = ref(null);
defineExpose({ panel: panelRef });

const position = ref({ left: "0px", top: "0px" });
const renaming = ref(false);
const draft = ref("");
const items = computed(() => props.group?.items || []);

const sort = useActivityRailSort({
  items,
  container: listRef,
  onReorder: ({ sourceId, targetId, position: at }) => emit("reorder", props.group?.groupId, sourceId, targetId, { position: at }),
});
const sortPhase = computed(() => sort.phase.value);

onBeforeUnmount(sort.dispose);

async function place() {
  const rect = props.anchorRect;
  position.value = { left: `${(rect?.right || 0) + 8}px`, top: `${rect?.top || 8}px` };
  await nextTick();
  const panel = panelRef.value;
  if (!panel || !rect) return;
  const bounds = panel.getBoundingClientRect();
  position.value = {
    left: `${Math.max(8, Math.min(rect.right + 8, globalThis.innerWidth - bounds.width - 8))}px`,
    top: `${Math.max(8, Math.min(rect.top - 6, globalThis.innerHeight - bounds.height - 8))}px`,
  };
}

function rows() {
  return [...(listRef.value?.querySelectorAll?.(".wb-rail-db-flyout-row:not(:disabled)") || [])];
}

function focusRow(step) {
  const list = rows();
  if (!list.length) return;
  const index = list.indexOf(document.activeElement);
  const next = index < 0 ? (step > 0 ? 0 : list.length - 1) : (index + step + list.length) % list.length;
  list[next].focus({ preventScroll: false });
}

watch(() => [props.open, props.group?.groupId], async ([open]) => {
  renaming.value = false;
  if (!open) return;
  await place();
  if (props.renameOnOpen) startRename();
  else if (props.focusOnOpen) {
    const current = rows().find((row) => row.getAttribute("aria-current") === "true");
    (current || rows()[0])?.focus({ preventScroll: true });
  }
}, { immediate: true });

watch(() => items.value.length, () => {
  if (props.open) void place();
});

function startRename() {
  if (!props.group) return;
  draft.value = props.group.name;
  renaming.value = true;
  nextTick(() => {
    nameInputRef.value?.focus();
    nameInputRef.value?.select();
  });
}

function commitRename() {
  if (!renaming.value) return;
  renaming.value = false;
  const name = draft.value.trim();
  if (name && name !== props.group?.name) emit("rename", props.group.groupId, name);
}

function cancelRename() {
  renaming.value = false;
  nextTick(() => panelRef.value?.querySelector?.(".wb-rail-db-flyout-name")?.focus?.());
}

function selectItem(item, event) {
  if (sort.consumeClick()) return;
  emit("select", item, event);
}

function onKeydown(event) {
  if (event.target === nameInputRef.value) return;
  if (event.altKey) return;
  if (event.key === "ArrowDown") focusRow(1);
  else if (event.key === "ArrowUp") focusRow(-1);
  else if (event.key === "Home") rows()[0]?.focus();
  else if (event.key === "End") rows().at(-1)?.focus();
  else if (event.key === "F2") startRename();
  else return;
  event.preventDefault();
  event.stopPropagation();
}

function sortableClass(item) {
  return {
    "is-rail-dragging": sort.isLifted(item),
    "is-rail-settling": sort.isSettling(item),
  };
}

function sortableStyle(item, index) {
  const shift = sort.shiftFor(item, index);
  return shift ? { "--wb-rail-sort-shift": `${shift}px` } : undefined;
}
</script>

<template>
  <Teleport to="body">
    <section
      v-if="open && group"
      ref="panelRef"
      class="wb-rail-db-flyout wb-floating-themed"
      :class="{
        'is-sorting': sortPhase === 'dragging' || sortPhase === 'settling',
        'is-sort-resetting': sortPhase === 'resetting',
      }"
      :data-theme="theme"
      :style="position"
      role="dialog"
      :aria-label="group.name"
      @keydown="onKeydown"
      @contextmenu.prevent
    >
      <header class="wb-rail-db-flyout-head">
        <input
          v-if="renaming"
          ref="nameInputRef"
          v-model="draft"
          class="wb-rail-db-flyout-name-input"
          :maxlength="RAIL_GROUP_NAME_MAX_LENGTH"
          :aria-label="t('railDatabase.groupRename')"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent.stop="cancelRename"
          @blur="commitRename"
        />
        <button
          v-else
          type="button"
          class="wb-rail-db-flyout-name"
          :title="t('railDatabase.groupRename')"
          @click="startRename"
        >
          <strong>{{ group.name }}</strong>
          <Pencil :size="12" :stroke-width="2" aria-hidden="true" />
        </button>
        <span class="wb-rail-db-flyout-count">{{ t("railDatabase.groupCount", { count: items.length }) }}</span>
      </header>
      <div ref="listRef" class="wb-rail-db-flyout-list">
        <button
          v-for="(item, index) in items"
          :key="item.id"
          type="button"
          class="wb-rail-db-flyout-row is-sortable"
          :class="[sortableClass(item), { 'is-current': item.current, 'is-disconnected': item.disconnected || item.missing }]"
          :style="sortableStyle(item, index)"
          :data-wb-rail-sort-id="item.id"
          :data-wb-rail-database="item.database"
          :disabled="item.missing"
          :aria-current="item.current ? 'true' : undefined"
          :title="item.hint"
          @pointerdown="sort.onPointerDown(item, $event)"
          @keydown.alt.up.prevent="sort.moveByKeyboard(item, -1)"
          @keydown.alt.down.prevent="sort.moveByKeyboard(item, 1)"
          @click="selectItem(item, $event)"
          @contextmenu.prevent.stop="emit('menu', item, $event)"
        >
          <RailDatabaseTile :glyph="item.glyph" :color="item.color" :ink="item.ink" />
          <span class="wb-rail-db-flyout-copy">
            <strong>{{ item.label }}</strong>
            <small>{{ item.connectionLabel }}<template v-if="item.realName !== item.label"> · {{ item.realName }}</template></small>
          </span>
          <Check v-if="item.current" :size="14" :stroke-width="2.2" class="wb-rail-db-flyout-check" aria-hidden="true" />
          <span class="wb-visually-hidden">{{ item.hint }}</span>
        </button>
      </div>
    </section>
  </Teleport>
</template>
