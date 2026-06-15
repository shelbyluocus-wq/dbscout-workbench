import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { syncVersionInWorkspace } from "./sync-update-version.mjs";

test("syncVersionInWorkspace aligns package, Tauri, Cargo, and frontend version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbscout-version-"));
  fs.mkdirSync(path.join(dir, "src-tauri"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src", "workbench"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "0.1.0" }, null, 2));
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ version: "0.1.0", packages: { "": { version: "0.1.0" } } }, null, 2));
  fs.writeFileSync(path.join(dir, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: "0.1.0" }, null, 2));
  fs.writeFileSync(path.join(dir, "src-tauri", "Cargo.toml"), '[package]\nname = "dbscout-workbench"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(dir, "src", "workbench", "appVersion.js"), 'export const APP_VERSION = "0.1.0";\n');

  syncVersionInWorkspace(dir, "0.2.0");

  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version, "0.2.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8")).packages[""].version, "0.2.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "src-tauri", "tauri.conf.json"), "utf8")).version, "0.2.0");
  assert.match(fs.readFileSync(path.join(dir, "src-tauri", "Cargo.toml"), "utf8"), /version = "0\.2\.0"/);
  assert.equal(fs.readFileSync(path.join(dir, "src", "workbench", "appVersion.js"), "utf8"), 'export const APP_VERSION = "0.2.0";\n');
});
