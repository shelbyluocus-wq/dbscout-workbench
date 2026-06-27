import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

describe("Tauri dev configuration", () => {
  it("builds the sidecar resource before starting the dev server", async () => {
    const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
    const beforeDevCommand = config.build?.beforeDevCommand ?? "";

    const buildIndex = beforeDevCommand.indexOf("build:sidecar");
    const devIndex = beforeDevCommand.indexOf("npm run dev") !== -1
      ? beforeDevCommand.indexOf("npm run dev")
      : beforeDevCommand.indexOf("scripts/dev.mjs");

    assert.notEqual(buildIndex, -1);
    assert.notEqual(devIndex, -1);
    assert.ok(
      buildIndex < devIndex,
      `expected build:sidecar to run before npm run dev, got ${beforeDevCommand}`
    );
  });

  it("keeps native CLI resources platform-specific instead of bundling both binaries", async () => {
    const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
    const windowsConfig = JSON.parse(await readFile("src-tauri/tauri.windows.conf.json", "utf8"));
    const macosConfig = JSON.parse(await readFile("src-tauri/tauri.macos.conf.json", "utf8"));

    assert.equal(config.bundle?.resources?.["resources/claude-code-native*"], undefined);
    assert.equal(windowsConfig.bundle?.resources?.["resources/claude-code-native.exe"], ".");
    assert.equal(macosConfig.bundle?.resources?.["resources/claude-code-native"], ".");
    assert.equal(windowsConfig.bundle?.resources?.["resources/claude-code-native"], undefined);
    assert.equal(macosConfig.bundle?.resources?.["resources/claude-code-native.exe"], undefined);
  });
});

describe("Tauri Windows installer configuration", () => {
  it("uses the project icon for NSIS installer and uninstaller executables", async () => {
    const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
    const nsis = config.bundle?.windows?.nsis ?? {};

    assert.equal(nsis.installerIcon, "icons/icon.ico");
    assert.equal(nsis.uninstallerIcon, "icons/icon.ico");
  });
});
