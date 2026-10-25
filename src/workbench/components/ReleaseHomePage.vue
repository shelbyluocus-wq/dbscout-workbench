<script setup>
// The overview: what needs attention across platforms, the open and
// scheduled updates, the open plans coming up this week, the latest records
// and the operations that can run right away.
import { computed, inject } from "vue";
import { ArrowRight, CalendarCheck2, FolderGit2, Package, Plus } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { RELEASE_TASK_BY_ID, localDateIso } from "../releaseFlowState.js";
import { addDays, formatPlanDate, parsePlanNote } from "../utils/releasePlanNotes.js";
import { formatDateTime, issueText } from "../utils/releaseFlowFormat.js";
import ReleaseHistoryList from "./ReleaseHistoryList.vue";
import ReleaseSectionHead from "./ReleaseSectionHead.vue";

const props = defineProps({
  workspace: { type: Object, required: true },
});

const openNewUpdate = inject("releaseNewUpdate", () => {});
const cards = computed(() => props.workspace.cards.value);
const today = localDateIso();

const issues = computed(() => cards.value.flatMap((card) => card.issues.map((issue, index) => ({ ...issue, card, key: `${card.platformId}-${index}` }))));
const open = computed(() => cards.value
  .filter((card) => card.runId && card.status !== "done")
  .sort((a, b) => (a.plannedAt || Infinity) - (b.plannedAt || Infinity)));
const recent = computed(() => props.workspace.history.value.slice(0, 5));
const counts = computed(() => ({
  active: cards.value.filter((card) => card.status === "active").length,
  attention: cards.value.filter((card) => card.status === "attention").length,
  pending: cards.value.filter((card) => card.status === "pending").length,
  week: props.workspace.history.value.filter((entry) => entry.kind === "release" && entry.outcome === "done" && Date.now() - entry.finishedAt < 7 * 86400000).length,
}));

