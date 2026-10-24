<script setup>
// Phase 3: build the platform client with Cocos Creator's command-line
// publishing, so nobody has to open the editor and click Build by hand.
import { computed, onBeforeUnmount, ref } from "vue";
import { Check, Copy, Lightbulb } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { cocosMajorVersion, describeCocosExit } from "../utils/cocosBuildCommand.js";
import { formatReleaseBytes, formatReleaseCount } from "../utils/releaseFlowFormat.js";
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
  { label: t("releaseFlow.cocos.project"), value: platform.value.targetClient },
  { label: t("releaseFlow.cocos.config"), value: platform.value.buildConfig || t("releaseFlow.cocos.noConfig") },
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
  <div>
    <ReleasePageHead page-id="build" />

    <div class="wb-rf-stack">
      <dl class="wb-rf-facts">
        <div v-for="fact in facts" :key="fact.label" class="wb-rf-fact">
          <dt>{{ fact.label }}</dt>
          <dd class="wb-rf-code">{{ fact.value }}</dd>
        </div>
      </dl>

      <section class="wb-rf-section" aria-labelledby="wb-rf-cocos-command">
        <div class="wb-rf-section-head">
          <h4 id="wb-rf-cocos-command">{{ t('releaseFlow.cocos.command') }}</h4>
          <div class="wb-rf-section-tools">
            <button type="button" class="wb-rf-ghost wb-rf-copy" @click="copyCommand">
              <Check v-if="copied" :size="13" aria-hidden="true" />
              <Copy v-else :size="13" aria-hidden="true" />
              {{ t(copied ? 'releaseFlow.cocos.copied' : 'releaseFlow.cocos.copy') }}
            </button>
          </div>
        </div>
        <pre class="wb-rf-log wb-rf-command">{{ command.display }}</pre>
        <p class="wb-rf-hint">{{ t(legacy ? 'releaseFlow.cocos.commandHintLegacy' : 'releaseFlow.cocos.commandHint') }}</p>
      </section>

      <details class="wb-rf-section wb-rf-research" open>
        <summary>
          <Lightbulb :size="14" aria-hidden="true" />
          <strong>{{ t('releaseFlow.cocos.research') }}</strong>
          <span class="wb-rf-muted">{{ t('releaseFlow.cocos.researchSummary') }}</span>
        </summary>
        <ul>
          <li>{{ t('releaseFlow.cocos.research.supported') }}</li>
          <li>{{ t('releaseFlow.cocos.research.flags') }}</li>
          <li>{{ t('releaseFlow.cocos.research.exitCodes') }}</li>
          <li>{{ t('releaseFlow.cocos.research.desktop') }}</li>
        </ul>
        <p class="wb-rf-hint">{{ t('releaseFlow.cocos.research.source') }}</p>
      </details>

      <ReleaseTaskPanel :flow="flow" task-id="build.cocos">
        <template #done="{ result }">
          <strong>{{ t('releaseFlow.cocos.done', { code: result.exitCode }) }}</strong>
          <span class="wb-rf-code">{{ result.outputDir }}</span>
          <span>{{ t('releaseFlow.cocos.doneSize', { size: formatReleaseBytes(result.sizeBytes), files: formatReleaseCount(result.files) }) }}</span>
        </template>
        <template #failed="{ result, error }">
          <span>{{ exitText(result, error) }}</span>
        </template>
      </ReleaseTaskPanel>
    </div>
  </div>
</template>

<style scoped>
.wb-rf-facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
}

.wb-rf-fact {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--wb-border);
  border-radius: 10px;
  background: var(--wb-table-surface);
}

.wb-rf-fact dt {
  color: var(--wb-secondary-text);
  font-size: 12px;
}

.wb-rf-fact dd {
  margin: 0;
  overflow: hidden;
  color: var(--wb-text);
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-rf-copy {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.wb-rf-command {
  max-height: none;
  white-space: pre-wrap;
}

.wb-rf-research summary {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}

.wb-rf-research summary svg {
  color: var(--wb-warning-text);
}

.wb-rf-research > .wb-rf-hint {
  margin-top: 4px;
}

.wb-rf-research ul {
  display: grid;
  gap: 6px;
  margin: 4px 0 0;
  padding-left: 22px;
  font-size: 12.5px;
  line-height: 1.65;
}

@media (max-width: 1180px) {
  .wb-rf-facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
