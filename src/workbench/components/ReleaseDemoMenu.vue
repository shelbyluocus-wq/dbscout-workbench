<script setup>
// The demo badge and its options: which simulated outcomes the steps take,
// how fast they run, where the sample data comes from, and resets. Real
// operations (the client build, the SVN tool, choosing excluded files) are
// named here so nobody mistakes them for part of the simulation.
import { computed, nextTick, ref } from "vue";
import { FlaskConical, SlidersHorizontal } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useConfirm } from "../composables/useConfirm.js";
import { isTauriRuntime } from "../utils/tauriBridge.js";

const props = defineProps({
  workspace: { type: Object, required: true },
});

const demo = computed(() => props.workspace.state.demo);
const busy = computed(() => props.workspace.anyBusy.value);
const preview = !isTauriRuntime();
const open = ref(false);
const menuRef = ref(null);
const buttonRef = ref(null);
const { confirm } = useConfirm();

function toggle() {
  open.value = !open.value;
  if (open.value) void nextTick(() => menuRef.value?.querySelector("input, button")?.focus());
}

function onKeydown(event) {
  if (event.key !== "Escape") return;
  // A handled Escape keeps the workspace open; only the menu closes.
  event.preventDefault();
  event.stopPropagation();
  open.value = false;
  buttonRef.value?.focus();
}

function onFocusOut(event) {
  const next = event.relatedTarget;
  if (next && (menuRef.value?.contains(next) || buttonRef.value?.contains(next))) return;
  open.value = false;
}

async function clearHistory() {
  open.value = false;
  if (!(await confirm({
    title: t("releaseFlow.demo.clearHistory.title"),
    message: t("releaseFlow.demo.clearHistory.message"),
    confirmText: t("releaseFlow.demo.clearHistory.action"),
    cancelText: t("releaseFlow.cancel"),
  }))) return;
  props.workspace.clearDemoHistory();
}

async function reset() {
  open.value = false;
  if (!(await confirm({
    title: t("releaseFlow.confirm.resetDemo.title"),
    message: t("releaseFlow.confirm.resetDemo.message"),
    confirmText: t("releaseFlow.confirm.resetDemo.action"),
    cancelText: t("releaseFlow.cancel"),
    danger: true,
  }))) return;
  props.workspace.resetDemo();
}
</script>

<template>
  <div class="wb-rf-demo" @focusout="onFocusOut">
    <span class="wb-rf-demo-badge" :title="t('releaseFlow.demo.badgeHint')">
      <FlaskConical :size="12" aria-hidden="true" />{{ t('releaseFlow.demo.badge') }}
    </span>
    <button
      ref="buttonRef"
      type="button"
      class="wb-rf-btn is-quiet"
      aria-haspopup="true"
      aria-controls="wb-rf-demo-menu"
      :aria-expanded="open"
      @click="toggle"
    >
      <SlidersHorizontal :size="14" aria-hidden="true" />{{ t('releaseFlow.demo.options') }}
    </button>
    <div
      v-if="open"
      id="wb-rf-demo-menu"
      ref="menuRef"
      class="wb-rf-menu"
      role="group"
      :aria-label="t('releaseFlow.demo.options')"
      @keydown="onKeydown"
    >
      <p class="wb-rf-menu-title">{{ t('releaseFlow.demo.optionsHint') }}</p>
      <label>
        <input type="checkbox" :checked="demo.conflicts" @change="workspace.setDemoOption('conflicts', $event.target.checked)" />
        {{ t('releaseFlow.demo.conflicts') }}
      </label>
      <label>
        <input type="checkbox" :checked="demo.missingFiles" @change="workspace.setDemoOption('missingFiles', $event.target.checked)" />
        {{ t('releaseFlow.demo.missingFiles') }}
      </label>
      <label v-if="preview">
        <input type="checkbox" :checked="demo.buildFailure" @change="workspace.setDemoOption('buildFailure', $event.target.checked)" />
        {{ t('releaseFlow.demo.buildFailure') }}
      </label>
      <div class="wb-rf-menu-row">
        <span>{{ t('releaseFlow.demo.speed') }}</span>
        <div class="wb-rf-segmented" role="radiogroup" :aria-label="t('releaseFlow.demo.speed')">
          <button
            v-for="speed in ['normal', 'fast']"
            :key="speed"
            type="button"
            role="radio"
            :aria-checked="demo.speed === speed"
            @click="workspace.setDemoOption('speed', speed)"
          >{{ t(`releaseFlow.demo.speed.${speed}`) }}</button>
        </div>
      </div>
      <p class="wb-rf-menu-title">{{ t('releaseFlow.demo.dataSource') }}</p>
      <p class="wb-rf-menu-title">{{ t(preview ? 'releaseFlow.demo.realPreview' : 'releaseFlow.demo.real') }}</p>
      <div class="wb-rf-menu-divider" />
      <button type="button" class="wb-rf-btn is-quiet wb-rf-menu-action" :disabled="busy" @click="clearHistory">
        {{ t('releaseFlow.demo.clearHistory') }}
      </button>
      <button type="button" class="wb-rf-btn is-quiet wb-rf-menu-action is-danger" :disabled="busy" @click="reset">
        {{ t('releaseFlow.demo.reset') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.wb-rf-demo {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
}

.wb-rf-demo .wb-rf-menu {
  right: 0;
}

.wb-rf-menu-action {
  justify-content: flex-start;
}

.wb-rf-menu-action.is-danger {
  color: var(--wb-danger);
}
</style>
