<script setup>
// A working copy's changes after Cairn's changes view: conflicts, changes and
// files svn does not know yet, each with a check box; the selected file's
// diff beside the list; commit, revert (confirmed, with what is lost) and
// conflict resolution; and the log. Operations on the demo working copy are
// simulated and say so.
import { computed, ref } from "vue";
import { CircleAlert, GitCommitHorizontal, RefreshCw, RotateCcw } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useConfirm } from "../composables/useConfirm.js";
import { canCommit, canRevert, isConflict, svnErrorCode, svnErrorDetail } from "../composables/useSvnWorkspace.js";
import { formatDateTime } from "../utils/releaseFlowFormat.js";
import ReleaseSplitDiff from "./ReleaseSplitDiff.vue";

const props = defineProps({
  svn: { type: Object, required: true },
  simulated: { type: Boolean, default: false },
});

const { confirm } = useConfirm();
const state = props.svn.state;
const tab = ref("changes");
const layout = ref("split");
const busy = computed(() => Boolean(state.busy) || state.loading);
const LETTERS = Object.freeze({ modified: "M", added: "A", deleted: "D", replaced: "R", unversioned: "?", missing: "!", conflicted: "C", obstructed: "~", incomplete: "!", normal: "M" });
const MAX_LISTED = 12;

const groups = computed(() => [
  { id: "conflicts", entries: props.svn.conflicts.value },
  { id: "changes", entries: props.svn.changes.value },
  { id: "unversioned", entries: props.svn.unversioned.value },
].filter((group) => group.entries.length));
const committable = computed(() => props.svn.checkedPaths.value.filter((path) => canCommit(entryOf(path) || {})));
const revertable = computed(() => props.svn.checkedPaths.value.filter((path) => canRevert(entryOf(path) || {})));
const conflictsLeft = computed(() => props.svn.conflicts.value.length);
const commitBlocked = computed(() => busy.value || !committable.value.length || !state.message.trim() || conflictsLeft.value > 0);

function entryOf(path) {
  return state.entries.find((entry) => entry.path === path) || null;
}

function letter(entry) {
  if (entry.treeConflict || entry.item === "conflicted") return "C";
  if (entry.item === "normal" && entry.props === "modified") return "P";
  return LETTERS[entry.item] || "?";
}

function itemTitle(entry) {
  if (entry.treeConflict) return t("releaseFlow.svn.item.treeConflict");
  if (entry.item === "normal" && entry.props === "modified") return t("releaseFlow.svn.item.props");
  return t(`releaseFlow.svn.item.${entry.item}`);
}

function listed(paths) {
  const shown = paths.slice(0, MAX_LISTED);
  if (paths.length > MAX_LISTED) shown.push(t("releaseFlow.svn.andMore", { count: paths.length - MAX_LISTED }));
  return shown;
}

const note = computed(() => (props.simulated ? t("releaseFlow.svn.simulatedNote") : undefined));

function errorText(error) {
  const code = svnErrorCode(error);
  const key = `releaseFlow.svn.error.${code}`;
  const text = t(key);
  return text === key ? svnErrorDetail(error) : `${text}${svnErrorDetail(error) ? `（${svnErrorDetail(error).split("\n")[0]}）` : ""}`;
}

async function commit() {
  const paths = committable.value;
  const adds = paths.filter((path) => entryOf(path)?.item === "unversioned").length;
  const deletes = paths.filter((path) => entryOf(path)?.item === "missing").length;
  if (!(await confirm({
    title: t("releaseFlow.svn.commit.title", { count: paths.length }),
    message: [
      t("releaseFlow.svn.commit.message", { url: state.info?.url || state.root }),
      adds ? t("releaseFlow.svn.commit.adds", { count: adds }) : "",
      deletes ? t("releaseFlow.svn.commit.deletes", { count: deletes }) : "",
    ].filter(Boolean).join("\n"),
    items: listed(paths),
    note: note.value,
    confirmText: t("releaseFlow.svn.commit.action"),
    cancelText: t("releaseFlow.cancel"),
  }))) return;
  await props.svn.commit();
}

async function revert(paths = revertable.value) {
  if (!paths.length) return;
  const adds = paths.filter((path) => entryOf(path)?.item === "added").length;
  if (!(await confirm({
    title: t("releaseFlow.svn.revert.title", { count: paths.length }),
    message: [t("releaseFlow.svn.revert.message"), adds ? t("releaseFlow.svn.revert.adds", { count: adds }) : ""].filter(Boolean).join("\n"),
    items: listed(paths),
    note: note.value,
    confirmText: t("releaseFlow.svn.revert.action"),
    cancelText: t("releaseFlow.cancel"),
    danger: true,
  }))) return;
  await props.svn.revert(paths);
}

