<script setup>
import { t } from "../i18n/index.js";
import { nextTick, computed, ref, watch } from "vue";
import {
  AlignLeft, BookOpen, CircleStop, Database, FileInput, FileOutput, FlaskConical,
  Play, PlayCircle, RotateCcw, Save, ShieldCheck, SplitSquareVertical,
} from "lucide-vue-next";

import { useConfirm } from "../composables/useConfirm.js";
import { resolveSqlRun } from "../utils/sqlRunRequests.js";
import { useSqlQuery } from "../composables/useSqlQuery.js";
import { sqlResultPane, sqlResultStatusText } from "../sqlExecutionState.js";
import { connectionHasCapability } from "../utils/connectionKinds.js";
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

// External-UI run requests: consume the one-shot marker, execute, report back.
watch(
  () => props.tab?.agentRunRequest,
  async (request) => {
    if (!request?.id || props.tab.agentRunRequest?.id !== request.id) return;
    props.tab.agentRunRequest = null;
    await nextTick();
    try {
      const result = await query.execute(editorRef.value?.executionContext?.(false));
      resolveSqlRun(request.id, {
        status: "ok",
        rowCount: Number(result?.rowCount ?? result?.rows?.length ?? props.tab.resultSets?.[0]?.rowCount ?? 0),
      });
    } catch (error) {
      resolveSqlRun(request.id, { status: "error", error: String(error?.message || error || "SQL 执行失败") });
    }
  },
  { immediate: true },
);
const resizeStart = ref(null);
const hasTransaction = computed(() => Boolean(props.tab.transactionSessionId));
const resultTabs = computed(() => props.tab.resultSets || []);
const resultPane = computed(() => sqlResultPane(props.tab, query.currentResult.value));

function isReadOnlyConnection(connectionId) {
  const connection = props.connections.find((item) => String(item.id) === String(connectionId));
  return Boolean(
    connection?.readOnly ||
      connection?.read_only ||
      !connectionHasCapability(connection?.kind, "sqlConsole"),
  );
}

