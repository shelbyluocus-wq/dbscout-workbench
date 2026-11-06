import test from "node:test";
import assert from "node:assert/strict";
import { createRenderer } from "vue";
import { useMacosTrafficLights } from "./composables/useMacosTrafficLights.js";

test("native traffic lights track titlebar height, zoom, resize and focus without blocking rendering", () => {
  const previous = new Map();
  const listeners = new Map();
  const frames = new Map();
  const calls = [];
  let frameId = 0;
  let scale = 1;
  let height = 40;
  let sync;
  let resizeObserver;
  let disconnected = false;
  const titlebar = { getBoundingClientRect: () => ({ height }) };
  const globals = {
    document: { querySelector: () => titlebar },
    window: {
      addEventListener: (name, handler) => listeners.set(name, handler),
      removeEventListener: (name) => listeners.delete(name),
    },
    requestAnimationFrame: (callback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (handle) => frames.delete(handle),
    ResizeObserver: class {
      constructor(callback) { resizeObserver = callback; }
      observe(element) { assert.equal(element, titlebar); }
      disconnect() { disconnected = true; }
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback();
  };
  const renderer = createRenderer({
    createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null,
  });
  const app = renderer.createApp({
    setup() {
      sync = useMacosTrafficLights({
        enabled: true,
        getScale: () => scale,
        invoke: async (command, payload) => { calls.push({ command, ...payload }); },
      });
      return () => null;
    },
  });
  try {
    app.mount({});
    assert.equal(calls.length, 0);
    flush();
    assert.deepEqual(calls.pop(), { command: "macos_align_traffic_lights", titlebarHeight: 40 });
    for (const nextScale of [0.5, 1, 1.2, 2]) {
      sync(nextScale);
      flush();
      assert.equal(calls.pop().titlebarHeight, height * nextScale);
    }
    scale = 1.2;
    height = 44;
    resizeObserver();
    listeners.get("resize")();
    listeners.get("focus")();
    assert.equal(frames.size, 1);
    flush();
    assert.equal(calls.pop().titlebarHeight, 52.8);
    height = 0;
    sync();
    flush();
    assert.equal(calls.length, 0);
    sync();
    app.unmount();
    assert.equal(frames.size, 0);
    assert.equal(listeners.size, 0);
    assert.equal(disconnected, true);
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
