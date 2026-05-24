<script setup>
const props = defineProps({
  tabs: { type: Array, default: () => [] },
  activeTabId: { type: String, default: "" },
});

const emit = defineEmits(["activate-tab", "close-tab"]);
</script>

<template>
  <section class="wb-object-tabs wb-tabs">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      :class="['wb-tab', { active: tab.id === activeTabId }]"
      @click="emit('activate-tab', tab.id)"
    >
      <span class="wb-object-icon" data-kind="table"></span>
      {{ tab.tableName }}
      <span class="wb-tab-close" @click.stop="emit('close-tab', tab.id)">×</span>
    </button>
  </section>
</template>
