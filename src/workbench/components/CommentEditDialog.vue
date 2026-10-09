<script setup>
import { t } from "../i18n/index.js";
import { computed, nextTick, ref, watch } from "vue";
import { useEscClose } from "../composables/useEscClose.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  kind: { type: String, default: "column" },
  name: { type: String, default: "" },
  value: { type: String, default: "" },
  saving: { type: Boolean, default: false },
  error: { type: String, default: "" },
});

const emit = defineEmits(["close", "save"]);

const draft = ref("");
const dialogRef = ref(null);
const textareaRef = ref(null);
const subject = computed(() => {
  if (props.kind === "table") {
    return props.name ? `${t("m_a00092e726d4")} · ${props.name}` : t("m_a00092e726d4");
  }
  return props.name;
});

useEscClose(
  () => props.open,
  () => {
    if (!props.saving) emit("close");
  },
  () => props.saving,
  { dialogRef },
);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    draft.value = props.value || "";
    void nextTick(() => textareaRef.value?.focus());
  },
  { immediate: true },
);

function submit() {
  if (props.saving) return;
  emit("save", draft.value);
}

function onTextareaKeydown(event) {
  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  submit();
}
</script>

<template>
  <div
    v-if="open"
    class="wb-dialog-overlay"
    @click.stop
    @contextmenu.prevent.stop
  >
    <form
      ref="dialogRef"
      class="wb-dialog wb-comment-edit-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wb-comment-edit-title"
      tabindex="-1"
      @submit.prevent="submit"
    >
      <header class="wb-dialog-header">
        <div class="wb-comment-edit-heading">
          <strong id="wb-comment-edit-title">{{ t('m_2d22af42a79f') }}</strong>
          <small v-if="subject" :title="subject">{{ subject }}</small>
        </div>
        <button
          type="button"
          class="wb-dialog-close"
          :aria-label="t('m_3fd47edce45b')"
          :disabled="saving"
          @click="emit('close')"
        >×</button>
      </header>
      <textarea
        ref="textareaRef"
        v-model="draft"
        :aria-label="t('m_2d22af42a79f')"
        :disabled="saving"
        spellcheck="false"
        @keydown="onTextareaKeydown"
      ></textarea>
      <p v-if="error" class="wb-comment-edit-error" role="alert">{{ error }}</p>
      <footer class="wb-dialog-actions">
        <button type="button" :disabled="saving" @click="emit('close')">{{ t('m_2cd0f3be8738') }}</button>
        <button type="submit" class="wb-dialog-primary" :disabled="saving">{{ t('m_4f8b0ab088ec') }}</button>
      </footer>
    </form>
  </div>
</template>
