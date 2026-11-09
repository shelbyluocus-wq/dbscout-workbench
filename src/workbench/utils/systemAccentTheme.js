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

export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Walks hex toward `toward` in 2% steps until it reaches `min` contrast
// against `bg`; falls back to `toward` when even that is not enough.
export function ensureContrast(hex, bg, min, toward) {
  for (let i = 0; i <= 50; i++) {
    const candidate = mixHex(hex, toward, i / 50);
    if (contrastRatio(candidate, bg) >= min) return candidate;
  }
  return toward;
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
  const text = accentControlText(accent);
  const control = text === "#ffffff"
    ? ensureContrast(accent, "#FFFFFF", 4.5, "#000000")
    : ensureContrast(accent, "#1A1C20", 4.5, "#FFFFFF");
  const away = text === "#ffffff" ? "#000000" : "#FFFFFF";
  const lightStrongBg = relativeLuminance(mixHex(accent, "#F9F9F7", 0.8)) < relativeLuminance("#E3E7EB")
    ? mixHex(accent, "#F9F9F7", 0.8)
    : "#E3E7EB";
  const accentStrong = dark
    ? ensureContrast(mixHex(accent, "#FFFFFF", 0.35), mixHex(accent, "#0F0F11", 0.72), 4.5, "#FFFFFF")
    : ensureContrast(mixHex(accent, "#000000", 0.2), lightStrongBg, 4.5, "#000000");
  return {
    "--wb-accent": accentMain,
    "--wb-accent-strong": accentStrong,
    "--wb-accent-soft": rgba(accentMain, dark ? 0.12 : 0.08),
    "--wb-accent-control": control,
    "--wb-accent-control-hover": mixHex(control, away, 0.12),
    "--wb-accent-control-busy": mixHex(control, away, 0.22),
    "--wb-accent-control-text": text,
    "--wb-cell-highlight": `var(--wb-cell-highlight-custom, ${accentMain})`,
  };
}
