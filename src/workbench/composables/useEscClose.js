import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { dialogLayerManager } from "../dialogLayerManager.js";

/**
 * 将对话框注册到统一层级：只让最上层响应 Esc，将 Tab 焦点留在窗口内，
 * 并在关闭后把焦点还给打开它的控件。
 *
 * 用法：在对话框组件里调用 `useEscClose(() => props.open, () => emit("close"), null, { dialogRef })`。
 *
 * @param {() => boolean} isOpen  返回对话框是否打开的函数（通常读 props.open / v-if 条件）
 * @param {() => void} close      关闭回调
 * @param {() => boolean} [isBusy] 可选，返回 true 时忽略 Esc（如导入/下载进行中）
 * @param {{ dialogRef?: import("vue").Ref<HTMLElement | null>, modal?: boolean, restoreFocus?: boolean }} [options]
 */
export function useEscClose(isOpen, close, isBusy, options = {}) {
  const dialogRef = options.dialogRef || ref(null);
  const layer = { close, dialogRef, isBusy, modal: options.modal !== false };
  let active = false;

  function activate() {
    if (active) return;
    active = true;
    dialogLayerManager.activate(layer);
    void nextTick(() => dialogLayerManager.focusLayer(layer));
  }

  function deactivate({ restoreFocus = true } = {}) {
    if (!active) return;
    active = false;
    const focusState = dialogLayerManager.deactivate(layer);
    if (restoreFocus && options.restoreFocus !== false) {
      void nextTick(() => dialogLayerManager.restoreFocus(focusState));
    }
  }

  const stop = watch(
    isOpen,
    (open) => {
      if (open) activate();
      else deactivate();
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    deactivate();
    stop();
  });

  return { dialogRef };
}
