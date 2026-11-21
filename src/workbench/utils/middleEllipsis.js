const TRAILING_TOKEN_PATTERN = /[_.-][a-zA-Z0-9]{1,8}$/;

/**
 * Splits a long identifier into `{ head, tail }` for pure-CSS middle ellipsis
 * (`head` gets `text-overflow: ellipsis`, `tail` stays `flex-shrink: 0`).
 *
 * Invariant: `head + tail === String(text ?? "")` so DOM `textContent` and
 * screen-reader labels remain identical to the original string.
 */
export function splitMiddleEllipsis(text, { minLength = 14, tailLength = 6 } = {}) {
  const value = String(text ?? "");
  const chars = Array.from(value);
  if (chars.length <= minLength) {
    return { head: value, tail: "" };
  }

  const maxTail = Math.max(1, Math.min(10, Math.floor(chars.length * 0.4)));
  let keepTail = Math.min(tailLength, maxTail);
  const suffixMatch = value.match(TRAILING_TOKEN_PATTERN);
  if (suffixMatch) {
    const suffixChars = Array.from(suffixMatch[0]).length;
    keepTail = Math.min(maxTail, Math.max(keepTail, suffixChars));
  }

  const splitAt = chars.length - keepTail;
  if (splitAt <= 4) {
    return { head: value, tail: "" };
  }

  return {
    head: chars.slice(0, splitAt).join(""),
    tail: chars.slice(splitAt).join(""),
  };
}
