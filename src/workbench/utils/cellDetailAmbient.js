// Time-of-day palette for the cell detail panel's frosted-glass hazes.
// Colors are opaque; each theme decides how strongly they tint the glass.

export const MINUTES_PER_DAY = 1440;

// [minute of day, primary haze, secondary haze]. Deliberately muted: the
// time of day should read as a change of light, never as color.
export const AMBIENT_KEYFRAMES = [
  [0, "#7d86b0", "#8c88a8"],
  [300, "#878cb0", "#9a92aa"],
  [390, "#bda89e", "#b8acb4"],
  [540, "#a2b2c6", "#aabcc2"],
  [720, "#9db6cc", "#a8c0bc"],
  [930, "#c0b49c", "#a6b6c6"],
  [1080, "#bba092", "#b39ca4"],
  [1170, "#a198b8", "#ac9cb0"],
  [1290, "#848cb4", "#958eb2"],
];

export function normalizeMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return 0;
  return ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

export function minutesOfDay(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

export function formatMinutes(value) {
  const minutes = Math.floor(normalizeMinutes(value));
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex(rgb) {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function mixHex(from, to, amount) {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  return rgbToHex(a.map((channel, index) => channel + (b[index] - channel) * amount));
}

function smoothstep(amount) {
  return amount * amount * (3 - 2 * amount);
}

function surroundingKeyframes(minutes) {
  const frames = AMBIENT_KEYFRAMES;
  for (let index = 0; index < frames.length; index += 1) {
    const next = frames[(index + 1) % frames.length];
    const start = frames[index][0];
    const end = index + 1 < frames.length ? next[0] : next[0] + MINUTES_PER_DAY;
    if (minutes >= start && minutes < end) return { from: frames[index], to: next, amount: (minutes - start) / (end - start) };
  }
  return { from: frames[0], to: frames[1], amount: 0 };
}

const percent = (value) => `${value.toFixed(1)}%`;

// The primary haze travels like the sun: rising on the left at 06:00, at the
// top center at noon, setting on the right at 18:00 and sinking out of view
// overnight; the secondary haze mirrors it. Everything is continuous across
// midnight, so a running clock never jumps.
export function resolveAmbient(value) {
  const minutes = normalizeMinutes(value);
  const { from, to, amount } = surroundingKeyframes(minutes);
  const eased = smoothstep(amount);
  const angle = (2 * Math.PI * minutes) / MINUTES_PER_DAY;
  const x = 50 - 45 * Math.cos(angle - Math.PI / 2);
  const y = 50 + 50 * Math.cos(angle);
  return {
    minutes,
    primary: mixHex(from[1], to[1], eased),
    secondary: mixHex(from[2], to[2], eased),
    primaryX: x,
    primaryY: y,
    secondaryX: 100 - x,
    secondaryY: 100 - y,
  };
}

export function ambientStyleVars(value) {
  const ambient = resolveAmbient(value);
  return {
    "--wb-ambient-a": ambient.primary,
    "--wb-ambient-b": ambient.secondary,
    "--wb-ambient-ax": percent(ambient.primaryX),
    "--wb-ambient-ay": percent(ambient.primaryY),
    "--wb-ambient-bx": percent(ambient.secondaryX),
    "--wb-ambient-by": percent(ambient.secondaryY),
  };
}
