// 设计调试面板的核心逻辑（仅 dev 模式挂载，不持久化）。
// 把分层面板的可调 token 集中管理：浅色 token 在 :root、深色 token 在
// .mysql-workbench[data-theme="dark"]，因此按当前模式把内联样式写到对应元素上，
// 即可只覆盖当前模式、不动另一模式。试好值后点"复制当前值"导出 CSS 回填 workbench.css。

// 画布色联动的 token：页签条下沿以下整块画布（面板/工具条/网格空区）+ 数据行
export const CANVAS_TOKENS = [
  "--wb-workspace-mist",
  "--wb-workspace-mist-raised",
  "--wb-workspace-mist-canvas",
  "--wb-grid-row",
];

export const DEBUG_COLOR_FIELDS = [
  { key: "chrome", label: "外框底色（侧栏/页签条）", tokens: ["--wb-chrome-surface"] },
  { key: "canvas", label: "画布底色（区域 2）", tokens: CANVAS_TOKENS },
  { key: "header", label: "表头色", tokens: ["--wb-grid-header"] },
  { key: "index", label: "行号列色", tokens: ["--wb-index-surface"] },
  { key: "altRow", label: "斑马纹色", tokens: ["--wb-grid-row-alt"] },
];

export const RADIUS_TOKEN = "--wb-workspace-corner-radius";
export const BORDER_TOKEN = "--wb-workspace-mist-border";
export const FRAME_SHADOW_TOKEN = "--wb-frame-shadow";
export const FILL_HANDLE_LEFT_TOKEN = "--wb-fill-handle-left";
export const FILL_HANDLE_TOP_TOKEN = "--wb-fill-handle-top";
export const FILL_HANDLE_SIZE_TOKEN = "--wb-fill-handle-size";

export const RADIUS_RANGE = { min: 0, max: 32, step: 1 };
export const BORDER_ALPHA_RANGE = { min: 0.02, max: 0.4, step: 0.01 };
export const SHADOW_RANGE = { min: 0, max: 0.35, step: 0.01 };
export const FILL_HANDLE_OFFSET_RANGE = { min: -32, max: 16, step: 1 };
export const FILL_HANDLE_SIZE_RANGE = { min: 2, max: 20, step: 1 };
export const FILL_HANDLE_DEFAULTS = { left: -5, top: -6, size: 6 };

const BORDER_RGB = { light: "45, 55, 72", dark: "255, 255, 255" };

// 浅色 token 在 :root（documentElement），深色在 .mysql-workbench[data-theme="dark"]。
// 圆角全模式只定义在 :root，统一写 documentElement。
export function resolveModeTarget(mode, doc = globalThis.document) {
  if (mode === "dark") {
    return doc?.querySelector?.(".mysql-workbench") ?? doc?.documentElement ?? null;
  }
  return doc?.documentElement ?? null;
}

function setToken(target, name, value) {
  target?.style?.setProperty?.(name, value);
}

export function applyColorField(target, field, hexColor) {
  for (const token of field.tokens) setToken(target, token, hexColor);
}

export function applyRadius(doc, px) {
  const clamped = Math.min(RADIUS_RANGE.max, Math.max(RADIUS_RANGE.min, Number(px) || 0));
  setToken(doc?.documentElement, RADIUS_TOKEN, `${clamped}px`);
  return clamped;
}

export function applyBorderAlpha(target, mode, alpha) {
  const clamped = Math.min(BORDER_ALPHA_RANGE.max, Math.max(BORDER_ALPHA_RANGE.min, Number(alpha) || 0));
  setToken(target, BORDER_TOKEN, `rgba(${BORDER_RGB[mode] ?? BORDER_RGB.light}, ${clamped})`);
  return clamped;
}

export function applyFrameShadow(target, strength) {
  const clamped = Math.min(SHADOW_RANGE.max, Math.max(SHADOW_RANGE.min, Number(strength) || 0));
  const value = clamped <= 0 ? "none" : `0 5px 8px -5px rgba(0, 0, 0, ${clamped})`;
  setToken(target, FRAME_SHADOW_TOKEN, value);
  return clamped;
}

function clampRange(value, range, fallback) {
  const numeric = Number(value);
  const base = Number.isFinite(numeric) ? numeric : fallback;
  return Math.min(range.max, Math.max(range.min, base));
}

