<script setup>
import { useEscClose } from "../composables/useEscClose.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: "确认" },
  message: { type: String, default: "" },
  items: { type: Array, default: () => [] },
  note: { type: String, default: "" },
  confirmText: { type: String, default: "确定" },
  cancelText: { type: String, default: "取消" },
  danger: { type: Boolean, default: false },
});

const emit = defineEmits(["confirm", "cancel", "close"]);

useEscClose(() => props.open, () => emit("cancel"));
</script>

<template>
  <div v-if="open" class="wb-dialog-overlay wb-confirm-dialog-overlay" @click.self="emit('cancel')">
    <section
      class="wb-dialog wb-confirm-dialog"
      role="alertdialog"
      aria-modal="true"
      :aria-label="title"
    >
      <header class="wb-dialog-header">
        <strong>{{ title }}</strong>
        <button
          type="button"
          class="wb-dialog-close"
          aria-label="关闭"
          @click="emit('cancel')"
        >
          ×
        </button>
      </header>
      <div class="wb-confirm-body">
        <p v-if="message" class="wb-confirm-message">{{ message }}</p>
        <ul v-if="items.length" class="wb-confirm-item-list" aria-label="操作对象列表">
          <li v-for="item in items" :key="item" :title="item">{{ item }}</li>
        </ul>
        <p v-if="note" class="wb-confirm-note">{{ note }}</p>
      </div>
      <footer class="wb-dialog-actions">
        <button v-if="cancelText" type="button" @click="emit('cancel')">
          {{ cancelText }}
        </button>
        <button
          type="button"
          class="wb-dialog-primary"
          :class="{ 'wb-dialog-danger': danger }"
          @click="emit('confirm')"
        >
          {{ confirmText }}
        </button>
      </footer>
    </section>
  </div>
</template>
