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
    :class="[item.stateClass, { 'has-status-text': Boolean(item.statusText) }]"
    :disabled="item.disabled"
    :aria-pressed="item.pressed"
    :aria-busy="item.busy || undefined"
    :aria-label="item.label"
    :aria-describedby="item.hint ? hintId(item) : undefined"
    :aria-keyshortcuts="item.ariaShortcut || undefined"
    :aria-haspopup="item.popup || undefined"
    :aria-expanded="item.expanded"
    :aria-controls="item.controls || undefined"
    :data-wb-rail-id="item.id"
  >
    <component :is="item.icon" :size="item.id === 'update' ? 10 : item.statusText ? 15 : 18" :stroke-width="1.6" :fill="item.pressed ? 'currentColor' : 'none'" aria-hidden="true" />
    <span v-if="item.statusText" class="wb-activity-rail-status" aria-hidden="true">{{ item.statusText }}</span>
    <span v-if="item.badgeText" class="wb-activity-rail-badge" aria-hidden="true">{{ item.badgeText }}</span>
    <span class="wb-activity-rail-tip" aria-hidden="true">
      <span class="wb-activity-rail-tip-title">
        <strong>{{ item.label }}</strong>
        <kbd v-if="item.shortcutLabel">{{ item.shortcutLabel }}</kbd>
      </span>
      <span v-if="item.hint" :id="hintId(item)" class="wb-activity-rail-tip-hint">{{ item.hint }}</span>
      <span v-if="item.badgeLabel" class="wb-activity-rail-tip-hint wb-activity-rail-tip-badge">{{ item.badgeLabel }}</span>
    </span>
  </button>
</template>
