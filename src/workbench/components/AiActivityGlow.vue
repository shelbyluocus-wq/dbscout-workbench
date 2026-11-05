<script setup>
import { useAiActivityGlow } from "../composables/useAiActivityGlow.js";

defineProps({
  theme: { type: String, default: "light" },
});

const { active, level, label } = useAiActivityGlow();
</script>

<template>
  <div class="wb-ai-glow wb-floating-themed" :data-theme="theme" :class="{ 'is-active': active, 'is-write': level === 'write' }" aria-hidden="true">
    <div class="wb-ai-glow-edge"></div>
  </div>
  <Transition name="wb-ai-glow-pill">
    <div v-if="active" class="wb-ai-glow-pill wb-floating-themed" :data-theme="theme" :class="{ 'is-write': level === 'write' }" role="status">
      <span class="wb-ai-glow-dot"></span>
      <span>{{ label }}</span>
    </div>
  </Transition>
</template>
