// Open-plan notes are free text written per platform ("10/28 開放",
// "10/28-11/30 開放", "11/30 關閉", "暫不開放", "已開放"). They are parsed into
// a rule and evaluated against the update date to decide whether an item
// (hero, mount, feature…) should be open in the platform database after the
// release. A note the parser cannot read never produces a write.

const NEVER_PATTERN = /暫不開放|暂不开放|不開放|不开放|暫緩|暂缓|未定|待定|\bnot\s+yet\b|\bon\s+hold\b|\btbd\b|\bnever\b/i;
const ALWAYS_PATTERN = /已開放|已开放|常駐|常驻|永久|\balready\b|\balways\b|\bpermanent\b/i;
const CLOSE_PATTERN = /關閉|关闭|下線|下线|下架|結束|结束|\bclose[sd]?\b|\bends?\b|\boff\b/i;
const OPEN_PATTERN = /開放|开放|開啟|开启|上線|上线|上架|\bopens?\b|\blaunch(?:es)?\b|\blive\b/i;
const UNTIL_PATTERN = /(?:至|到|~|～|\buntil\b|\btill\b|\bthrough\b)\s*$/i;
const DATE_PATTERN = /(?:(\d{4})\s*[-/.年]\s*)?(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日號号]?/g;
const DAY_MS = 86400000;

export const PLAN_CHANGE = Object.freeze({ OPEN: "open", CLOSE: "close", KEEP: "keep", SKIP: "skip" });

function isoFromParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return date.toISOString().slice(0, 10);
}

export function isIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  return Boolean(match && isoFromParts(Number(match[1]), Number(match[2]), Number(match[3])));
}

export function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

// "10/28" carries no year: use the one that lands closest to the update date,
// so a December release reads "1/5" as early next year.
function nearestYearDate(month, day, referenceIso) {
  const referenceYear = Number(referenceIso.slice(0, 4));
  let best = "";
  for (const year of [referenceYear - 1, referenceYear, referenceYear + 1]) {
    const iso = isoFromParts(year, month, day);
    if (!iso) continue;
    if (!best || Math.abs(daysBetween(referenceIso, iso)) < Math.abs(daysBetween(referenceIso, best))) best = iso;
  }
  return best;
}

function readDates(note, referenceIso) {
  const dates = [];
  let invalid = false;
  for (const match of note.matchAll(DATE_PATTERN)) {
    const [token, year, month, day] = match;
    const iso = year
      ? isoFromParts(Number(year), Number(month), Number(day))
      : nearestYearDate(Number(month), Number(day), referenceIso);
    if (!iso) {
      invalid = true;
      continue;
    }
    dates.push({
      iso,
      until: UNTIL_PATTERN.test(note.slice(0, match.index)),
      after: note.slice(match.index + token.length),
    });
  }
  return { dates, invalid };
}

/**
 * Parse a note into a rule. Kinds: `empty`, `unknown`, `open` / `closed`
 * (no date), `always`, `never`, and `window` with `from` (first open day) and
 * `to` (first closed day, exclusive); either bound may be null.
 */
export function parsePlanNote(text, referenceIso) {
  const note = String(text ?? "").trim();
  if (!note) return { kind: "empty" };
  if (NEVER_PATTERN.test(note)) return { kind: "never" };
  const { dates, invalid } = readDates(note, referenceIso);
  if (!dates.length) {
    if (invalid) return { kind: "unknown" };
    if (ALWAYS_PATTERN.test(note)) return { kind: "always" };
    const opens = OPEN_PATTERN.test(note);
    const closes = CLOSE_PATTERN.test(note);
    if (opens && !closes) return { kind: "open" };
    if (closes && !opens) return { kind: "closed" };
    return { kind: "unknown" };
  }
  if (dates.length >= 2) {
    const [first, second] = dates;
    // "10/28-11/30 開放" keeps 11/30 open; "10/28 開放、11/30 關閉" closes on it.
    const to = CLOSE_PATTERN.test(second.after) ? second.iso : addDays(second.iso, 1);
    if (to <= first.iso) return { kind: "unknown" };
    return { kind: "window", from: first.iso, to };
  }
  const [only] = dates;
  if (only.until) return { kind: "window", from: null, to: addDays(only.iso, 1) };
  if (CLOSE_PATTERN.test(note) && !OPEN_PATTERN.test(note)) return { kind: "window", from: null, to: only.iso };
  return { kind: "window", from: only.iso, to: null };
}

/**
 * Decide the item's state on `dateIso`. `state` is "open", "closed" or null
 * when the note gives no answer; `reason` explains it for display.
 */
export function evaluatePlanRule(rule, dateIso) {
  switch (rule?.kind) {
    case "open":
    case "always":
      return { state: "open", reason: rule.kind };
    case "closed":
    case "never":
      return { state: "closed", reason: rule.kind };
    case "window":
      if (rule.from && dateIso < rule.from) {
        return { state: "closed", reason: "upcoming", days: daysBetween(dateIso, rule.from) };
      }
      if (rule.to && dateIso >= rule.to) return { state: "closed", reason: "ended" };
      return { state: "open", reason: rule.from === dateIso ? "opensToday" : "open" };
    default:
      return { state: null, reason: rule?.kind === "empty" ? "empty" : "unknown" };
  }
}

