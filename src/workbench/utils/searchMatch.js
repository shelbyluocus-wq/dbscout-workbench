export const searchMatchRank = Object.freeze({
  exact: 0,
  prefix: 1,
  contains: 2,
  similar: 3,
  subsequence: 4,
  none: Number.POSITIVE_INFINITY,
});

function escapeHtmlText(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function emptyMatch() {
  return { matched: false, kind: "none", rank: searchMatchRank.none, score: Number.POSITIVE_INFINITY, ranges: [] };
}

function rangeMatch(kind, rank, start, length) {
  return {
    matched: true,
    kind,
    rank,
    score: 0,
    ranges: [{ start, end: start + length }],
  };
}

export function findCaseInsensitiveRange(value, query) {
  const text = String(value ?? "");
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return null;

  const normalized = text.toLowerCase();
  const normalizedStart = normalized.indexOf(needle);
  if (normalizedStart < 0) return null;
  const normalizedEnd = normalizedStart + needle.length;
  // Most identifiers and comments preserve UTF-16 offsets when lower-cased.
  // Avoid allocating one segment object per character on this common path.
  if (normalized.length === text.length) {
    return { start: normalizedStart, end: normalizedEnd };
  }

  let normalizedOffset = 0;
  let sourceOffset = 0;
  const segments = [];
  for (const sourceChar of text) {
    const sourceStart = sourceOffset;
    sourceOffset += sourceChar.length;
    const normalizedStart = normalizedOffset;
    normalizedOffset += sourceChar.toLowerCase().length;
    segments.push({
      normalizedStart,
      normalizedEnd: normalizedOffset,
      sourceStart,
      sourceEnd: sourceOffset,
    });
  }

  const overlapping = segments.filter(
    (segment) => segment.normalizedStart < normalizedEnd && normalizedStart < segment.normalizedEnd,
  );
  if (!overlapping.length) return null;
  return {
    start: overlapping[0].sourceStart,
    end: overlapping[overlapping.length - 1].sourceEnd,
  };
}

export function contiguousSearchPreview(value, query, maxChars = 80) {
  const text = String(value ?? "");
  const limit = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (!limit) return "";
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  const range = findCaseInsensitiveRange(text, query);
  if (!range) return chars.slice(0, limit).join("");

  let sourceOffset = 0;
  const sourceSegments = chars.map((char) => {
    const start = sourceOffset;
    sourceOffset += char.length;
    return { start, end: sourceOffset };
  });
  const matchStart = sourceSegments.findIndex((segment) => segment.start <= range.start && range.start < segment.end);
  const matchEnd = sourceSegments.reduce(
    (end, segment, index) => (segment.start < range.end && range.start < segment.end ? index + 1 : end),
    matchStart + 1,
  );
  const matchLength = matchEnd - matchStart;
  const windowLength = Math.min(chars.length, Math.max(limit, matchLength));
  const contextBefore = Math.floor((windowLength - matchLength) / 2);
  let windowStart = Math.max(0, matchStart - contextBefore);
  if (windowStart + windowLength < matchEnd) windowStart = matchEnd - windowLength;
  windowStart = Math.min(windowStart, chars.length - windowLength);
  return chars.slice(windowStart, windowStart + windowLength).join("");
}

function subsequenceRanges(text, query) {
  const haystack = String(text ?? "").toLowerCase();
  const needle = String(query ?? "").toLowerCase();
  const ranges = [];
  let cursor = 0;
  for (const char of needle) {
    const index = haystack.indexOf(char, cursor);
    if (index < 0) return [];
    ranges.push({ start: index, end: index + char.length });
    cursor = index + char.length;
  }
  return ranges;
}

function levenshteinDistance(left, right, maxDistance = Number.POSITIVE_INFINITY) {
  const a = Array.from(String(left ?? ""));
  const b = Array.from(String(right ?? ""));
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const bounded = Number.isFinite(maxDistance);
  const limit = bounded ? Math.max(0, Math.floor(maxDistance)) : Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array(b.length + 1);
  for (let i = 0; i < a.length; i++) {
    current.fill(limit + 1);
    current[0] = i + 1;
    const start = Math.max(1, i + 1 - limit);
    const end = Math.min(b.length, i + 1 + limit);
    let rowMinimum = limit + 1;
    for (let j = start; j <= end; j++) {
      const cost = a[i] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
      rowMinimum = Math.min(rowMinimum, current[j]);
    }
    if (bounded && rowMinimum > limit) return limit + 1;
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

function similarMatch(text, query) {
  const maxLength = Math.max(text.length, query.length);
  if (!maxLength) return null;
  const allowedDistance = maxLength <= 4 ? 1 : maxLength <= 12 ? 2 : 3;
  const distanceLimit = Math.min(allowedDistance, Math.floor(maxLength * 0.34));
  if (Math.abs(text.length - query.length) > distanceLimit) return null;
  const distance = levenshteinDistance(text, query, distanceLimit);
  if (distance > distanceLimit) return null;
  return {
    matched: true,
    kind: "similar",
    rank: searchMatchRank.similar,
    score: distance * 100 + Math.abs(text.length - query.length),
    ranges: [{ start: 0, end: String(text).length }],
  };
}

function subsequenceScore(ranges, textLength, queryLength) {
  if (!ranges.length) return Number.POSITIVE_INFINITY;
  const first = ranges[0].start;
  const last = ranges[ranges.length - 1].end;
  const span = last - first;
  const gap = Math.max(0, span - queryLength);
  return gap * 100 + Math.max(0, textLength - queryLength) + first * 2;
}

export function matchSearchText(value, query, { mode = "fuzzy" } = {}) {
  const rawText = String(value ?? "");
  const rawQuery = String(query ?? "").trim();
  if (!rawQuery) return emptyMatch();
  if (mode === "exact") {
    return rawText === rawQuery
      ? rangeMatch("exact", searchMatchRank.exact, 0, rawText.length)
      : emptyMatch();
  }

  const contiguousRange = findCaseInsensitiveRange(rawText, rawQuery);
  if (contiguousRange) {
    const kind = contiguousRange.start === 0 && contiguousRange.end === rawText.length
      ? "exact"
      : contiguousRange.start === 0
        ? "prefix"
        : "contains";
    return rangeMatch(kind, searchMatchRank[kind], contiguousRange.start, contiguousRange.end - contiguousRange.start);
  }
  if (mode === "contains" || mode === "continuous") return emptyMatch();

  const text = rawText.toLowerCase();
  const needle = rawQuery.toLowerCase();
  const similar = similarMatch(text, needle);
  if (similar) return similar;

  const ranges = subsequenceRanges(rawText, rawQuery);
  if (ranges.length) {
    return {
      matched: true,
      kind: "subsequence",
      rank: searchMatchRank.subsequence,
      score: subsequenceScore(ranges, rawText.length, rawQuery.length),
      ranges,
    };
  }
  return emptyMatch();
}

function findAllReplaceRanges(text, needle, caseSensitive) {
  if (!needle) return [];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const ranges = [];
  let cursor = 0;
  for (;;) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) break;
    ranges.push({ start: index, end: index + needle.length });
    cursor = index + needle.length;
  }
  if (caseSensitive || haystack.length === text.length) return ranges;

  // Lower-casing changed UTF-16 length (rare, e.g. some unicode): rebuild the
  // source-coordinate segments like findCaseInsensitiveRange and map each
  // normalized range back to source offsets.
  const segments = [];
  let normalizedOffset = 0;
  let sourceOffset = 0;
  for (const sourceChar of text) {
    const sourceStart = sourceOffset;
    sourceOffset += sourceChar.length;
    const normalizedStart = normalizedOffset;
    normalizedOffset += sourceChar.toLowerCase().length;
    segments.push({ normalizedStart, normalizedEnd: normalizedOffset, sourceStart, sourceEnd: sourceOffset });
  }
  return ranges.map((range) => {
    const overlapping = segments.filter(
      (segment) => segment.normalizedStart < range.end && range.start < segment.normalizedEnd,
    );
    if (!overlapping.length) return range;
    return { start: overlapping[0].sourceStart, end: overlapping[overlapping.length - 1].sourceEnd };
  });
}

/**
 * Return every match range of `query` inside `value` (substring semantics,
 * case-insensitive by default), in source order. Empty query → empty list.
 * Used by the find/replace dialog to highlight hits in the result list.
 */
export function findSearchRanges(value, query, { caseSensitive = false } = {}) {
  const text = String(value ?? "");
  const needle = String(query ?? "");
  if (!needle) return [];
  return findAllReplaceRanges(text, caseSensitive ? needle : needle.toLowerCase(), caseSensitive);
}

/**
 * Replace every occurrence of `query` inside `value` with `replacement`
 * (Excel-style substring replace). Matching is case-insensitive by default.
 * Returns `{ text, replacedCount }`; an empty/absent query is a no-op.
 */
export function replaceSearchText(value, query, replacement, { caseSensitive = false } = {}) {
  const text = String(value ?? "");
  const needle = String(query ?? "");
  if (!needle) return { text, replacedCount: 0 };
  const substitute = String(replacement ?? "");
  const ranges = findAllReplaceRanges(text, caseSensitive ? needle : needle.toLowerCase(), caseSensitive);
  if (!ranges.length) return { text, replacedCount: 0 };

  let next = "";
  let cursor = 0;
  for (const range of ranges) {
    next += text.slice(cursor, range.start) + substitute;
    cursor = range.end;
  }
  next += text.slice(cursor);
  return { text: next, replacedCount: ranges.length };
}

export function compareSearchMatches(left, right) {
  const leftRank = left?.rank ?? searchMatchRank.none;
  const rightRank = right?.rank ?? searchMatchRank.none;
  const delta = leftRank - rightRank || (left?.score ?? Number.POSITIVE_INFINITY) - (right?.score ?? Number.POSITIVE_INFINITY);
  return delta < 0 ? -1 : delta > 0 ? 1 : 0;
}

export function mergeRanges(ranges = []) {
  const ordered = ranges
    .filter((range) => Number.isFinite(range?.start) && Number.isFinite(range?.end) && range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

export function highlightSearchText(value, query, { mode = "fuzzy" } = {}) {
  const text = String(value ?? "");
  const match = matchSearchText(text, query, { mode });
  if (!match.matched) return escapeHtmlText(text);

  return highlightSearchRanges(text, match.ranges);
}

export function highlightSearchRanges(value, ranges = []) {
  const text = String(value ?? "");

  let html = "";
  let cursor = 0;
  for (const range of mergeRanges(ranges)) {
    html += escapeHtmlText(text.slice(cursor, range.start));
    html += `<mark>${escapeHtmlText(text.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  }
  return html + escapeHtmlText(text.slice(cursor));
}

export function searchMatchExcerpt(value, ranges = [], maxChars = 72) {
  const text = String(value ?? "");
  const limit = Math.max(8, Math.floor(Number(maxChars) || 72));
  const normalizedRanges = mergeRanges(ranges).filter((range) => range.start < text.length);
  if (text.length <= limit || !normalizedRanges.length) {
    return { text, ranges: normalizedRanges, prefix: false, suffix: false };
  }

  const firstMatch = normalizedRanges[0];
  const lastMatch = normalizedRanges[normalizedRanges.length - 1];
  const matchedSpan = Math.max(1, lastMatch.end - firstMatch.start);
  const focusSpan = Math.min(limit, matchedSpan);
  const context = Math.max(0, limit - focusSpan);
  let start = Math.max(0, firstMatch.start - Math.floor(context / 2));
  let end = Math.min(text.length, start + limit);
  if (matchedSpan <= limit && end < lastMatch.end) {
    end = Math.min(text.length, lastMatch.end);
    start = Math.max(0, end - limit);
  }
  if (end - start < limit) start = Math.max(0, end - limit);

  const prefix = start > 0;
  const suffix = end < text.length;
  const prefixText = prefix ? "…" : "";
  const excerptText = `${prefixText}${text.slice(start, end)}${suffix ? "…" : ""}`;
  const adjustedRanges = normalizedRanges
    .filter((range) => range.end > start && range.start < end)
    .map((range) => ({
      start: prefixText.length + Math.max(0, range.start - start),
      end: prefixText.length + Math.min(end, range.end) - start,
    }));
  return { text: excerptText, ranges: adjustedRanges, prefix, suffix };
}

export function highlightSearchExcerpt(value, ranges = [], maxChars = 72) {
  const excerpt = searchMatchExcerpt(value, ranges, maxChars);
  return highlightSearchRanges(excerpt.text, excerpt.ranges);
}
