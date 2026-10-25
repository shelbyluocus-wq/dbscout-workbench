<script setup>
// Heading of a workspace page (overview, history, open plans, build, SVN,
// platform settings): a way back to the update it was opened from, the
// title, one line, and room for the page's own actions.
import { computed } from "vue";
import { ArrowLeft } from "lucide-vue-next";
import { t } from "../i18n/index.js";

const props = defineProps({
  workspace: { type: Object, required: true },
  title: { type: String, required: true },
  description: { type: String, default: "" },
});

const back = computed(() => {
  const target = props.workspace.view.returnTo;
  if (target?.section === "run") {
    const run = props.workspace.flowFor(target.runId);
    return run ? t("releaseFlow.section.backToRun", { platform: run.platform.value.name }) : "";
  }
  if (target?.section === "platform") return t("releaseFlow.section.backToPlatform", { platform: props.workspace.platformById(target.platformId)?.name || "" });
  return target?.section === "home" ? t("releaseFlow.section.backToHome") : "";
});
</script>

<template>
  <header class="wb-rf-page-head wb-rf-section-head">
    <button v-if="back" type="button" class="wb-rf-link wb-rf-back" data-release-back @click="workspace.back()">
      <ArrowLeft :size="13" aria-hidden="true" />{{ back }}
    </button>
    <div class="wb-rf-section-title">
      <h3 tabindex="-1">{{ title }}</h3>
      <slot name="tag" />
      <div v-if="$slots.actions" class="wb-rf-section-actions"><slot name="actions" /></div>
    </div>
    <p v-if="description">{{ description }}</p>
  </header>
</template>
