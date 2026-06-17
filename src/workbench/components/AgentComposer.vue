<script setup>
const props = defineProps({
  assistant: { type: Object, required: true },
});

const emit = defineEmits(["send", "abort"]);

const MODE_OPTIONS = [
  { value: "default", label: "执行", description: "直接回答，写入操作需批准" },
  { value: "plan", label: "计划", description: "先出计划，批准后再执行" },
];

function submit() {
  emit("send");
}

function onEnter(event) {
  if (event.shiftKey) return;
  event.preventDefault();
  emit("send");
}

function toggleMode() {
  const next = props.assistant.permissionMode.value === "plan" ? "default" : "plan";
  props.assistant.setMode(next);
}

function toggleAutoApprove() {
  props.assistant.setAutoApprove(!props.assistant.autoApproveWrites.value);
}
</script>

<template>
  <form class="wb-ai-composer" @submit.prevent="submit">
    <div class="wb-ai-composer-toolbar">
      <button
        type="button"
        class="wb-ai-mode-pill"
        :class="{ 'is-plan': assistant.permissionMode.value === 'plan' }"
        :title="MODE_OPTIONS.find((m) => m.value === assistant.permissionMode.value)?.description"
        @click="toggleMode"
      >
        <span class="wb-ai-mode-dot" />
        {{ MODE_OPTIONS.find((m) => m.value === assistant.permissionMode.value)?.label }}
      </button>

      <button
        type="button"
        class="wb-ai-auto-pill"
        :class="{ 'is-on': assistant.autoApproveWrites.value }"
        title="开启后自动批准写入/修改操作"
        @click="toggleAutoApprove"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <polyline v-if="assistant.autoApproveWrites.value" points="9,12 12,15 16,10" />
        </svg>
        自动批准写入
      </button>

    </div>

    <div class="wb-ai-composer-input-wrap">
      <textarea
        v-model="assistant.draft.value"
        :disabled="assistant.isBusy.value"
        rows="2"
        placeholder="询问数据库结构、查询数据，或请求 Agent 帮你修改…"
        @keydown.enter.exact.prevent="onEnter"
      ></textarea>
      <div class="wb-ai-composer-actions">
        <button
          v-if="assistant.isBusy.value"
          type="button"
          class="wb-ai-btn wb-ai-btn-danger"
          @click="emit('abort')"
        >
          停止
        </button>
      </div>
    </div>
  </form>
</template>
