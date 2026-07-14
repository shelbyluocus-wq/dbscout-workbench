<script setup>
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
useEscClose(() => props.open, () => emit("close"));
watch(() => props.open, (open) => {
  if (open) void nextTick(() => searchRef.value?.focus());
});
watch(view, () => { editingFavoriteId.value = null; });
defineExpose({ load });
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="wb-sql-history-overlay wb-floating-themed" @click.self="emit('close')">
      <aside class="wb-sql-history" role="dialog" aria-modal="true" aria-label="SQL 查询历史">
        <header><strong>查询历史</strong><button type="button" title="关闭" @click="emit('close')"><X :size="17" /></button></header>
        <nav class="wb-sql-history-views" aria-label="查询资料类型">
          <button type="button" :class="{ active: view === 'history' }" @click="view = 'history'">历史 <small>{{ rows.length }}</small></button>
          <button type="button" :class="{ active: view === 'favorites' }" @click="view = 'favorites'">收藏 <small>{{ favoriteCount }}</small></button>
          <button type="button" :class="{ active: view === 'recent' }" @click="view = 'recent'">最近文件 <small>{{ recentFiles.length }}</small></button>
        </nav>
        <div class="wb-sql-history-search"><Search :size="15" /><input ref="searchRef" v-model="query" type="search" :placeholder="view === 'recent' ? '搜索文件名或路径' : '搜索名称、SQL 或数据库'" @keydown.enter="view === 'recent' ? null : load()" /></div>
        <div class="wb-sql-history-list">
          <article v-for="row in (view === 'recent' ? [] : filtered)" :key="row.id" class="wb-sql-history-item" :class="{ 'is-renaming': editingFavoriteId === row.id }">
            <button type="button" class="wb-sql-history-open" :aria-label="`重新打开查询：${row.sql}`" @click="emit('open-sql', row.sql)">
              <span class="wb-sql-history-meta"><b :class="`is-${row.status}`">{{ row.status === 'success' ? '成功' : '失败' }}</b>{{ row.database || '默认库' }} · {{ row.durationMs }} ms · {{ row.executedAt }}</span>
              <strong v-if="row.favorite && row.name" class="wb-sql-favorite-title">{{ row.name }}</strong>
              <code>{{ row.sql }}</code>
            </button>
            <label v-if="editingFavoriteId === row.id" class="wb-sql-favorite-editor"><span>收藏名称</span><input ref="renameInputRef" v-model="row.name" maxlength="80" @keydown.enter.prevent="finishRename(row)" @keydown.esc.prevent="cancelRename(row)" @blur="finishRename(row)" /></label>
            <span class="wb-sql-history-actions">
              <button type="button" :title="row.favorite ? '取消收藏' : '收藏'" :aria-label="row.favorite ? '取消收藏' : '收藏'" @click="toggleFavorite(row)"><StarOff v-if="row.favorite" :size="15" /><Star v-else :size="15" /></button>
              <button v-if="row.favorite" type="button" title="重命名收藏" aria-label="重命名收藏" @click="startRename(row)"><Pencil :size="14" /></button>
              <button type="button" title="删除" aria-label="删除" @click="remove(row)"><Trash2 :size="15" /></button>
            </span>
          </article>
          <article v-for="file in (view === 'recent' ? filteredRecentFiles : [])" :key="file.path" class="wb-sql-history-item wb-sql-recent-file">
            <button type="button" class="wb-sql-history-open" :aria-label="`打开最近文件：${file.fileName}`" @click="emit('open-file', file)">
              <span class="wb-sql-history-meta">最近打开 · {{ file.openedAt }}</span>
              <strong class="wb-sql-favorite-title">{{ file.fileName }}</strong>
              <code>{{ file.path }}</code>
            </button>
            <span class="wb-sql-history-actions"><button type="button" title="从最近文件移除" aria-label="从最近文件移除" @click="emit('remove-recent', file)"><Trash2 :size="15" /></button></span>
          </article>
          <p v-if="!loading && view !== 'recent' && !filtered.length">{{ view === 'favorites' ? '暂无收藏查询' : '暂无查询历史' }}</p>
          <p v-if="view === 'recent' && !filteredRecentFiles.length">暂无最近文件</p>
        </div>
        <footer><button v-if="view === 'history'" type="button" @click="clearAll">清空普通历史</button><span>{{ view === 'recent' ? '单击文件重新打开' : view === 'favorites' ? '收藏项不会自动清理' : '单击记录重新打开' }}</span></footer>
      </aside>
    </div>
  </Teleport>
</template>