async function resolve(entry, accept) {
  if (!(await confirm({
    title: t("releaseFlow.svn.resolve.title", { path: entry.path }),
    message: t(`releaseFlow.svn.resolve.message.${accept}`),
    note: note.value,
    confirmText: t(`releaseFlow.svn.accept.${accept}`),
    cancelText: t("releaseFlow.cancel"),
    danger: accept !== "working",
  }))) return;
  await props.svn.resolve([entry.path], accept);
}

function openLog() {
  tab.value = "log";
  if (!state.logLoaded) void props.svn.loadLog();
}
</script>

<template>
  <div class="wb-rf-svn">
    <div class="wb-rf-svn-info">
      <span class="wb-rf-code wb-rf-svn-root" :title="state.root">{{ state.root }}</span>
      <span v-if="state.info?.url" class="wb-rf-code wb-rf-muted" :title="state.info.url">{{ state.info.url }}</span>
      <span v-if="state.info?.revision" class="wb-rf-chip">r{{ state.info.revision }}</span>
      <span class="wb-rf-chip" :class="simulated ? 'is-quiet' : 'is-accent'">{{ t(simulated ? 'releaseFlow.svn.simulated' : 'releaseFlow.real') }}</span>
      <button type="button" class="wb-rf-btn is-small is-quiet wb-rf-svn-refresh" :disabled="busy" @click="svn.refresh()">
        <RefreshCw :size="13" :class="{ 'wb-rf-spin': state.loading }" aria-hidden="true" />{{ t('releaseFlow.svn.refresh') }}
      </button>
    </div>

    <p v-if="state.error" class="wb-rf-notice is-danger" role="alert">
      <CircleAlert :size="15" aria-hidden="true" /><span>{{ errorText(state.error) }}</span>
    </p>

    <template v-else>
      <div class="wb-rf-segmented" role="tablist" :aria-label="t('releaseFlow.svn.tabs')">
        <button type="button" role="tab" :aria-selected="tab === 'changes'" data-svn-tab="changes" @click="tab = 'changes'">
          {{ t('releaseFlow.svn.tab.changes') }}<span class="wb-rf-count">{{ state.entries.length }}</span>
        </button>
        <button type="button" role="tab" :aria-selected="tab === 'log'" data-svn-tab="log" @click="openLog">{{ t('releaseFlow.svn.tab.log') }}</button>
      </div>

      <div v-if="tab === 'changes'" class="wb-rf-svn-body">
        <div class="wb-rf-svn-side">
          <p v-if="!state.entries.length && !state.loading" class="wb-rf-empty">{{ t('releaseFlow.svn.clean') }}</p>
          <section v-for="group in groups" :key="group.id" class="wb-rf-svn-group" :aria-label="t(`releaseFlow.svn.group.${group.id}`)">
            <div class="wb-rf-svn-group-head">
              <h5>{{ t(`releaseFlow.svn.group.${group.id}`) }}</h5>
              <span class="wb-rf-count">{{ group.entries.length }}</span>
            </div>
            <ul class="wb-rf-list">
              <li
                v-for="entry in group.entries"
                :key="entry.path"
                class="wb-rf-svn-entry"
                :class="{ 'is-selected': entry.path === state.selected }"
                :data-svn-path="entry.path"
              >
                <input
                  v-if="!isConflict(entry)"
                  type="checkbox"
                  :checked="Boolean(state.checked[entry.path])"
                  :disabled="busy"
                  :aria-label="t('releaseFlow.svn.check', { path: entry.path })"
                  @change="svn.setChecked(entry.path, $event.target.checked)"
                />
                <span v-else class="wb-rf-svn-check-gap" aria-hidden="true" />
                <button type="button" class="wb-rf-svn-entry-main" @click="svn.select(entry.path)">
                  <span class="wb-rf-svn-letter" :class="`is-${letter(entry)}`" :title="itemTitle(entry)">{{ letter(entry) }}</span>
                  <span class="wb-rf-code wb-rf-svn-path">
                    <strong>{{ entry.path.split('/').pop() }}</strong>
                    <small>{{ entry.path.split('/').slice(0, -1).join('/') }}</small>
                  </span>
                </button>
                <div v-if="isConflict(entry) && entry.path === state.selected" class="wb-rf-svn-resolve">
                  <p class="wb-rf-hint">{{ t(entry.treeConflict ? 'releaseFlow.svn.treeConflict' : 'releaseFlow.svn.textConflict') }}</p>
                  <div class="wb-rf-svn-resolve-actions">
                    <template v-if="!entry.treeConflict">
                      <button type="button" class="wb-rf-btn is-small" :disabled="busy" @click="resolve(entry, 'theirs-full')">{{ t('releaseFlow.svn.accept.theirs-full') }}</button>
                      <button type="button" class="wb-rf-btn is-small" :disabled="busy" @click="resolve(entry, 'mine-full')">{{ t('releaseFlow.svn.accept.mine-full') }}</button>
                    </template>
                    <button type="button" class="wb-rf-btn is-small is-quiet" :disabled="busy" @click="resolve(entry, 'working')">{{ t('releaseFlow.svn.accept.working') }}</button>
                  </div>
                </div>
              </li>
            </ul>
          </section>

          <div v-if="state.entries.length" class="wb-rf-svn-commit">
            <textarea
              v-model="state.message"
              class="wb-rf-input wb-rf-svn-message"
              rows="3"
              :placeholder="t('releaseFlow.svn.messagePlaceholder')"
              :aria-label="t('releaseFlow.svn.message')"
              :disabled="busy"
            />
            <p v-if="conflictsLeft" class="wb-rf-hint is-warning">{{ t('releaseFlow.svn.conflictsFirst', { count: conflictsLeft }) }}</p>
            <div class="wb-rf-svn-commit-actions">
              <button type="button" class="wb-rf-btn wb-rf-danger-text is-small" data-svn-revert :disabled="busy || !revertable.length" @click="revert()">
                <RotateCcw :size="13" aria-hidden="true" />{{ t('releaseFlow.svn.revertSelected', { count: revertable.length }) }}
              </button>
              <button type="button" class="wb-rf-btn is-primary is-small" data-svn-commit :disabled="commitBlocked" @click="commit">
                <GitCommitHorizontal :size="14" aria-hidden="true" />{{ t('releaseFlow.svn.commitSelected', { count: committable.length }) }}
              </button>
            </div>
          </div>

          <p v-if="state.notice" class="wb-rf-notice" :class="`is-${state.notice.tone}`" role="status">
            <template v-if="state.notice.tone === 'success'">
              {{ state.notice.kind === 'commit'
                ? t('releaseFlow.svn.done.commit', { revision: state.notice.result?.revision || '?' })
                : t(`releaseFlow.svn.done.${state.notice.kind}`, { count: state.notice.result?.paths?.length || 0 }) }}
            </template>
            <template v-else>{{ errorText(state.notice.error) }}</template>
          </p>
        </div>

        <ReleaseSplitDiff
          v-model:layout="layout"
          :file="state.diff"
          :loading="state.diffLoading"
          :error="state.diffError ? errorText(state.diffError) : ''"
        />
      </div>

      <div v-else class="wb-rf-svn-log">
        <p v-if="state.logLoading" class="wb-rf-empty">{{ t('releaseFlow.svn.logLoading') }}</p>
        <p v-else-if="state.logError" class="wb-rf-notice is-danger">{{ errorText(state.logError) }}</p>
        <p v-else-if="!state.log.length" class="wb-rf-empty">{{ t('releaseFlow.svn.logEmpty') }}</p>
        <ul v-else class="wb-rf-list wb-rf-svn-log-list">
          <li v-for="entry in state.log" :key="entry.revision" :data-svn-revision="entry.revision">
            <details>
              <summary>
                <span class="wb-rf-chip">r{{ entry.revision }}</span>
                <strong>{{ (entry.message || t('releaseFlow.svn.noMessage')).split('\n')[0] }}</strong>
                <span class="wb-rf-muted">{{ entry.author }} · {{ formatDateTime(entry.date) }} · {{ t('releaseFlow.svn.changedPaths', { count: entry.paths.length }) }}</span>
              </summary>
              <p v-if="entry.message.includes('\n')" class="wb-rf-svn-log-message">{{ entry.message }}</p>
              <ul class="wb-rf-list wb-rf-svn-log-paths">
                <li v-for="path in entry.paths" :key="path.path" class="wb-rf-code"><span class="wb-rf-svn-letter" :class="`is-${path.action}`">{{ path.action }}</span>{{ path.path }}</li>
              </ul>
            </details>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
