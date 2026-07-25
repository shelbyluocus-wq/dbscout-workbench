import test from "node:test";
import assert from "node:assert/strict";

import { useWindowPin } from "./composables/useWindowPin.js";

test("window pin toggles the native always-on-top state", async () => {
  const calls = [];
  const window = {
    isAlwaysOnTop: async () => false,
    setAlwaysOnTop: async (value) => calls.push(value),
  };
  const pin = useWindowPin({
    runtimeAvailable: () => true,
    getWindow: async () => window,
  });

  assert.deepEqual(await pin.sync(), { ok: true, pinned: false });
  assert.equal(pin.pinned.value, false);

  assert.deepEqual(await pin.toggle(), { ok: true, pinned: true, simulated: false });
  assert.equal(pin.pinned.value, true);
  assert.deepEqual(calls, [true]);

  assert.deepEqual(await pin.toggle(), { ok: true, pinned: false, simulated: false });
  assert.equal(pin.pinned.value, false);
  assert.deepEqual(calls, [true, false]);
});

test("window pin keeps its previous state and reports native failures", async () => {
  const pin = useWindowPin({
    runtimeAvailable: () => true,
    getWindow: async () => ({
      setAlwaysOnTop: async () => {
        throw new Error("permission denied");
      },
    }),
  });

  const result = await pin.setPinned(true);

  assert.deepEqual(result, {
    ok: false,
    pinned: false,
    error: "permission denied",
  });
  assert.equal(pin.pinned.value, false);
  assert.equal(pin.pending.value, false);
  assert.equal(pin.error.value, "permission denied");
});

test("window pin remains interactive in browser-only development", async () => {
  const pin = useWindowPin({ runtimeAvailable: () => false });

  assert.deepEqual(await pin.toggle(), {
    ok: true,
    pinned: true,
    simulated: true,
  });
  assert.equal(pin.pinned.value, true);
});
