<script setup>
import { t } from "../i18n/index.js";
import { computed, onBeforeUnmount, ref } from "vue";
import {
  DEFAULT_BINDINGS,
  GLOBAL_ACTIONS,
  shortcutComboFromEvent,
  shortcutLabel,
  useShortcuts,
} from "../composables/useShortcuts.js";
import { useEscClose } from "../composables/useEscClose.js";
import { formatShortcutForPlatform } from "../utils/desktopPlatform.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  invokeWorkbench: { type: Function, default: () => {} },
  theme: { type: String, default: "light" },
});

const emit = defineEmits(["close"]);

const { bindings, rebind, reset } = useShortcuts(props.invokeWorkbench);

const listeningAction = ref(null);
const error = ref("");
const dialogRef = ref(null);

const rows = computed(() =>
  Object.keys(DEFAULT_BINDINGS).map((action) => ({
    action,
    label: shortcutLabel(action),
    combo: bindings[action] || "",
    isGlobal: GLOBAL_ACTIONS.has(action),
  })),
);

// Fixed keys of the table lists and tabs, listed for discoverability.
const referenceRows = computed(() => {
  const click = t("shortcut.keyClick");
  return [
    { label: t("pageZoom.in"), keys: [`${formatShortcutForPlatform("Ctrl")} +`, formatShortcutForPlatform("Ctrl+=")] },
    { label: t("pageZoom.out"), keys: [formatShortcutForPlatform("Ctrl+-")] },
    { label: t("pageZoom.reset"), keys: [formatShortcutForPlatform("Ctrl+0")] },
    { label: t("shortcut.refOpen"), keys: ["Enter", t("shortcut.keyDoubleClick")] },
    { label: t("shortcut.refDelete"), keys: ["Delete"] },
    { label: t("shortcut.refRename"), keys: ["F2"] },
    { label: t("shortcut.refMultiSelect"), keys: [`${formatShortcutForPlatform("Ctrl")}+${click}`, `Shift+${click}`] },
    { label: t("shortcut.refSelectAll"), keys: [formatShortcutForPlatform("Ctrl+A")] },
    { label: t("shortcut.refContextMenu"), keys: ["Shift+F10"] },
    { label: t("shortcut.refCloseTab"), keys: [t("shortcut.keyMiddleClick")] },
  ];
});

function startRebind(action) {
  listeningAction.value = action;
  error.value = "";
}

function cancelRebind() {
  listeningAction.value = null;
}

async function onKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    if (listeningAction.value) {
      cancelRebind();
    } else {
      close();
    }
    return;
  }
  if (!listeningAction.value) return;
  const combo = shortcutComboFromEvent(event);
  if (!combo) return;
  event.preventDefault();
  event.stopPropagation();
  const action = listeningAction.value;
  listeningAction.value = null;
  try {
    await rebind(action, combo);
  } catch (err) {
    error.value = String(err?.message || err || "绑定失败");
  }
}

async function clearBinding(action) {
  error.value = "";
  try {
    await rebind(action, "");
  } catch (err) {
    error.value = String(err?.message || err || "清除失败");
  }
}

async function resetAll() {
  error.value = "";
  try {
    await reset();
  } catch (err) {
    error.value = String(err?.message || err || "恢复默认失败");
  }
}

function close() {
  cancelRebind();
  emit("close");
}

useEscClose(() => props.open, close, null, { dialogRef });

// Clean up the listening state if the dialog closes mid-capture.
onBeforeUnmount(cancelRebind);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="wb-shortcut-dialog-overlay wb-floating-themed"
      :data-theme="theme"
    >
      <section
        ref="dialogRef"
        class="wb-shortcut-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('m_9bc299a8d5de')"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="wb-shortcut-dialog-header">
          <strong>{{ t('m_9bc299a8d5de') }}</strong>
          <button type="button" class="wb-shortcut-dialog-close" :aria-label="t('m_3fd47edce45b')" @click="close">✕</button>
        </header>
        <p v-if="error" class="wb-shortcut-dialog-error">{{ error }}</p>
        <p class="wb-shortcut-dialog-hint"> {{ t('m_ca1097b87e7a') }} </p>
        <div class="wb-shortcut-scroll">
        <ul class="wb-shortcut-list">
          <li v-for="row in rows" :key="row.action" class="wb-shortcut-row">
            <span class="wb-shortcut-row-label">
              {{ row.label }}
              <em v-if="row.isGlobal" class="wb-shortcut-global-badge" :title="t('m_0299dc01919c')">🌐</em>
            </span>
            <div class="wb-shortcut-row-body">
              <span v-if="listeningAction === row.action" class="wb-shortcut-listening">{{ t('m_56e021041872') }}</span>
              <kbd v-else class="wb-shortcut-combo">{{ row.combo || t('m_e026c6693dc5') }}</kbd>
              <span class="wb-shortcut-row-actions">
                <button
                  type="button"
                  @click="listeningAction === row.action ? cancelRebind() : startRebind(row.action)"
                >{{ listeningAction === row.action ? t('m_2cd0f3be8738') : t('m_37090f456516') }}</button>
                <button
                  type="button"
                  :disabled="!row.combo"
                  :title="t('m_057b5f5fe635')"
                  @click="clearBinding(row.action)"
                >{{ t('m_bce2377283c2') }}</button>
              </span>
            </div>
          </li>
        </ul>
        <section class="wb-shortcut-reference" :aria-label="t('shortcut.referenceTitle')">
          <h3>{{ t('shortcut.referenceTitle') }}</h3>
          <p>{{ t('shortcut.referenceHint') }}</p>
          <dl>
            <template v-for="row in referenceRows" :key="row.label">
              <dt>{{ row.label }}</dt>
              <dd><kbd v-for="key in row.keys" :key="key" class="wb-shortcut-combo">{{ key }}</kbd></dd>
            </template>
          </dl>
        </section>
        </div>
        <footer class="wb-shortcut-dialog-footer">
          <button type="button" @click="resetAll">{{ t('m_ba2e93e73037') }}</button>
          <button type="button" class="wb-shortcut-dialog-primary" @click="close">{{ t('m_c0b3fbff51cc') }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
