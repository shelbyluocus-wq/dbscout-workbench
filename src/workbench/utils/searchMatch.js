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

function levenshteinDistance(left, right) {
  const a = Array.from(String(left ?? ""));
  const b = Array.from(String(right ?? ""));
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      current[j + 1] = Math.min(
        current[j] + 1,
        previous[j + 1] + 1,
        previous[j] + cost,
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function similarMatch(text, query) {
  const distance = levenshteinDistance(text, query);
  const maxLength = Math.max(text.length, query.length);
  if (!maxLength) return null;
  const ratio = distance / maxLength;
  const allowedDistance = maxLength <= 4 ? 1 : maxLength <= 8 ? 2 : 3;
  if (distance > allowedDistance || ratio > 0.34) return null;
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

  const text = rawText.toLowerCase();
  const needle = rawQuery.toLowerCase();
  if (text === needle) return rangeMatch("exact", searchMatchRank.exact, 0, rawText.length);
  if (text.startsWith(needle)) return rangeMatch("prefix", searchMatchRank.prefix, 0, rawQuery.length);
  const containsIndex = text.indexOf(needle);
  if (containsIndex >= 0) return rangeMatch("contains", searchMatchRank.contains, containsIndex, rawQuery.length);

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

  let html = "";
  let cursor = 0;
  for (const range of mergeRanges(match.ranges)) {
    html += escapeHtmlText(text.slice(cursor, range.start));
    html += `<mark>${escapeHtmlText(text.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  }
  return html + escapeHtmlText(text.slice(cursor));
}
