<script setup>
// Find a table in the relation graph by name or comment: type, move with the
// arrow keys and press Enter (or click). The graph then brings the table into
// view and pins it, so its relations and actions are one step away. Escape
// closes the box without closing anything behind it.
import { t } from "../i18n/index.js";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { Search, X } from "lucide-vue-next";

const props = defineProps({
  // [{ id, name, comment }]
  items: { type: Array, default: () => [] },
});

const emit = defineEmits(["pick", "close"]);

const MAX_MATCHES = 8;
const listId = `wb-relation-graph-find-${Math.random().toString(36).slice(2, 10)}`;
const inputEl = ref(null);
const query = ref("");
const cursor = ref(0);

// Names that start with the text first, then names and comments that contain it.
const matches = computed(() => {
  const text = query.value.trim().toLowerCase();
  if (!text) return [];
  const starts = [];
  const contains = [];
  for (const item of props.items) {
    const name = String(item.name || item.id).toLowerCase();
    if (name.startsWith(text)) starts.push(item);
    else if (name.includes(text) || String(item.comment || "").toLowerCase().includes(text)) contains.push(item);
    if (starts.length >= MAX_MATCHES) break;
  }
  return [...starts, ...contains].slice(0, MAX_MATCHES);
});

watch(matches, () => {
  cursor.value = 0;
});

function pick(item) {
  if (item) emit("pick", item.id);
}

function onKeydown(event) {
  if (event.key === "Escape") {
    // Handled here: the full-screen view behind must stay open.
    event.preventDefault();
    event.stopPropagation();
    emit("close");
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const count = matches.value.length;
    if (!count) return;
    cursor.value = (cursor.value + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    pick(matches.value[cursor.value]);
  }
}

onMounted(() => {
  void nextTick(() => inputEl.value?.focus());
});
</script>

<template>
  <div class="wb-relation-graph-find" @pointerdown.stop @wheel.stop>
    <div class="wb-relation-graph-find-field">
      <Search :size="13" aria-hidden="true" />
      <input
        ref="inputEl"
        v-model="query"
        type="text"
        role="combobox"
        :aria-label="t('relations.graph.find.label')"
        :aria-expanded="matches.length > 0"
        :aria-controls="listId"
        :aria-activedescendant="matches.length ? `${listId}-${cursor}` : undefined"
        :placeholder="t('relations.graph.find.placeholder')"
        autocomplete="off"
        spellcheck="false"
        @keydown="onKeydown"
      >
      <button type="button" :title="t('relations.graph.find.close')" :aria-label="t('relations.graph.find.close')" @click="emit('close')">
        <X :size="12" aria-hidden="true" />
      </button>
    </div>
    <ul v-if="matches.length" :id="listId" role="listbox" class="wb-relation-graph-find-list">
      <li
        v-for="(item, index) in matches"
        :id="`${listId}-${index}`"
        :key="item.id"
        role="option"
        :aria-selected="index === cursor"
        :class="{ 'is-active': index === cursor }"
        @pointerenter="cursor = index"
        @click="pick(item)"
      >
        <strong>{{ item.name }}</strong>
        <span v-if="item.comment">{{ item.comment }}</span>
      </li>
    </ul>
    <p v-else-if="query.trim()" class="wb-relation-graph-find-empty">{{ t('relations.graph.find.none') }}</p>
  </div>
</template>

<style scoped>
.wb-relation-graph-find {
  position: absolute;
  top: 8px;
  right: 44px;
  z-index: 4;
  display: grid;
  width: min(280px, calc(100% - 56px));
  overflow: hidden;
  border-radius: 9px;
  background: var(--wb-menu-surface);
  box-shadow: 0 0 0 1px var(--wb-border), var(--wb-floating-shadow);
  font-size: var(--wb-fs-caption);
}

.wb-relation-graph-find-field {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px 0 9px;
  color: var(--wb-quiet-text);
}

.wb-relation-graph-find-field input {
  flex: 1 1 auto;
  min-width: 0;
  height: 30px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--wb-text);
  font: inherit;
  outline: none;
  box-shadow: none;
}

.wb-relation-graph-find-field button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  min-height: 22px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--wb-quiet-text);
}

.wb-relation-graph-find-field button:hover:not(:disabled) {
  background: var(--wb-control-hover);
  color: var(--wb-text);
}

.wb-relation-graph-find-list {
  display: grid;
  margin: 0;
  padding: 3px;
  border-top: 1px solid var(--wb-line);
  list-style: none;
}

.wb-relation-graph-find-list li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  padding: 4px 7px;
  border-radius: 6px;
  cursor: pointer;
}

.wb-relation-graph-find-list li.is-active {
  background: var(--wb-control-hover);
}

.wb-relation-graph-find-list strong {
  flex: none;
  max-width: 60%;
  overflow: hidden;
  color: var(--wb-text);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-relation-graph-find-list span {
  min-width: 0;
  overflow: hidden;
  color: var(--wb-quiet-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-relation-graph-find-empty {
  margin: 0;
  padding: 6px 10px 8px;
  border-top: 1px solid var(--wb-line);
  color: var(--wb-quiet-text);
}
</style>