const sqlConnections = computed(() =>
  props.connections.filter((item) => connectionHasCapability(item?.kind, "sqlConsole")),
);

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
    if (token === completionLoadToken && Array.isArray(schemas)) {
      const byTable = new Map(schemas.map((table) => [
        String(table.table_name || table.tableName || table.name || "").toLocaleLowerCase(),
        table,
      ]));
      completionSchema.value = placeholders.map((table) => (
        byTable.get(String(table.table_name || table.tableName || table.name || "").toLocaleLowerCase()) || table
      ));
    }
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
      <label :title="t('m_1eb6f41a1e8a')"><Database :size="15" /><select :value="tab.connectionId" :disabled="tab.running || hasTransaction" @change="changeConnection"><option v-for="connection in sqlConnections" :key="connection.id" :value="connection.id">{{ connection.label }}</option></select></label>
      <label :title="t('m_4f49c152713b')"><select :value="tab.database" :disabled="tab.running || hasTransaction" @change="changeDatabase"><option v-for="database in (tab.availableDatabases || databases)" :key="database" :value="database">{{ database }}</option></select></label>
      <span class="wb-sql-toolbar-separator"></span>
      <button type="button" class="is-primary" :title="t('m_18bddd92954e')" :disabled="tab.running" @click="query.execute(editorRef?.executionContext(false))"><Play :size="15" /><span>{{ t('m_32c8d373afe0') }}</span></button>
      <button type="button" :title="t('m_2e834327f396')" :disabled="tab.running" @click="query.execute(editorRef?.executionContext(true))"><PlayCircle :size="15" /><span>{{ t('m_5c55a67935af') }}</span></button>
      <button type="button" class="is-danger" :title="t('m_de0da8431fcf')" :disabled="!tab.running" @click="query.cancel"><CircleStop :size="15" /></button>
      <button type="button" :title="t('m_a4b617faa8fa')" :disabled="tab.running" @click="query.execute({ ...editorRef?.executionContext(false), explain: true })"><FlaskConical :size="15" /><span>EXPLAIN</span></button>
      <button type="button" :title="t('m_3e5d6050dde1')" @click="query.formatDocument"><AlignLeft :size="15" /></button>
      <span class="wb-sql-toolbar-separator"></span>
      <label class="wb-sql-switch" :title="t('m_057034189d69')"><input v-model="tab.autoCommit" type="checkbox" :disabled="hasTransaction" /><span></span>{{ t('m_86c46618a6a2') }}</label>
      <button type="button" :title="t('m_519efb833eec')" :disabled="!hasTransaction" @click="query.commit"><ShieldCheck :size="15" /><span>{{ t('m_08a85f4ab4ba') }}</span></button>
      <button type="button" :title="t('m_90689a0b356a')" :disabled="!hasTransaction" @click="query.rollback"><RotateCcw :size="15" /><span>{{ t('m_6518e21a8e5f') }}</span></button>
      <span class="wb-sql-toolbar-spacer"></span>
      <label :title="t('m_803caaca93cc')"><span>{{ t('m_8e7ddbeee310') }}</span><select v-model.number="tab.limit"><option v-for="limit in query.LIMIT_OPTIONS" :key="limit" :value="limit">{{ limit }}</option></select></label>
      <button type="button" :title="t('m_fa8c496e0eb5')" :disabled="tab.running" @click="query.openFile"><FileInput :size="15" /></button>
      <button type="button" :title="t('m_3e5730509acc')" @click="query.saveFile()"><Save :size="15" /></button>
      <button type="button" :title="t('m_1232eb44296b')" @click="query.saveFile({ saveAs: true })"><FileOutput :size="15" /></button>
      <button type="button" :title="t('m_e74d81c0d444')" @click="query.refreshRecentFiles(); query.historyOpen.value = true; historyRef?.load()"><BookOpen :size="15" /></button>
    </header>
    <div class="wb-sql-filebar">
      <span :class="{ 'is-dirty': tab.dirty }">{{ tab.dirty ? t('m_6a1be012c99c') : t('m_1bd91a7d0c53') }}</span>
      <code>{{ tab.filePath || `${tab.connectionId || t('m_6ad3c3fd5540')} / ${tab.database || t('m_28410cb597bc')}` }}</code>
      <b v-if="hasTransaction">{{ t('m_73e93e6e6b66') }}</b>
      <b v-if="tab.running" class="is-running">{{ t('m_8f38fd93b5a0') }}</b>
    </div>
    <div class="wb-sql-editor-pane" :style="{ flexBasis: `${tab.editorRatio * 100}%` }">
      <SqlCodeEditor ref="editorRef" :model-value="tab.sql" :schema="completionSchema" :database="tab.database" :databases="tab.availableDatabases || databases" @update:model-value="query.updateSql" @execute="query.execute" @save="query.saveFile()" @stop="query.cancel" />
    </div>
    <div class="wb-sql-resize" role="separator" tabindex="0" :aria-label="t('m_09d0f3fe4f13')" aria-orientation="horizontal" aria-valuemin="25" aria-valuemax="80" :aria-valuenow="Math.round(tab.editorRatio * 100)" @pointerdown.prevent="startResize" @keydown.up.prevent="resizeWithKeyboard(-0.05)" @keydown.down.prevent="resizeWithKeyboard(0.05)"><SplitSquareVertical :size="14" /></div>
    <section class="wb-sql-output">
      <nav class="wb-sql-output-tabs">
        <button type="button" :class="{ active: tab.resultView === 'results' }" @click="tab.resultView = 'results'">{{ t('m_10bc92e64134') }} <small>{{ resultTabs.length }}</small></button>
        <button type="button" :class="{ active: tab.resultView === 'messages' }" @click="tab.resultView = 'messages'">{{ t('m_4da199fae933') }} <small>{{ tab.messages.length }}</small></button>
        <button type="button" :class="{ active: tab.resultView === 'plan' }" :disabled="!tab.executionPlan" @click="tab.resultView = 'plan'">{{ t('m_2619ddf6f550') }}</button>
        <span v-if="tab.resultView === 'results' && resultTabs.length > 1" class="wb-sql-result-set-tabs"><button v-for="(result, index) in resultTabs" :key="result.statementIndex" type="button" :class="{ active: tab.activeResultIndex === index }" @click="tab.activeResultIndex = index">{{ t('m_bb7ef73495dd') }} {{ index + 1 }}</button></span>
      </nav>
      <SqlResultGrid v-if="resultPane === 'grid'" :result="query.currentResult.value" :invoke-workbench="invokeWorkbench" />
      <div v-else-if="resultPane === 'messages'" class="wb-sql-messages"><p v-for="(message, index) in tab.messages" :key="index" :class="`is-${message.type}`"><time>{{ message.durationMs ? `${message.durationMs} ms` : '' }}</time>{{ message.text }}</p><p v-if="!tab.messages.length">{{ t('m_64fbe1d11eea') }}</p></div>
      <pre v-else-if="resultPane === 'plan'" class="wb-sql-plan">{{ typeof tab.executionPlan === 'string' ? tab.executionPlan : JSON.stringify(tab.executionPlan, null, 2) }}</pre>
      <div v-else-if="resultPane === 'summary'" class="wb-sql-result-summary" :class="{ 'is-failed': query.currentResult.value?.status === 'failed' }"><strong>{{ sqlResultStatusText(query.currentResult.value) }}</strong><code v-if="query.currentResult.value?.sql">{{ query.currentResult.value.sql }}</code></div>
      <div v-else class="wb-sql-output-empty">{{ t('m_083c76d3309e') }}</div>
      <footer v-if="query.currentResult.value" class="wb-sql-result-status"><span>{{ sqlResultStatusText(query.currentResult.value) }}</span><b v-if="query.currentResult.value.truncated">{{ t('m_b3a1e0e714f8') }} {{ tab.limit }} {{ t('m_39aac487d527') }}</b></footer>
    </section>
    <SqlHistoryDialog ref="historyRef" :open="query.historyOpen.value" :invoke-workbench="invokeWorkbench" :connection-id="tab.connectionId" :recent-files="query.recentFiles.value" @close="query.historyOpen.value = false" @open-sql="reopenHistory" @open-file="reopenRecentFile" @remove-recent="query.removeRecentFile" />
  </section>
</template>
