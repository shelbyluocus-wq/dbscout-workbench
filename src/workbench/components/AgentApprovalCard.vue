<script setup>
const props = defineProps({
  approval: { type: Object, required: true },
});

const emit = defineEmits(["approve", "deny"]);
</script>

<template>
  <div class="wb-ai-approval-card">
    <div class="wb-ai-approval-title">工具执行请求</div>
    <div class="wb-ai-approval-body">
      <strong>{{ approval.toolName }}</strong>
      <code>{{ JSON.stringify(approval.input) }}</code>
    </div>
    <div class="wb-ai-approval-actions">
      <button type="button" @click="emit('deny', approval.reqId, '用户拒绝')">拒绝</button>
      <button type="button" class="wb-ai-primary" @click="emit('approve', approval.reqId)">批准</button>
    </div>
  </div>
</template>
