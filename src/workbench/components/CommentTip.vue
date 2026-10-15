<script>
import { createTipWarmth } from "../utils/commentTip.js";

// One warmth for every card, so moving between names feels continuous.
const warmth = createTipWarmth();
</script>

<script setup>
// Wraps a table or field name on the relation surfaces. Hovering it (or
// reaching it with the keyboard) floats a small card with its comment, so the
// lists stay as quiet as before and what a table or field is for is one
// glance away. Without a comment, or outside an opted-in surface, it renders
// only its content.
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { useCommentTips } from "../composables/commentTips.js";
import { placeCommentTip } from "../utils/commentTip.js";

const props = defineProps({
  // Shown quietly above the comment: "table" or "table.field".
  name: { type: String, default: "" },
  comment: { type: String, default: "" },
  // A plain field name (not a link) hints at its card with a dotted underline.
  field: { type: Boolean, default: false },
});

const enabled = useCommentTips();
const text = computed(() => String(props.comment || "").trim());
const active = computed(() => enabled && Boolean(text.value));

const tipId = `wb-comment-tip-${Math.random().toString(36).slice(2, 10)}`;
const anchor = ref(null);
const card = ref(null);
const visible = ref(false);
const placement = ref(null);
// Teleported out of the themed shell, so the card carries the theme of the
// place it was opened from.
const theme = ref("light");
let timer = 0;

function clearTimer() {
  if (timer) globalThis.clearTimeout(timer);
  timer = 0;
}

function schedule() {
  if (!active.value || visible.value) return;
  clearTimer();
  const delay = warmth.delay();
  if (delay) timer = globalThis.setTimeout(show, delay);
  else show();
}

async function show() {
  timer = 0;
  if (!active.value || !anchor.value) return;
  placement.value = null;
  theme.value = anchor.value.closest?.("[data-theme]")?.getAttribute("data-theme") || "light";
  visible.value = true;
  listen(true);
  await nextTick();
  if (!visible.value || !card.value || !anchor.value) return;
  placement.value = placeCommentTip(anchor.value.getBoundingClientRect(), {
    width: card.value.offsetWidth,
    height: card.value.offsetHeight,
  }, {
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  });
}

function hide() {
  clearTimer();
  if (!visible.value) return;
  visible.value = false;
  placement.value = null;
  listen(false);
  warmth.cool();
}

function onFocusIn(event) {
  if (event.target?.matches?.(":focus-visible")) schedule();
}

function onKeyDown(event) {
  if (event.key === "Escape") hide();
}

// While shown, anything that moves the page or acts on it lets go.
function listen(on) {
  const method = on ? "addEventListener" : "removeEventListener";
  globalThis.window?.[method]("scroll", hide, true);
  globalThis.window?.[method]("blur", hide);
  globalThis.window?.[method]("resize", hide);
  globalThis.document?.[method]("pointerdown", hide, true);
  globalThis.document?.[method]("keydown", onKeyDown, true);
}

onBeforeUnmount(hide);
</script>

<template>
  <slot v-if="!active" :described-by="undefined" :tip="false" />
  <!-- The empty title keeps a parent's native tooltip from covering the card. -->
  <span
    v-else
    ref="anchor"
    class="wb-comment-tip-anchor"
    :class="{ 'is-field': field }"
    title=""
    @pointerenter="schedule"
    @pointerleave="hide"
    @focusin="onFocusIn"
    @focusout="hide"
  >
    <slot :described-by="visible ? tipId : undefined" :tip="true" />
  </span>
  <Teleport v-if="active && visible" to="body">
    <div
      :id="tipId"
      ref="card"
      role="tooltip"
      class="wb-comment-tip wb-floating-themed"
      :data-theme="theme"
      :class="placement ? ['is-placed', `is-${placement.side}`] : ''"
      :style="placement ? { left: `${placement.left}px`, top: `${placement.top}px` } : null"
    >
      <span class="wb-comment-tip-name">{{ name }}</span>
      <span class="wb-comment-tip-comment">{{ text }}</span>
    </div>
  </Teleport>
</template>

<style scoped>
.wb-comment-tip-anchor {
  display: inline;
}

.wb-comment-tip-anchor.is-field:hover {
  text-decoration: underline dotted color-mix(in srgb, currentColor 55%, transparent);
  text-underline-offset: 3px;
}

/* Measured hidden first, then placed and faded in beside the name. */
.wb-comment-tip {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 1300;
  display: grid;
  gap: 1px;
  box-sizing: border-box;
  width: max-content;
  max-width: min(300px, calc(100vw - 16px));
  padding: 6px 10px 7px;
  border-radius: 8px;
  background: var(--wb-menu-surface);
  box-shadow: 0 0 0 1px var(--wb-border), var(--wb-floating-shadow);
  color: var(--wb-text);
  font-family: var(--wb-font-ui);
  line-height: 1.45;
  pointer-events: none;
  visibility: hidden;
  opacity: 0;
}

.wb-comment-tip.is-placed {
  visibility: visible;
  animation: wb-comment-tip-in var(--wb-duration-fast, 120ms) var(--wb-ease-out, ease-out) both;
}

.wb-comment-tip.is-below {
  animation-name: wb-comment-tip-in-below;
}

.wb-comment-tip-name {
  overflow: hidden;
  color: var(--wb-secondary-text);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-comment-tip-comment {
  display: -webkit-box;
  overflow: hidden;
  font-size: 12px;
  overflow-wrap: anywhere;
  white-space: pre-line;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
}

@keyframes wb-comment-tip-in {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: none; }
}

@keyframes wb-comment-tip-in-below {
  from { opacity: 0; transform: translateY(-3px); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .wb-comment-tip.is-placed {
    animation: none;
    opacity: 1;
  }
}
</style>
