<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ArrowLeft, ArrowRight, Check, ChevronRight, CircleCheck, Download, FlaskConical, LoaderCircle, RotateCcw, ShieldCheck, X } from "lucide-vue-next";
import { t, language } from "../i18n/index.js";
import { useEscClose } from "../composables/useEscClose.js";
import { useConfirm } from "../composables/useConfirm.js";
import { useReleaseWorkflow } from "../composables/useReleaseWorkflow.js";
import { RELEASE_ACTIONS, RELEASE_PLATFORMS, RELEASE_STEPS, stepActions, stepComplete } from "../releaseWorkflowState.js";
import ReleasePrepareStage from "./ReleasePrepareStage.vue";
import ReleaseDatabaseStage from "./ReleaseDatabaseStage.vue";
import ReleaseClientStage from "./ReleaseClientStage.vue";
import ReleaseBuildStage from "./ReleaseBuildStage.vue";
import ReleaseGmStage from "./ReleaseGmStage.vue";
import ReleaseLaunchStage from "./ReleaseLaunchStage.vue";
import "../releaseWorkflow.css";

defineProps({ templates: { type: Array, default: () => [] } });
const emit = defineEmits(["close"]);
const workflow = useReleaseWorkflow();
const { state, draft, config, busy, progress, nextAction, blocked, doneCount, complete, persistenceError, invalidated } = workflow;
const dialogRef = ref(null);
const contentRef = ref(null);
const currentComplete = computed(() => stepComplete(draft.value, state.step));
const currentActions = computed(() => stepActions(state.step, config.value));
const { confirm } = useConfirm();

function close() { workflow.cancel(); emit("close"); }
useEscClose(() => true, close, null, { dialogRef });
onBeforeUnmount(workflow.dispose);
watch(() => state.step, async () => {
  await nextTick();
  if (contentRef.value) contentRef.value.scrollTop = 0;
  contentRef.value?.querySelector("h2")?.focus({ preventScroll: true });
});

function stepStatus(step) {
  if (stepComplete(draft.value, step)) return "done";
  const statuses = Object.entries(draft.value.results).filter(([key]) => RELEASE_ACTIONS[key].step === step).map(([, value]) => value);
  return ["running", "blocked", "failed", "cancelled"].find((status) => statuses.includes(status)) || "pending";
}

async function reset() {
  if (await confirm({ title: t("release.resetTitle"), message: t("release.resetBody"), confirmText: t("release.reset"), cancelText: t("release.keepDraft"), danger: true })) workflow.reset();
}

