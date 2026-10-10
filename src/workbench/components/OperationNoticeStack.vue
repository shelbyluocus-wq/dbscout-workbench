<script setup>
import { computed } from "vue";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-vue-next";
import { language, t } from "../i18n/index.js";
import { localizeStatusMessage } from "../utils/statusMessages.js";

const props = defineProps({
  notices: { type: Object, required: true },
});

const TONE_ICONS = Object.freeze({
  error: CircleAlert,
  warning: TriangleAlert,
  success: CircleCheck,
  info: Info,
});

// Messages are stored in their authoring form and rendered in the current
// interface language, so switching language updates visible notices too.
const items = computed(() => {
  const locale = language.locale.value;
  return props.notices.state.items.map((item) => {
    const primary = localizeStatusMessage(item.text, locale, { tone: item.tone });
    const secondary = item.detail ? localizeStatusMessage(item.detail, locale, { tone: item.tone }) : null;
    const details = [primary.detail, secondary?.title, secondary?.detail].filter(Boolean);
    return {
      id: item.id,
      tone: item.tone,
      count: item.count,
      icon: TONE_ICONS[item.tone] || Info,
      title: primary.title,
      detail: details.join(" "),
    };
  });
});

function pause(id) {
  props.notices.pause(id);
}

function resume(id, event) {
  // Keep the notice while keyboard focus is still inside it.
  if (event?.relatedTarget && event.currentTarget?.contains?.(event.relatedTarget)) return;
  props.notices.resume(id);
}
</script>

<template>
  <section class="wb-notice-stack" :aria-label="t('notice.region')">
    <TransitionGroup name="wb-notice">
      <article
        v-for="notice in items"
        :key="notice.id"
        class="wb-notice"
        :class="`is-${notice.tone}`"
        :data-tone="notice.tone"
        @mouseenter="pause(notice.id)"
        @mouseleave="resume(notice.id, $event)"
        @focusin="pause(notice.id)"
        @focusout="resume(notice.id, $event)"
        @contextmenu.stop.prevent
      >
        <component :is="notice.icon" class="wb-notice-icon" :size="16" :stroke-width="2" aria-hidden="true" />
        <div class="wb-notice-copy">
          <p class="wb-notice-title">
            {{ notice.title }}
            <span
              v-if="notice.count > 1"
              class="wb-notice-count"
              :title="t('notice.repeat', { count: notice.count })"
            >×{{ notice.count }}</span>
          </p>
          <p v-if="notice.detail" class="wb-notice-detail">{{ notice.detail }}</p>
        </div>
        <button
          type="button"
          class="wb-notice-close"
          :title="t('notice.dismiss')"
          :aria-label="t('notice.dismiss')"
          @click="notices.dismiss(notice.id)"
        >
          <X :size="14" :stroke-width="2" aria-hidden="true" />
        </button>
      </article>
    </TransitionGroup>
  </section>
</template>
