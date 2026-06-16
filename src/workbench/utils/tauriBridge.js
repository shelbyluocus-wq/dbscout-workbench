import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { mockWorkbenchInvoke } from "../mock/mockBackend.js";
import { onMockEvent } from "../mock/mockEventBus.js";
import { measureAsync } from "./performanceMarks.js";

export function isTauriApiUnavailable(error) {
  const message = String(error?.message || error || "");
  return (
    message.includes("__TAURI_INTERNALS__") ||
    message.includes("reading 'invoke'") ||
    message.includes("reading 'listen'") ||
    message.includes("not available") ||
    message.includes("window is not defined") ||
    message.includes("window is undefined")
  );
}

export const isTauriInvokeUnavailable = isTauriApiUnavailable;

function isTauriAvailable() {
  return typeof globalThis !== "undefined" && !!globalThis.__TAURI_INTERNALS__;
}

export async function invokeWorkbench(command, payload = {}) {
  return measureAsync(
    `invoke:${command}`,
    async () => {
      if (!isTauriAvailable()) {
        return mockWorkbenchInvoke(command, payload);
      }
      try {
        return await tauriInvoke(command, payload);
      } catch (error) {
        if (isTauriApiUnavailable(error)) {
          return mockWorkbenchInvoke(command, payload);
        }
        throw error;
      }
    },
    { command },
  );
}

export async function listenWorkbenchEvent(eventName, handler, eventApi = null) {
  if (!isTauriAvailable()) {
    return onMockEvent(eventName, handler);
  }
  try {
    const listen = eventApi?.listen || (await import("@tauri-apps/api/event")).listen;
    return await listen(eventName, handler);
  } catch (error) {
    if (isTauriApiUnavailable(error)) {
      return onMockEvent(eventName, handler);
    }
    throw error;
  }
}
