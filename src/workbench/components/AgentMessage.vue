<script setup>
const props = defineProps({
  message: { type: Object, required: true },
});
</script>

<template>
  <article class="wb-ai-message" :class="`is-${message.role}`">
    <div class="wb-ai-message-role">{{ message.role === "assistant" ? "Agent" : "你" }}</div>
    <div v-if="message.thinking" class="wb-ai-thinking">
      <em>思考：</em>
      <pre>{{ message.thinking }}</pre>
    </div>
    <ul v-if="message.toolUses?.length" class="wb-ai-tool-list" aria-label="工具调用">
      <li v-for="tool in message.toolUses" :key="tool.id">
        <span class="wb-ai-tool-status" aria-hidden="true"></span>
        <div>
          <strong>{{ tool.name }}</strong>
          <code>{{ JSON.stringify(tool.input) }}</code>
        </div>
      </li>
    </ul>
    <ul v-if="message.toolResults?.length" class="wb-ai-tool-list wb-ai-tool-results" aria-label="工具结果">
      <li v-for="result in message.toolResults" :key="result.id">
        <span class="wb-ai-tool-status" :class="{ 'is-error': result.isError }" aria-hidden="true"></span>
        <div>
          <strong>{{ result.summary || '工具结果' }}</strong>
        </div>
      </li>
    </ul>
    <p>{{ message.content }}</p>
  </article>
</template>
