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

  it("bundles common agent resources without a cross-platform native binary glob", async () => {
    const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));

    assert.equal(config.bundle?.resources?.["resources/claude-code-native*"], undefined);
    assert.equal(config.bundle?.resources?.["resources/agent-runner.mjs"], "agent-runner.mjs");
    assert.equal(config.bundle?.resources?.["resources/agent-auth*.json"], ".");
    assert.equal(config.bundle?.resources?.["resources/node/*"], "node/");
  });

  it("bundles only the native CLI binary for the target operating system", async () => {
    const macos = JSON.parse(await readFile("src-tauri/tauri.macos.conf.json", "utf8"));
    const windows = JSON.parse(await readFile("src-tauri/tauri.windows.conf.json", "utf8"));
    const macResources = macos.bundle?.resources ?? {};
    const windowsResources = windows.bundle?.resources ?? {};

    assert.equal(macResources["resources/claude-code-native"], ".");
    assert.equal(macResources["resources/claude-code-native.exe"], undefined);
    assert.equal(windowsResources["resources/claude-code-native.exe"], ".");
    assert.equal(windowsResources["resources/claude-code-native"], undefined);
  });
});

describe("Tauri Windows installer configuration", () => {
  it("uses the project icon for NSIS installer and uninstaller executables", async () => {
    const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
    const nsis = config.bundle?.windows?.nsis ?? {};

    assert.equal(nsis.installerIcon, "icons/icon.ico");
    assert.equal(nsis.uninstallerIcon, "icons/icon.ico");
  });

  it("defaults upgrades to installing without uninstalling the current version", async () => {
    const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
    const nsis = config.bundle?.windows?.nsis ?? {};
    const template = await readFile(`src-tauri/${nsis.template}`, "utf8");

    assert.equal(nsis.template, "installer.nsi");
    assert.match(template, /\$\{Else\}\s+StrCpy \$ReinstallPageCheck 2\s+\$\{EndIf\}/);
    assert.match(template, /\$\{If\} \$ReinstallPageCheck = 1[\s\S]*?\$\{NSD_SetFocus\} \$R2[\s\S]*?\$\{Else\}[\s\S]*?\$\{NSD_SetFocus\} \$R3/);
  });
});
