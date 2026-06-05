<script setup>
import { computed, onMounted, watch } from "vue";

import { useTableDesign } from "../composables/useTableDesign.js";

const props = defineProps({
  source: {
    type: Object,
    required: true,
  },
  invokeWorkbench: {
    type: Function,
    required: true,
  },
});

const emit = defineEmits(["applied"]);

const {
  loading,
  saving,
  error,
  draft,
  dirty,
  validationErrors,
  preview,
  previewOpen,
  loadDesign,
  resetDraft,
  previewDesign,
  applyDesign,
} = useTableDesign(props.invokeWorkbench, computed(() => props.source), {
  onApplied: (event) => emit("applied", event),
});

const sourceTitle = computed(() => {
  const database = props.source?.database ? `${props.source.database}.` : "";
  return `${database}${props.source?.tableName || props.source?.table_name || props.source?.name || ""}`;
});

const hasValidationMessages = computed(() => validationErrors.value?.valid === false);

const sourceKey = computed(() => [
  props.source?.connectionId || props.source?.connection_id || "",
  props.source?.database || "",
  props.source?.tableName || props.source?.table_name || props.source?.name || "",
].join(""));

async function refreshDesign() {
  try {
    await loadDesign();
  } catch {
    // Error text is already exposed through the composable state.
  }
}

async function handlePreview() {
  try {
    await previewDesign();
  } catch {
    // Error text is already exposed through the composable state.
  }
}

async function handleSave() {
  await handlePreview();
}

async function handleConfirmApply() {
  try {
    await applyDesign();
  } catch {
    // Error text is already exposed through the composable state.
  }
}

onMounted(refreshDesign);
watch(sourceKey, refreshDesign);
</script>

<template>
  <section class="wb-design-editor" aria-label="表设计编辑器">
    <header class="wb-design-header">
      <div class="wb-design-title">
        <strong>表设计</strong>
        <span :title="sourceTitle">{{ sourceTitle }}</span>
        <em v-if="dirty" class="wb-design-dirty">未保存</em>
      </div>
      <div class="wb-design-actions">
        <button type="button" :disabled="loading || saving" @click="refreshDesign">刷新</button>
        <button type="button" :disabled="loading || saving || !dirty" @click="resetDraft">重置</button>
        <button type="button" :disabled="loading || saving" @click="handlePreview">预览 SQL</button>
        <button type="button" class="wb-design-primary" :disabled="loading || saving || !dirty" @click="handleSave">保存</button>
      </div>
    </header>

    <div v-if="loading" class="wb-design-state">正在加载表设计...</div>
    <div v-else class="wb-design-body">
      <p v-if="error" class="wb-design-error">{{ error }}</p>
      <div v-if="hasValidationMessages" class="wb-design-validation" role="alert">
        <strong>请先修正以下问题</strong>
        <span v-for="message in validationErrors.messages" :key="message">{{ message }}</span>
      </div>

      <label class="wb-design-comment">
        <span>表备注</span>
        <textarea v-model="draft.tableComment" name="tableComment" rows="2" placeholder="输入 tableComment"></textarea>
      </label>

      <div class="wb-design-grid-wrap">
        <table class="wb-design-grid">
          <thead>
            <tr>
              <th>字段名</th>
              <th>类型</th>
              <th>长度</th>
              <th>小数位</th>
              <th>允许 NULL</th>
              <th>主键</th>
              <th>默认值模式</th>
              <th>默认值</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(column, index) in draft.columns" :key="column.id || column.originalName || index">
              <td>
                <input v-model="column.name" aria-label="字段名" />
                <small v-if="validationErrors.columns?.[index]?.name">{{ validationErrors.columns[index].name }}</small>
              </td>
              <td>
                <input v-model="column.type" aria-label="字段类型" />
                <small v-if="validationErrors.columns?.[index]?.type">{{ validationErrors.columns[index].type }}</small>
              </td>
              <td>
                <input v-model="column.length" aria-label="字段长度" inputmode="numeric" />
                <small v-if="validationErrors.columns?.[index]?.length">{{ validationErrors.columns[index].length }}</small>
              </td>
              <td>
                <input v-model="column.scale" aria-label="小数位" inputmode="numeric" />
                <small v-if="validationErrors.columns?.[index]?.scale">{{ validationErrors.columns[index].scale }}</small>
              </td>
              <td class="wb-design-check-cell">
                <input v-model="column.nullable" type="checkbox" :disabled="column.primaryKey" aria-label="允许 NULL" />
                <small v-if="validationErrors.columns?.[index]?.nullable">{{ validationErrors.columns[index].nullable }}</small>
              </td>
              <td class="wb-design-check-cell">
                <input v-model="column.primaryKey" type="checkbox" aria-label="主键" @change="column.nullable = column.primaryKey ? false : column.nullable" />
              </td>
              <td>
                <select v-model="column.defaultMode" aria-label="defaultMode">
                  <option value="none">无</option>
                  <option value="null">NULL</option>
                  <option value="value">固定值</option>
                  <option value="expression">表达式</option>
                </select>
                <small v-if="validationErrors.columns?.[index]?.defaultMode">{{ validationErrors.columns[index].defaultMode }}</small>
              </td>
              <td>
                <input v-model="column.defaultValue" :disabled="column.defaultMode === 'none' || column.defaultMode === 'null'" aria-label="默认值" />
                <small v-if="validationErrors.columns?.[index]?.defaultValue">{{ validationErrors.columns[index].defaultValue }}</small>
              </td>
              <td>
                <input v-model="column.comment" aria-label="字段备注" />
                <small v-if="validationErrors.columns?.[index]?.comment">{{ validationErrors.columns[index].comment }}</small>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="previewOpen" class="wb-design-preview" role="dialog" aria-modal="true" aria-label="SQL 预览">
      <section class="wb-design-preview-card">
        <header class="wb-design-preview-header">
          <strong>SQL 预览</strong>
          <button type="button" @click="previewOpen = false">取消</button>
        </header>
        <ul v-if="preview.warnings?.length" class="wb-design-warnings">
          <li v-for="warning in preview.warnings" :key="warning">{{ warning }}</li>
        </ul>
        <pre class="wb-design-sql"><code>{{ (preview.statements || []).join(";\n") }}</code></pre>
        <footer class="wb-design-preview-actions">
          <button type="button" @click="previewOpen = false">取消</button>
          <button type="button" class="wb-design-danger" :disabled="saving" @click="handleConfirmApply">确认执行 ALTER TABLE</button>
        </footer>
      </section>
    </div>
  </section>
</template>
