import { compareSearchMatches, matchSearchText, searchMatchRank } from "./searchMatch.js";

const TABLE_NAME_RANK = 0;
const TABLE_COMMENT_RANK = 10;
const UNORDERED_TEXT_RANK = searchMatchRank.subsequence + 1;

function textValues(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function bestTextMatch(values, query, { mode = "fuzzy" } = {}) {
  const candidates = textValues(values);
  const ordered = candidates
    .map((value) => matchSearchText(value, query, { mode }))
    .filter((match) => match.matched)
    .sort(compareSearchMatches)[0];
  if (ordered) return ordered;
  if (mode !== "fuzzy") return null;

  return candidates
    .map((value) => unorderedTextMatch(value, query))
    .filter(Boolean)
    .sort(compareSearchMatches)[0] || null;
}

function unorderedRanges(text, query) {
  const haystack = String(text ?? "").toLowerCase();
  const needle = String(query ?? "").toLowerCase();
  if (needle.length < 3 || !/^[a-z0-9]+$/.test(needle) || !/^[\x00-\x7f]*$/.test(haystack)) return [];

  const used = new Set();
  const positions = [];
  let previous = -1;
  for (const char of needle) {
    let index = haystack.indexOf(char, previous + 1);
    while (index >= 0 && used.has(index)) index = haystack.indexOf(char, index + 1);
    if (index < 0) {
      index = haystack.indexOf(char);
      while (index >= 0 && used.has(index)) index = haystack.indexOf(char, index + 1);
    }
    if (index < 0) return [];
    used.add(index);
    positions.push(index);
    previous = index;
  }
  if (positions.every((position, index) => index === 0 || positions[index - 1] < position)) return [];
  return positions.map((start) => ({ start, end: start + 1 }));
}

function unorderedTextMatch(text, query) {
  const ranges = unorderedRanges(text, query);
  if (!ranges.length) return null;

  const positions = ranges.map((range) => range.start);
  let inversions = 0;
  for (let left = 0; left < positions.length; left++) {
    for (let right = left + 1; right < positions.length; right++) {
      if (positions[left] > positions[right]) inversions += 1;
    }
  }
  const first = Math.min(...positions);
  const last = Math.max(...positions);
  const gap = Math.max(0, last - first + 1 - ranges.length);
  return {
    matched: true,
    kind: "unordered",
    rank: UNORDERED_TEXT_RANK,
    score: inversions * 1000 + gap * 100 + first * 10 + Math.max(0, String(text).length - ranges.length),
    ranges,
  };
}

function unmatchedTableSearch() {
  return {
    matched: false,
    kind: "none",
    textMatchKind: "none",
    rank: searchMatchRank.none,
    score: Number.POSITIVE_INFINITY,
  };
}

export function matchTableSearch(table, query, { includeComments = true, mode = "fuzzy", includedKinds = null } = {}) {
  const needle = String(query ?? "").trim();
  if (!needle) return unmatchedTableSearch();

  const allowedKinds = Array.isArray(includedKinds) && includedKinds.length
    ? new Set(includedKinds)
    : null;

  const nameMatch = allowedKinds && !allowedKinds.has("tableName")
    ? null
    : bestTextMatch([table?.tableName, table?.table_name, table?.name], needle, { mode });
  if (nameMatch?.matched) {
    return {
      ...nameMatch,
      kind: "tableName",
      textMatchKind: nameMatch.kind,
      rank: TABLE_NAME_RANK + nameMatch.rank,
    };
  }

  if (includeComments && (!allowedKinds || allowedKinds.has("tableComment"))) {
    const commentMatch = bestTextMatch(
      [table?.tableComment, table?.table_comment, table?.comment],
      needle,
      { mode },
    );
    if (commentMatch?.matched) {
      return {
        ...commentMatch,
        kind: "tableComment",
        textMatchKind: commentMatch.kind,
        rank: TABLE_COMMENT_RANK + commentMatch.rank,
      };
    }
  }
  return unmatchedTableSearch();
}

export function rankTableSearchResults(tables = [], query = "", options = {}) {
  const list = Array.isArray(tables?.value) ? tables.value : tables;
  if (!Array.isArray(list)) return [];
  const needle = String(query ?? "").trim();
  if (!needle) return list.map((table, index) => ({ table, index, match: unmatchedTableSearch() }));

  return list
    .map((table, index) => ({ table, index, match: matchTableSearch(table, needle, options) }))
    .filter(({ match }) => match.matched)
    .sort((left, right) =>
      left.match.rank - right.match.rank
      || left.match.score - right.match.score
      || left.index - right.index);
}

export function findBestTableSearchMatch(tables = [], query = "", options = {}) {
  return rankTableSearchResults(tables, query, options)[0]?.table || null;
}
