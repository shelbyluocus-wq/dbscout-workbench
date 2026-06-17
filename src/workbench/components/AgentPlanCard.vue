<script setup>
import { ref, computed } from "vue";
import { renderMarkdown } from "../utils/markdown.js";

const props = defineProps({
  plan: { type: Object, required: true },
});

const emit = defineEmits(["approve", "deny"]);

const feedback = ref("");
const expanded = ref(true);

const rendered = computed(() => renderMarkdown(props.plan.text || "").html);

function approve() {
  emit("approve", props.plan.reqId);
}

function deny() {
  emit("deny", props.plan.reqId, feedback.value || "用户拒绝了该计划");
}
</script>

<template>
  <article class="wb-ai-plan-card" aria-live="polite">
    <header class="wb-ai-plan-header">
      <span class="wb-ai-plan-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3L20 7.5V16.5L12 21L4 16.5V7.5L12 3Z" />
          <path d="M12 12L12 21" />
          <path d="M12 12L20 7.5" />
          <path d="M12 12L4 7.5" />
        </svg>
      </span>
      <strong>执行计划</strong>
      <button
        type="button"
        class="wb-ai-plan-toggle"
        :aria-expanded="expanded"
        :aria-label="expanded ? '收起计划' : '展开计划'"
        @click="expanded = !expanded"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <polyline v-if="expanded" points="18,15 12,9 6,15" />
          <polyline v-else points="6,9 12,15 18,9" />
        </svg>
      </button>
    </header>

    <div v-show="expanded" class="wb-ai-plan-body">
      <div v-if="rendered" class="wb-ai-plan-text wb-md" v-html="rendered"></div>
      <p v-else class="wb-ai-plan-empty">Agent 没有提供具体计划文本。</p>

      <label class="wb-ai-plan-feedback">
        <span>反馈（可选）</span>
        <textarea
          v-model="feedback"
          rows="2"
          placeholder="需要调整什么？留空直接拒绝。"
        ></textarea>
      </label>

      <div class="wb-ai-plan-actions">
        <button type="button" class="wb-ai-btn wb-ai-btn-secondary" @click="deny">
          拒绝
        </button>
        <button type="button" class="wb-ai-btn wb-ai-btn-primary" @click="approve">
          批准执行
        </button>
      </div>
    </div>
  </article>
</template>
