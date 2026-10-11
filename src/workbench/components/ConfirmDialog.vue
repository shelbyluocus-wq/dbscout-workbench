<script setup>
import { t } from "../i18n/index.js";
import { computed, ref } from "vue";
import { useEscClose } from "../composables/useEscClose.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: "确认" },
  message: { type: String, default: "" },
  items: { type: Array, default: () => [] },
  note: { type: String, default: "" },
  confirmText: { type: String, default: "确定" },
  alternativeText: { type: String, default: "" },
  cancelText: { type: String, default: "取消" },
  danger: { type: Boolean, default: false },
  alternativeDanger: { type: Boolean, default: false },
});

const emit = defineEmits(["confirm", "alternative", "cancel", "close"]);

const dialogRef = ref(null);
useEscClose(() => props.open, () => emit("cancel"), null, { dialogRef });

// Initial focus goes to the safe choice: Cancel for destructive actions,
// the primary button otherwise, so Enter never deletes by reflex.
const focusCancel = computed(() => props.danger && Boolean(props.cancelText));
</script>

<template>
  <div v-if="open" class="wb-dialog-overlay wb-confirm-dialog-overlay">
    <section
      ref="dialogRef"
      class="wb-dialog wb-confirm-dialog"
      role="alertdialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
    >
      <header class="wb-dialog-header">
        <strong>{{ title }}</strong>
        <button
          type="button"
          class="wb-dialog-close"
          :aria-label="t('m_3fd47edce45b')"
          @click="emit('cancel')"
        >
          ×
        </button>
      </header>
      <div class="wb-confirm-body">
        <p v-if="message" class="wb-confirm-message">{{ message }}</p>
        <ul v-if="items.length" class="wb-confirm-item-list" :aria-label="t('m_6c8b6da2e9f5')">
          <li v-for="item in items" :key="item" :title="item">{{ item }}</li>
        </ul>
        <p v-if="note" class="wb-confirm-note">{{ note }}</p>
      </div>
      <footer class="wb-dialog-actions">
        <button v-if="cancelText" type="button" :autofocus="focusCancel" @click="emit('cancel')">
          {{ cancelText }}
        </button>
        <button
          v-if="alternativeText"
          type="button"
          :class="{ danger: alternativeDanger }"
          @click="emit('alternative')"
        >
          {{ alternativeText }}
        </button>
        <button
          type="button"
          class="wb-dialog-primary"
          :class="{ danger }"
          :autofocus="!focusCancel"
          @click="emit('confirm')"
        >
          {{ confirmText }}
        </button>
      </footer>
    </section>
  </div>
</template>