// Memo entries whose note opens or closes them within the next week.
const upcoming = computed(() => {
  const end = addDays(today, 7);
  const rows = [];
  for (const entry of props.workspace.state.plans.items) {
    for (const platform of props.workspace.state.platforms) {
      const rule = parsePlanNote(entry.notes?.[platform.id], today);
      if (rule.kind !== "window") continue;
      for (const [date, change] of [[rule.from, "open"], [rule.to, "close"]]) {
        if (date && date >= today && date <= end) rows.push({ key: `${entry.id}-${platform.id}-${change}`, date, change, entry, platform });
      }
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8);
});

function goToIssue(issue) {
  const flow = props.workspace.flowFor(issue.card.runId);
  if (!flow) return;
  const page = issue.taskId ? RELEASE_TASK_BY_ID.get(issue.taskId)?.page : "brief";
  if (page) flow.go(page);
  props.workspace.openRun(issue.card.runId);
}

function openHistory(entryId) {
  props.workspace.ui.historyEntryId = entryId;
  props.workspace.openSection("history");
}

const ACTIONS = Object.freeze([
  { id: "new", icon: Plus },
  { id: "build", icon: Package, real: true },
  { id: "svn", icon: FolderGit2, real: true },
  { id: "plans", icon: CalendarCheck2 },
]);

function runAction(id) {
  if (id === "new") openNewUpdate();
  else props.workspace.openSection(id);
}
</script>

<template>
  <ReleaseSectionHead :workspace="workspace" :title="t('releaseFlow.home.title')" :description="t('releaseFlow.home.description')" />

  <div class="wb-rf-stats">
    <div class="wb-rf-stat"><strong>{{ counts.active }}</strong><span>{{ t('releaseFlow.home.active') }}</span></div>
    <div class="wb-rf-stat is-warning"><strong>{{ counts.attention }}</strong><span>{{ t('releaseFlow.home.attention') }}</span></div>
    <div class="wb-rf-stat is-muted"><strong>{{ counts.pending }}</strong><span>{{ t('releaseFlow.home.pending') }}</span></div>
    <div class="wb-rf-stat is-success"><strong>{{ counts.week }}</strong><span>{{ t('releaseFlow.home.week') }}</span></div>
  </div>

  <section class="wb-rf-group" aria-labelledby="wb-rf-home-actions">
    <div class="wb-rf-group-head"><h4 id="wb-rf-home-actions">{{ t('releaseFlow.home.actions') }}</h4></div>
    <div class="wb-rf-actions">
      <button v-for="action in ACTIONS" :key="action.id" type="button" class="wb-rf-action" :data-release-action="action.id" @click="runAction(action.id)">
        <span class="wb-rf-action-icon" aria-hidden="true"><component :is="action.icon" :size="17" /></span>
        <span class="wb-rf-action-text">
          <strong>{{ t(`releaseFlow.home.action.${action.id}`) }}</strong>
          <span>{{ t(`releaseFlow.home.action.${action.id}.hint`) }}</span>
        </span>
        <span v-if="action.real" class="wb-rf-chip is-accent">{{ t('releaseFlow.real') }}</span>
      </button>
    </div>
  </section>

  <div class="wb-rf-home-grid">
    <section class="wb-rf-card" aria-labelledby="wb-rf-home-issues">
      <div class="wb-rf-group-head">
        <h4 id="wb-rf-home-issues">{{ t('releaseFlow.home.issues') }}</h4>
        <span class="wb-rf-count">{{ issues.length }}</span>
      </div>
      <ul v-if="issues.length" class="wb-rf-list wb-rf-home-rows">
        <li v-for="issue in issues" :key="issue.key" :class="`is-${issue.tone}`">
          <strong>{{ issue.card.name }}</strong>
          <span>{{ issueText(issue) }}</span>
          <button type="button" class="wb-rf-link" @click="goToIssue(issue)">{{ t('releaseFlow.home.goTo') }}<ArrowRight :size="13" aria-hidden="true" /></button>
        </li>
      </ul>
      <p v-else class="wb-rf-empty">{{ t('releaseFlow.home.noIssues') }}</p>
    </section>

    <section class="wb-rf-card" aria-labelledby="wb-rf-home-open">
      <div class="wb-rf-group-head">
        <h4 id="wb-rf-home-open">{{ t('releaseFlow.home.open') }}</h4>
        <span class="wb-rf-count">{{ open.length }}</span>
      </div>
      <ul v-if="open.length" class="wb-rf-list wb-rf-home-rows">
        <li v-for="card in open" :key="card.platformId">
          <strong>{{ card.name }}</strong>
          <span>
            {{ t(`releaseFlow.card.status.${card.status}`) }}
            <template v-if="card.status !== 'pending'"> · {{ t('releaseFlow.card.progress', card.progress) }}</template>
            <template v-if="card.plannedAt"> · {{ t('releaseFlow.card.planned', { time: formatDateTime(card.plannedAt) }) }}</template>
          </span>
          <button type="button" class="wb-rf-link" @click="workspace.openRun(card.runId)">{{ t('releaseFlow.home.continue') }}<ArrowRight :size="13" aria-hidden="true" /></button>
        </li>
      </ul>
      <p v-else class="wb-rf-empty">{{ t('releaseFlow.home.noOpen') }}</p>
    </section>

    <section class="wb-rf-card" aria-labelledby="wb-rf-home-plans">
      <div class="wb-rf-group-head">
        <h4 id="wb-rf-home-plans">{{ t('releaseFlow.home.plans') }}</h4>
        <div class="wb-rf-group-tools">
          <button type="button" class="wb-rf-link" @click="workspace.openSection('plans')">{{ t('releaseFlow.home.allPlans') }}<ArrowRight :size="13" aria-hidden="true" /></button>
        </div>
      </div>
      <ul v-if="upcoming.length" class="wb-rf-list wb-rf-home-rows">
        <li v-for="row in upcoming" :key="row.key">
          <strong class="wb-rf-home-date">{{ formatPlanDate(row.date, today) }}</strong>
          <span>{{ row.platform.name }} · {{ t(`releaseFlow.home.plan.${row.change}`, { name: row.entry.name }) }}</span>
        </li>
      </ul>
      <p v-else class="wb-rf-empty">{{ t('releaseFlow.home.noPlans') }}</p>
    </section>

    <section class="wb-rf-card" aria-labelledby="wb-rf-home-recent">
      <div class="wb-rf-group-head">
        <h4 id="wb-rf-home-recent">{{ t('releaseFlow.home.recent') }}</h4>
        <div class="wb-rf-group-tools">
          <button type="button" class="wb-rf-link" @click="workspace.openSection('history')">{{ t('releaseFlow.home.allHistory') }}<ArrowRight :size="13" aria-hidden="true" /></button>
        </div>
      </div>
      <ReleaseHistoryList v-if="recent.length" :entries="recent" compact @select="openHistory" />
      <p v-else class="wb-rf-empty">{{ t('releaseFlow.home.noHistory') }}</p>
    </section>
  </div>
</template>
