<script setup>
import { computed, ref } from 'vue';
import { useEscClose } from '../composables/useEscClose.js';
import BatchImportComparison from './BatchImportComparison.vue';

const props = defineProps({
  wizard: { type: Object, required: true },
  activeTab: { type: Object, default: null },
});

const emit = defineEmits(['close', 'file-selected', 'file-dropped', 'parse-sheet', 'go-step', 'execute', 'compare', 'cancel']);

const fileInput = ref(null);
const dragOverFileArea = ref(false);
const comparisonFullscreen = ref(false);
const dialogRef = ref(null);

// 导入进行中时 Esc 不关闭（需先点"取消导入"中止），其余步骤可 Esc 关闭。
useEscClose(
  () => props.wizard.open,
  () => emit('close'),
  () => props.wizard.importing || comparisonFullscreen.value,
  { dialogRef },
);

const comparisonAvailable = computed(() =>
  ['succeeded', 'partial'].includes(props.wizard.comparison?.status)
);
const comparisonChangeCount = computed(() => {
  const summary = props.wizard.comparison?.summary || {};
  return Number(summary.inserted || 0) + Number(summary.updated || 0) + Number(summary.deleted || 0);
});
const executeButtonLabel = computed(() => {
  if (comparisonAvailable.value && !props.wizard.comparison.stale) {
    if (comparisonChangeCount.value === 0) return '没有需要同步的变化';
    return `同步 ${comparisonChangeCount.value} 条变化`;
  }
  return '开始导入';
});

function importErrorText(error) {
  return error.message || error.error || error.shortMessage || '未知错误';
}

function importErrorSummary(errors) {
  return errors.every((error) => error.row) ? `失败 ${errors.length} 行` : '导入失败';
}

function isSpreadsheetFile(file) {
  return /\.(xlsx|xls)$/i.test(file?.name || '');
}

function chooseFile() {
  fileInput.value?.click();
}

function onFileAreaDragOver(event) {
  const hasFile = Array.from(event.dataTransfer?.types || []).includes('Files');
  if (hasFile) dragOverFileArea.value = true;
}

function onFileAreaDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) {
    dragOverFileArea.value = false;
  }
}

function onFileAreaDrop(event) {
  dragOverFileArea.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (!file || !isSpreadsheetFile(file)) return;
  emit('file-dropped', file);
}
</script>

