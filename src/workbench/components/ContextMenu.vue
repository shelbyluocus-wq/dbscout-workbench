<script setup>
import { computed } from 'vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
});

const emit = defineEmits(['refresh', 'set-null']);

const contextMenuStyle = computed(() => ({
  left: `${props.x}px`,
  top: `${props.y}px`,
}));
</script>

<template>
  <menu v-if="open" class="wb-context-menu" :style="contextMenuStyle" @click.stop>
    <button type="button" @click="emit('refresh')">刷新</button>
    <button type="button" @click="emit('set-null')">设为 NULL</button>
  </menu>
</template>
