// How strongly artwork may show behind frame text. The frame (title bar, rail,
// sidebar) draws its labels straight on the wallpaper, so the strongest safe
// opacity is derived from the picture itself instead of a fixed veil: light
// artwork can show fully in the light appearance while a dark photo is dimmed
// until the quietest label still meets WCAG AA.
//
// The reference colours are the most demanding frame surface among the bundled
// colour themes (darkest light chrome, lightest dark chrome) and the quiet text
// token, so a ceiling holds for every theme.
export const WALLPAPER_TONE_REFERENCE = Object.freeze({
  light: Object.freeze({ base: Object.freeze([231, 236, 236]), text: Object.freeze([79, 86, 97]) }),
  dark: Object.freeze({ base: Object.freeze([27, 31, 35]), text: Object.freeze([162, 169, 179]) }),
});
export const WALLPAPER_MIN_CONTRAST = 4.5;
const SAMPLE_WIDTH = 48;
const SAMPLE_HEIGHT = 27;

const linear = (channel) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const luminance = (red, green, blue) => 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
const contrast = (first, second) => (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);

function ceilingFor(pixels, { base, text }) {
  const textLuminance = luminance(...text);
  // Opacity composites in sRGB, so mix the encoded channels before measuring.
  const readable = (opacity) => {
    for (let index = 0; index + 3 < pixels.length; index += 4) {
      const alpha = opacity * pixels[index + 3] / 255;
      const mixed = luminance(
        base[0] + (pixels[index] - base[0]) * alpha,
        base[1] + (pixels[index + 1] - base[1]) * alpha,
        base[2] + (pixels[index + 2] - base[2]) * alpha,
      );
      if (contrast(mixed, textLuminance) < WALLPAPER_MIN_CONTRAST) return false;
    }
    return true;
  };
  if (readable(1)) return 1;
  // Each pixel only moves away from the base as opacity grows, so the readable
  // range is one interval starting at zero.
  let low = 0;
  let high = 1;
  for (let step = 0; step < 10; step += 1) {
    const middle = (low + high) / 2;
    if (readable(middle)) low = middle;
    else high = middle;
  }
  return Math.floor(low * 100) / 100;
}

/** RGBA bytes (any length) → the strongest readable opacity per appearance. */
export function wallpaperCeilings(pixels) {
  return {
    light: ceilingFor(pixels, WALLPAPER_TONE_REFERENCE.light),
    dark: ceilingFor(pixels, WALLPAPER_TONE_REFERENCE.dark),
  };
}

// Pure black and pure white bound every possible picture; used when a frame
// cannot be read back (decoder quirks) or keeps changing (playing video).
export const WALLPAPER_FALLBACK_CEILINGS = Object.freeze(
  wallpaperCeilings(new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255])),
);

/** Samples a loaded <img> or a <video> frame. Never throws. */
export function measureWallpaperCeilings(media, { document = globalThis.document } = {}) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_WIDTH;
    canvas.height = SAMPLE_HEIGHT;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.imageSmoothingQuality = "high";
    context.drawImage(media, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    return wallpaperCeilings(context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data);
  } catch {
    return WALLPAPER_FALLBACK_CEILINGS;
  }
}