<template>
  <div v-if="wizard.open" class="wb-dialog-overlay">
    <div
      ref="dialogRef"
      class="wb-dialog wb-import-wizard"
      :class="{ 'is-comparison-mode': wizard.step === 4 && wizard.step4View === 'comparison' && comparisonAvailable }"
      role="dialog"
      aria-modal="true"
      aria-label="导入向导"
      tabindex="-1"
    >
      <header class="wb-dialog-header">
        <strong>导入向导 — {{ activeTab?.tableName }}</strong>
        <button type="button" class="wb-dialog-close" :disabled="wizard.importing" :title="wizard.importing ? '导入进行中，请先取消' : '关闭'" @click="emit('close')">×</button>
      </header>

      <!-- Step 1: 选择文件 -->
      <div v-if="wizard.step === 1" class="wb-import-step">
        <div
          class="wb-import-file-area"
          :class="{ 'is-dragging': dragOverFileArea }"
          role="button"
          tabindex="0"
          @click="chooseFile"
          @keydown.enter.prevent="chooseFile"
          @keydown.space.prevent="chooseFile"
          @dragenter.prevent="onFileAreaDragOver"
          @dragover.prevent="onFileAreaDragOver"
          @dragleave.prevent="onFileAreaDragLeave"
          @drop.prevent="onFileAreaDrop"
        >
          <span v-if="!wizard.fileName">点击或拖入 XLSX 文件</span>
          <span v-else>已选择：{{ wizard.fileName }}</span>
        </div>
        <input ref="fileInput" type="file" accept=".xlsx,.xls" style="display:none" @change="emit('file-selected', $event)" />
        <label v-if="wizard.sheetNames.length > 1" class="wb-dialog-field">
          <span>工作表</span>
          <select v-model.number="wizard.selectedSheet" @change="emit('parse-sheet')">
            <option v-for="(name, i) in wizard.sheetNames" :key="i" :value="i">{{ name }}</option>
          </select>
        </label>
        <footer class="wb-dialog-actions">
          <button @click="emit('close')">取消</button>
          <button :disabled="!wizard.fileName" @click="wizard.step = 2">下一步</button>
        </footer>
      </div>

      <!-- Step 2: 预览数据 -->
      <div v-if="wizard.step === 2" class="wb-import-step">
        <p class="wb-import-info">共 {{ wizard.rawRows.length > 0 ? wizard.rawRows.length - 1 : 0 }} 行数据，预览前 20 行：</p>
        <div class="wb-import-preview-wrap">
          <table class="wb-import-preview">
            <thead>
              <tr><th v-for="(h, i) in wizard.rawRows[0] || []" :key="i">{{ h }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="(row, ri) in wizard.rawRows.slice(1, 21)" :key="ri">
                <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <footer class="wb-dialog-actions">
          <button @click="wizard.step = 1">上一步</button>
          <button @click="emit('go-step', 3)">下一步</button>
        </footer>
      </div>

      <!-- Step 3: 列映射 -->
      <div v-if="wizard.step === 3" class="wb-import-step">
        <div v-if="wizard.warnings.length" class="wb-import-warning-box">
          <p v-for="(w, i) in wizard.warnings" :key="i">{{ w }}</p>
        </div>
        <p class="wb-import-info">将文件列映射到表 {{ activeTab?.tableName }} 的字段（自动匹配名称相同的列）：</p>
        <div class="wb-import-mapping-wrap">
          <div class="wb-import-mapping-row wb-import-mapping-header">
            <span>文件列</span><span>→</span><span>表字段</span><span>类型</span><span>跳过</span>
          </div>
          <div v-for="(m, i) in wizard.mapping" :key="i" class="wb-import-mapping-row">
            <span class="wb-import-file-col">{{ m.fileCol }}</span>
            <span>→</span>
            <select v-model="m.tableCol" @change="m.skip = !m.tableCol; wizard.comparison.stale = true">
              <option value="">（跳过）</option>
              <option v-for="tc in m.tableCols" :key="tc.name" :value="tc.name">{{ tc.name }}</option>
            </select>
            <span class="wb-import-col-type">{{ m.tableCols.find(tc => tc.name === m.tableCol)?.type || '' }}</span>
            <input type="checkbox" v-model="m.skip" @change="m.skip && (m.tableCol = ''); wizard.comparison.stale = true" />
          </div>
        </div>
        <footer class="wb-dialog-actions">
          <button @click="wizard.step = 2">上一步</button>
          <button :disabled="!wizard.mapping.some(m => !m.skip && m.tableCol)" @click="emit('go-step', 4)">下一步</button>
        </footer>
      </div>

      <!-- Step 4: 确认并导入（含变化对比视图） -->
      <div v-if="wizard.step === 4" class="wb-import-step">
        <div v-if="comparisonAvailable" class="wb-batch-import-view-switch" role="tablist" aria-label="导入视图">
          <button
            type="button"
            role="tab"
            :class="{ 'is-active': wizard.step4View === 'summary' }"
            :aria-selected="wizard.step4View === 'summary'"
            @click="wizard.step4View = 'summary'"
          >
            确认信息
          </button>
          <button
            type="button"
            role="tab"
            :class="{ 'is-active': wizard.step4View === 'comparison' }"
            :aria-selected="wizard.step4View === 'comparison'"
            @click="wizard.step4View = 'comparison'"
          >
            变化对比
            <span>{{ comparisonChangeCount }}</span>
          </button>
        </div>

        <template v-if="wizard.step4View === 'comparison' && comparisonAvailable">
          <BatchImportComparison
            :comparison="wizard.comparison"
            @fullscreen-change="comparisonFullscreen = $event"
          />
          <div class="wb-import-actions-center">
            <button @click="wizard.step4View = 'summary'">返回确认信息</button>
            <button :disabled="wizard.comparison.running || wizard.importing" @click="emit('compare')">
              {{ wizard.comparison.running ? '正在对比…' : '重新对比' }}
            </button>
            <button
              class="wb-import-start-btn"
              :disabled="wizard.importing || wizard.comparison.running"
              @click="emit('execute')"
            >
              {{ executeButtonLabel }}
            </button>
          </div>
        </template>

        <template v-else>
          <div class="wb-import-summary">
            <p>文件：<strong>{{ wizard.fileName }}</strong></p>
            <p>目标表：<strong>{{ activeTab?.tableName }}</strong></p>
            <p>映射列数：<strong>{{ wizard.mapping.filter(m => !m.skip && m.tableCol).length }}</strong></p>
            <p>数据行数：<strong>{{ wizard.rawRows.length > 0 ? wizard.rawRows.length - 1 : 0 }}</strong></p>
          </div>
          <div class="wb-import-warning-box">
            <p>整表覆盖：目标表中不在该文件里的数据将被删除。</p>
          </div>
          <div v-if="!wizard.importing && wizard.progress.total === 0" class="wb-import-actions-center">
            <button @click="wizard.step = 3">上一步</button>
            <button :disabled="wizard.comparison.running" @click="emit('compare')">
              {{ wizard.comparison.running ? '正在对比…' : '对比变化' }}
            </button>
            <button class="wb-import-start-btn" :disabled="wizard.comparison.running" @click="emit('execute')">{{ executeButtonLabel }}</button>
          </div>
          <div v-if="wizard.importing || wizard.progress.total > 0" class="wb-import-progress-section">
            <div class="wb-import-progress-bar">
              <div class="wb-import-progress-fill" :style="{ width: (wizard.progress.total ? (wizard.progress.done / wizard.progress.total * 100) : 0) + '%' }"></div>
            </div>
            <p>{{ wizard.progress.done }} / {{ wizard.progress.total }}</p>
            <p v-if="wizard.cancelled && wizard.importing" class="wb-import-cancel-hint">正在取消…</p>
            <p v-if="wizard.progress.errors.length" class="wb-import-errors">{{ importErrorSummary(wizard.progress.errors) }}</p>
            <p v-else-if="!wizard.importing && wizard.progress.total > 0" class="wb-import-info">
              新增 {{ wizard.progress.inserted }}，覆盖 {{ wizard.progress.updated }}，删除 {{ wizard.progress.deleted }}，未变化 {{ wizard.progress.unchanged }}
            </p>
            <ul v-if="wizard.progress.errors.length" class="wb-import-error-details">
              <li v-for="error in wizard.progress.errors.slice(0, 8)" :key="`${error.row}-${error.columnName || ''}-${error.code || importErrorText(error)}`">
                <span v-if="error.row" class="wb-import-error-row">第 {{ error.row }} 行</span>
                <span v-if="error.columnName" class="wb-import-error-column">{{ error.columnName }}</span>
                <span class="wb-import-error-message">{{ importErrorText(error) }}</span>
              </li>
            </ul>
            <p v-if="wizard.progress.errors.length > 8" class="wb-import-error-more">还有 {{ wizard.progress.errors.length - 8 }} 条错误未显示</p>
            <div v-if="wizard.importing" class="wb-import-actions-center">
              <button class="wb-import-cancel-btn" disabled>正在原子覆盖…</button>
            </div>
          </div>
          <div v-if="!wizard.importing && wizard.progress.total > 0" class="wb-import-actions-center">
            <button @click="emit('close')">完成</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
