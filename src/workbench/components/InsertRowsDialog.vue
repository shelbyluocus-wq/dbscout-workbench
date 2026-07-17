<script setup>
import BackupNumberInput from "./BackupNumberInput.vue";
import { useEscClose } from "../composables/useEscClose.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  count: { type: Number, default: 5 },
  direction: { type: String, default: "below" },
});

const emit = defineEmits(["update:count", "update:direction", "confirm", "cancel"]);

useEscClose(() => props.open, () => emit("cancel"));
</script>

<template>
  <div v-if="open" class="wb-dialog-overlay wb-insert-rows-overlay" @click.self="emit('cancel')">
    <section
      class="wb-dialog wb-insert-rows-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="新增行"
    >
      <header class="wb-dialog-header">
        <strong>新增行</strong>
        <button
          type="button"
          class="wb-dialog-close"
          aria-label="关闭"
          @click="emit('cancel')"
        >
          ×
        </button>
      </header>
      <div class="wb-insert-rows-body">
        <label class="wb-insert-rows-field">
          <span>数量</span>
          <BackupNumberInput
            :model-value="count"
            :min="1"
            :max="99"
            aria-label="新增行数"
            @update:model-value="emit('update:count', $event)"
          />
        </label>
        <div class="wb-insert-rows-field">
          <span>位置</span>
          <div class="wb-insert-rows-segment" role="group" aria-label="插入位置">
            <button
              type="button"
              :class="{ active: direction === 'above' }"
              @click="emit('update:direction', 'above')"
            >往上</button>
            <button
              type="button"
              :class="{ active: direction === 'below' }"
              @click="emit('update:direction', 'below')"
            >往下</button>
          </div>
        </div>
      </div>
      <footer class="wb-dialog-actions">
        <button type="button" @click="emit('cancel')">取消</button>
        <button
          type="button"
          class="wb-dialog-primary"
          @click="emit('confirm')"
        >新增 {{ count }} 行</button>
      </footer>
    </section>
  </div>
</template>
