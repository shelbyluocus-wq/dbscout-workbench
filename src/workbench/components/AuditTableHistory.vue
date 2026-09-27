<script setup>
import { language, t } from "../i18n/index.js";
import { computed, ref, watch, nextTick } from "vue";
import { auditChangeItems } from "../utils/auditDisplay.js";
import { auditTableKey } from "../composables/useAuditHistory.js";
const props = defineProps({ history: { type: Object, required: true }, connections: { type: Array, default: () => [] } });
const s = computed(() => props.history.state);
const labels = { import: "导入表", grid: "编辑数据", rollback: "恢复数据", ddl: "修改结构", agent: "AI 操作", sql_console: "SQL 操作" };
const opLabels = { INSERT: "新增", UPDATE: "修改", DELETE: "删除", DDL: "结构变更" };
const stamp = (value) => new Date(value).toLocaleString(language.intlLocale.value, { hour12: false });
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
  <section class="wb-audit-history" :class="{ 'has-selection': s.selected }" :aria-label="t('m_92122adecaa1')" :aria-busy="s.restoring">
    <aside class="wb-audit-tables" :aria-label="t('m_190fb5404595')">
      <form class="wb-audit-search" @submit.prevent="history.loadTables()">
        <label for="wb-audit-table-search">{{ t('m_d459170f4de3') }}</label>
        <div><input id="wb-audit-table-search" v-model="s.search" type="search" :placeholder="t('m_bccdf7213ff4')" :disabled="s.restoring" /><button type="submit" :disabled="s.loadingTables || s.restoring">{{ t('m_44ce7ae909bb') }}</button></div>
      </form>
      <p v-if="s.error && !s.selected" class="wb-audit-error" role="alert">{{ s.error }}</p>
      <div class="wb-audit-table-scroll">
        <p v-if="s.loadingTables && !s.tables.length" class="wb-audit-hint" role="status">{{ t('m_133b5069fbfb') }}</p>
        <p v-else-if="!s.tables.length" class="wb-audit-hint">{{ t('m_7e40d7555c9d') }}</p>
        <button v-for="table in s.tables" :key="auditTableKey(table)" type="button" class="wb-audit-table" :class="{ active: s.selected && auditTableKey(table) === auditTableKey(s.selected) }" :aria-pressed="Boolean(s.selected && auditTableKey(table) === auditTableKey(s.selected))" :disabled="s.restoring" @click="history.selectTable(table)">
          <strong>{{ table.tableName }}</strong><span>{{ connectionLabel(table) }} · {{ table.database }}</span><time :datetime="table.latestTs">{{ stamp(table.latestTs) }}</time>
        </button>
        <button v-if="s.tablesMore" type="button" class="wb-audit-more" :disabled="s.loadingTables || s.restoring" @click="history.loadTables(undefined, true)">{{ s.loadingTables ? t('m_4927a53bcc88') : t('m_ab36d2486c97') }}</button>
      </div>
    </aside>
    <div class="wb-audit-timeline">
      <p v-if="s.error && s.selected" class="wb-audit-error" role="alert">{{ s.error }}</p>
      <p v-if="s.notice" class="wb-audit-notice" role="status">{{ s.notice }}</p>
      <template v-if="s.selected">
        <header class="wb-audit-heading">
          <button type="button" class="wb-audit-back" :disabled="s.restoring" @click="history.resetSelection()">{{ t('m_d5e75e167780') }}</button>
          <strong>{{ s.selected.tableName }}</strong><span>{{ connectionLabel(s.selected) }} · {{ s.selected.database }}</span>
        </header>
        <p class="wb-audit-hint">{{ t('m_7643dd10ab6c') }}</p>
        <p v-if="s.previewing" class="wb-audit-hint" role="status">{{ t('m_5e110fbd036a') }}</p>
        <section v-if="s.preview" ref="previewElement" class="wb-audit-preview" :aria-label="t('m_10328a6f1af8')" tabindex="-1">
          <h3>{{ t('m_e0534b8a4e46') }} {{ s.selected.tableName }}</h3>
          <p>{{ t('m_bce1c3ca6c6a') }} <strong>{{ stamp(s.preview.targetTs) }}</strong> {{ t('m_0a679a59cc2f') }}{{ s.target.legacy ? t('m_5467922dce50') : t('m_ed31fbb483ee') }}{{ t('m_f5ce82c6a8d0') }}</p>
          <p>{{ t('m_1f24dac29a16') }} {{ s.preview.operations }} {{ t('m_08d280575cd7') }}{{ s.preview.entries }} {{ t('m_87888d9905f3') }}</p>
          <p>{{ t('m_722dbe0b4198') }} {{ s.preview.inserted }} {{ t('m_b0c051075336') }} {{ s.preview.updated }} {{ t('m_a416b503f813') }} {{ s.preview.deleted }} {{ t('m_172fb7e67b9b') }}</p>
          <p class="wb-audit-hint">{{ t('m_2d5c41b23d0a') }}</p>
          <p><strong>{{ t('m_c14bbbc3dc89') }}</strong>{{ t('m_2e889cb86fec') }}</p>
          <div class="wb-audit-actions"><button type="button" class="wb-backup-action-danger" :disabled="s.restoring" @click="history.restore()">{{ s.restoring ? t('m_dfe29b3fe927') : t('m_2341331d9a51') }}</button><button type="button" :disabled="s.restoring" @click="history.dismissPreview()">{{ t('m_2cd0f3be8738') }}</button></div>
        </section>
        <div class="wb-audit-operations">
          <p v-if="s.loadingOperations && !s.operations.length" class="wb-audit-hint" role="status">{{ t('m_9b0566efad4d') }}</p>
          <p v-else-if="!s.operations.length" class="wb-audit-hint">{{ t('m_3586ed29907f') }}</p>
          <article v-for="operation in s.operations" :key="operation.id" class="wb-audit-operation">
            <header><strong>{{ title(operation) }}</strong><time :datetime="operation.ts">{{ stamp(operation.ts) }}</time></header>
            <p>{{ t('m_0006d696d8e1') }} {{ operation.inserted }} {{ t('m_112663fdf504') }} {{ operation.updated }} {{ t('m_7dad13b30d05') }} {{ operation.deleted }}<span v-if="operation.blocked"> {{ t('m_664fba5d05c8') }}</span></p>
            <p v-if="operation.legacy" class="wb-audit-hint">{{ t('m_2964bd3c0438') }}</p>
            <div class="wb-audit-actions">
              <button type="button" :aria-expanded="s.expanded === operation.id" :disabled="s.restoring" @click="history.loadDetails(operation)">{{ s.expanded === operation.id ? t('m_0ae7312510f4') : `查看 ${operation.entryCount} 条明细` }}</button>
              <button type="button" :disabled="operation.blocked || s.restoring || s.previewing" @click="history.prepareRestore(operation)">{{ t('m_37671d5dde4e') }}{{ operation.legacy ? t('m_9fad24e2c377') : t('m_ed31fbb483ee') }}{{ t('m_6044e9f095e0') }}</button>
            </div>
            <section v-if="s.expanded === operation.id" class="wb-audit-details" :aria-label="t('m_0f64b165836e')">
              <p v-if="s.loadingDetails && !details(operation.id).length" role="status">{{ t('m_00d75928dfcd') }}</p>
              <article v-for="entry in details(operation.id)" :key="entry.id" class="wb-audit-detail">
                <header><strong>{{ opLabels[entry.operation] || entry.operation }}</strong><time :datetime="entry.ts">{{ stamp(entry.ts) }}</time><span>{{ entry.status === 'aborted' ? t('m_a37778f17c5f') : entry.status === 'pending' ? t('m_33df16b4afab') : entry.status === 'rolled_back' ? t('m_9d1ac300aa31') : t('m_f28461bb49c8') }}</span></header>
                <p v-if="entry.rowIdentity" class="wb-audit-hint">{{ t('m_a9e8c256cb93') }}{{ Object.entries(entry.rowIdentity).map(([key, value]) => `${key}=${value ?? 'NULL'}`).join('，') }}</p>
                <ul v-if="auditChangeItems(entry).length"><li v-for="(item, index) in auditChangeItems(entry)" :key="index">{{ item }}</li></ul><p v-else class="wb-audit-hint">{{ t('m_c226c1702dc7') }}</p>
              </article>
              <button v-if="s.details[operation.id]?.hasMore" type="button" :disabled="s.loadingDetails || s.restoring" @click="history.loadDetails(operation, true)">{{ s.loadingDetails ? t('m_4927a53bcc88') : t('m_eb880dd3c3e1') }}</button>
            </section>
          </article>
          <button v-if="s.operationsMore" type="button" class="wb-audit-more" :disabled="s.loadingOperations || s.restoring" @click="history.loadOperations(true)">{{ s.loadingOperations ? t('m_4927a53bcc88') : t('m_db3f67fe422a') }}</button>
        </div>
      </template>
      <div v-else class="wb-audit-welcome"><strong>{{ t('m_86860bdd48e6') }}</strong><p>{{ t('m_9072ba3cf6bf') }}</p></div>
    </div>
  </section>
</template>
