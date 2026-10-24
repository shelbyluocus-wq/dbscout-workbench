<script setup>
// Phase 2, step 4: review what the copy and the conversion changed in the
// platform client's working copy before it is built.
import { computed, ref } from "vue";
import { t } from "../i18n/index.js";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleaseTaskPanel from "./ReleaseTaskPanel.vue";

const props = defineProps({
  flow: { type: Object, required: true },
});
defineEmits(["run", "rerun", "navigate"]);

const files = computed(() => props.flow.diffFiles);
const selectedPath = ref(files.value[0]?.path || "");
const selected = computed(() => files.value.find((file) => file.path === selectedPath.value) || files.value[0]);
const counts = computed(() => ({
  modified: files.value.filter((file) => file.status === "M").length,
  added: files.value.filter((file) => file.status === "A").length,
  deleted: files.value.filter((file) => file.status === "D").length,
}));

function lineKind(line) {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

function onListKeydown(event) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const index = files.value.findIndex((file) => file.path === selectedPath.value);
  const next = files.value[Math.max(0, Math.min(files.value.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
  selectedPath.value = next.path;
  event.currentTarget.querySelector(`[data-diff-path="${CSS.escape(next.path)}"]`)?.focus();
}
</script>

<template>
  <div>
    <ReleasePageHead page-id="clientDiff" />

    <div class="wb-rf-stack">
      <div class="wb-rf-stats">
        <div class="wb-rf-stat"><strong>{{ files.length }}</strong><span>{{ t('releaseFlow.diff.files') }}</span></div>
        <div class="wb-rf-stat"><strong>{{ counts.modified }}</strong><span>{{ t('releaseFlow.files.modified') }}</span></div>
        <div class="wb-rf-stat is-success"><strong>{{ counts.added }}</strong><span>{{ t('releaseFlow.files.added') }}</span></div>
        <div class="wb-rf-stat is-warning"><strong>{{ counts.deleted }}</strong><span>{{ t('releaseFlow.files.deleted') }}</span></div>
      </div>

      <div class="wb-rf-diff">
        <ul class="wb-rf-list wb-rf-diff-files" role="listbox" :aria-label="t('releaseFlow.diff.files')" @keydown="onListKeydown">
          <li v-for="file in files" :key="file.path">
            <button
              type="button"
              role="option"
              class="wb-rf-diff-file"
              :data-diff-path="file.path"
              :aria-selected="file.path === selected.path"
              :tabindex="file.path === selected.path ? 0 : -1"
              @click="selectedPath = file.path"
            >
              <span class="wb-rf-diff-status" :class="`is-${file.status}`">{{ file.status }}</span>
              <span class="wb-rf-code wb-rf-diff-name">
                <strong>{{ file.path.split('/').pop() }}</strong>
                <small>{{ file.path.split('/').slice(0, -1).join('/') }}</small>
              </span>
              <span class="wb-rf-diff-delta">
                <span v-if="file.added" class="is-add">+{{ file.added }}</span>
                <span v-if="file.removed" class="is-remove">−{{ file.removed }}</span>
              </span>
            </button>
          </li>
        </ul>
        <div class="wb-rf-diff-view">
          <div class="wb-rf-diff-head wb-rf-code">{{ selected.path }}</div>
          <p v-if="selected.binary" class="wb-rf-empty">{{ t('releaseFlow.diff.binary') }}</p>
          <pre v-else class="wb-rf-diff-lines" tabindex="0" :aria-label="t('releaseFlow.diff.content', { path: selected.path })"><span
            v-for="(line, index) in selected.lines"
            :key="index"
            class="wb-rf-diff-line"
            :class="`is-${lineKind(line)}`"
          >{{ line }}</span></pre>
        </div>
      </div>

      <p class="wb-rf-hint">{{ t('releaseFlow.diff.hint') }}</p>

      <ReleaseTaskPanel :flow="flow" task-id="client.diff" :show-log="false">
        <template #done="{ result }">
          <strong>{{ t('releaseFlow.diff.done', { count: result.files }) }}</strong>
        </template>
      </ReleaseTaskPanel>
    </div>
  </div>
</template>

<style scoped>
.wb-rf-diff {
  display: grid;
  grid-template-columns: minmax(240px, 0.8fr) minmax(0, 2fr);
  min-height: 380px;
  overflow: hidden;
  border: 1px solid var(--wb-border);
  border-radius: 10px;
  background: var(--wb-table-surface);
}

.wb-rf-diff-files {
  max-height: 460px;
  padding: 6px;
  overflow-y: auto;
  border-right: 1px solid var(--wb-line);
}

.wb-rf-diff-file {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 40px;
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-weight: 400;
  text-align: left;
}

.wb-rf-diff-file:hover:not(:disabled) {
  border: none;
  background: var(--wb-list-hover);
}

.wb-rf-diff-file[aria-selected="true"] {
  background: var(--wb-list-selected);
}

.wb-rf-diff-status {
  display: grid;
  flex: none;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  background: var(--wb-accent-soft);
  font-family: var(--wb-font-mono, ui-monospace, monospace);
  font-size: 11px;
  font-weight: 700;
}

.wb-rf-diff-status.is-A { background: var(--wb-success-surface); color: var(--wb-success-text); }
.wb-rf-diff-status.is-D { background: var(--wb-warning-surface); color: var(--wb-warning-text); }

.wb-rf-diff-name {
  display: grid;
  flex: 1 1 auto;
  min-width: 0;
}

.wb-rf-diff-name strong,
.wb-rf-diff-name small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-rf-diff-name strong {
  color: var(--wb-text);
  font-weight: 600;
}

.wb-rf-diff-name small {
  color: var(--wb-quiet-text);
  font-size: 11px;
}

.wb-rf-diff-delta {
  display: flex;
  flex: none;
  gap: 6px;
  font-family: var(--wb-font-mono, ui-monospace, monospace);
  font-size: 11px;
}

.wb-rf-diff-delta .is-add { color: var(--wb-success-text); }
.wb-rf-diff-delta .is-remove { color: var(--wb-danger); }

.wb-rf-diff-view {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
}

.wb-rf-diff-head {
  padding: 9px 14px;
  border-bottom: 1px solid var(--wb-line);
  background: var(--wb-grid-header);
  color: var(--wb-secondary-text);
}

.wb-rf-diff-lines {
  max-height: 420px;
  margin: 0;
  padding: 8px 0;
  overflow: auto;
  font-family: var(--wb-font-mono, ui-monospace, "Cascadia Mono", Consolas, monospace);
  font-size: 12px;
  line-height: 1.7;
  user-select: text;
}

.wb-rf-diff-line {
  display: block;
  padding: 0 14px;
  white-space: pre;
}

.wb-rf-diff-line.is-hunk {
  margin: 4px 0;
  background: var(--wb-accent-soft);
  color: var(--wb-secondary-text);
}

.wb-rf-diff-line.is-add {
  background: var(--wb-success-surface);
  color: var(--wb-success-text);
}

.wb-rf-diff-line.is-remove {
  background: var(--wb-danger-surface);
  color: var(--wb-danger-text);
}
</style>
