import { watch, onBeforeUnmount } from "vue";

/**
 * 让对话框在按下 Esc 时关闭。
 *
 * 用法：在对话框组件里调用 `useEscClose(() => props.open, () => emit("close"))`。
 * 当 `isOpen` 为真时挂载全局 keydown 监听；按下 Esc 且未处于忙碌态时触发 `close`。
 *
 * @param {() => boolean} isOpen  返回对话框是否打开的函数（通常读 props.open / v-if 条件）
 * @param {() => void} close      关闭回调
 * @param {() => boolean} [isBusy] 可选，返回 true 时忽略 Esc（如导入/下载进行中）
 */
export function useEscClose(isOpen, close, isBusy) {
  function onKeydown(event) {
    if (event.key !== "Escape") return;
    if (isBusy && isBusy()) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  const stop = watch(
    isOpen,
    (open) => {
      if (open) {
        window.addEventListener("keydown", onKeydown, true);
      } else {
        window.removeEventListener("keydown", onKeydown, true);
      }
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKeydown, true);
    stop();
  });
}