function exportReport() {
  const url = URL.createObjectURL(new Blob([workflow.report()], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `release-DEMO-${state.platform}-${config.value.date || "draft"}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timeLabel(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(language.locale.value, {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date) : "—";
}
</script>

<template>
  <div class="wb-dialog-overlay rw-overlay">
    <section ref="dialogRef" class="rw-workspace" role="dialog" aria-modal="true" aria-labelledby="rw-title" aria-describedby="rw-safety" tabindex="-1">
      <header class="rw-header">
        <div class="rw-title-group"><h1 id="rw-title">{{ t('release.title') }}</h1><span class="rw-demo-badge"><FlaskConical :size="13" />{{ t('release.demo') }}</span></div>
        <button type="button" class="rw-btn rw-leave" @click="close">{{ t('release.close') }}<X :size="16" /></button>
      </header>
      <div class="rw-body">
        <aside class="rw-sidebar">
          <label class="rw-field">{{ t('release.platform') }}<select :value="state.platform" :disabled="!!busy" @change="workflow.switchPlatform($event.target.value)"><option v-for="id in RELEASE_PLATFORMS" :key="id" :value="id">{{ t('release.platformName', { name: id.toUpperCase() }) }} · {{ t('release.sample') }}</option></select></label>
          <p class="rw-platform-hint">{{ t('release.platformHint') }}</p>
          <nav class="rw-step-nav" :aria-label="t('release.flowTitle')">
            <button v-for="(step, index) in RELEASE_STEPS" :key="step" type="button" :data-release-step="index" :class="{ 'is-active': state.step === index, 'is-complete': stepStatus(index) === 'done' }" :aria-current="state.step === index ? 'step' : undefined" :disabled="!!busy" @click="workflow.go(index)">
              <span class="rw-step-number"><Check v-if="stepStatus(index) === 'done'" :size="15" /><LoaderCircle v-else-if="stepStatus(index) === 'running'" :size="15" class="rw-spinning" /><template v-else>{{ String(index + 1).padStart(2, '0') }}</template></span>
              <span><strong>{{ t(`release.step_${step}`) }}</strong><small>{{ t(`release.state_${stepStatus(index)}`) }}</small></span><ChevronRight v-if="state.step === index" :size="14" />
            </button>
          </nav>
          <div class="rw-sidebar-bottom"><p>{{ t('release.progress', { done: doneCount }) }}</p><progress :value="doneCount" max="6" :aria-label="t('release.flowTitle')" /><small :class="{ 'rw-warning-text': persistenceError }">{{ t(`release.${persistenceError ? 'unsaved' : 'saved'}`) }}</small></div>
          <div class="rw-compact-tools"><button type="button" class="rw-btn rw-subtle" :disabled="!!busy" @click="exportReport"><Download :size="14" />{{ t('release.export') }}</button><button type="button" class="rw-btn rw-subtle" :disabled="!!busy" @click="reset"><RotateCcw :size="14" />{{ t('release.reset') }}</button></div>
        </aside>
        <div class="rw-center">
          <div id="rw-safety" class="rw-safety"><ShieldCheck :size="17" /><span>{{ t('release.safety') }}</span></div>
          <p v-if="persistenceError" class="rw-storage-warning" role="alert">{{ t('release.unsaved') }}</p>
          <div ref="contentRef" class="rw-content">
            <div class="rw-content-heading"><div><h2 tabindex="-1">{{ t(`release.step_${RELEASE_STEPS[state.step]}`) }}</h2><p>{{ t(`release.intro_${RELEASE_STEPS[state.step]}`) }}</p></div><span class="rw-stage-count">{{ String(state.step + 1).padStart(2, '0') }} / 06</span></div>
            <p v-if="invalidated" class="rw-warning-panel" role="status">{{ t('release.invalidated') }}</p>
            <p v-if="state.step > 0 && !stepComplete(draft, state.step - 1)" class="rw-inline-note">{{ t('release.prereq') }}</p>
            <ReleasePrepareStage v-if="state.step === 0" :workflow="workflow" />
            <ReleaseDatabaseStage v-else-if="state.step === 1" :workflow="workflow" />
            <ReleaseClientStage v-else-if="state.step === 2" :workflow="workflow" :templates="templates" />
            <ReleaseBuildStage v-else-if="state.step === 3" :workflow="workflow" />
            <ReleaseGmStage v-else-if="state.step === 4" :workflow="workflow" />
            <ReleaseLaunchStage v-else :workflow="workflow" />
            <details class="rw-details rw-log">
              <summary>{{ t('release.log') }} <span>{{ draft.logs.length }}</span></summary>
              <p v-if="!draft.logs.length" class="rw-help">{{ t('release.emptyLog') }}</p>
              <ol v-else><li v-for="(log, index) in [...draft.logs].reverse()" :key="draft.logs.length - index"><time :datetime="log.time">{{ timeLabel(log.time) }}</time><span>{{ t(`release.action_${log.action}`) }}</span><span :class="{ 'rw-success': log.status === 'done', 'rw-warning-text': ['failed', 'blocked'].includes(log.status) }">{{ t(`release.state_${log.status}`) }}</span></li></ol>
            </details>
          </div>
          <footer class="rw-footer">
            <div class="rw-footer-status" aria-live="polite">
              <template v-if="busy"><LoaderCircle :size="14" class="rw-spinning" /><span>{{ t(`release.action_${busy}`) }}</span><progress :value="progress" max="100" :aria-label="t(`release.action_${busy}`)" /></template>
              <template v-else-if="currentComplete"><CircleCheck :size="16" class="rw-success" /><span>{{ t(complete ? 'release.finished' : 'release.state_done') }}</span></template>
              <template v-else-if="blocked"><span>{{ t(`release.error_${blocked}`) }}</span></template>
              <template v-else><span>{{ currentActions.filter(action => draft.results[action] === 'done').length }} / {{ currentActions.length }}</span><span>{{ t(`release.action_${nextAction}`) }}</span></template>
            </div>
            <div class="rw-footer-buttons">
              <button type="button" class="rw-btn" :disabled="!!busy || state.step === 0" @click="workflow.go(state.step - 1)"><ArrowLeft :size="14" />{{ t('release.previous') }}</button>
              <button v-if="busy" type="button" class="rw-btn" data-release-primary @click="workflow.cancel">{{ t('release.cancel') }}</button>
              <button v-else-if="currentComplete && state.step < 5" type="button" class="rw-btn rw-primary" data-release-primary @click="workflow.go(state.step + 1)">{{ t('release.next', { stage: t(`release.step_${RELEASE_STEPS[state.step + 1]}`) }) }}<ArrowRight :size="15" /></button>
              <button v-else-if="complete && state.step === 5" type="button" class="rw-btn rw-primary" data-release-primary @click="exportReport"><Download :size="15" />{{ t('release.export') }}</button>
              <button v-else type="button" class="rw-btn rw-primary" data-release-primary :disabled="!!blocked || !nextAction" @click="workflow.run()">{{ t(['failed', 'blocked', 'cancelled'].includes(draft.results[nextAction]) ? 'release.retry' : 'release.simulate', { action: t(`release.action_${nextAction}`) }) }}<ArrowRight :size="15" /></button>
            </div>
          </footer>
        </div>
        <aside class="rw-context">
          <h3>{{ t('release.currentTarget') }}</h3><strong class="rw-target-name">{{ t('release.platformName', { name: state.platform.toUpperCase() }) }}</strong><span class="rw-tag">{{ t('release.sample') }}</span>
          <dl><dt>{{ t('release.version') }}</dt><dd>{{ config.version || '—' }}</dd><dt>{{ t('release.date') }}</dt><dd>{{ config.date || '—' }}</dd><dt>{{ t('release.targetDb') }}</dt><dd><code>{{ config.targetDb || '—' }}</code></dd><dt>{{ t('release.targetClient') }}</dt><dd><code>{{ config.targetClient || '—' }}</code></dd><dt>{{ t('release.clientOpen') }}</dt><dd>{{ config.clientOpen.replace('T', ' ') || '—' }}<small>UTC+8</small></dd></dl>
          <div class="rw-context-tools"><button type="button" class="rw-btn" :disabled="!!busy" @click="exportReport"><Download :size="14" />{{ t('release.export') }}</button><button type="button" class="rw-btn rw-subtle" :disabled="!!busy" @click="reset"><RotateCcw :size="14" />{{ t('release.reset') }}</button></div>
        </aside>
      </div>
    </section>
  </div>
</template>
