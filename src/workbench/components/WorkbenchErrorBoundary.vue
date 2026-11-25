<script setup>
import { onErrorCaptured, ref } from "vue";
import { AlertTriangle, RotateCcw } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import {
  extractComponentName,
  normalizeFrontendError,
  redactFrontendErrorText,
  reportFrontendError,
} from "../utils/frontendErrorLog.js";

const props = defineProps({
  area: { type: String, default: "panel" },
  compact: { type: Boolean, default: false },
});

const emit = defineEmits(["error", "recover"]);

const capturedError = ref(null);
const recoveryKey = ref(0);

onErrorCaptured((err, instance, info) => {
  const component = extractComponentName(instance);
  const normalized = normalizeFrontendError(err);
  reportFrontendError(err, {
    kind: "error-boundary",
    area: props.area,
    component,
    info: String(info || ""),
  });
  capturedError.value = {
    message: redactFrontendErrorText(normalized.message),
    component,
  };
  emit("error", { error: err, component, info, area: props.area });
  console.error(`[blackcat:boundary:${props.area}]`, component || "unknown", info, err);
  // Stop propagation so one broken panel/view cannot corrupt the parent workbench shell.
  return false;
});

function recover() {
  capturedError.value = null;
  recoveryKey.value += 1;
  emit("recover", { area: props.area, attempt: recoveryKey.value });
}

function reloadWindow() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

defineExpose({ recover, capturedError });
</script>

<template>
  <slot v-if="!capturedError" :key="recoveryKey" />
  <section
    v-else
    class="wb-error-boundary"
    :class="{ 'is-compact': compact }"
    role="alert"
    :data-error-area="area"
  >
    <div class="wb-error-boundary-card">
      <div class="wb-error-boundary-icon" aria-hidden="true">
        <AlertTriangle :size="compact ? 18 : 22" :stroke-width="1.8" />
      </div>
      <div class="wb-error-boundary-copy">
        <strong class="wb-error-boundary-title">{{ t("errorBoundary.title") }}</strong>
        <p class="wb-error-boundary-desc">{{ t("errorBoundary.description") }}</p>
        <p v-if="capturedError.message" class="wb-error-boundary-detail" :title="capturedError.message">
          {{ capturedError.message }}
        </p>
      </div>
      <div class="wb-error-boundary-actions">
        <button
          type="button"
          class="wb-error-boundary-btn is-primary"
          @click="recover"
        >
          <RotateCcw :size="13" :stroke-width="2" aria-hidden="true" />
          <span>{{ t("errorBoundary.recover") }}</span>
        </button>
        <button
          type="button"
          class="wb-error-boundary-btn"
          @click="reloadWindow"
        >
          {{ t("errorBoundary.reloadWindow") }}
        </button>
      </div>
    </div>
  </section>
</template>
