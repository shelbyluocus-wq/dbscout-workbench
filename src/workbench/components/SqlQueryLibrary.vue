<script setup>
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
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(timestamp);
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
        <h2>SQL 查询</h2>
        <p>{{ documents.length }} 个查询文档</p>
      </div>
      <div class="wb-sql-library-header-actions">
        <button type="button" title="打开 SQL 文件" @click="emit('open-file', { path: '' })">
          <FileInput :size="15" />
          <span>打开文件</span>
        </button>
        <button type="button" class="is-primary" @click="emit('new-query', {})">
          <Plus :size="15" />
          <span>新建查询</span>
        </button>
      </div>
    </header>

    <div class="wb-sql-library-toolbar">
      <label class="wb-sql-library-search">
        <Search :size="15" aria-hidden="true" />
        <input v-model="query" type="search" placeholder="搜索查询名称或 SQL" />
        <button v-if="query" type="button" title="清空搜索" aria-label="清空搜索" @click="query = ''"><X :size="14" /></button>
      </label>
      <label class="wb-sql-library-filter">
        <span>连接</span>
        <select v-model="connectionFilter">
          <option value="">全部连接</option>
          <option v-for="option in connectionOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
        </select>
      </label>
      <button type="button" class="wb-sql-library-history-button" @click="openHistory">
        <BookOpen :size="15" />
        <span>查询历史</span>
      </button>
    </div>

    <div class="wb-sql-library-scroll">
      <section class="wb-sql-library-section" aria-labelledby="sql-document-heading">
        <div class="wb-sql-library-section-heading">
          <h3 id="sql-document-heading">查询文档</h3>
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
                    aria-label="查询名称"
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
              <button type="button" title="重命名" aria-label="重命名查询" @click="startRename(document)"><Pencil :size="14" /></button>
              <button type="button" title="复制查询" aria-label="复制查询" @click="emit('duplicate-query', { documentId: document.id })"><Copy :size="14" /></button>
              <button type="button" class="is-danger" title="删除查询" aria-label="删除查询" @click="emit('delete-query', { documentId: document.id })"><Trash2 :size="14" /></button>
              <button type="button" title="打开查询" aria-label="打开查询" @click="emit('open-query', { documentId: document.id })"><ArrowRight :size="15" /></button>
            </div>
          </article>
        </div>

        <div v-else class="wb-sql-library-empty">
          <FileCode2 :size="24" aria-hidden="true" />
          <p>{{ query || connectionFilter ? '没有匹配的查询文档' : '暂无查询文档' }}</p>
          <button v-if="!query && !connectionFilter" type="button" @click="emit('new-query', {})"><Plus :size="15" />新建查询</button>
        </div>
      </section>

      <section v-if="filteredRecentFiles.length" class="wb-sql-library-section is-recent" aria-labelledby="sql-recent-heading">
        <div class="wb-sql-library-section-heading">
          <h3 id="sql-recent-heading">最近文件</h3>
          <span>{{ filteredRecentFiles.length }}</span>
        </div>
        <div class="wb-sql-library-recent-list">
          <article v-for="file in filteredRecentFiles" :key="file.path" class="wb-sql-library-recent-row">
            <button type="button" @click="emit('open-file', { path: file.path })">
              <FileCode2 :size="15" aria-hidden="true" />
              <span><strong>{{ file.fileName }}</strong><code>{{ file.path }}</code></span>
              <small>{{ updatedLabel(file.openedAt) }}</small>
            </button>
            <button type="button" title="从最近文件移除" aria-label="从最近文件移除" @click="removeRecentFile(file)"><X :size="14" /></button>
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
