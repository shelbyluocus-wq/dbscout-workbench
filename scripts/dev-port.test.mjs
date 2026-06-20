import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DEV_PORT,
  buildDevServerUrl,
  findAvailablePort,
} from "./dev-port.mjs";

test("buildDevServerUrl formats host and port", () => {
  assert.equal(buildDevServerUrl("127.0.0.1", 1431), "http://127.0.0.1:1431");
});

test("findAvailablePort returns the first available port", async () => {
  const used = new Set([1431, 1432]);
  const port = await findAvailablePort({
    start: DEFAULT_DEV_PORT,
    check: async (candidate) => !used.has(candidate),
  });

  assert.equal(port, 1433);
});

test("findAvailablePort throws when no port is available", async () => {
  await assert.rejects(
    () => findAvailablePort({
      start: 4000,
      maxAttempts: 2,
      check: async () => false,
    }),
    /No available dev port found near 4000/,
  );
});