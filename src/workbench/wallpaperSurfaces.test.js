import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./wallpaperCanvas.css", import.meta.url), "utf8");

test("home search row and list header sit on the wallpaper sheet", () => {
  const sheetRule = css.match(/\.mysql-workbench\.has-wallpaper :is\(([^)]*\.wb-database-home[^)]*)\)\s*\{\s*background:\s*transparent;/);
  assert.ok(sheetRule, "the main-area sheet rule exists");
  assert.match(sheetRule[1], /\.wb-dbhome-toolbar/);
  assert.match(sheetRule[1], /\.wb-dbhome-table-header/);
  // Once rows scroll beneath it, the sticky header covers them again.
  assert.match(css, /\.wb-dbhome-table-surface\.is-scrolled \.wb-dbhome-table-header\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--wb-workspace-mist\) 94%, transparent\)[^}]*backdrop-filter:\s*blur/s);
});

test("cell detail panel drops its own glass card over a wallpaper", () => {
  assert.match(css, /\.mysql-workbench\.has-wallpaper \.wb-cell-detail\s*\{[^}]*background:\s*transparent;[^}]*backdrop-filter:\s*none/s);
});
