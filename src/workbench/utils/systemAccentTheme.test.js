import test from "node:test";
import assert from "node:assert/strict";

import {
  accentControlText,
  contrastRatio,
  mixHex,
  relativeLuminance,
  systemAccentTokens,
} from "./systemAccentTheme.js";

const ACCENTS = ["#007AFF", "#953D96", "#F74F9E", "#E0383E", "#F7821B", "#FFC600", "#62BA46", "#8C8C8C"];

function strongReferenceBg(mode, accent) {
  if (mode === "dark") return mixHex(accent, "#0F0F11", 0.72);
  const tinted = mixHex(accent, "#F9F9F7", 0.8);
  return relativeLuminance(tinted) < relativeLuminance("#E3E7EB") ? tinted : "#E3E7EB";
}

test("mixHex blends toward white and black", () => {
  assert.equal(mixHex("#000000", "#FFFFFF", 0), "#000000");
  assert.equal(mixHex("#000000", "#FFFFFF", 1), "#FFFFFF");
  assert.equal(mixHex("#000000", "#FFFFFF", 0.5), "#808080");
  assert.equal(mixHex("#FF0000", "#000000", 0.2), "#CC0000");
});

test("systemAccentTokens light mode keeps the accent but guarantees control contrast", () => {
  const tokens = systemAccentTokens("light", "#007AFF");
  assert.equal(tokens["--wb-accent"], "#007AFF");
  assert.equal(tokens["--wb-accent-soft"], "rgba(0, 122, 255, 0.08)");
  assert.equal(tokens["--wb-cell-highlight"], "var(--wb-cell-highlight-custom, #007AFF)");
  // The control fill may be darkened from the raw accent until its text hits 4.5:1.
  assert.ok(contrastRatio(tokens["--wb-accent-control-text"], tokens["--wb-accent-control"]) >= 4.5);
});

test("systemAccentTokens dark mode lifts the accent toward white", () => {
  const tokens = systemAccentTokens("dark", "#007AFF");
  assert.equal(tokens["--wb-accent"], mixHex("#007AFF", "#FFFFFF", 0.2));
  assert.equal(tokens["--wb-accent-soft"].includes("0.12"), true);
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

test("control, hover, busy and strong stay at 4.5:1 for every system accent", () => {
  for (const mode of ["light", "dark"]) {
    for (const accent of ACCENTS) {
      const tokens = systemAccentTokens(mode, accent);
      const text = tokens["--wb-accent-control-text"];
      for (const key of ["--wb-accent-control", "--wb-accent-control-hover", "--wb-accent-control-busy"]) {
        const ratio = contrastRatio(text, tokens[key]);
        assert.ok(ratio >= 4.5, `${mode} ${accent} ${key}=${tokens[key]} text=${text} ratio=${ratio.toFixed(2)}`);
      }
      const strongRatio = contrastRatio(tokens["--wb-accent-strong"], strongReferenceBg(mode, accent));
      assert.ok(
        strongRatio >= 4.5,
        `${mode} ${accent} --wb-accent-strong=${tokens["--wb-accent-strong"]} vs ${strongReferenceBg(mode, accent)} ratio=${strongRatio.toFixed(2)}`,
      );
    }
  }
});
