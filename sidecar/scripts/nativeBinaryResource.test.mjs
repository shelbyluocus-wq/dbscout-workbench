import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureNativeBinaryResource } from "./nativeBinaryResource.mjs";

describe("ensureNativeBinaryResource", () => {
  it("skips copying when the destination already has the same contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dbscout-native-resource-"));
    const source = join(dir, "source.bin");
    const dest = join(dir, "dest.bin");
    await writeFile(source, "same-binary");
    await writeFile(dest, "same-binary");

    try {
      const result = await ensureNativeBinaryResource(source, dest, {
        copyFile: async () => {
          throw new Error("copy should not be called for identical files");
        },
      });

      assert.equal(result.action, "skipped");
      assert.equal(String(await readFile(dest)), "same-binary");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