function parsePx(text, fallback) {
  const numeric = Number.parseFloat(text);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function fillHandleDeltaFromKey(key) {
  if (key === "ArrowLeft") return { axis: "x", delta: -1 };
  if (key === "ArrowRight") return { axis: "x", delta: 1 };
  if (key === "ArrowUp") return { axis: "y", delta: -1 };
  if (key === "ArrowDown") return { axis: "y", delta: 1 };
  return null;
}

export function nudgeFillHandle(current, axis, delta) {
  const left = Number(current?.left);
  const top = Number(current?.top);
  const size = Number(current?.size);
  return {
    left: (Number.isFinite(left) ? left : FILL_HANDLE_DEFAULTS.left) + (axis === "x" ? Number(delta) || 0 : 0),
    top: (Number.isFinite(top) ? top : FILL_HANDLE_DEFAULTS.top) + (axis === "y" ? Number(delta) || 0 : 0),
    size: Number.isFinite(size) ? size : FILL_HANDLE_DEFAULTS.size,
  };
}

export function applyFillHandle(doc, next) {
  const left = clampRange(next?.left, FILL_HANDLE_OFFSET_RANGE, FILL_HANDLE_DEFAULTS.left);
  const top = clampRange(next?.top, FILL_HANDLE_OFFSET_RANGE, FILL_HANDLE_DEFAULTS.top);
  const size = clampRange(next?.size, FILL_HANDLE_SIZE_RANGE, FILL_HANDLE_DEFAULTS.size);
  setToken(doc?.documentElement, FILL_HANDLE_LEFT_TOKEN, `${left}px`);
  setToken(doc?.documentElement, FILL_HANDLE_TOP_TOKEN, `${top}px`);
  setToken(doc?.documentElement, FILL_HANDLE_SIZE_TOKEN, `${size}px`);
  return { left, top, size };
}

export function managedTokens() {
  const tokens = new Set([
    RADIUS_TOKEN,
    BORDER_TOKEN,
    FRAME_SHADOW_TOKEN,
    FILL_HANDLE_LEFT_TOKEN,
    FILL_HANDLE_TOP_TOKEN,
    FILL_HANDLE_SIZE_TOKEN,
  ]);
  for (const field of DEBUG_COLOR_FIELDS) for (const token of field.tokens) tokens.add(token);
  return [...tokens];
}

// 清掉两个模式目标元素上的全部内联覆盖，恢复样式表原值
// （深色覆盖写在 .mysql-workbench 上，即使当前已切回浅色也要一并清掉）
export function clearAllOverrides(mode, doc = globalThis.document) {
  const targets = new Set([
    resolveModeTarget(mode, doc),
    doc?.querySelector?.(".mysql-workbench"),
    doc?.documentElement,
  ]);
  for (const token of managedTokens()) {
    for (const target of targets) target?.style?.removeProperty?.(token);
  }
}

function channelToHex(channel) {
  const clamped = Math.min(1, Math.max(0, channel));
  return Math.round(clamped * 255).toString(16).padStart(2, "0");
}

// oklch → sRGB（Ottosson 矩阵）：token 大量用 oklch 表示，headless 环境 canvas 不可靠，纯数学换算最稳
export function oklchToHex(lightness, chroma, hueDegrees) {
  const hue = (Number(hueDegrees) * Math.PI) / 180;
  const a = Number(chroma) * Math.cos(hue);
  const b = Number(chroma) * Math.sin(hue);
  const L = Number(lightness);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const toSrgb = (channel) =>
    channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
  const r = toSrgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const bl = toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return `#${channelToHex(r)}${channelToHex(g)}${channelToHex(bl)}`;
}

function parseOklch(text) {
  const match = text.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(deg)?\s*\)$/);
  if (!match) return null;
  const rawL = Number.parseFloat(match[1]);
  const lightness = match[2] === "%" ? rawL / 100 : rawL;
  return { lightness, chroma: Number.parseFloat(match[3]), hue: Number.parseFloat(match[4]) };
}

