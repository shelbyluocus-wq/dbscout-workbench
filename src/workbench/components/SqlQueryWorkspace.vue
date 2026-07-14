<script setup>
import { computed, ref, watch } from "vue";
import {
  AlignLeft, BookOpen, CircleStop, Database, FileInput, FileOutput, FlaskConical,
  Play, PlayCircle, RotateCcw, Save, ShieldCheck, SplitSquareVertical,
} from "lucide-vue-next";

import { useConfirm } from "../composables/useConfirm.js";
import { useSqlQuery } from "../composables/useSqlQuery.js";
import SqlCodeEditor from "./SqlCodeEditor.vue";
import SqlHistoryDialog from "./SqlHistoryDialog.vue";
import SqlResultGrid from "./SqlResultGrid.vue";

const props = defineProps({
  tab: { type: Object, required: true },
  invokeWorkbench: { type: Function, required: true },
  schema: { type: Array, default: () => [] },
  connections: { type: Array, default: () => [] },
  databases: { type: Array, default: () => [] },
});
const emit = defineEmits(["schema-changed", "state-change"]);
const { confirm, alert } = useConfirm();
const tabRef = computed(() => props.tab);
const historyRef = ref(null);
const completionSchema = ref(props.schema || []);
let completionLoadToken = 0;
const query = useSqlQuery({
  tab: tabRef,
  invokeWorkbench: props.invokeWorkbench,
  confirm,
  alert,
  onSchemaChanged: () => emit("schema-changed", props.tab),
});
const editorRef = query.editorRef;
const resizeStart = ref(null);
const hasTransaction = computed(() => Boolean(props.tab.transactionSessionId));
const resultTabs = computed(() => props.tab.resultSets || []);

function isReadOnlyConnection(connectionId) {
  const connection = props.connections.find((item) => String(item.id) === String(connectionId));
  return Boolean(connection?.readOnly || connection?.read_only || String(connection?.kind || "").toLowerCase() === "clickhouse");
}

async function refreshCompletionSchema() {
  const token = ++completionLoadToken;
  const connectionId = props.tab.connectionId;
  const database = props.tab.database;
  if (!connectionId || !database) {
    completionSchema.value = [];
    return;
  }
  try {
    const tables = await props.invokeWorkbench("list_tables", { connectionId, database });
    if (token !== completionLoadToken) return;
    const placeholders = (Array.isArray(tables) ? tables : []).map((table) => ({ ...table, columns: [] }));
    completionSchema.value = placeholders;
    const tableNames = placeholders
      .map((table) => table.table_name || table.tableName || table.name)
      .filter(Boolean)
      .slice(0, 100);
    if (!tableNames.length) return;
    const schemas = await props.invokeWorkbench("get_table_schemas", {
      connectionId,
      database,
      tableNames,
      force: false,
    });
    if (token === completionLoadToken && Array.isArray(schemas)) completionSchema.value = schemas;
  } catch {
    if (token === completionLoadToken && !completionSchema.value.length) completionSchema.value = props.schema || [];
  }
}

watch(
  () => [props.tab.connectionId, props.tab.database, props.tab.schemaChangedAt],
  refreshCompletionSchema,
  { immediate: true },
);

watch(
  () => props.tab.resultSets?.find((result) => result.status === "failed"),
  (result) => {
    if (!result) return;
    const statementStart = props.tab.sql.indexOf(result.sql || "");
    editorRef.value?.revealOffset(Math.max(0, statementStart) + (Number(result.errorOffset) || 0));
  },
);

