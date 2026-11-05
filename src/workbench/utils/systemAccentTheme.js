// Derives the accent --wb-* tokens for the "system accent" color-theme preset
// from a single hex color. Pure functions so the derivation is unit-testable
// (including the yellow-on-light contrast case).

function hexToRgb(hex) {
  const value = String(hex || "").trim().replace(/^#/, "");
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value;
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n) || full.length !== 6) return [0, 122, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  const c = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

// t = 0 → a, t = 1 → b.
export function mixHex(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex(ca.map((v, i) => v + (cb[i] - v) * t));
}

function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// WCAG relative luminance, used to pick readable text over the accent.
export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function accentControlText(hex) {
  return relativeLuminance(hex) > 0.45 ? "#1a1c20" : "#ffffff";
}

/**
 * @param {"light"|"dark"} mode
 * @param {string} accent - hex color, e.g. "#007AFF"
 * @returns {Object} --wb-* overrides for that mode
 */
export function systemAccentTokens(mode, accent) {
  const dark = mode === "dark";
  const accentMain = dark ? mixHex(accent, "#FFFFFF", 0.2) : accent;
  const accentStrong = dark ? mixHex(accent, "#FFFFFF", 0.35) : mixHex(accent, "#000000", 0.2);
  const accentBusy = dark ? mixHex(accent, "#FFFFFF", 0.5) : mixHex(accent, "#000000", 0.32);
  return {
    "--wb-accent": accentMain,
    "--wb-accent-strong": accentStrong,
    "--wb-accent-soft": rgba(accentMain, dark ? 0.12 : 0.08),
    "--wb-accent-control": accent,
    "--wb-accent-control-hover": accentStrong,
    "--wb-accent-control-busy": accentBusy,
    "--wb-accent-control-text": accentControlText(accent),
    "--wb-cell-highlight": `var(--wb-cell-highlight-custom, ${accentMain})`,
  };
}
