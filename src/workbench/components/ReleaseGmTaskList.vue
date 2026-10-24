<script setup>
// The GM operations of one page, in order. Only the operation the page's
// main button runs next is emphasized.
import { computed } from "vue";
import { nextTaskOnPage } from "../releaseFlowState.js";
import ReleaseGmTaskCard from "./ReleaseGmTaskCard.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  pageId: { type: String, required: true },
  tasks: { type: Array, required: true },
  details: { type: Object, default: () => ({}) },
});
const emit = defineEmits(["run", "rerun"]);

const nextTask = computed(() => nextTaskOnPage(props.pageId, props.flow.state.tasks, props.flow.state.brief));
</script>

<template>
  <ol class="wb-rf-list wb-rf-gm-tasks">
    <ReleaseGmTaskCard
      v-for="taskId in tasks"
      :key="taskId"
      :flow="flow"
      :task-id="taskId"
      :detail="details[taskId] || ''"
      :next="taskId === nextTask"
      @run="emit('run', $event)"
      @rerun="emit('rerun', $event)"
    />
  </ol>
</template>

<style scoped>
.wb-rf-gm-tasks {
  display: grid;
  gap: 8px;
}
</style>
