<script setup>
import { t } from "../i18n/index.js";
import { computed, nextTick, onMounted, ref, watch } from "vue";

const props = defineProps({
  assistant: { type: Object, required: true },
  tableSource: { type: String, default: () => t("agent.currentDatabase") },
});

const emit = defineEmits(["send", "abort"]);

const textareaRef = ref(null);
const hasDraft = computed(() => props.assistant.draft.value.trim().length > 0);
const runtimeReady = computed(() => props.assistant.runtimeReady?.value !== false);
const inputDisabled = computed(() => props.assistant.isBusy.value || !runtimeReady.value);
const placeholder = computed(() => runtimeReady.value ? t("agent.composerPlaceholder") : t("agent.composerPreparing"));

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
  if (!runtimeReady.value) return;
  if (!hasDraft.value) return;
  emit("send");
}

function onEnter(event) {
  if (!runtimeReady.value) return;
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
    <div class="wb-ai-composer-context" :title="tableSource">
      <span>{{ t('m_080bc981ec09') }}</span>
      <strong>{{ tableSource }}</strong>
    </div>
    <div class="wb-ai-composer-input-wrap">
      <textarea
        ref="textareaRef"
        v-model="assistant.draft.value"
        :disabled="inputDisabled"
        rows="1"
        :placeholder="placeholder"
        @keydown.enter.exact.prevent="onEnter"
        @keydown.esc.prevent="onEsc"
        @input="onInput"
      ></textarea>
      <button
        v-if="assistant.isBusy.value"
        type="button"
        class="wb-ai-composer-send is-stop"
        :aria-label="t('m_9ad0aac32ea3')"
        :title="t('m_9ad0aac32ea3')"
        @click="emit('abort')"
      >
        <span aria-hidden="true" class="wb-ai-stop-icon"></span>
      </button>
      <button
        v-else
        type="submit"
        class="wb-ai-composer-send"
        :aria-label="t('m_008814832cf7')"
        :title="t('m_008814832cf7')"
        :disabled="!hasDraft || !runtimeReady"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M22 2 11 13" />
          <path d="m22 2-7 20-4-9-9-4 20-7Z" />
        </svg>
      </button>
    </div>
  </form>
</template>
