import test from "node:test";
import assert from "node:assert/strict";

import {
  accentControlText,
  mixHex,
  relativeLuminance,
  systemAccentTokens,
} from "./systemAccentTheme.js";

test("mixHex blends toward white and black", () => {
  assert.equal(mixHex("#000000", "#FFFFFF", 0), "#000000");
  assert.equal(mixHex("#000000", "#FFFFFF", 1), "#FFFFFF");
  assert.equal(mixHex("#000000", "#FFFFFF", 0.5), "#808080");
  assert.equal(mixHex("#FF0000", "#000000", 0.2), "#CC0000");
});

test("systemAccentTokens light mode uses the accent directly", () => {
  const tokens = systemAccentTokens("light", "#007AFF");
  assert.equal(tokens["--wb-accent"], "#007AFF");
  assert.equal(tokens["--wb-accent-control"], "#007AFF");
  assert.equal(tokens["--wb-accent-strong"], "#0062CC"); // 20% toward black
  assert.equal(tokens["--wb-accent-soft"], "rgba(0, 122, 255, 0.08)");
  assert.equal(tokens["--wb-accent-control-text"], "#ffffff");
  assert.equal(tokens["--wb-cell-highlight"], "var(--wb-cell-highlight-custom, #007AFF)");
});

test("systemAccentTokens dark mode lifts the accent toward white", () => {
  const tokens = systemAccentTokens("dark", "#007AFF");
  assert.equal(tokens["--wb-accent"], mixHex("#007AFF", "#FFFFFF", 0.2));
  assert.equal(tokens["--wb-accent-strong"], mixHex("#007AFF", "#FFFFFF", 0.35));
  assert.equal(tokens["--wb-accent-soft"].includes("0.12"), true);
  // Control color stays the raw accent so buttons keep the system hue.
  assert.equal(tokens["--wb-accent-control"], "#007AFF");
});

test("yellow accent gets dark control text for contrast", () => {
  assert.equal(accentControlText("#FFC600"), "#1a1c20");
  assert.equal(accentControlText("#007AFF"), "#ffffff");
  assert.equal(accentControlText("#F7821B"), "#ffffff");
  assert.equal(accentControlText("#62BA46"), "#ffffff");
  assert.ok(relativeLuminance("#FFC600") > relativeLuminance("#007AFF"));
  const tokens = systemAccentTokens("light", "#FFC600");
  assert.equal(tokens["--wb-accent-control-text"], "#1a1c20");
});
