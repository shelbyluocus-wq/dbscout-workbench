<script setup>
import { t } from "../i18n/index.js";
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
      :aria-label="t('m_d52c17622d3f')"
      tabindex="-1"
    >
      <header class="wb-dialog-header">
        <strong>{{ t('m_bceb1458fdbd') }} {{ activeTab?.tableName }}</strong>
        <button type="button" class="wb-dialog-close" :disabled="wizard.importing" :title="wizard.importing ? t('m_b3075ca60314') : t('m_3fd47edce45b')" @click="emit('close')">×</button>
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
          <span v-if="!wizard.fileName">{{ t('m_3ab194493555') }}</span>
          <span v-else>{{ t('m_d4102e5d06a3') }}{{ wizard.fileName }}</span>
        </div>
        <input ref="fileInput" type="file" accept=".xlsx,.xls" style="display:none" @change="emit('file-selected', $event)" />
        <label v-if="wizard.sheetNames.length > 1" class="wb-dialog-field">
          <span>{{ t('m_b02781ee06c6') }}</span>
          <select v-model.number="wizard.selectedSheet" @change="emit('parse-sheet')">
            <option v-for="(name, i) in wizard.sheetNames" :key="i" :value="i">{{ name }}</option>
          </select>
        </label>
        <footer class="wb-dialog-actions">
          <button @click="emit('close')">{{ t('m_2cd0f3be8738') }}</button>
          <button :disabled="!wizard.fileName" @click="wizard.step = 2">{{ t('m_acfc4e74a650') }}</button>
        </footer>
      </div>

      <!-- Step 2: 预览数据 -->
      <div v-if="wizard.step === 2" class="wb-import-step">
        <p class="wb-import-info">{{ t('m_76e547a8fa54') }} {{ wizard.rawRows.length > 0 ? wizard.rawRows.length - 1 : 0 }} {{ t('m_c5a0db112d28') }}</p>
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
          <button @click="wizard.step = 1">{{ t('m_da336fdc0dbd') }}</button>
          <button @click="emit('go-step', 3)">{{ t('m_acfc4e74a650') }}</button>
        </footer>
      </div>

      <!-- Step 3: 列映射 -->
      <div v-if="wizard.step === 3" class="wb-import-step">
        <div v-if="wizard.warnings.length" class="wb-import-warning-box">
          <p v-for="(w, i) in wizard.warnings" :key="i">{{ w }}</p>
        </div>
        <p class="wb-import-info">{{ t('m_5cbc122ac36a') }} {{ activeTab?.tableName }} {{ t('m_59d3f1489950') }}</p>
        <div class="wb-import-mapping-wrap">
          <div class="wb-import-mapping-row wb-import-mapping-header">
            <span>{{ t('m_7a05b39355df') }}</span><span>→</span><span>{{ t('m_be6a29abcad3') }}</span><span>{{ t('m_ba40014ff496') }}</span><span>{{ t('m_fc50a99caae0') }}</span>
          </div>
          <div v-for="(m, i) in wizard.mapping" :key="i" class="wb-import-mapping-row">
            <span class="wb-import-file-col">{{ m.fileCol }}</span>
            <span>→</span>
            <select v-model="m.tableCol" @change="m.skip = !m.tableCol; wizard.comparison.stale = true">
              <option value="">{{ t('m_47c30f9f6c62') }}</option>
              <option v-for="tc in m.tableCols" :key="tc.name" :value="tc.name">{{ tc.name }}</option>
            </select>
            <span class="wb-import-col-type">{{ m.tableCols.find(tc => tc.name === m.tableCol)?.type || '' }}</span>
            <input type="checkbox" v-model="m.skip" @change="m.skip && (m.tableCol = ''); wizard.comparison.stale = true" />
          </div>
        </div>
        <footer class="wb-dialog-actions">
          <button @click="wizard.step = 2">{{ t('m_da336fdc0dbd') }}</button>
          <button :disabled="!wizard.mapping.some(m => !m.skip && m.tableCol)" @click="emit('go-step', 4)">{{ t('m_acfc4e74a650') }}</button>
        </footer>
      </div>

      <!-- Step 4: 确认并导入（含变化对比视图） -->
      <div v-if="wizard.step === 4" class="wb-import-step">
        <div v-if="comparisonAvailable" class="wb-batch-import-view-switch" role="tablist" :aria-label="t('m_666793048210')">
          <button
            type="button"
            role="tab"
            :class="{ 'is-active': wizard.step4View === 'summary' }"
            :aria-selected="wizard.step4View === 'summary'"
            @click="wizard.step4View = 'summary'"
          > {{ t('m_b4d05b44a5a5') }} </button>
          <button
            type="button"
            role="tab"
            :class="{ 'is-active': wizard.step4View === 'comparison' }"
            :aria-selected="wizard.step4View === 'comparison'"
            @click="wizard.step4View = 'comparison'"
          > {{ t('m_745edd3e58e9') }} <span>{{ comparisonChangeCount }}</span>
          </button>
        </div>

        <template v-if="wizard.step4View === 'comparison' && comparisonAvailable">
          <BatchImportComparison
            :comparison="wizard.comparison"
            @fullscreen-change="comparisonFullscreen = $event"
          />
          <div class="wb-import-actions-center">
            <button @click="wizard.step4View = 'summary'">{{ t('m_47ae378a279f') }}</button>
            <button :disabled="wizard.comparison.running || wizard.importing" @click="emit('compare')">
              {{ wizard.comparison.running ? t('m_1a578633bbd7') : t('m_1e4cfe2a5930') }}
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
            <p>{{ t('m_9491ade2781f') }}<strong>{{ wizard.fileName }}</strong></p>
            <p>{{ t('m_da2cccbea8ce') }}<strong>{{ activeTab?.tableName }}</strong></p>
            <p>{{ t('m_69aa887bb369') }}<strong>{{ wizard.mapping.filter(m => !m.skip && m.tableCol).length }}</strong></p>
            <p>{{ t('m_88af878d821b') }}<strong>{{ wizard.rawRows.length > 0 ? wizard.rawRows.length - 1 : 0 }}</strong></p>
          </div>
          <div class="wb-import-warning-box">
            <p>{{ t('m_fd80e02c1b33') }}</p>
          </div>
          <div v-if="!wizard.importing && wizard.progress.total === 0" class="wb-import-actions-center">
            <button @click="wizard.step = 3">{{ t('m_da336fdc0dbd') }}</button>
            <button :disabled="wizard.comparison.running" @click="emit('compare')">
              {{ wizard.comparison.running ? t('m_1a578633bbd7') : t('m_c9b3a8e7059a') }}
            </button>
            <button class="wb-import-start-btn" :disabled="wizard.comparison.running" @click="emit('execute')">{{ executeButtonLabel }}</button>
          </div>
          <div v-if="wizard.importing || wizard.progress.total > 0" class="wb-import-progress-section">
            <div class="wb-import-progress-bar">
              <div class="wb-import-progress-fill" :style="{ width: (wizard.progress.total ? (wizard.progress.done / wizard.progress.total * 100) : 0) + '%' }"></div>
            </div>
            <p>{{ wizard.progress.done }} / {{ wizard.progress.total }}</p>
            <p v-if="wizard.cancelled && wizard.importing" class="wb-import-cancel-hint">{{ t('m_e8e08b0f61dd') }}</p>
            <p v-if="wizard.progress.errors.length" class="wb-import-errors">{{ importErrorSummary(wizard.progress.errors) }}</p>
            <p v-else-if="!wizard.importing && wizard.progress.total > 0" class="wb-import-info"> {{ t('m_0006d696d8e1') }} {{ wizard.progress.inserted }}{{ t('m_c70b24090f24') }} {{ wizard.progress.updated }}{{ t('m_45235841ecc1') }} {{ wizard.progress.deleted }}{{ t('m_a08d3a1a7509') }} {{ wizard.progress.unchanged }}
            </p>
            <ul v-if="wizard.progress.errors.length" class="wb-import-error-details">
              <li v-for="error in wizard.progress.errors.slice(0, 8)" :key="`${error.row}-${error.columnName || ''}-${error.code || importErrorText(error)}`">
                <span v-if="error.row" class="wb-import-error-row">{{ t('m_af50a0fe2a50') }} {{ error.row }} {{ t('m_4cc7b00050cb') }}</span>
                <span v-if="error.columnName" class="wb-import-error-column">{{ error.columnName }}</span>
                <span class="wb-import-error-message">{{ importErrorText(error) }}</span>
              </li>
            </ul>
            <p v-if="wizard.progress.errors.length > 8" class="wb-import-error-more">{{ t('m_83eec76b3911') }} {{ wizard.progress.errors.length - 8 }} {{ t('m_27b437079060') }}</p>
            <div v-if="wizard.importing" class="wb-import-actions-center">
              <button class="wb-import-cancel-btn" disabled>{{ t('m_9deabf8c95fd') }}</button>
            </div>
          </div>
          <div v-if="!wizard.importing && wizard.progress.total > 0" class="wb-import-actions-center">
            <button @click="emit('close')">{{ t('m_c0b3fbff51cc') }}</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
