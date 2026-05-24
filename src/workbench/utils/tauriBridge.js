import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { mockWorkbenchInvoke } from "../mock/mockBackend.js";

export function isTauriInvokeUnavailable(error) {
  const message = String(error?.message || error || "");
  return message.includes("__TAURI_INTERNALS__") || message.includes("reading 'invoke'") || message.includes("not available");
}

export async function invokeWorkbench(command, payload = {}) {
  try {
    return await tauriInvoke(command, payload);
  } catch (error) {
    if (isTauriInvokeUnavailable(error)) {
      return mockWorkbenchInvoke(command, payload);
    }
    throw error;
  }
}
