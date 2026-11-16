<script setup>
import { language, t } from "../i18n/index.js";
import { computed, nextTick, onMounted, ref } from "vue";
import {
  ArrowRight,
  BookOpen,
  Copy,
  FileCode2,
  FileInput,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-vue-next";

import { forgetRecentSqlFile, loadRecentSqlFiles } from "../utils/sqlRecentFiles.js";
import SqlHistoryDialog from "./SqlHistoryDialog.vue";

const props = defineProps({
  documents: { type: Array, default: () => [] },
  tabs: { type: Array, default: () => [] },
  connections: { type: Array, default: () => [] },
  connectionId: { type: String, default: "" },
  invokeWorkbench: { type: Function, required: true },
});

const emit = defineEmits([
  "new-query",
  "open-query",
  "duplicate-query",
  "rename-query",
  "delete-query",
  "open-file",
]);

const query = ref("");
const connectionFilter = ref("");
const editingId = ref("");
const renameDraft = ref("");
const renameInputRef = ref(null);
const historyOpen = ref(false);
const historyRef = ref(null);
const recentFiles = ref([]);
// Over a wallpaper the section headings stay clear until rows scroll beneath them.
const listScrolled = ref(false);

const openTabsByDocument = computed(() => {
  const entries = props.tabs
    .filter((tab) => tab?.kind === "sql" && tab.documentId)
    .map((tab) => [tab.documentId, tab]);
  return new Map(entries);
});

const connectionOptions = computed(() => {
  const ids = [...new Set(props.documents.map((document) => document.connectionId).filter(Boolean))];
  return ids.map((id) => ({ id, label: connectionLabel(id) }));
});

const filteredDocuments = computed(() => {
  const text = query.value.trim().toLocaleLowerCase();
  return props.documents.filter((document) => {
    if (connectionFilter.value && document.connectionId !== connectionFilter.value) return false;
    if (!text) return true;
    return [
      document.title,
      document.sql,
      document.fileName,
      document.filePath,
      document.database,
      connectionLabel(document.connectionId),
    ].some((value) => String(value || "").toLocaleLowerCase().includes(text));
  });
});

const filteredRecentFiles = computed(() => {
  const text = query.value.trim().toLocaleLowerCase();
  if (!text) return recentFiles.value;
  return recentFiles.value.filter((file) => `${file.fileName} ${file.path}`.toLocaleLowerCase().includes(text));
});

function connectionLabel(connectionId) {
  if (!connectionId) return "未选择连接";
  const connection = props.connections.find((item) => String(item.id) === String(connectionId));
  return String(connection?.alias || connection?.label || connection?.name || connectionId);
}

function sourceLabel(document) {
  const connection = connectionLabel(document.connectionId);
  return document.database ? `${connection} / ${document.database}` : connection;
}

function sqlPreview(document) {
  return String(document.sql || "").replace(/\s+/g, " ").trim() || "尚未输入 SQL";
}

function documentStatus(document) {
  const tab = openTabsByDocument.value.get(document.id);
  if (tab?.running) return { key: "running", label: "运行中" };
  if (tab?.transactionSessionId) return { key: "transaction", label: "事务中" };
  if (document.filePath && document.dirty) return { key: "dirty", label: "未保存" };
  if (document.filePath) return { key: "saved", label: "已保存" };
  return { key: "draft", label: "草稿" };
}

function updatedLabel(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return "刚刚";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)} 分钟前`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)} 小时前`;
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)} 天前`;
  return new Intl.DateTimeFormat(language.intlLocale.value, { month: "2-digit", day: "2-digit" }).format(timestamp);
}

function startRename(document) {
  editingId.value = document.id;
  renameDraft.value = document.title;
  void nextTick(() => {
    const input = Array.isArray(renameInputRef.value) ? renameInputRef.value[0] : renameInputRef.value;
    input?.focus();
    input?.select();
  });
}

function finishRename(document) {
  if (editingId.value !== document.id) return;
  const title = renameDraft.value.trim();
  editingId.value = "";
  renameDraft.value = "";
  if (title && title !== document.title) emit("rename-query", { documentId: document.id, title });
}

function cancelRename() {
  editingId.value = "";
  renameDraft.value = "";
}

function openHistory() {
  recentFiles.value = loadRecentSqlFiles();
  historyOpen.value = true;
  void nextTick(() => historyRef.value?.load?.());
}

function openHistorySql(sql) {
  historyOpen.value = false;
  emit("new-query", { sql: String(sql || "") });
}

function openRecentFile(file) {
  historyOpen.value = false;
  emit("open-file", { path: file?.path || "" });
}

function removeRecentFile(file) {
  recentFiles.value = forgetRecentSqlFile(file?.path);
}

onMounted(() => {
  recentFiles.value = loadRecentSqlFiles();
});
</script>

<template>
  <section class="wb-sql-library">
    <header class="wb-sql-library-header">
      <div>
        <h2>{{ t('m_6369c8800ff1') }}</h2>
        <p>{{ documents.length }} {{ t('m_17f2688f41dd') }}</p>
      </div>
      <div class="wb-sql-library-header-actions">
        <button type="button" :title="t('m_fa8c496e0eb5')" @click="emit('open-file', { path: '' })">
          <FileInput :size="15" />
          <span>{{ t('m_4c8a4e3da39e') }}</span>
        </button>
        <button type="button" class="is-primary" @click="emit('new-query', {})">
          <Plus :size="15" />
          <span>{{ t('m_342c248eb6b7') }}</span>
        </button>
      </div>
    </header>

    <div class="wb-sql-library-toolbar">
      <label class="wb-sql-library-search">
        <Search :size="15" aria-hidden="true" />
        <input v-model="query" type="search" :placeholder="t('m_38059436f49a')" />
        <button v-if="query" type="button" :title="t('m_b6f00afa6537')" :aria-label="t('m_b6f00afa6537')" @click="query = ''"><X :size="14" /></button>
      </label>
      <label class="wb-sql-library-filter">
        <span>{{ t('m_a5574109f020') }}</span>
        <select v-model="connectionFilter">
          <option value="">{{ t('m_dbb2c7b44300') }}</option>
          <option v-for="option in connectionOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
        </select>
      </label>
      <button type="button" class="wb-sql-library-history-button" @click="openHistory">
        <BookOpen :size="15" />
        <span>{{ t('m_e74d81c0d444') }}</span>
      </button>
    </div>

    <div class="wb-sql-library-scroll" :class="{ 'is-scrolled': listScrolled }" @scroll.passive="listScrolled = $event.target.scrollTop > 0">
      <section class="wb-sql-library-section" aria-labelledby="sql-document-heading">
        <div class="wb-sql-library-section-heading">
          <h3 id="sql-document-heading">{{ t('m_815a013f4853') }}</h3>
          <span>{{ filteredDocuments.length }}</span>
        </div>

        <div v-if="filteredDocuments.length" class="wb-sql-library-list">
          <article
            v-for="document in filteredDocuments"
            :key="document.id"
            class="wb-sql-library-row"
            :class="{ 'is-open': openTabsByDocument.has(document.id) }"
          >
            <div class="wb-sql-library-open">
              <FileCode2 :size="16" aria-hidden="true" />
              <button
                v-if="editingId !== document.id"
                type="button"
                class="wb-sql-library-document-main"
                @click="emit('open-query', { documentId: document.id })"
              >
                <span class="wb-sql-library-document-title">
                  <strong>{{ document.title }}</strong>
                  <small :class="`is-${documentStatus(document).key}`">{{ documentStatus(document).label }}</small>
                </span>
                <code>{{ sqlPreview(document) }}</code>
              </button>
              <div v-else class="wb-sql-library-document-main is-editing">
                <span class="wb-sql-library-document-title">
                  <input
                    ref="renameInputRef"
                    v-model="renameDraft"
                    maxlength="120"
                    :aria-label="t('m_4f4017307cfc')"
                    @keydown.enter.prevent.stop="finishRename(document)"
                    @keydown.esc.prevent.stop="cancelRename"
                    @blur="finishRename(document)"
                  />
                  <small :class="`is-${documentStatus(document).key}`">{{ documentStatus(document).label }}</small>
                </span>
                <code>{{ sqlPreview(document) }}</code>
              </div>
              <span class="wb-sql-library-document-source">
                <span>{{ sourceLabel(document) }}</span>
                <small>{{ updatedLabel(document.updatedAt) }}</small>
              </span>
            </div>
            <div class="wb-sql-library-row-actions">
              <button type="button" :title="t('m_0d0cbac2eee5')" :aria-label="t('m_b82664404744')" @click="startRename(document)"><Pencil :size="14" /></button>
              <button type="button" :title="t('m_67f297ef42b8')" :aria-label="t('m_67f297ef42b8')" @click="emit('duplicate-query', { documentId: document.id })"><Copy :size="14" /></button>
              <button type="button" class="is-danger" :title="t('m_1b755b369241')" :aria-label="t('m_1b755b369241')" @click="emit('delete-query', { documentId: document.id })"><Trash2 :size="14" /></button>
              <button type="button" :title="t('m_3ad1a90f4275')" :aria-label="t('m_3ad1a90f4275')" @click="emit('open-query', { documentId: document.id })"><ArrowRight :size="15" /></button>
            </div>
          </article>
        </div>

        <div v-else class="wb-sql-library-empty">
          <FileCode2 :size="24" aria-hidden="true" />
          <p>{{ query || connectionFilter ? t('m_c526e3c5207b') : t('m_efe148ec41c6') }}</p>
          <button v-if="!query && !connectionFilter" type="button" @click="emit('new-query', {})"><Plus :size="15" />{{ t('m_342c248eb6b7') }}</button>
        </div>
      </section>

      <section v-if="filteredRecentFiles.length" class="wb-sql-library-section is-recent" aria-labelledby="sql-recent-heading">
        <div class="wb-sql-library-section-heading">
          <h3 id="sql-recent-heading">{{ t('m_a686e6436452') }}</h3>
          <span>{{ filteredRecentFiles.length }}</span>
        </div>
        <div class="wb-sql-library-recent-list">
          <article v-for="file in filteredRecentFiles" :key="file.path" class="wb-sql-library-recent-row">
            <button type="button" @click="emit('open-file', { path: file.path })">
              <FileCode2 :size="15" aria-hidden="true" />
              <span><strong>{{ file.fileName }}</strong><code>{{ file.path }}</code></span>
              <small>{{ updatedLabel(file.openedAt) }}</small>
            </button>
            <button type="button" :title="t('m_0249523e3886')" :aria-label="t('m_0249523e3886')" @click="removeRecentFile(file)"><X :size="14" /></button>
          </article>
        </div>
      </section>
    </div>

    <SqlHistoryDialog
      ref="historyRef"
      :open="historyOpen"
      :invoke-workbench="invokeWorkbench"
      :connection-id="connectionId"
      :recent-files="recentFiles"
      @close="historyOpen = false"
      @open-sql="openHistorySql"
      @open-file="openRecentFile"
      @remove-recent="removeRecentFile"
    />
  </section>
</template>
