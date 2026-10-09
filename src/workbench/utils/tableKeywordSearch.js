import { findCaseInsensitiveRange } from "./searchMatch.js";

// Relevance tiers for keyword table search; lower is better. Within a tier the
// caller keeps its own ordering (for example the active sort mode).
export const TABLE_KEYWORD_TIER = Object.freeze({
  nameExact: 0,
  namePrefix: 1,
  nameWordStart: 2,
  nameContains: 3,
  mixed: 4,
  commentExact: 5,
  commentPrefix: 6,
  commentWordStart: 7,
  commentContains: 8,
});

const FIELD_TIER = Object.freeze({ exact: 0, prefix: 1, wordStart: 2, contains: 3 });
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;
const DIGIT = /\p{N}/u;
const LETTER = /\p{L}/u;

function noMatch() {
  return { matched: false, tier: Number.POSITIVE_INFINITY, nameRanges: [], commentRanges: [] };
}

/**
 * Split a search box value into distinct lower-cased keywords. Any whitespace,
 * including the full-width IME space, separates keywords.
 */
export function parseSearchKeywords(query) {
  const words = String(query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(words)];
}

function charBefore(text, index) {
  const low = text.charCodeAt(index - 1);
  if (index >= 2 && low >= 0xdc00 && low <= 0xdfff) return text.slice(index - 2, index);
  return text[index - 1];
}

// A keyword starts a word after a separator (`_`, `-`, `.`, space, ...), at a
// camelCase hump, at a letter/digit change, or where an acronym run ends
// (`HTTPServer` → `Server`).
function isWordStart(text, index) {
  if (index === 0) return true;
  const previous = charBefore(text, index);
  const current = text[index];
  if (!LETTER_OR_DIGIT.test(previous)) return true;
  if (LOWER.test(previous) && UPPER.test(current)) return true;
  if ((LETTER.test(previous) && DIGIT.test(current)) || (DIGIT.test(previous) && LETTER.test(current))) return true;
  return UPPER.test(previous) && UPPER.test(current) && LOWER.test(text[index + 1] || "");
}

function keywordInField(text, lowerText, keyword, allowExact) {
  // Lower-casing can change UTF-16 offsets for a few characters; keep exact
  // source ranges there and skip word-start detection.
  if (lowerText.length !== text.length) {
    const range = findCaseInsensitiveRange(text, keyword);
    if (!range) return null;
    const tier = range.start !== 0
      ? FIELD_TIER.contains
      : allowExact && range.end === text.length ? FIELD_TIER.exact : FIELD_TIER.prefix;
    return { tier, range };
  }

  let start = lowerText.indexOf(keyword);
  if (start < 0) return null;
  const range = (at) => ({ start: at, end: at + keyword.length });
  if (start === 0) {
    return { tier: allowExact && keyword.length === text.length ? FIELD_TIER.exact : FIELD_TIER.prefix, range: range(0) };
  }
  const first = start;
  while (start >= 0) {
    if (isWordStart(text, start)) return { tier: FIELD_TIER.wordStart, range: range(start) };
    start = lowerText.indexOf(keyword, start + 1);
  }
  return { tier: FIELD_TIER.contains, range: range(first) };
}

function matchField(text, keywords) {
  const value = String(text ?? "");
  if (!value) return { hits: [], worstTier: Number.POSITIVE_INFINITY, all: false };
  const lowerValue = value.toLowerCase();
  const allowExact = keywords.length === 1;
  const hits = [];
  let worstTier = -1;
  for (const keyword of keywords) {
    const hit = keywordInField(value, lowerValue, keyword, allowExact);
    hits.push(hit);
    if (hit) worstTier = Math.max(worstTier, hit.tier);
  }
  return { hits, worstTier, all: hits.every(Boolean) };
}

/**
 * Match a table against already parsed keywords. Every keyword must appear as
 * contiguous text in the table name or comment, in any order. The returned
 * ranges cover each keyword found in each field, for highlighting.
 */
export function matchTableKeywords(table, keywords = []) {
  if (!keywords.length) return noMatch();
  const name = matchField(table?.tableName ?? table?.table_name ?? table?.name, keywords);
  const comment = matchField(table?.tableComment ?? table?.table_comment ?? table?.comment, keywords);
  const covered = keywords.every((_, index) => name.hits[index] || comment.hits[index]);
  if (!covered) return noMatch();

  const tier = name.all
    ? TABLE_KEYWORD_TIER.nameExact + name.worstTier
    : comment.all
      ? TABLE_KEYWORD_TIER.commentExact + comment.worstTier
      : TABLE_KEYWORD_TIER.mixed;
  return {
    matched: true,
    tier,
    nameRanges: name.hits.filter(Boolean).map((hit) => hit.range),
    commentRanges: comment.hits.filter(Boolean).map((hit) => hit.range),
  };
}

/**
 * Filter an already ordered table list by keywords. Better tiers come first and
 * each tier keeps the input order, so the result is a stable partition: one
 * linear pass, no re-sorting while the user types.
 */
export function filterTablesByKeywords(tables = [], query = "") {
  const list = Array.isArray(tables) ? tables : [];
  const keywords = parseSearchKeywords(query);
  if (!keywords.length) return list;
  const buckets = [];
  for (const table of list) {
    const { matched, tier } = matchTableKeywords(table, keywords);
    if (!matched) continue;
    (buckets[tier] ||= []).push(table);
  }
  return buckets.flat();
}
