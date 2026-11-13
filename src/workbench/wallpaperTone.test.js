import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  measureWallpaperCeilings, wallpaperCeilings, WALLPAPER_FALLBACK_CEILINGS, WALLPAPER_TONE_REFERENCE,
} from "./wallpaperTone.js";
import { COLOR_THEMES } from "./colorThemes.js";

const fill = (...rgba) => new Uint8ClampedArray(Array.from({ length: 16 }, () => rgba).flat());
const hex = (value) => [1, 3, 5].map((start) => parseInt(value.slice(start, start + 2), 16));
const brightness = ([red, green, blue]) => red + green + blue;

test("artwork matching the appearance shows fully; opposing artwork is dimmed", () => {
  assert.deepEqual(wallpaperCeilings(fill(244, 246, 246, 255)), { light: 1, dark: WALLPAPER_FALLBACK_CEILINGS.dark });
  assert.deepEqual(wallpaperCeilings(fill(8, 12, 16, 255)), { light: WALLPAPER_FALLBACK_CEILINGS.light, dark: 1 });
  const { light, dark } = WALLPAPER_FALLBACK_CEILINGS;
  assert.ok(light > 0.08 && light < 0.25, `light fallback ${light}`);
  assert.ok(dark > 0.08 && dark < 0.25, `dark fallback ${dark}`);
});

test("one harsh region limits the whole picture; transparent pixels never do", () => {
  const mostlyPale = fill(244, 246, 246, 255);
  mostlyPale.set([0, 0, 0, 255], 8);
  assert.equal(wallpaperCeilings(mostlyPale).light, WALLPAPER_FALLBACK_CEILINGS.light);
  assert.deepEqual(wallpaperCeilings(fill(0, 0, 0, 0)), { light: 1, dark: 1 });
  const mid = wallpaperCeilings(fill(128, 128, 128, 255));
  assert.ok(mid.light > WALLPAPER_FALLBACK_CEILINGS.light && mid.light < 1);
  assert.ok(mid.dark > WALLPAPER_FALLBACK_CEILINGS.dark && mid.dark < 1);
  assert.deepEqual(wallpaperCeilings(new Uint8ClampedArray()), { light: 1, dark: 1 });
});

test("unreadable media falls back to the safest ceiling", () => {
  const blocked = { createElement: () => ({ getContext() { throw new Error("tainted"); } }) };
  assert.equal(measureWallpaperCeilings({}, { document: blocked }), WALLPAPER_FALLBACK_CEILINGS);
  const drawn = [];
  const document = { createElement: () => ({ getContext: () => ({
    drawImage: (...args) => drawn.push(args),
    getImageData: () => ({ data: fill(8, 12, 16, 255) }),
  }) }) };
  const media = {};
  assert.equal(measureWallpaperCeilings(media, { document }).dark, 1);
  assert.equal(drawn[0][0], media);
});

test("reference colours stay at least as demanding as every bundled colour theme", () => {
  const css = readFileSync(new URL("./workbench.css", import.meta.url), "utf8");
  const [lightBlock, darkBlock] = css.split('.mysql-workbench[data-theme="dark"],');
  const token = (block, name) => hex(block.match(new RegExp(`${name}: (#[0-9a-f]{6});`))[1]);
  const surfaces = { light: [token(lightBlock, "--wb-chrome-surface")], dark: [token(darkBlock, "--wb-chrome-surface")] };
  for (const theme of COLOR_THEMES) {
    for (const appearance of ["light", "dark"]) {
      const value = theme[appearance]?.["--wb-chrome-surface"];
      if (/^#[0-9a-f]{6}$/i.test(value || "")) surfaces[appearance].push(hex(value));
    }
  }
  assert.ok(surfaces.light.length > 1 && surfaces.dark.length > 1, "colour theme surfaces were found");
  for (const surface of surfaces.light) {
    assert.ok(brightness(WALLPAPER_TONE_REFERENCE.light.base) <= brightness(surface), `light ${surface}`);
  }
  for (const surface of surfaces.dark) {
    assert.ok(brightness(WALLPAPER_TONE_REFERENCE.dark.base) >= brightness(surface), `dark ${surface}`);
  }
  assert.deepEqual(token(lightBlock, "--wb-quiet-text"), [...WALLPAPER_TONE_REFERENCE.light.text]);
  assert.deepEqual(token(darkBlock, "--wb-quiet-text"), [...WALLPAPER_TONE_REFERENCE.dark.text]);
});
