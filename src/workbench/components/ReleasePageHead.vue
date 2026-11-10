<script setup>
// Heading of a release workspace page: its title and one short line. The
// title takes focus when the page opens, so screen readers announce it.
import { computed } from "vue";
import { t } from "../i18n/index.js";
import { pageTitle } from "../utils/releaseFlowFormat.js";

const props = defineProps({
  pageId: { type: String, required: true },
  description: { type: String, default: "" },
});

const descriptionText = computed(() => props.description
  || t(`releaseFlow.page.${props.pageId}.description`));
</script>

<template>
  <header class="wb-rf-page-head">
    <div class="wb-rf-page-title">
      <h3 tabindex="-1">{{ pageTitle(pageId) }}</h3>
      <slot name="tag" />
    </div>
    <p>{{ descriptionText }}</p>
  </header>
</template>

<style scoped>
.wb-rf-page-title {
  display: flex;
  align-items: center;
  gap: 10px;
}
</style>
