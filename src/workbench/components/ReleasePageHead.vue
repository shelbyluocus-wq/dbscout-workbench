<script setup>
// Heading of a release workspace page: its title and one short line. The
// title takes focus when the page opens, so screen readers announce it.
import { computed, inject } from "vue";
import { t } from "../i18n/index.js";
import { pageTitle } from "../utils/releaseFlowFormat.js";

const props = defineProps({
  pageId: { type: String, required: true },
  description: { type: String, default: "" },
});

const runContext = inject("releaseRunContext", null);
const descriptionText = computed(() => props.description
  || t(`releaseFlow.page.${props.pageId}.description`));
</script>

<template>
  <header class="wb-rf-page-head">
    <div class="wb-rf-page-title">
      <h3 tabindex="-1">{{ pageTitle(pageId) }}</h3>
      <span v-if="runContext?.value" class="wb-rf-chip is-quiet">{{ runContext.value }}</span>
      <slot name="tag" />
    </div>
    <p>{{ descriptionText }}</p>
  </header>
</template>

<style scoped>
.wb-rf-page-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
}
</style>
