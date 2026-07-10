import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { mockWorkbenchInvoke } from "../mock/mockBackend.js";
import { onMockEvent } from "../mock/mockEventBus.js";
import { measureAsync } from "./performanceMarks.js";
import { getGlobalPerformanceRecorder } from "./performanceReport.js";

const TAURI_UNAVAILABLE_MESSAGE = /\btauri(?: api)?(?: is)? not available\b/iu;

export function isTauriApiUnavailable(error) {
  const message = String(error?.message || error || "");
  return (
    message.includes("__TAURI_INTERNALS__") ||
    message.includes("reading 'invoke'") ||
    message.includes("reading 'listen'") ||
    TAURI_UNAVAILABLE_MESSAGE.test(message) ||
    message.includes("window is not defined") ||
    message.includes("window is undefined")
  );
}

export const isTauriInvokeUnavailable = isTauriApiUnavailable;

function isTauriAvailable() {
  return typeof globalThis !== "undefined" && !!globalThis.__TAURI_INTERNALS__;
}

function isTauriInvokeAvailable() {
  return (
    typeof globalThis !== "undefined" &&
    typeof globalThis.__TAURI_INTERNALS__?.invoke === "function" &&
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__?.invoke === "function"
  );
}

export async function invokeWorkbench(command, payload = {}) {
  if (!isTauriInvokeAvailable()) {
    return mockWorkbenchInvoke(command, payload);
  }
  return measureAsync(`invoke:${command}`, () => invokeWorkbenchInternal(command, payload), { command });
}

async function invokeWorkbenchInternal(command, payload) {
  const span = getGlobalPerformanceRecorder()?.beginSpan(`ipc:${command}`, { phase: "ipc" });
  const options = span?.spanId
    ? {
        headers: {
          "x-dbscout-perf-run-id": span.runId,
          "x-dbscout-perf-span-id": span.spanId,
        },
      }
    : undefined;
  try {
    const result = options
      ? await tauriInvoke(command, payload, options)
      : await tauriInvoke(command, payload);
    span?.end();
    return result;
  } catch (error) {
    span?.end({ outcome: "error" });
    throw error;
  }
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
