<script setup>
import { nextTick, ref, watch } from "vue";

const props = defineProps({
  tabs: { type: Array, default: () => [] },
  activeTabId: { type: String, default: "" },
});

const emit = defineEmits(["activate-tab", "close-tab", "tab-contextmenu"]);

const tabBarRef = ref(null);

function openTabContextMenu(event) {
  if (props.tabs.length === 0) return;
  emit("tab-contextmenu", { x: event.clientX, y: event.clientY });
}

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
  <section class="wb-object-tabs wb-tabs" ref="tabBarRef" @contextmenu.prevent.stop="openTabContextMenu">
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
