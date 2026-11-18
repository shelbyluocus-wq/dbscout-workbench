<script setup>
import { t } from "../i18n/index.js";
import { computed, nextTick, ref, watch } from "vue";
import { CircleAlert, X } from "lucide-vue-next";
import { useEscClose } from "../composables/useEscClose.js";
import { formatShortcutForPlatform } from "../utils/desktopPlatform.js";
import { isImeKeyEvent } from "../utils/imeInput.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  kind: { type: String, default: "column" },
  name: { type: String, default: "" },
  tableName: { type: String, default: "" },
  value: { type: String, default: "" },
  saving: { type: Boolean, default: false },
  error: { type: String, default: "" },
});

const emit = defineEmits(["close", "save"]);

const draft = ref("");
const dialogRef = ref(null);
const textareaRef = ref(null);
const subject = computed(() => {
  const table = props.kind === "table";
  const label = t(table ? "m_a00092e726d4" : "m_39230fff0eb1");
  const name = table ? props.name : [props.tableName, props.name].filter(Boolean).join(".");
  return name ? `${label} · ${name}` : label;
});
const saveShortcut = formatShortcutForPlatform("Ctrl+Enter");

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
  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || isImeKeyEvent(event)) return;
  event.preventDefault();
  event.stopPropagation();
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
      aria-describedby="wb-comment-edit-subject"
      tabindex="-1"
      @submit.prevent="submit"
    >
      <header class="wb-dialog-header">
        <div class="wb-comment-edit-heading">
          <h2 id="wb-comment-edit-title">{{ t('m_2d22af42a79f') }}</h2>
          <p id="wb-comment-edit-subject" :title="subject">{{ subject }}</p>
        </div>
        <button
          type="button"
          class="wb-dialog-close"
          :aria-label="t('m_3fd47edce45b')"
          :disabled="saving"
          @click="emit('close')"
        ><X :size="16" aria-hidden="true" /></button>
      </header>
      <div class="wb-comment-edit-body">
        <textarea
          ref="textareaRef"
          v-model="draft"
          :aria-label="t('m_daede9881787')"
          :placeholder="t('commentEdit.placeholder')"
          :disabled="saving"
          spellcheck="false"
          @keydown="onTextareaKeydown"
        ></textarea>
        <p v-if="error" class="wb-comment-edit-error" role="alert">
          <CircleAlert :size="15" aria-hidden="true" />
          <span>{{ error }}</span>
        </p>
      </div>
      <footer class="wb-dialog-actions">
        <span v-if="!saving" class="wb-comment-edit-shortcut">
          <span>{{ t('commentEdit.quickSave') }}</span>
          <kbd>{{ saveShortcut }}</kbd>
        </span>
        <button type="button" :disabled="saving" @click="emit('close')">{{ t('m_2cd0f3be8738') }}</button>
        <button type="submit" class="wb-dialog-primary" :disabled="saving" aria-live="polite">
          {{ t(saving ? 'm_ff509c9ba052' : 'm_4f8b0ab088ec') }}
        </button>
      </footer>
    </form>
  </div>
</template>
