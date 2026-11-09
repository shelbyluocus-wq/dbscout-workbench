import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { COLOR_THEMES } from "./colorThemes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(__dirname, "workbench.css"), "utf8");

// Token-level WCAG contrast gate, ported from the contrast audit so regressions
// in theme tokens fail CI instead of shipping low-contrast text.
function block(selectorStart) {
  const i = css.indexOf(selectorStart);
  if (i < 0) throw new Error("missing " + selectorStart);
  const open = css.indexOf("{", i);
  let depth = 0, j = open;
  for (; j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}" && --depth === 0) break;
  }
  const body = css.slice(open + 1, j);
  const out = {};
  // declarations may span lines; split on ; at top level
  let buf = "", par = 0;
  for (const ch of body) {
    if (ch === "(") par++;
    if (ch === ")") par--;
    if (ch === ";" && par === 0) { push(buf); buf = ""; } else buf += ch;
  }
  push(buf);
  function push(d) {
    d = d.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const m = d.match(/^(--wb-[\w-]+)\s*:\s*([\s\S]+)$/);
    if (m) out[m[1]] = m[2].trim().replace(/\s+/g, " ");
  }
  return out;
}

const lightBase = block(":root {");
const darkBase = { ...lightBase, ...block('.mysql-workbench[data-theme="dark"],\n.wb-floating-themed[data-theme="dark"] {') };

