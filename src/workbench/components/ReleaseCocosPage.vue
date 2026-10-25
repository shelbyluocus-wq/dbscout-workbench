<script setup>
// Phase 3: build the platform client with Cocos Creator's command-line
// publishing, then run the client's own release guard on the output, so
// nobody has to open the editor and click Build by hand.
import { computed, onBeforeUnmount, ref } from "vue";
import { Check, Copy, Lightbulb } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { DEMO_BUILD_OUTPUT } from "../utils/releaseFlowDemo.js";
import { cocosMajorVersion, describeCocosExit } from "../utils/cocosBuildCommand.js";
import { formatReleaseCount } from "../utils/releaseFlowFormat.js";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleaseTaskPanel from "./ReleaseTaskPanel.vue";

const props = defineProps({
  flow: { type: Object, required: true },
});
defineEmits(["run", "rerun", "navigate"]);

const platform = computed(() => props.flow.platform.value);
const command = computed(() => props.flow.cocosCommand.value);
const legacy = computed(() => cocosMajorVersion(platform.value.cocosVersion) < 3);
const copied = ref(false);
let copiedTimer = null;
onBeforeUnmount(() => clearTimeout(copiedTimer));

const facts = computed(() => [
  { label: t("releaseFlow.cocos.version"), value: `Cocos Creator ${platform.value.cocosVersion}` },
  { label: t("releaseFlow.cocos.platform"), value: platform.value.buildPlatform },
  { label: t("releaseFlow.cocos.output"), value: DEMO_BUILD_OUTPUT },
]);

async function copyCommand() {
  try {
    await navigator.clipboard.writeText(command.value.display);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1600);
  } catch {
    copied.value = false;
  }
}

function exitText(result, error) {
  const code = Number.isFinite(result?.exitCode) ? result.exitCode : null;
  const meaning = t(`releaseFlow.cocos.exit.${describeCocosExit(platform.value.cocosVersion, code)}`);
  if (error === "buildFailed" && code !== null) return t("releaseFlow.cocos.failed", { code, meaning });
  return meaning;
}
</script>

<template>
  <ReleasePageHead page-id="build" />

  <dl class="wb-rf-facts">
    <div v-for="fact in facts" :key="fact.label" class="wb-rf-fact">
      <dt>{{ fact.label }}</dt>
      <dd class="wb-rf-code">{{ fact.value }}</dd>
    </div>
  </dl>

  <section class="wb-rf-group" aria-labelledby="wb-rf-cocos-command">
    <div class="wb-rf-group-head">
      <h4 id="wb-rf-cocos-command">{{ t('releaseFlow.cocos.command') }}</h4>
      <div class="wb-rf-group-tools">
        <button type="button" class="wb-rf-btn is-quiet is-small" @click="copyCommand">
          <Check v-if="copied" :size="13" aria-hidden="true" />
          <Copy v-else :size="13" aria-hidden="true" />
          {{ t(copied ? 'releaseFlow.cocos.copied' : 'releaseFlow.cocos.copy') }}
        </button>
      </div>
    </div>
    <pre class="wb-rf-log wb-rf-command">{{ command.display }}</pre>
    <details class="wb-rf-research">
      <summary><Lightbulb :size="14" aria-hidden="true" />{{ t('releaseFlow.cocos.research') }}</summary>
      <ul>
        <li>{{ t('releaseFlow.cocos.research.supported') }}</li>
        <li>{{ t(legacy ? 'releaseFlow.cocos.research.legacy' : 'releaseFlow.cocos.research.exitCodes') }}</li>
        <li>{{ t('releaseFlow.cocos.research.guard') }}</li>
        <li>{{ t('releaseFlow.cocos.research.desktop') }}</li>
      </ul>
    </details>
  </section>

  <ReleaseTaskPanel :flow="flow" task-id="build.cocos">
    <template #done="{ result }">
      <strong>{{ t('releaseFlow.cocos.done', { code: result.exitCode }) }}</strong>
      <span>{{ t('releaseFlow.cocos.qaPassed', { count: formatReleaseCount(result.qaChecked) }) }}</span>
      <span>{{ t('releaseFlow.cocos.hotUpdate', { version: result.hotUpdate }) }}</span>
    </template>
    <template #failed="{ result, error }">
      <span>{{ exitText(result, error) }}</span>
    </template>
  </ReleaseTaskPanel>
</template>

<style scoped>
.wb-rf-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 40px;
  margin: 0;
}

.wb-rf-fact {
  display: grid;
  gap: 4px;
}

.wb-rf-fact dt {
  color: var(--wb-secondary-text);
  font-size: 12px;
}

.wb-rf-fact dd {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.wb-rf-command {
  max-height: none;
  white-space: pre-wrap;
}

.wb-rf-research summary {
  display: flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  color: var(--wb-secondary-text);
  font-size: 12.5px;
  cursor: pointer;
}

.wb-rf-research summary svg {
  color: var(--wb-warning-text);
}

.wb-rf-research ul {
  display: grid;
  gap: 6px;
  margin: 10px 0 0;
  padding-left: 20px;
  color: var(--wb-secondary-text);
  font-size: 12.5px;
  line-height: 1.65;
}
</style>
