import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("Tauri dev configuration", () => {
  it("builds the sidecar resource before starting the dev server", async () => {
    const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
    const beforeDevCommand = config.build?.beforeDevCommand ?? "";

    const buildIndex = beforeDevCommand.indexOf("build:sidecar");
    const devIndex = beforeDevCommand.indexOf("npm run dev");

    assert.notEqual(buildIndex, -1);
    assert.notEqual(devIndex, -1);
    assert.ok(
      buildIndex < devIndex,
      `expected build:sidecar to run before npm run dev, got ${beforeDevCommand}`
    );
  });
});
