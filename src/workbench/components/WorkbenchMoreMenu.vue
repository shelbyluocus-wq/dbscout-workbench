<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { focusMenuItem, handleMenuKeydown } from '../utils/menuKeyboard.js';
import WorkbenchActivityRailButton from './WorkbenchActivityRailButton.vue';

const props = defineProps({
  item: { type: Object, required: true },
  theme: { type: String, default: 'light' },
  actions: { type: Array, default: () => [] },
});
const emit = defineEmits(['select', 'open']);
const open = ref(false);
const root = ref(null);
const menu = ref(null);
const position = ref({ left: '0px', top: '0px' });
let anchor = null;

function close(restoreFocus = false) {
  open.value = false;
  if (restoreFocus) anchor?.focus({ preventScroll: true });
}

async function toggle(event) {
  if (open.value) return close(true);
  anchor = event.currentTarget;
  const rect = anchor.getBoundingClientRect();
  position.value = { left: `${rect.right + 8}px`, top: `${rect.top}px` };
  emit('open');
  open.value = true;
  await nextTick();
  if (!open.value || !menu.value) return;
  const bounds = menu.value.getBoundingClientRect();
  position.value = {
    left: `${Math.max(8, Math.min(rect.right + 8, window.innerWidth - bounds.width - 8))}px`,
    top: `${Math.max(8, Math.min(rect.top, window.innerHeight - bounds.height - 8))}px`,
  };
  focusMenuItem(menu.value);
}

function select(action) {
  if (action.disabled) return;
  close(true);
  emit('select', action.id);
}

function dismiss(event) {
  if (!root.value?.contains(event.target) && !menu.value?.contains(event.target)) close();
}

function keydown(event) {
  handleMenuKeydown(event, menu.value, { close: () => close(true) });
}
function resize() { close(); }
onMounted(() => {
  document.addEventListener('pointerdown', dismiss, true);
  window.addEventListener('resize', resize);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', dismiss, true);
  window.removeEventListener('resize', resize);
});
</script>

<template>
  <div ref="root" class="wb-activity-more" @click.stop>
    <WorkbenchActivityRailButton :item="{ ...item, expanded: open }" @click="toggle" />
    <Teleport to="body">
      <menu v-if="open" id="wb-activity-more-menu" ref="menu" class="wb-context-menu wb-activity-more-menu wb-floating-themed" :data-theme="theme"
        :style="position" role="menu" :aria-label="item.label" tabindex="-1"
        @keydown="keydown" @click.stop @contextmenu.prevent.stop>
        <button v-for="action in actions" :key="action.id" type="button" role="menuitem"
          :disabled="action.disabled" @click="select(action)">
          <component :is="action.icon" :size="14" class="wb-context-icon" aria-hidden="true" />
          {{ action.label }}
        </button>
      </menu>
    </Teleport>
  </div>
</template>