// 把 rgb()/oklch()/color-mix() 的计算值归一化成 #rrggbb（<input type="color"> 只认 hex）
export function colorToHex(value, doc = globalThis.document) {
  const text = String(value ?? "").trim();
  if (!text) return "#000000";
  if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toLowerCase();
  const rgbMatch = text.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (rgbMatch) {
    return `#${[rgbMatch[1], rgbMatch[2], rgbMatch[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  }
  const oklch = parseOklch(text);
  if (oklch) return oklchToHex(oklch.lightness, oklch.chroma, oklch.hue);
  try {
    const canvas = doc?.createElement?.("canvas");
    const ctx = canvas?.getContext?.("2d");
    if (!ctx) return text;
    ctx.fillStyle = "#000000";
    ctx.fillStyle = text;
    const normalized = ctx.fillStyle;
    if (/^#[0-9a-fA-F]{6}$/.test(normalized)) return normalized.toLowerCase();
    const m = normalized.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (m) {
      return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
    }
    return text;
  } catch {
    return text;
  }
}

function readToken(target, token) {
  if (!target) return "";
  return globalThis.getComputedStyle?.(target)?.getPropertyValue?.(token)?.trim() ?? "";
}

// 读取当前模式下的生效值（含内联覆盖），用于初始化控件与导出
export function readCurrentValues(mode, doc = globalThis.document) {
  const modeTarget = resolveModeTarget(mode, doc);
  const values = {};
  for (const field of DEBUG_COLOR_FIELDS) {
    values[field.key] = colorToHex(readToken(modeTarget, field.tokens[0]), doc);
  }
  const radiusText = readToken(doc?.documentElement, RADIUS_TOKEN);
  values.radius = Number.parseFloat(radiusText) || 0;
  const borderText = readToken(modeTarget, BORDER_TOKEN);
  const alphaMatch = borderText.match(/[\d.]+\s*\)$/);
  values.borderAlpha = alphaMatch ? Number.parseFloat(alphaMatch[0]) : BORDER_ALPHA_RANGE.min;
  const shadowText = readToken(modeTarget, FRAME_SHADOW_TOKEN);
  const shadowMatch = shadowText.match(/[\d.]+\s*\)$/);
  values.shadowStrength = shadowText === "none" || !shadowText ? 0 : shadowMatch ? Number.parseFloat(shadowMatch[0]) : 0;
  values.fillLeft = parsePx(readToken(doc?.documentElement, FILL_HANDLE_LEFT_TOKEN), FILL_HANDLE_DEFAULTS.left);
  values.fillTop = parsePx(readToken(doc?.documentElement, FILL_HANDLE_TOP_TOKEN), FILL_HANDLE_DEFAULTS.top);
  values.fillSize = parsePx(readToken(doc?.documentElement, FILL_HANDLE_SIZE_TOKEN), FILL_HANDLE_DEFAULTS.size);
  return values;
}

const DARK_EXPORT_SELECTOR = '.mysql-workbench[data-theme="dark"], .wb-floating-themed[data-theme="dark"]';

// 导出为可直接回填 workbench.css 的 CSS 片段
export function buildExportCss(mode, values) {
  const selector = mode === "dark" ? DARK_EXPORT_SELECTOR : ":root";
  const lines = [];
  for (const field of DEBUG_COLOR_FIELDS) {
    for (const token of field.tokens) lines.push(`  ${token}: ${values[field.key]};`);
  }
  lines.push(`  ${RADIUS_TOKEN}: ${values.radius}px;`);
  lines.push(`  ${BORDER_TOKEN}: rgba(${BORDER_RGB[mode] ?? BORDER_RGB.light}, ${values.borderAlpha});`);
  lines.push(`  ${FRAME_SHADOW_TOKEN}: ${values.shadowStrength > 0 ? `0 5px 8px -5px rgba(0, 0, 0, ${values.shadowStrength})` : "none"};`);
  lines.push(`  ${FILL_HANDLE_LEFT_TOKEN}: ${values.fillLeft ?? FILL_HANDLE_DEFAULTS.left}px;`);
  lines.push(`  ${FILL_HANDLE_TOP_TOKEN}: ${values.fillTop ?? FILL_HANDLE_DEFAULTS.top}px;`);
  lines.push(`  ${FILL_HANDLE_SIZE_TOKEN}: ${values.fillSize ?? FILL_HANDLE_DEFAULTS.size}px;`);
  return `/* 设计调试导出（${mode === "dark" ? "深色" : "浅色"} 模式） */\n${selector} {\n${lines.join("\n")}\n}`;
}
