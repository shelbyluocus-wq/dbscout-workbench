<script setup>
import { computed } from "vue";

const props = defineProps({
  progress: { type: Object, required: true },
});

const STAGE_LABELS = {
  runtime: "运行时",
  native_cli: "本地执行文件",
  context: "数据库上下文",
  sdk: "会话启动",
  ready_wait: "等待就绪",
  ready: "已就绪",
};

const stageLabel = computed(() => {
  const stage = String(props.progress.stage || "runtime");
  return STAGE_LABELS[stage] || stage;
});
</script>

<template>
  <article class="wb-ai-startup-card" aria-live="polite">
    <div class="wb-ai-startup-mark" aria-hidden="true">
      <span></span>
    </div>
    <div class="wb-ai-startup-copy">
      <div class="wb-ai-startup-kicker">首次启动会稍慢，后续会复用已启动的进程</div>
      <h2>{{ progress.title }}</h2>
      <p>{{ progress.detail }}</p>
    </div>
    <div
      class="wb-ai-startup-progress"
      role="progressbar"
      :aria-valuenow="progress.percent"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="progress.title"
    >
      <span
        class="wb-ai-startup-progress-fill"
        :style="{ width: `${progress.percent}%` }"
      ></span>
    </div>
    <div class="wb-ai-startup-meta">
      <span>{{ stageLabel }}</span>
      <strong>{{ progress.percent }}%</strong>
    </div>
  </article>
</template>
