<script setup>
// A file's diff after Cairn's diff view: side by side (old on the left, new
// on the right, removed lines beside the added lines that replaced them) or
// unified, with line numbers, the changed part of a line highlighted, and
// previous / next change. One scroll area holds both sides, so they always
// scroll together.
import { computed, nextTick, ref, watch } from "vue";
import { ChevronDown, ChevronUp } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { diffRows, diffStats } from "../utils/unifiedDiff.js";

const props = defineProps({
  file: { type: Object, default: null },
  layout: { type: String, default: "split" },
  loading: { type: Boolean, default: false },
  error: { type: String, default: "" },
});

const emit = defineEmits(["update:layout"]);
// Very large diffs show their beginning; the rest stays a click away in svn tools.
const MAX_ROWS = 4000;
const scrollRef = ref(null);
const changeIndex = ref(-1);

const allRows = computed(() => (props.file ? diffRows(props.file, props.layout) : []));
const rows = computed(() => allRows.value.slice(0, MAX_ROWS));
const truncated = computed(() => allRows.value.length > MAX_ROWS);
const changeStarts = computed(() => rows.value.map((row, index) => (row.startsChange ? index : -1)).filter((index) => index >= 0));
const stats = computed(() => diffStats(props.file));
const empty = computed(() => props.file && !props.file.binary && !props.file.tooLarge && !props.file.folder && !rows.value.length);

watch(() => [props.file, props.layout], () => {
  changeIndex.value = -1;
  if (scrollRef.value) scrollRef.value.scrollTop = 0;
});

function highlightParts(cell) {
  if (!cell?.highlight || cell.highlight.end <= cell.highlight.start) return [{ text: cell?.text ?? "", mark: false }];
  const { start, end } = cell.highlight;
  return [
    { text: cell.text.slice(0, start), mark: false },
    { text: cell.text.slice(start, end), mark: true },
    { text: cell.text.slice(end), mark: false },
  ].filter((part) => part.text);
}

function jump(step) {
  const starts = changeStarts.value;
  if (!starts.length) return;
  changeIndex.value = (changeIndex.value + step + starts.length) % starts.length;
  void nextTick(() => {
    const target = scrollRef.value?.querySelector(`[data-diff-row="${starts[changeIndex.value]}"]`);
    target?.scrollIntoView?.({ block: "center" });
  });
}

function onKeydown(event) {
  if (event.key === "n" || event.key === "F7") {
    event.preventDefault();
    jump(event.shiftKey ? -1 : 1);
  } else if (event.key === "p") {
    event.preventDefault();
    jump(-1);
  }
}
</script>

<template>
  <div class="wb-rf-split-diff">
    <div class="wb-rf-split-toolbar">
      <span class="wb-rf-code wb-rf-split-path" :title="file?.path">{{ file?.path || '' }}</span>
      <span v-if="file && !file.binary" class="wb-rf-diff-delta">
        <span v-if="stats.added" class="is-add">+{{ stats.added }}</span>
        <span v-if="stats.removed" class="is-remove">−{{ stats.removed }}</span>
      </span>
      <div class="wb-rf-split-tools">
        <button type="button" class="wb-rf-icon-btn" :disabled="!changeStarts.length" :title="t('releaseFlow.diff.previous')" :aria-label="t('releaseFlow.diff.previous')" @click="jump(-1)">
          <ChevronUp :size="15" aria-hidden="true" />
        </button>
        <button type="button" class="wb-rf-icon-btn" :disabled="!changeStarts.length" :title="t('releaseFlow.diff.next')" :aria-label="t('releaseFlow.diff.next')" @click="jump(1)">
          <ChevronDown :size="15" aria-hidden="true" />
        </button>
        <span v-if="changeStarts.length" class="wb-rf-count">{{ t('releaseFlow.diff.changeCount', { current: Math.max(0, changeIndex) + (changeIndex >= 0 ? 1 : 0), total: changeStarts.length }) }}</span>
        <div class="wb-rf-segmented" role="radiogroup" :aria-label="t('releaseFlow.diff.layout')">
          <button type="button" role="radio" :aria-checked="layout === 'split'" @click="emit('update:layout', 'split')">{{ t('releaseFlow.diff.split') }}</button>
          <button type="button" role="radio" :aria-checked="layout === 'unified'" @click="emit('update:layout', 'unified')">{{ t('releaseFlow.diff.unified') }}</button>
        </div>
      </div>
    </div>

    <p v-if="loading" class="wb-rf-empty">{{ t('releaseFlow.diff.loading') }}</p>
    <p v-else-if="error" class="wb-rf-notice is-danger">{{ error }}</p>
    <p v-else-if="!file" class="wb-rf-empty">{{ t('releaseFlow.diff.pick') }}</p>
    <p v-else-if="file.folder" class="wb-rf-empty">{{ t('releaseFlow.diff.folder') }}</p>
    <p v-else-if="file.binary" class="wb-rf-empty">{{ t('releaseFlow.diff.binary') }}</p>
    <p v-else-if="file.tooLarge" class="wb-rf-empty">{{ t('releaseFlow.diff.tooLarge') }}</p>
    <p v-else-if="empty" class="wb-rf-empty">{{ t('releaseFlow.diff.noText') }}</p>
    <div
      v-else
      ref="scrollRef"
      class="wb-rf-split-scroll"
      :class="`is-${layout}`"
      tabindex="0"
      :aria-label="t('releaseFlow.diff.content', { path: file.path })"
      @keydown="onKeydown"
    >
      <template v-for="(row, index) in rows" :key="index">
        <div v-if="row.type === 'hunk'" class="wb-rf-split-hunk" :data-diff-row="index">{{ row.text }}</div>
        <div v-else-if="row.type === 'property'" class="wb-rf-split-property" :data-diff-row="index">
          {{ t(`releaseFlow.diff.property.${row.change}`, { name: row.name }) }}
        </div>
        <div v-else-if="row.type === 'split'" class="wb-rf-split-row" :class="{ 'is-current': changeStarts[changeIndex] === index }" :data-diff-row="index">
          <template v-for="(cell, side) in [row.left, row.right]" :key="side">
            <span class="wb-rf-split-num" :class="cell ? `is-${cell.kind}` : 'is-empty'">{{ cell?.number ?? '' }}</span>
            <span class="wb-rf-split-text" :class="cell ? `is-${cell.kind}` : 'is-empty'"><template v-if="cell"><span
              v-for="(part, partIndex) in highlightParts(cell)"
              :key="partIndex"
              :class="{ 'is-mark': part.mark }"
            >{{ part.text }}</span></template></span>
          </template>
        </div>
        <div v-else class="wb-rf-split-line" :class="[`is-${row.cell.kind}`, { 'is-current': changeStarts[changeIndex] === index }]" :data-diff-row="index">
          <span class="wb-rf-split-num">{{ row.oldNumber ?? '' }}</span>
          <span class="wb-rf-split-num">{{ row.newNumber ?? '' }}</span>
          <span class="wb-rf-split-marker" aria-hidden="true">{{ row.cell.kind === 'added' ? '+' : row.cell.kind === 'removed' ? '−' : '' }}</span>
          <span class="wb-rf-split-text"><span
            v-for="(part, partIndex) in highlightParts(row.cell)"
            :key="partIndex"
            :class="{ 'is-mark': part.mark }"
          >{{ part.text }}</span></span>
        </div>
      </template>
      <p v-if="truncated" class="wb-rf-split-more">{{ t('releaseFlow.diff.truncated', { count: MAX_ROWS }) }}</p>
    </div>
  </div>
</template>
