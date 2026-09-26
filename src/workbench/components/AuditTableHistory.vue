<script setup>
import { computed, ref, watch, nextTick } from "vue";
import { auditChangeItems } from "../utils/auditDisplay.js";
import { auditTableKey } from "../composables/useAuditHistory.js";
const props = defineProps({ history: { type: Object, required: true }, connections: { type: Array, default: () => [] } });
const s = computed(() => props.history.state);
const labels = { import: "导入表", grid: "编辑数据", rollback: "恢复数据", ddl: "修改结构", agent: "AI 操作", sql_console: "SQL 操作" };
const opLabels = { INSERT: "新增", UPDATE: "修改", DELETE: "删除", DDL: "结构变更" };
const stamp = (value) => new Date(value).toLocaleString("zh-CN", { hour12: false });
const connectionLabel = (row) => props.connections.find((c) => c.id === row.connectionId)?.label || row.connectionId;
const title = (operation) => operation.legacy ? "历史记录" : labels[operation.source] || "修改数据";
const previewElement = ref(null);
watch(() => s.value.preview, async (value) => {
  if (!value) return;
  await nextTick();
  previewElement.value?.focus({ preventScroll: true });
  previewElement.value?.scrollIntoView({ block: "nearest" });
});
const details = (id) => s.value.details[id]?.items || [];
</script>

