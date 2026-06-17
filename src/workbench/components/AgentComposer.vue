<script setup>
import { nextTick, onMounted, ref, watch } from "vue";

const props = defineProps({
  assistant: { type: Object, required: true },
});

const emit = defineEmits(["send", "abort"]);

const textareaRef = ref(null);

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
  emit("send");
}

function onEnter(event) {
  if (event.shiftKey) return;
  event.preventDefault();
  emit("send");
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
    </div>
  </form>
</template>
