<script setup>
import { computed } from "vue";

const props = defineProps({
  updater: {
    type: Object,
    required: true,
  },
});

const emit = defineEmits(["close", "open"]);
const update = computed(() => props.updater.availableUpdate.value);
const notes = computed(() =>
  String(update.value?.body || "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*•]\s*/, ""))
    .filter(Boolean),
);
</script>

<template>
  <aside class="wb-update-notice" :class="{ 'has-notes': notes.length }" role="status" aria-live="polite" aria-atomic="true">
    <span class="wb-update-notice-mark" aria-hidden="true"></span>
    <div class="wb-update-notice-copy">
      <strong>发现新版本 {{ update?.version }}</strong>
      <ul v-if="notes.length" class="wb-update-notice-notes">
        <li v-for="(note, index) in notes" :key="index">{{ note }}</li>
      </ul>
      <span v-else>更新已经准备好，可随时查看并安装。</span>
    </div>
    <button type="button" class="wb-update-notice-action" @click="emit('open')">查看更新</button>
    <button type="button" class="wb-update-notice-close" title="关闭提醒" aria-label="关闭更新提醒" @click="emit('close')">×</button>
  </aside>
</template>
