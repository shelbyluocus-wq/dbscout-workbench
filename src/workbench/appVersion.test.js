import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { APP_VERSION } from "./appVersion.js";

const readJson = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), "utf8"));

test("frontend app version matches package and Tauri config", () => {
  const pkg = readJson("../../package.json");
  const tauri = readJson("../../src-tauri/tauri.conf.json");

  assert.equal(APP_VERSION, pkg.version);
  assert.equal(APP_VERSION, tauri.version);
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
});
