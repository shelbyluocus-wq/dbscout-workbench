<script setup>
defineProps({
  item: { type: Object, required: true },
});

function hintId(item) {
  return `wb-activity-rail-hint-${item.id}`;
}
</script>

<template>
  <button
    type="button"
    class="wb-activity-rail-btn"
    :aria-label="item.label"
    :aria-describedby="item.hint ? hintId(item) : undefined"
    :aria-keyshortcuts="item.ariaShortcut || undefined"
    :aria-haspopup="item.popup || undefined"
    :aria-expanded="item.expanded"
    :aria-controls="item.controls || undefined"
    :data-wb-rail-id="item.id"
  >
    <component :is="item.icon" :size="18" :stroke-width="1.6" aria-hidden="true" />
    <span class="wb-activity-rail-tip" aria-hidden="true">
      <span class="wb-activity-rail-tip-title">
        <strong>{{ item.label }}</strong>
        <kbd v-if="item.shortcutLabel">{{ item.shortcutLabel }}</kbd>
      </span>
      <span v-if="item.hint" :id="hintId(item)" class="wb-activity-rail-tip-hint">{{ item.hint }}</span>
    </span>
  </button>
</template>
