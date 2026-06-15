<script setup>
const props = defineProps({
  assistant: { type: Object, required: true },
  tableSource: { type: String, default: "当前数据库" },
});

const emit = defineEmits(["send", "abort", "clear"]);
</script>

<template>
  <form class="wb-ai-composer" @submit.prevent="emit('send')">
    <textarea
      v-model="assistant.draft.value"
      :disabled="assistant.isBusy.value"
      rows="3"
      placeholder="How can I help you today?"
      @keydown.enter.exact.prevent="emit('send')"
    ></textarea>
    <div class="wb-ai-composer-footer">
      <span class="wb-ai-context-chip">{{ assistant.permissionMode.value }}</span>
      <span class="wb-ai-context-chip" :title="tableSource">{{ tableSource }}</span>
      <button type="button" :disabled="assistant.isBusy.value" @click="emit('clear')">清空</button>
      <button
        v-if="assistant.isBusy.value"
        type="button"
        @click="emit('abort')"
      >停止</button>
      <button v-else type="submit" :disabled="!assistant.draft.value.trim()">发送</button>
    </div>
  </form>
</template>
