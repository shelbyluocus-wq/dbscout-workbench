import { DATABASE_DECORATION_COLORS } from "../composables/databaseDecorationStore.js";

export const RAIL_DATABASE_ICON_IDS = Object.freeze([
  "database", "server", "cloud", "boxes", "package", "archive", "layers", "globe",
  "rocket", "flask", "bug", "wrench", "shield", "lock", "flag", "target",
  "gamepad", "swords", "crown", "trophy", "gem", "coins", "gift", "dice",
  "map", "castle", "skull", "ghost", "flame", "zap", "sparkles", "puzzle",
  "star", "heart", "cat", "dog", "bird", "leaf", "sun", "moon",
]);

export const RAIL_DATABASE_COLORS = DATABASE_DECORATION_COLORS;

export const RAIL_AUTO_COLOR_ORDER = Object.freeze([
  "#0f766e", "#2563eb", "#7c3aed", "#c2410c", "#15803d", "#be123c", "#b45309", "#64748b",
]);

export const RAIL_INK_LIGHT = "#ffffff";
export const RAIL_INK_DARK = "#111827";

const RAIL_ICON_ID_SET = new Set(RAIL_DATABASE_ICON_IDS);
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

export function railDatabaseId(connectionId, database) {
  return `${String(connectionId || "")}\u001f${String(database || "")}`;
}

export function normalizeRailIcon(value) {
  const id = String(value || "").trim().toLowerCase();
  return RAIL_ICON_ID_SET.has(id) ? id : "";
}

export function normalizeRailColor(value) {
  const color = String(value || "").trim().toLowerCase();
  return HEX_COLOR_PATTERN.test(color) ? color : "";
}

export function normalizeRailText(value) {
  const chars = Array.from(String(value || "").replace(/[\s\p{Cc}\p{Cf}]+/gu, ""));
  if (!chars.length) return "";
  const allAscii = chars.every((char) => char.charCodeAt(0) < 128);
  return chars.slice(0, allAscii ? 3 : 2).join("");
}

export function isCompactRailText(text) {
  const chars = Array.from(String(text || ""));
  if (chars.length >= 3) return true;
  return chars.length >= 2 && chars.some((char) => char.charCodeAt(0) > 127);
}

export function deriveRailMonogram(label) {
  const text = String(label || "").trim();
  if (!text) return "DB";
  const digits = /\d+/.exec(text);
  if (digits) return digits[0].slice(0, 3);
  const han = text.match(/\p{Script=Han}/gu);
  if (han?.length) return han.slice(0, 2).join("");
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length >= 2) {
    const first = Array.from(words[0])[0] || "";
    const second = Array.from(words[1])[0] || "";
    return (first + second).toUpperCase();
  }
  if (words.length === 1) {
    const chars = Array.from(words[0]);
    return (chars[0] || "").toUpperCase() + (chars[1] || "").toLowerCase();
  }
  return Array.from(text).slice(0, 2).join("");
}

function channelLuminance(value) {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return (
    0.2126 * channelLuminance((value >> 16) & 255)
    + 0.7152 * channelLuminance((value >> 8) & 255)
    + 0.0722 * channelLuminance(value & 255)
  );
}

function contrastRatio(first, second) {
  const [high, low] = first > second ? [first, second] : [second, first];
  return (high + 0.05) / (low + 0.05);
}

export function readableInkOn(hex) {
  const background = relativeLuminance(hex);
  if (background == null) return RAIL_INK_LIGHT;
  const light = contrastRatio(background, 1);
  const dark = contrastRatio(background, relativeLuminance(RAIL_INK_DARK));
  return light >= dark ? RAIL_INK_LIGHT : RAIL_INK_DARK;
}

function stableStringHash(text) {
  let hash = 0;
  const value = String(text || "");
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function autoRailColor(id) {
  return RAIL_AUTO_COLOR_ORDER[stableStringHash(id) % RAIL_AUTO_COLOR_ORDER.length];
}

export function nextRailColor(usedColors, id) {
  const used = new Set(
    (Array.isArray(usedColors) ? usedColors : []).map((color) => String(color || "").toLowerCase()),
  );
  const free = RAIL_AUTO_COLOR_ORDER.find((color) => !used.has(color.toLowerCase()));
  return free || autoRailColor(id);
}