<template>
  <section class="wb-audit-history" :class="{ 'has-selection': s.selected }" aria-label="按表查看变更历史" :aria-busy="s.restoring">
    <aside class="wb-audit-tables" aria-label="有修改记录的表">
      <form class="wb-audit-search" @submit.prevent="history.loadTables()">
        <label for="wb-audit-table-search">查找表</label>
        <div><input id="wb-audit-table-search" v-model="s.search" type="search" placeholder="表名或数据库" :disabled="s.restoring" /><button type="submit" :disabled="s.loadingTables || s.restoring">搜索</button></div>
      </form>
      <p v-if="s.error && !s.selected" class="wb-audit-error" role="alert">{{ s.error }}</p>
      <div class="wb-audit-table-scroll">
        <p v-if="s.loadingTables && !s.tables.length" class="wb-audit-hint" role="status">正在读取表列表…</p>
        <p v-else-if="!s.tables.length" class="wb-audit-hint">暂无匹配的修改记录</p>
        <button v-for="table in s.tables" :key="auditTableKey(table)" type="button" class="wb-audit-table" :class="{ active: s.selected && auditTableKey(table) === auditTableKey(s.selected) }" :aria-pressed="Boolean(s.selected && auditTableKey(table) === auditTableKey(s.selected))" :disabled="s.restoring" @click="history.selectTable(table)">
          <strong>{{ table.tableName }}</strong><span>{{ connectionLabel(table) }} · {{ table.database }}</span><time :datetime="table.latestTs">{{ stamp(table.latestTs) }}</time>
        </button>
        <button v-if="s.tablesMore" type="button" class="wb-audit-more" :disabled="s.loadingTables || s.restoring" @click="history.loadTables(undefined, true)">{{ s.loadingTables ? '加载中…' : '更多表' }}</button>
      </div>
    </aside>
    <div class="wb-audit-timeline">
      <p v-if="s.error && s.selected" class="wb-audit-error" role="alert">{{ s.error }}</p>
      <p v-if="s.notice" class="wb-audit-notice" role="status">{{ s.notice }}</p>
      <template v-if="s.selected">
        <header class="wb-audit-heading">
          <button type="button" class="wb-audit-back" :disabled="s.restoring" @click="history.resetSelection()">返回表列表</button>
          <strong>{{ s.selected.tableName }}</strong><span>{{ connectionLabel(s.selected) }} · {{ s.selected.database }}</span>
        </header>
        <p class="wb-audit-hint">仅恢复本机留存的修改。未记录的外部修改和已清理的历史不在恢复范围内。</p>
        <p v-if="s.previewing" class="wb-audit-hint" role="status">正在核对历史与当前数据，生成恢复预览…</p>
        <section v-if="s.preview" ref="previewElement" class="wb-audit-preview" aria-label="恢复预览" tabindex="-1">
          <h3>恢复 {{ s.selected.tableName }}</h3>
          <p>回到 <strong>{{ stamp(s.preview.targetTs) }}</strong> 这次{{ s.target.legacy ? '历史记录' : '操作' }}之前。</p>
          <p>将撤回 {{ s.preview.operations }} 组操作、{{ s.preview.entries }} 条修改明细。</p>
          <p>预计执行：新增 {{ s.preview.inserted }} 次 · 修改 {{ s.preview.updated }} 次 · 删除 {{ s.preview.deleted }} 次</p>
          <p class="wb-audit-hint">同一行可能多次变更，以上为逆向操作次数，不是去重后的行数。</p>
          <p><strong>此节点之后对这张表的修改也将撤回。</strong>其他表保持原样。</p>
          <div class="wb-audit-actions"><button type="button" class="wb-backup-action-danger" :disabled="s.restoring" @click="history.restore()">{{ s.restoring ? '正在统一恢复…' : '确认恢复此表' }}</button><button type="button" :disabled="s.restoring" @click="history.dismissPreview()">取消</button></div>
        </section>
        <div class="wb-audit-operations">
          <p v-if="s.loadingOperations && !s.operations.length" class="wb-audit-hint" role="status">正在读取操作历史…</p>
          <p v-else-if="!s.operations.length" class="wb-audit-hint">这张表暂无留存记录。</p>
          <article v-for="operation in s.operations" :key="operation.id" class="wb-audit-operation">
            <header><strong>{{ title(operation) }}</strong><time :datetime="operation.ts">{{ stamp(operation.ts) }}</time></header>
            <p>新增 {{ operation.inserted }} · 修改 {{ operation.updated }} · 删除 {{ operation.deleted }}<span v-if="operation.blocked"> · 含不可恢复记录</span></p>
            <p v-if="operation.legacy" class="wb-audit-hint">旧记录未保存批次，按相同时间戳展示；不代表一次导入。</p>
            <div class="wb-audit-actions">
              <button type="button" :aria-expanded="s.expanded === operation.id" :disabled="s.restoring" @click="history.loadDetails(operation)">{{ s.expanded === operation.id ? '收起详情' : `查看 ${operation.entryCount} 条明细` }}</button>
              <button type="button" :disabled="operation.blocked || s.restoring || s.previewing" @click="history.prepareRestore(operation)">恢复到此次{{ operation.legacy ? '记录' : '操作' }}前</button>
            </div>
            <section v-if="s.expanded === operation.id" class="wb-audit-details" aria-label="修改详情">
              <p v-if="s.loadingDetails && !details(operation.id).length" role="status">正在读取明细…</p>
              <article v-for="entry in details(operation.id)" :key="entry.id" class="wb-audit-detail">
                <header><strong>{{ opLabels[entry.operation] || entry.operation }}</strong><time :datetime="entry.ts">{{ stamp(entry.ts) }}</time><span>{{ entry.status === 'aborted' ? '已取消' : entry.status === 'pending' ? '待核对' : entry.status === 'rolled_back' ? '已回滚' : '已完成' }}</span></header>
                <p v-if="entry.rowIdentity" class="wb-audit-hint">行：{{ Object.entries(entry.rowIdentity).map(([key, value]) => `${key}=${value ?? 'NULL'}`).join('，') }}</p>
                <ul v-if="auditChangeItems(entry).length"><li v-for="(item, index) in auditChangeItems(entry)" :key="index">{{ item }}</li></ul><p v-else class="wb-audit-hint">此历史记录没有字段级详情。</p>
              </article>
              <button v-if="s.details[operation.id]?.hasMore" type="button" :disabled="s.loadingDetails || s.restoring" @click="history.loadDetails(operation, true)">{{ s.loadingDetails ? '加载中…' : '加载更多明细' }}</button>
            </section>
          </article>
          <button v-if="s.operationsMore" type="button" class="wb-audit-more" :disabled="s.loadingOperations || s.restoring" @click="history.loadOperations(true)">{{ s.loadingOperations ? '加载中…' : '更早的操作' }}</button>
        </div>
      </template>
      <div v-else class="wb-audit-welcome"><strong>选择一张表，查看它的修改历史</strong><p>导入与批量修改集中展示。找到历史节点后，可以预览并统一还原。</p></div>
    </div>
  </section>
</template>
