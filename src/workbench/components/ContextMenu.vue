<script setup>
import { computed } from 'vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  tableScoped: { type: Boolean, default: false },
});

const emit = defineEmits(['refresh', 'open-design']);

const contextMenuStyle = computed(() => ({
  left: `${props.x}px`,
  top: `${props.y}px`,
}));
</script>

<template>
  <menu v-if="open" class="wb-context-menu" :style="contextMenuStyle" @click.stop>
    <button v-if="tableScoped" type="button" @click="emit('open-design')">表设计</button>
    <button type="button" @click="emit('refresh')">刷新</button>
  </menu>
</template>
