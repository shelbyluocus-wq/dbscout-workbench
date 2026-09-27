<script setup>
import { t } from "../i18n/index.js";
import { nextTick, computed, onMounted, ref, watch } from "vue";
import { Pencil, Search, Star, StarOff, Trash2, X } from "lucide-vue-next";

import { useEscClose } from "../composables/useEscClose.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  invokeWorkbench: { type: Function, required: true },
  connectionId: { type: String, default: "" },
  recentFiles: { type: Array, default: () => [] },
});
const emit = defineEmits(["close", "open-sql", "open-file", "remove-recent"]);
const rows = ref([]);
const query = ref("");
const loading = ref(false);
const searchRef = ref(null);
const renameInputRef = ref(null);
const dialogRef = ref(null);
const view = ref("history");
const editingFavoriteId = ref(null);
let originalFavoriteName = "";
const favoriteCount = computed(() => rows.value.filter((row) => row.favorite).length);
const filtered = computed(() => {
  const text = query.value.trim().toLocaleLowerCase();
  const source = view.value === "favorites" ? rows.value.filter((row) => row.favorite) : rows.value;
  return text ? source.filter((row) => `${row.name || ""} ${row.sql} ${row.database}`.toLocaleLowerCase().includes(text)) : source;
});
const filteredRecentFiles = computed(() => {
  const text = query.value.trim().toLocaleLowerCase();
  return text ? props.recentFiles.filter((file) => `${file.fileName} ${file.path}`.toLocaleLowerCase().includes(text)) : props.recentFiles;
});
async function load() {
  loading.value = true;
  try { rows.value = await props.invokeWorkbench("list_sql_history", { request: { connectionId: props.connectionId || null, query: query.value || null, limit: 500 } }); }
  finally { loading.value = false; }
}
async function toggleFavorite(row) {
  const favorite = !row.favorite;
  const name = favorite ? row.name || suggestedFavoriteName(row.sql) : null;
  await props.invokeWorkbench("save_sql_favorite", { id: row.id, favorite, name });
  Object.assign(row, { favorite, name });
}
function suggestedFavoriteName(sql) {
  const compact = String(sql || "").replace(/\s+/g, " ").trim();
  return compact.length > 56 ? `${compact.slice(0, 53)}...` : compact || "收藏查询";
}
function startRename(row) {
  editingFavoriteId.value = row.id;
  originalFavoriteName = row.name || "";
  void nextTick(() => {
    const input = Array.isArray(renameInputRef.value) ? renameInputRef.value[0] : renameInputRef.value;
    input?.focus();
    input?.select();
  });
}
async function finishRename(row) {
  if (editingFavoriteId.value !== row.id) return;
  const name = String(row.name || "").trim() || suggestedFavoriteName(row.sql);
  editingFavoriteId.value = null;
  row.name = name;
  await props.invokeWorkbench("save_sql_favorite", { id: row.id, favorite: true, name });
}
function cancelRename(row) {
  row.name = originalFavoriteName;
  editingFavoriteId.value = null;
}
async function remove(row) {
  await props.invokeWorkbench("delete_sql_history", { id: row.id });
  rows.value = rows.value.filter((item) => item.id !== row.id);
}
async function clearAll() {
  await props.invokeWorkbench("clear_sql_history", { connectionId: props.connectionId || null });
  rows.value = rows.value.filter((row) => row.favorite);
}
onMounted(load);
useEscClose(() => props.open, () => emit("close"), null, { dialogRef });
watch(() => props.open, (open) => {
  if (open) void nextTick(() => searchRef.value?.focus());
});
watch(view, () => { editingFavoriteId.value = null; });
defineExpose({ load });
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="wb-sql-history-overlay wb-floating-themed">
      <aside ref="dialogRef" class="wb-sql-history" role="dialog" aria-modal="true" :aria-label="t('m_2bb8b6e184d6')" tabindex="-1">
        <header><strong>{{ t('m_e74d81c0d444') }}</strong><button type="button" :title="t('m_3fd47edce45b')" @click="emit('close')"><X :size="17" /></button></header>
        <nav class="wb-sql-history-views" :aria-label="t('m_954687267f95')">
          <button type="button" :class="{ active: view === 'history' }" @click="view = 'history'">{{ t('m_b0385cfe4b42') }} <small>{{ rows.length }}</small></button>
          <button type="button" :class="{ active: view === 'favorites' }" @click="view = 'favorites'">{{ t('m_60a53514eb92') }} <small>{{ favoriteCount }}</small></button>
          <button type="button" :class="{ active: view === 'recent' }" @click="view = 'recent'">{{ t('m_a686e6436452') }} <small>{{ recentFiles.length }}</small></button>
        </nav>
        <div class="wb-sql-history-search"><Search :size="15" /><input ref="searchRef" v-model="query" type="search" :placeholder="view === 'recent' ? t('m_a15dd3e4d894') : t('m_905fe566fdd6')" @keydown.enter="view === 'recent' ? null : load()" /></div>
        <div class="wb-sql-history-list">
          <article v-for="row in (view === 'recent' ? [] : filtered)" :key="row.id" class="wb-sql-history-item" :class="{ 'is-renaming': editingFavoriteId === row.id }">
            <button type="button" class="wb-sql-history-open" :aria-label="`重新打开查询：${row.sql}`" @click="emit('open-sql', row.sql)">
              <span class="wb-sql-history-meta"><b :class="`is-${row.status}`">{{ row.status === 'success' ? t('m_053461ce86d2') : t('m_28384d7afd2e') }}</b>{{ row.database || t('m_1796340673c6') }} · {{ row.durationMs }} ms · {{ row.executedAt }}</span>
              <strong v-if="row.favorite && row.name" class="wb-sql-favorite-title">{{ row.name }}</strong>
              <code>{{ row.sql }}</code>
            </button>
            <label v-if="editingFavoriteId === row.id" class="wb-sql-favorite-editor"><span>{{ t('m_71d9ea75f5c8') }}</span><input ref="renameInputRef" v-model="row.name" maxlength="80" @keydown.enter.prevent="finishRename(row)" @keydown.esc.prevent="cancelRename(row)" @blur="finishRename(row)" /></label>
            <span class="wb-sql-history-actions">
              <button type="button" :title="row.favorite ? t('m_dca60869e7d2') : t('m_60a53514eb92')" :aria-label="row.favorite ? t('m_dca60869e7d2') : t('m_60a53514eb92')" @click="toggleFavorite(row)"><StarOff v-if="row.favorite" :size="15" /><Star v-else :size="15" /></button>
              <button v-if="row.favorite" type="button" :title="t('m_d34e449e652f')" :aria-label="t('m_d34e449e652f')" @click="startRename(row)"><Pencil :size="14" /></button>
              <button type="button" :title="t('m_2f9daa828907')" :aria-label="t('m_2f9daa828907')" @click="remove(row)"><Trash2 :size="15" /></button>
            </span>
          </article>
          <article v-for="file in (view === 'recent' ? filteredRecentFiles : [])" :key="file.path" class="wb-sql-history-item wb-sql-recent-file">
            <button type="button" class="wb-sql-history-open" :aria-label="`打开最近文件：${file.fileName}`" @click="emit('open-file', file)">
              <span class="wb-sql-history-meta">{{ t('m_99143164a516') }} {{ file.openedAt }}</span>
              <strong class="wb-sql-favorite-title">{{ file.fileName }}</strong>
              <code>{{ file.path }}</code>
            </button>
            <span class="wb-sql-history-actions"><button type="button" :title="t('m_0249523e3886')" :aria-label="t('m_0249523e3886')" @click="emit('remove-recent', file)"><Trash2 :size="15" /></button></span>
          </article>
          <p v-if="!loading && view !== 'recent' && !filtered.length">{{ view === 'favorites' ? t('m_bf764ff9805f') : t('m_86284993c825') }}</p>
          <p v-if="view === 'recent' && !filteredRecentFiles.length">{{ t('m_902be115a3fd') }}</p>
        </div>
        <footer><button v-if="view === 'history'" type="button" @click="clearAll">{{ t('m_f6cb980bb77b') }}</button><span>{{ view === 'recent' ? t('m_a050ddb7fb19') : view === 'favorites' ? t('m_3084cce5d51f') : t('m_e3776f2f3898') }}</span></footer>
      </aside>
    </div>
  </Teleport>
</template>
