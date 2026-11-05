import { onBeforeUnmount, ref } from "vue";

// navigator.clipboard needs a secure context; fall back to a hidden textarea +
// execCommand where it is unavailable (e.g. plain-http dev pages).
async function writeClipboardText(text) {
  const value = String(text || "");
  if (!value) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (document.execCommand?.("copy") !== true) {
      throw new Error("当前环境不允许访问剪贴板");
    }
  } finally {
    textarea.remove();
  }
}

// Copy-to-clipboard with a transient "已复制" marker per target. `copy` throws
// on failure so the caller can surface its own error text.
export function useCopyFeedback() {
  const copiedTarget = ref("");
  let timer = null;

  async function copy(target, text) {
    const value = String(text || "");
    if (!value) return;
    await writeClipboardText(value);
    copiedTarget.value = String(target);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      copiedTarget.value = "";
      timer = null;
    }, 1500);
  }

  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer);
  });

  return { copiedTarget, copy };
}
