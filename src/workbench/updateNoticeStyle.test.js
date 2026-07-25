import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("./workbench.css", import.meta.url), "utf8");

test("update notice action keeps visible accent styling on hover and focus", () => {
  assert.match(
    styles,
    /\.wb-update-notice \.wb-update-notice-action:hover:not\(:disabled\),\s*\.wb-update-notice \.wb-update-notice-action:focus-visible\s*\{[^}]*border-color:\s*var\(--wb-accent-control-hover\);[^}]*background:\s*var\(--wb-accent-control-hover\);[^}]*color:\s*var\(--wb-accent-control-text\);/s,
  );
});
