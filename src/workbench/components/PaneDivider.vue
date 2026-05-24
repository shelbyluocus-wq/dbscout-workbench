<script setup>
const props = defineProps({
  side: { type: String, required: true },
  collapsed: { type: Boolean, default: false },
});

const emit = defineEmits(["drag-start", "toggle"]);
</script>

<template>
  <div
    class="wb-pane-divider"
    :class="{ 'wb-pane-divider--left': side === 'left', 'wb-pane-divider--right': side === 'right' }"
    @mousedown="emit('drag-start', $event)"
    @dblclick="emit('toggle')"
  >
    <button class="wb-pane-toggle" @click.stop="emit('toggle')" :title="collapsed ? '展开' : '收起'">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <template v-if="side === 'left'">
          <polyline v-if="collapsed" points="3,1.5 7.5,5 3,8.5" />
          <polyline v-else points="7,1.5 2.5,5 7,8.5" />
        </template>
        <template v-else>
          <polyline v-if="collapsed" points="7,1.5 2.5,5 7,8.5" />
          <polyline v-else points="3,1.5 7.5,5 3,8.5" />
        </template>
      </svg>
    </button>
  </div>
</template>
