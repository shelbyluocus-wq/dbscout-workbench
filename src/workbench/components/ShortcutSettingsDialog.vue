<script setup>
import { computed, onBeforeUnmount, ref } from "vue";
import {
  DEFAULT_BINDINGS,
  SHORTCUT_LABELS,
  GLOBAL_ACTIONS,
  shortcutComboFromEvent,
  useShortcuts,
} from "../composables/useShortcuts.js";
import { useEscClose } from "../composables/useEscClose.js";

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
    label: SHORTCUT_LABELS[action] || action,
    combo: bindings[action] || "",
    isGlobal: GLOBAL_ACTIONS.has(action),
  })),
);

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
        aria-label="快捷键设置"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="wb-shortcut-dialog-header">
          <strong>快捷键设置</strong>
          <button type="button" class="wb-shortcut-dialog-close" aria-label="关闭" @click="close">✕</button>
        </header>
        <p v-if="error" class="wb-shortcut-dialog-error">{{ error }}</p>
        <p class="wb-shortcut-dialog-hint">
          点击「修改」后按下新的组合键；按 Esc 取消。带 🌐 标记的为全局快捷键（系统级）。
        </p>
        <ul class="wb-shortcut-list">
          <li v-for="row in rows" :key="row.action" class="wb-shortcut-row">
            <span class="wb-shortcut-row-label">
              {{ row.label }}
              <em v-if="row.isGlobal" class="wb-shortcut-global-badge" title="全局快捷键">🌐</em>
            </span>
            <div class="wb-shortcut-row-body">
              <span v-if="listeningAction === row.action" class="wb-shortcut-listening">按下组合键…</span>
              <kbd v-else class="wb-shortcut-combo">{{ row.combo || "未绑定" }}</kbd>
              <span class="wb-shortcut-row-actions">
                <button
                  type="button"
                  @click="listeningAction === row.action ? cancelRebind() : startRebind(row.action)"
                >{{ listeningAction === row.action ? "取消" : "修改" }}</button>
                <button
                  type="button"
                  :disabled="!row.combo"
                  title="清除绑定"
                  @click="clearBinding(row.action)"
                >清除</button>
              </span>
            </div>
          </li>
        </ul>
        <footer class="wb-shortcut-dialog-footer">
          <button type="button" @click="resetAll">恢复默认</button>
          <button type="button" class="wb-shortcut-dialog-primary" @click="close">完成</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
