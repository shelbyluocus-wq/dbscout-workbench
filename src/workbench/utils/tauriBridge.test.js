import test from "node:test";
import assert from "node:assert/strict";

import { listenWorkbenchEvent } from "./tauriBridge.js";

test("listenWorkbenchEvent delegates to Tauri listen without relying on __TAURI_INTERNALS__", async () => {
  const previousInternals = globalThis.__TAURI_INTERNALS__;
  delete globalThis.__TAURI_INTERNALS__;

  const handler = () => {};
  const unlisten = () => {};
  let observed = null;

  try {
    const result = await listenWorkbenchEvent("search-values-progress", handler, {
      listen: async (eventName, eventHandler) => {
        observed = { eventName, eventHandler };
        return unlisten;
      },
    });

    assert.equal(result, unlisten);
    assert.deepEqual(observed, {
      eventName: "search-values-progress",
      eventHandler: handler,
    });
  } finally {
    if (previousInternals === undefined) delete globalThis.__TAURI_INTERNALS__;
    else globalThis.__TAURI_INTERNALS__ = previousInternals;
  }
});

test("listenWorkbenchEvent returns a noop listener when Tauri events are unavailable", async () => {
  const result = await listenWorkbenchEvent("search-values-progress", () => {}, {
    listen: async () => {
      throw new Error("Cannot read properties of undefined (reading 'listen')");
    },
  });

  assert.equal(typeof result, "function");
  assert.doesNotThrow(() => result());
});
