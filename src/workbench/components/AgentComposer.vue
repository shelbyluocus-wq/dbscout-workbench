<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";

const props = defineProps({
  assistant: { type: Object, required: true },
});

const emit = defineEmits(["send", "abort"]);

const textareaRef = ref(null);
const hasDraft = computed(() => props.assistant.draft.value.trim().length > 0);

function autosize() {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function onInput() {
  autosize();
}

function submit() {
  if (props.assistant.isBusy.value) {
    emit("abort");
    return;
  }
  if (!hasDraft.value) return;
  emit("send");
}

function onEnter(event) {
  if (event.shiftKey) return;
  event.preventDefault();
  if (hasDraft.value) emit("send");
}

function onEsc(event) {
  if (!props.assistant.isBusy.value) return;
  event.preventDefault();
  emit("abort");
}

watch(
  () => props.assistant.draft.value,
  () => nextTick(autosize),
);

onMounted(() => nextTick(autosize));
</script>

<template>
  <form class="wb-ai-composer" @submit.prevent="submit">
    <div class="wb-ai-composer-input-wrap">
      <textarea
        ref="textareaRef"
        v-model="assistant.draft.value"
        :disabled="assistant.isBusy.value"
        rows="1"
        placeholder="询问数据库…"
        @keydown.enter.exact.prevent="onEnter"
        @keydown.esc.prevent="onEsc"
        @input="onInput"
      ></textarea>
      <button
        v-if="assistant.isBusy.value"
        type="button"
        class="wb-ai-composer-send is-stop"
        aria-label="停止生成"
        title="停止生成"
        @click="emit('abort')"
      >
        <span aria-hidden="true" class="wb-ai-stop-icon"></span>
      </button>
      <button
        v-else
        type="submit"
        class="wb-ai-composer-send"
        aria-label="发送消息"
        title="发送消息"
        :disabled="!hasDraft"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M22 2 11 13" />
          <path d="m22 2-7 20-4-9-9-4 20-7Z" />
        </svg>
      </button>
    </div>
  </form>
</template>