async function changeConnection(event) {
  props.tab.connectionId = event.target.value;
  props.tab.readOnly = isReadOnlyConnection(props.tab.connectionId);
  props.tab.database = "";
  try {
    const databases = await props.invokeWorkbench("list_databases", { connectionId: props.tab.connectionId });
    props.tab.availableDatabases = databases;
    props.tab.database = databases[0] || "";
  } catch { props.tab.availableDatabases = []; }
  emit("state-change");
}
function changeDatabase(event) {
  props.tab.database = event.target.value;
  emit("state-change");
}
function startResize(event) {
  const root = event.currentTarget.closest(".wb-sql-workspace");
  if (!root) return;
  resizeStart.value = { y: event.clientY, ratio: props.tab.editorRatio, height: root.clientHeight };
  const move = (moveEvent) => {
    const next = resizeStart.value.ratio + (moveEvent.clientY - resizeStart.value.y) / Math.max(1, resizeStart.value.height);
    setEditorRatio(next);
  };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
function setEditorRatio(next) {
  props.tab.editorRatio = Math.max(0.25, Math.min(0.8, Number(next) || 0.55));
  emit("state-change");
}
function resizeWithKeyboard(delta) {
  setEditorRatio(props.tab.editorRatio + delta);
}
function reopenHistory(sql) {
  query.updateSql(sql);
  query.historyOpen.value = false;
  query.editorRef.value?.focus();
}
function reopenRecentFile(file) {
  query.historyOpen.value = false;
  void query.openRecentFile(file);
}
</script>

<template>
  <section class="wb-sql-workspace">
    <header class="wb-sql-toolbar">
      <label title="查询连接"><Database :size="15" /><select :value="tab.connectionId" :disabled="tab.running || hasTransaction" @change="changeConnection"><option v-for="connection in connections" :key="connection.id" :value="connection.id">{{ connection.label }}</option></select></label>
      <label title="查询数据库"><select :value="tab.database" :disabled="tab.running || hasTransaction" @change="changeDatabase"><option v-for="database in (tab.availableDatabases || databases)" :key="database" :value="database">{{ database }}</option></select></label>
      <span class="wb-sql-toolbar-separator"></span>
      <button type="button" class="is-primary" title="执行选中内容或当前语句 (Ctrl+Enter)" :disabled="tab.running" @click="query.execute(editorRef?.executionContext(false))"><Play :size="15" /><span>执行</span></button>
      <button type="button" title="按顺序执行全部语句 (F5)" :disabled="tab.running" @click="query.execute(editorRef?.executionContext(true))"><PlayCircle :size="15" /><span>全部</span></button>
      <button type="button" class="is-danger" title="停止查询 (Esc)" :disabled="!tab.running" @click="query.cancel"><CircleStop :size="15" /></button>
      <button type="button" title="查看执行计划" :disabled="tab.running" @click="query.execute({ ...editorRef?.executionContext(false), explain: true })"><FlaskConical :size="15" /><span>EXPLAIN</span></button>
      <button type="button" title="格式化 SQL" @click="query.formatDocument"><AlignLeft :size="15" /></button>
      <span class="wb-sql-toolbar-separator"></span>
      <label class="wb-sql-switch" title="关闭自动提交后，本标签使用专用事务连接"><input v-model="tab.autoCommit" type="checkbox" :disabled="hasTransaction" /><span></span>自动提交</label>
      <button type="button" title="提交事务" :disabled="!hasTransaction" @click="query.commit"><ShieldCheck :size="15" /><span>提交</span></button>
      <button type="button" title="回滚事务" :disabled="!hasTransaction" @click="query.rollback"><RotateCcw :size="15" /><span>回滚</span></button>
      <span class="wb-sql-toolbar-spacer"></span>
      <label title="结果行数上限"><span>上限</span><select v-model.number="tab.limit"><option v-for="limit in query.LIMIT_OPTIONS" :key="limit" :value="limit">{{ limit }}</option></select></label>
      <button type="button" title="打开 SQL 文件" :disabled="tab.running" @click="query.openFile"><FileInput :size="15" /></button>
      <button type="button" title="保存 SQL 文件 (Ctrl+S)" @click="query.saveFile()"><Save :size="15" /></button>
      <button type="button" title="另存为" @click="query.saveFile({ saveAs: true })"><FileOutput :size="15" /></button>
      <button type="button" title="查询历史" @click="query.refreshRecentFiles(); query.historyOpen.value = true; historyRef?.load()"><BookOpen :size="15" /></button>
    </header>
    <div class="wb-sql-filebar">
      <span :class="{ 'is-dirty': tab.dirty }">{{ tab.dirty ? '未保存' : '已保存' }}</span>
      <code>{{ tab.filePath || `${tab.connectionId || '未选择连接'} / ${tab.database || '未选择数据库'}` }}</code>
      <b v-if="hasTransaction">事务进行中</b>
      <b v-if="tab.running" class="is-running">正在执行</b>
    </div>
    <div class="wb-sql-editor-pane" :style="{ flexBasis: `${tab.editorRatio * 100}%` }">
      <SqlCodeEditor ref="editorRef" :model-value="tab.sql" :schema="completionSchema" :databases="tab.availableDatabases || databases" @update:model-value="query.updateSql" @execute="query.execute" @save="query.saveFile()" @stop="query.cancel" />
    </div>
    <div class="wb-sql-resize" role="separator" tabindex="0" aria-label="调整编辑器和结果区高度" aria-orientation="horizontal" aria-valuemin="25" aria-valuemax="80" :aria-valuenow="Math.round(tab.editorRatio * 100)" @pointerdown.prevent="startResize" @keydown.up.prevent="resizeWithKeyboard(-0.05)" @keydown.down.prevent="resizeWithKeyboard(0.05)"><SplitSquareVertical :size="14" /></div>
    <section class="wb-sql-output">
      <nav class="wb-sql-output-tabs">
        <button type="button" :class="{ active: tab.resultView === 'results' }" @click="tab.resultView = 'results'">结果集 <small>{{ resultTabs.length }}</small></button>
        <button type="button" :class="{ active: tab.resultView === 'messages' }" @click="tab.resultView = 'messages'">消息 <small>{{ tab.messages.length }}</small></button>
        <button type="button" :class="{ active: tab.resultView === 'plan' }" :disabled="!tab.executionPlan" @click="tab.resultView = 'plan'">执行计划</button>
        <span v-if="tab.resultView === 'results' && resultTabs.length > 1" class="wb-sql-result-set-tabs"><button v-for="(result, index) in resultTabs" :key="result.statementIndex" type="button" :class="{ active: tab.activeResultIndex === index }" @click="tab.activeResultIndex = index">结果 {{ index + 1 }}</button></span>
      </nav>
      <SqlResultGrid v-if="tab.resultView === 'results' && query.currentResult.value?.columns?.length" :result="query.currentResult.value" :invoke-workbench="invokeWorkbench" />
      <div v-else-if="tab.resultView === 'messages'" class="wb-sql-messages"><p v-for="(message, index) in tab.messages" :key="index" :class="`is-${message.type}`"><time>{{ message.durationMs ? `${message.durationMs} ms` : '' }}</time>{{ message.text }}</p><p v-if="!tab.messages.length">执行消息会显示在这里</p></div>
      <pre v-else-if="tab.resultView === 'plan'" class="wb-sql-plan">{{ typeof tab.executionPlan === 'string' ? tab.executionPlan : JSON.stringify(tab.executionPlan, null, 2) }}</pre>
      <div v-else class="wb-sql-output-empty">执行查询后，结果会显示在这里</div>
      <footer v-if="query.currentResult.value" class="wb-sql-result-status"><span>{{ query.currentResult.value.status === 'failed' ? query.currentResult.value.error : `${query.currentResult.value.rowCount} 行 · ${query.currentResult.value.durationMs} ms` }}</span><b v-if="query.currentResult.value.truncated">结果已截断（上限 {{ tab.limit }} 行）</b></footer>
    </section>
    <SqlHistoryDialog ref="historyRef" :open="query.historyOpen.value" :invoke-workbench="invokeWorkbench" :connection-id="tab.connectionId" :recent-files="query.recentFiles.value" @close="query.historyOpen.value = false" @open-sql="reopenHistory" @open-file="reopenRecentFile" @remove-recent="query.removeRecentFile" />
  </section>
</template>
