import { nextTick, reactive } from "vue";
import { dialogLayerManager } from "../dialogLayerManager.js";

const confirmDialog = reactive({
  open: false,
  title: "",
  message: "",
  items: [],
  note: "",
  confirmText: "确定",
  alternativeText: null,
  cancelText: "取消",
  danger: false,
  alternativeDanger: false,
  resolve: null,
});

const pendingDialogs = [];
let activeDialog = null;
let nextDialogScheduled = false;

function presentNextDialog() {
  nextDialogScheduled = false;
  if (activeDialog || !pendingDialogs.length) return;
  activeDialog = pendingDialogs.shift();
  const options = activeDialog.options;
  confirmDialog.open = true;
  confirmDialog.title = options.title ?? "";
  confirmDialog.message = options.message ?? "";
  confirmDialog.items = Array.isArray(options.items) ? [...options.items] : [];
  confirmDialog.note = options.note ?? "";
  confirmDialog.confirmText = options.confirmText ?? "确定";
  confirmDialog.alternativeText = options.alternativeText ?? null;
  confirmDialog.cancelText = Object.hasOwn(options, "cancelText") ? options.cancelText : "取消";
  confirmDialog.danger = options.danger ?? false;
  confirmDialog.alternativeDanger = options.alternativeDanger ?? false;
  confirmDialog.resolve = activeDialog.resolve;
  void nextTick(() => dialogLayerManager.focusCurrentLayer());
}

function show(options = {}) {
  return new Promise((resolve) => {
    pendingDialogs.push({ options, resolve });
    presentNextDialog();
  });
}

export function useConfirm() {
  function confirm(options = {}) {
    return show(options);
  }

  function alert(message, options = {}) {
    if (typeof message === "object" && message !== null) {
      options = message;
      message = options.message ?? "";
    }
    return show({
      title: options.title ?? "提示",
      message,
      confirmText: options.confirmText ?? "知道了",
      cancelText: null,
      danger: false,
    }).then(() => {});
  }

  function close(result) {
    if (!activeDialog) return;
    confirmDialog.open = false;
    const finishedDialog = activeDialog;
    activeDialog = null;
    confirmDialog.resolve = null;
    finishedDialog.resolve(result);
    if (!pendingDialogs.length || nextDialogScheduled) return;
    nextDialogScheduled = true;
    queueMicrotask(presentNextDialog);
  }

  return { confirmDialog, confirm, alert, close };
}
