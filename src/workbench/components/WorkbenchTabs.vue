<script setup>
import { nextTick, ref, watch } from "vue";

const props = defineProps({
  tabs: { type: Array, default: () => [] },
  activeTabId: { type: String, default: "" },
});

const emit = defineEmits(["activate-tab", "close-tab"]);

const tabBarRef = ref(null);

watch(
  () => props.activeTabId,
  async () => {
    await nextTick();
    const activeTab = tabBarRef.value?.querySelector(".wb-tab.active");
    activeTab?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  },
);
</script>

<template>
  <section class="wb-object-tabs wb-tabs" ref="tabBarRef">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      :class="['wb-tab', { active: tab.id === activeTabId }]"
      @click="emit('activate-tab', tab.id)"
    >
      <span class="wb-object-icon" data-kind="table"></span>
      <span class="wb-tab-title" :title="`${tab.connectionId || ''}/${tab.database || ''}.${tab.tableName}`">
        {{ tab.tableName }}
        <small v-if="tab.database">{{ tab.database }}</small>
      </span>
      <span class="wb-tab-close" @click.stop="emit('close-tab', tab.id)">×</span>
    </button>
  </section>
</template>
