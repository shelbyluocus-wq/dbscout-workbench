import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(css|vue)$/.test(name)) yield path;
  }
}

// font-size values that stay hard-coded on purpose (file + snippet + reason).
const ALLOWED = [
  { file: "components/ReleaseFlowSummary.vue", value: "22px", reason: "summary stat icon glyph" },
  { file: "components/ReleaseServerPage.vue", value: "34px", reason: "large status icon glyph" },
  { file: "components/TableTransferDialog.vue", value: "22px", reason: "result icon glyph" },
  { file: "releaseFlow.css", value: "22px", reason: "icon glyph" },
  { file: "releaseFlow.css", value: "24px", reason: "icon glyph" },
  { file: "workbench.css", value: "38px", reason: "empty-state hero glyph" },
];

const OK_VALUE = /^var\(--wb-fs-(micro|caption|body|title|heading|display)\)$/;

test("every font-size uses a --wb-fs-* token, inherit, 0, relative units, or the allowlist", () => {
  const violations = [];
  for (const path of walk(__dirname)) {
    const rel = path.slice(__dirname.length + 1);
    const text = readFileSync(path, "utf8");
    for (const m of text.matchAll(/font-size:\s*([^;}\n]+)/g)) {
      const value = m[1].replace(/\s*!important\s*$/, "").trim();
      if (OK_VALUE.test(value)) continue;
      if (value === "inherit" || value === "0") continue; // inherit / collapse whitespace
      if (/^[0-9.]+(em|%|rem)$/.test(value)) continue; // icon/markdown relative sizing
      if (ALLOWED.some((a) => a.file === rel && value === a.value)) continue;
      violations.push(`${rel}: font-size: ${value}`);
    }
    // `font:` shorthand must not smuggle a px size either
    for (const m of text.matchAll(/\bfont:\s*([0-9.]+)px\//g)) {
      violations.push(`${rel}: font shorthand ${m.group(1)}px`);
    }
  }
  assert.deepEqual(violations, [], violations.join("\n"));
});
