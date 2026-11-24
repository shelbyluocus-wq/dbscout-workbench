const TRAILING_TOKEN_PATTERN = /[_.-][a-zA-Z0-9]{1,8}$/;
const DEFAULT_MIDDLE_ELLIPSIS_CACHE = new Map();
const MAX_CACHE_ENTRIES = 2000;

/**
 * Splits a long identifier into `{ head, tail }` for pure-CSS middle ellipsis
 * (`head` gets `text-overflow: ellipsis`, `tail` stays `flex-shrink: 0`).
 *
 * Invariant: `head + tail === String(text ?? "")` so DOM `textContent` and
 * screen-reader labels remain identical to the original string.
 */
export function splitMiddleEllipsis(text, { minLength = 14, tailLength = 6 } = {}) {
  const value = String(text ?? "");
  const useCache = minLength === 14 && tailLength === 6;
  if (useCache) {
    const cached = DEFAULT_MIDDLE_ELLIPSIS_CACHE.get(value);
    if (cached) return cached;
  }

  const chars = Array.from(value);
  let result;
  if (chars.length <= minLength) {
    result = { head: value, tail: "" };
  } else {
    const maxTail = Math.max(1, Math.min(10, Math.floor(chars.length * 0.4)));
    let keepTail = Math.min(tailLength, maxTail);
    const suffixMatch = value.match(TRAILING_TOKEN_PATTERN);
    if (suffixMatch) {
      const suffixChars = Array.from(suffixMatch[0]).length;
      keepTail = Math.min(maxTail, Math.max(keepTail, suffixChars));
    }

    const splitAt = chars.length - keepTail;
    result = splitAt <= 4
      ? { head: value, tail: "" }
      : {
          head: chars.slice(0, splitAt).join(""),
          tail: chars.slice(splitAt).join(""),
        };
  }

  if (useCache) {
    if (DEFAULT_MIDDLE_ELLIPSIS_CACHE.size >= MAX_CACHE_ENTRIES) DEFAULT_MIDDLE_ELLIPSIS_CACHE.clear();
    DEFAULT_MIDDLE_ELLIPSIS_CACHE.set(value, Object.freeze(result));
    return DEFAULT_MIDDLE_ELLIPSIS_CACHE.get(value);
  }
  return result;
}

function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

function commonSuffixLength(a, b, maxPrefix) {
  const limit = Math.min(a.length, b.length) - maxPrefix;
  let i = 0;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

/**
 * Splits a tab label into `{ head, tail }` without colliding sibling tabs that
 * share a long common prefix and boilerplate suffix (e.g.
 * `actbilayerdrawboxencmodelprop` vs `actbilayerdrawboxmodelprop`).
 *
 * - Explicit delimiter suffixes (`_tw`, `_en2`, `_v2`) always stay pinned on
 *   the right via `splitMiddleEllipsis`.
 * - When a sibling tab shares both a long prefix and a shared suffix, splits
 *   right at the diverging segment so both tabs remain visibly distinct.
 * - Standalone long names with no delimiter suffix use normal end-ellipsis so
 *   meaningful leading words are not sacrificed to a generic suffix like `elprop`.
 *
 * Invariant: `head + tail === String(text ?? "")`.
 */
export function splitTabLabel(
  text,
  siblingTexts = [],
  { minLength = 14, maxTailLength = 13 } = {},
) {
  const value = String(text ?? "");
  const chars = Array.from(value);
  if (chars.length <= minLength) {
    return { head: value, tail: "" };
  }

  if (TRAILING_TOKEN_PATTERN.test(value)) {
    return splitMiddleEllipsis(value, { minLength });
  }

  let bestDiffStart = -1;
  if (Array.isArray(siblingTexts) && siblingTexts.length > 0) {
    for (const rawSibling of siblingTexts) {
      const sibling = String(rawSibling ?? "");
      if (!sibling || sibling === value) continue;
      const siblingChars = Array.from(sibling);
      const lcp = commonPrefixLength(chars, siblingChars);
      if (lcp < 6) continue;
      const lcs = commonSuffixLength(chars, siblingChars, lcp);
      if (lcs < 4) continue;
      if (lcp > bestDiffStart) bestDiffStart = lcp;
    }
  }

  if (bestDiffStart >= 5) {
    const tailLen = chars.length - bestDiffStart;
    if (tailLen > 0 && tailLen <= maxTailLength) {
      return {
        head: chars.slice(0, bestDiffStart).join(""),
        tail: chars.slice(bestDiffStart).join(""),
      };
    }
  }

  return { head: value, tail: "" };
}