// ---------- color math ----------
const clamp = (v) => Math.min(1, Math.max(0, v));
function oklchToRgb(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((c) => clamp(c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
}
function splitTop(s, sep = ",") {
  const parts = []; let buf = "", par = 0;
  for (const ch of s) {
    if (ch === "(") par++;
    if (ch === ")") par--;
    if (ch === sep && par === 0) { parts.push(buf.trim()); buf = ""; } else buf += ch;
  }
  parts.push(buf.trim());
  return parts;
}
// returns {r,g,b,a} 0-255 / 0-1, or null
function parse(value, tokens, depth = 0) {
  if (depth > 20 || value == null) return null;
  value = value.trim();
  let m;
  if ((m = value.match(/^var\((--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/))) {
    const v = tokens[m[1]];
    if (v != null) return parse(v, tokens, depth + 1);
    return m[2] ? parse(m[2], tokens, depth + 1) : null;
  }
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (value === "white" || value === "#fff") return { r: 255, g: 255, b: 255, a: 1 };
  if (value === "black") return { r: 0, g: 0, b: 0, a: 1 };
  if ((m = value.match(/^#([0-9a-f]{3,8})$/i))) {
    let h = m[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    const n = parseInt(h.slice(0, 6), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
  }
  if ((m = value.match(/^rgba?\(([^)]+)\)$/))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  }
  if ((m = value.match(/^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)$/))) {
    const [r, g, b] = oklchToRgb(+m[1] / 100, +m[2], +m[3]);
    return { r, g, b, a: 1 };
  }
  if ((m = value.match(/^color-mix\(in srgb,\s*([\s\S]+)\)$/))) {
    const [A, B] = splitTop(m[1]);
    const pa = A.match(/^([\s\S]+?)\s+([\d.]+)%$/);
    const pb = B.match(/^([\s\S]+?)\s+([\d.]+)%$/);
    const ca = parse(pa ? pa[1] : A, tokens, depth + 1);
    const cb = parse(pb ? pb[1] : B, tokens, depth + 1);
    if (!ca || !cb) return null;
    let wa = pa ? +pa[2] / 100 : pb ? 1 - +pb[2] / 100 : 0.5;
    const wb = 1 - wa;
    // premultiplied mix
    const a = ca.a * wa + cb.a * wb;
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const ch = (k) => (ca[k] * ca.a * wa + cb[k] * cb.a * wb) / a;
    return { r: ch("r"), g: ch("g"), b: ch("b"), a };
  }
  if (value.startsWith("linear-gradient")) return null;
  return null;
}
const over = (top, bottom) => {
  const a = top.a + bottom.a * (1 - top.a);
  const ch = (k) => (top[k] * top.a + bottom[k] * bottom.a * (1 - top.a)) / a;
  return { r: ch("r"), g: ch("g"), b: ch("b"), a: 1 };
};
const lum = ({ r, g, b }) => {
  const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hex = ({ r, g, b }) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

// ---------- audit spec ----------
// [text token, minimum ratio, surfaces it realistically sits on]
const chromeSurf = ["--wb-window", "--wb-chrome-surface", "--wb-tree-surface", "--wb-pane-header"];
const canvasSurf = ["--wb-workspace-mist", "--wb-grid-row", "--wb-grid-row-alt", "--wb-grid-header", "--wb-index-surface", "--wb-toolbar-surface", "--wb-table-surface"];
const floatSurf = ["--wb-dialog-surface", "--wb-menu-surface", "--wb-surface", "--wb-control"];
const stateSurf = ["--wb-row-selected", "--wb-row-hover", "--wb-list-selected", "--wb-insert-row"];
const ALL = [...chromeSurf, ...canvasSurf, ...floatSurf, ...stateSurf];
const spec = [
  ["--wb-text", 7, ALL],
  ["--wb-grid-heading", 4.5, ["--wb-grid-header"]],
  ["--wb-identifier-text", 4.5, ALL],
  ["--wb-database-text", 4.5, chromeSurf],
  ["--wb-secondary-text", 4.5, ALL],
  ["--wb-muted", 4.5, ALL],
  ["--wb-quiet-text", 4.5, ALL],
  ["--wb-tree-text", 4.5, chromeSurf],
  ["--wb-remark-text", 4.5, [...canvasSurf, ...stateSurf]],
  ["--wb-type-text", 4.5, [...canvasSurf, ...floatSurf]],
  ["--wb-empty-text", 4.5, [...canvasSurf, ...floatSurf]],
  ["--wb-field-placeholder", 4.5, ["--wb-field-surface", "--wb-control", "--wb-dialog-surface", "--wb-toolbar-surface"]],
  ["--wb-disabled", 3, [...floatSurf, ...chromeSurf]],
  ["--wb-window-control-text", 4.5, chromeSurf],
  ["--wb-tab-close-text", 4.5, ["--wb-tab-active", "--wb-tab-surface", "--wb-chrome-surface"]],
  ["--wb-accent-strong", 4.5, ALL],
  ["--wb-danger", 4.5, [...canvasSurf, ...floatSurf, ...chromeSurf]],
  ["--wb-danger-text", 4.5, ["--wb-danger-surface", "--wb-dialog-surface", "--wb-workspace-mist"]],
  ["--wb-warning-text", 4.5, ["--wb-warning-surface", "--wb-dialog-surface", "--wb-workspace-mist", "--wb-insert-row"]],
  ["--wb-success-text", 4.5, ["--wb-success-surface", "--wb-dialog-surface", "--wb-workspace-mist"]],
  ["--wb-accent-control-text", 4.5, ["--wb-accent-control", "--wb-accent-control-hover"]],
  ...["keyword", "string", "number", "comment", "type", "function", "operator", "identifier", "invalid"].map((k) => [`--wb-sql-${k}`, 4.5, ["--wb-table-surface", "--wb-workspace-mist", "--wb-dialog-surface"]]),
  ...["key", "function", "string", "number", "keyword", "comment"].map((k) => [`--wb-code-${k}`, 4.5, ["--wb-dialog-surface", "--wb-workspace-mist", "--wb-surface"]]),
  ...["table-name", "table-comment", "column-name", "column-comment", "value"].map((k) => [`--wb-hit-${k}-text`, 4.5, [`--wb-hit-${k}-bg`, "--wb-dialog-surface", "--wb-menu-surface"]]),
  ...["slate", "teal", "blue", "violet", "amber", "orange", "rose", "green"].map((k) => [`--wb-database-name-${k}`, 4.5, [...chromeSurf, "--wb-workspace-mist", "--wb-tab-active"]]),
];

function collectFailures() {
  const results = [];
  for (const theme of COLOR_THEMES) {
    for (const mode of ["light", "dark"]) {
      const base = mode === "light" ? lightBase : darkBase;
      const tokens = { ...base, ...(theme[mode] || {}) };
      const windowColor = parse(tokens["--wb-window"], tokens);
      const resolveSurface = (name) => {
        const c = parse(tokens[name], tokens);
        if (!c) return null;
        // translucent surfaces composite over the window (canvas ones over workspace mist)
        const backdrop = canvasSurf.includes(name) || stateSurf.includes(name)
          ? over(parse(tokens["--wb-workspace-mist"], tokens), windowColor)
          : windowColor;
        return c.a < 1 ? over(c, backdrop) : c;
      };
      for (const [text, min, surfaces] of spec) {
        const tc = parse(tokens[text], tokens);
        if (!tc) { results.push({ theme: theme.id, mode, text, issue: "UNRESOLVED", value: tokens[text] }); continue; }
        for (const s of surfaces) {
          const sc = resolveSurface(s);
          if (!sc) continue;
          const fg = tc.a < 1 ? over(tc, sc) : tc;
          const r = ratio(fg, sc);
          results.push({ theme: theme.id, mode, text, textHex: hex(fg), surface: s, surfaceHex: hex(sc), ratio: +r.toFixed(2), min, fail: r < min });
        }
      }
    }
  }
  return results.filter((r) => r.fail || r.issue);
}

test("theme text tokens keep WCAG contrast on their surfaces across all themes and modes", () => {
  const fails = collectFailures();
  const fmt = (r) => r.issue
    ? `${r.theme}/${r.mode} ${r.text} ${r.issue} (${r.value})`
    : `${r.theme} ${r.mode} ${r.text} ${r.textHex} on ${r.surface} ${r.surfaceHex} ${r.ratio} < ${r.min}`;
  assert.equal(fails.length, 0, `${fails.length} contrast pairs below target:\n${fails.map(fmt).join("\n")}`);
});
