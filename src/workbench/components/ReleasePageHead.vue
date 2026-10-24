<script setup>
// Heading of a release workspace page: its phase, title and what it does.
// The title takes focus when the page opens, so screen readers announce it.
import { computed } from "vue";
import { Unplug } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { RELEASE_PAGE_BY_ID, RELEASE_PHASES } from "../releaseFlowState.js";
import { pageTitle, phaseTitle } from "../utils/releaseFlowFormat.js";

const props = defineProps({
  pageId: { type: String, required: true },
  eyebrow: { type: String, default: "" },
  description: { type: String, default: "" },
});

const phase = computed(() => RELEASE_PAGE_BY_ID.get(props.pageId)?.phase || "");
const eyebrowText = computed(() => {
  if (props.eyebrow) return props.eyebrow;
  if (!phase.value) return "";
  return t("releaseFlow.phaseEyebrow", { number: RELEASE_PHASES.indexOf(phase.value) + 1, phase: phaseTitle(phase.value) });
});
const descriptionText = computed(() => props.description || t(`releaseFlow.page.${props.pageId}.description`));
</script>

<template>
  <header class="wb-rf-page-head">
    <span v-if="eyebrowText" class="wb-rf-eyebrow">{{ eyebrowText }}</span>
    <h3 tabindex="-1">{{ pageTitle(pageId) }}</h3>
    <p>{{ descriptionText }}</p>
    <!-- No GM API is connected yet; say so where the GM steps begin. -->
    <p v-if="phase === 'gm'" class="wb-rf-gm-simulated">
      <Unplug :size="13" aria-hidden="true" />
      <span>{{ t('releaseFlow.gm.simulated') }}</span>
    </p>
  </header>
</template>

<style scoped>
.wb-rf-gm-simulated {
  display: flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  margin-top: 6px;
  padding: 3px 10px;
  border: 1px dashed var(--wb-border-strong);
  border-radius: 999px;
  font-size: 12px;
}
</style>