export function stateFlag(state) {
  if (state === "open") return 1;
  if (state === "closed") return 0;
  return null;
}

/**
 * Compare each item's planned state with the value currently in the database.
 * `noteFor(item)` returns the platform's note; `currentFor(item)` returns the
 * stored flag (1 / 0). Items whose note gives no answer are skipped.
 */
export function planChanges(items, { dateIso, noteFor, currentFor }) {
  return items.map((item) => {
    const note = noteFor(item);
    const rule = parsePlanNote(note, dateIso);
    const verdict = evaluatePlanRule(rule, dateIso);
    const current = currentFor(item);
    const next = stateFlag(verdict.state);
    let change = PLAN_CHANGE.KEEP;
    if (next === null) change = PLAN_CHANGE.SKIP;
    else if (current !== null && next !== current) {
      change = next === 1 ? PLAN_CHANGE.OPEN : PLAN_CHANGE.CLOSE;
    }
    return { item, note, rule, verdict, current, next, change };
  });
}

export function countPlanChanges(rows) {
  const counts = { open: 0, close: 0, keep: 0, skip: 0 };
  for (const row of rows) counts[row.change] += 1;
  return counts;
}

function sqlIdentifier(name) {
  return `\`${String(name).replace(/`/g, "``")}\``;
}

function sqlValue(value) {
  return /^-?\d+$/.test(String(value)) ? String(value) : `'${String(value).replace(/'/g, "''")}'`;
}

function keyTuple(key, columns) {
  if (columns.length === 1) return sqlValue(typeof key === "object" ? key[columns[0]] : key);
  return `(${columns.map((column) => sqlValue(key[column])).join(", ")})`;
}

export function keyTupleNumbers(key, columns) {
  if (columns.length === 1) return [Number(typeof key === "object" ? key[columns[0]] : key)];
  return columns.map((column) => Number(key[column]));
}

function mergePlanGroups(groups) {
  const merged = new Map();
  for (const { table, keyColumn, keyColumns, flagColumn, rows = [], entries = [] } of groups) {
    const columns = keyColumns ? [...keyColumns] : [keyColumn];
    const id = [table, columns.join(","), flagColumn].join("\u001f");
    if (!merged.has(id)) merged.set(id, { table, columns, flagColumn, rows: [], items: [] });
    const bucket = merged.get(id);
    bucket.rows.push(...rows);
    bucket.items.push(...(entries.length ? entries : rows.map((row) => row.item)));
  }
  return merged;
}

/**
 * Grouped table read requests for `release_read_plan_flags`: merges categories
 * sharing the same table, key columns and flag column into one query per table.
 */
export function planFlagQueries(groups) {
  const queries = [];
  for (const { table, columns, flagColumn, items } of mergePlanGroups(groups).values()) {
    if (!items.length) continue;
    queries.push({
      table,
      keyColumns: [...columns],
      flagColumn,
      items: items.map((item) => ({ id: item.id, keys: keyTupleNumbers(item.key, columns) })),
    });
  }
  return queries;
}

/**
 * Structured write payloads for `release_execute_plan_writes`, matching the
 * exact table/flag grouping and order of `planStatements`.
 */
export function planWriteGroups(groups) {
  const writes = [];
  for (const { table, columns, flagColumn, rows } of mergePlanGroups(groups).values()) {
    for (const [change, flag] of [[PLAN_CHANGE.OPEN, 1], [PLAN_CHANGE.CLOSE, 0]]) {
      const keys = rows.filter((row) => row.change === change).map((row) => keyTupleNumbers(row.item.key, columns));
      if (!keys.length) continue;
      writes.push({ table, keyColumns: [...columns], flagColumn, flag, keys });
    }
  }
  return writes;
}

/**
 * The statements a write would run: one UPDATE per table, switch column and
 * target flag, so groups sharing a table (heroes and mounts in heroprop)
 * write together. A composite key compares as a row value.
 */
export function planStatements(groups) {
  const merged = mergePlanGroups(groups);
  const statements = [];
  for (const { table, columns, flagColumn, rows } of merged.values()) {
    const target = columns.length === 1
      ? sqlIdentifier(columns[0])
      : `(${columns.map(sqlIdentifier).join(", ")})`;
    for (const [change, flag] of [[PLAN_CHANGE.OPEN, 1], [PLAN_CHANGE.CLOSE, 0]]) {
      const keys = rows.filter((row) => row.change === change).map((row) => keyTuple(row.item.key, columns));
      if (!keys.length) continue;
      statements.push(
        `UPDATE ${sqlIdentifier(table)} SET ${sqlIdentifier(flagColumn)} = ${flag} WHERE ${target} IN (${keys.join(", ")});`,
      );
    }
  }
  return statements;
}

/** "10/28", or "2027/1/5" when the year differs from the reference date. */
export function formatPlanDate(iso, referenceIso = iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const prefix = referenceIso && referenceIso.slice(0, 4) !== iso.slice(0, 4) ? `${year}/` : "";
  return `${prefix}${month}/${day}`;
}
