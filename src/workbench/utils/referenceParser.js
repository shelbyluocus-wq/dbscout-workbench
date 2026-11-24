// Keep these parsers aligned with config_relations/parser.rs. Formats refine
// established references; a comma or an array alone never implies a relation.

const EMPTY = new Set(["", "0", "-1", "null", "NULL", "[]", "{}"]);
const scalar = (value) => typeof value === "string" || typeof value === "number" ? String(value).trim() : null;
const member = (object, name) => object[Object.keys(object).find((key) => key.toLowerCase() === name.toLowerCase())];
const atom = (value) => /^[-A-Za-z0-9_.:]*$/.test(value);

function stripPrefixedToken(token, prefix) {
  const trimmed = String(token ?? "").trim().replace(/^"+|"+$/g, "").trim();
  if (!trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length);
  return !EMPTY.has(rest) && atom(rest) ? rest : null;
}

export function normalizeReferenceParser(parser) {
  if (!parser || typeof parser !== "object") return null;
  if (parser.type === "prefix" && typeof parser.prefix === "string") {
    return { type: "prefix", prefix: parser.prefix };
  }
  if (parser.type === "prefixed" && typeof parser.prefix === "string" && parser.prefix && parser.prefix.length <= 64 && atom(parser.prefix)) {
    const delimiter = parser.delimiter == null ? null : parser.delimiter;
    const index = parser.index == null ? null : parser.index;
    if (delimiter !== null && ![",", "|"].includes(delimiter)) return { type: "unsupported" };
    if (index !== null && (delimiter === null || !Number.isInteger(index) || index < 0 || index > 1024)) {
      return { type: "unsupported" };
    }
    return {
      type: "prefixed",
      prefix: parser.prefix,
      ...(delimiter !== null ? { delimiter } : {}),
      ...(index !== null ? { index } : {}),
    };
  }
  if (parser.type === "token" && [",", "|"].includes(parser.delimiter)
    && Number.isInteger(parser.index) && parser.index >= 0 && parser.index <= 1024) {
    return { type: "token", delimiter: parser.delimiter, index: parser.index };
  }
  if (parser.type === "jsonPaths") {
    if (!Array.isArray(parser.paths) || !parser.paths.every((path) =>
      typeof path === "string" && /^\$(?:\.[A-Za-z0-9_]+|\[(?:\d+|\*)\])*$/.test(path)
      && (path.match(/\.[A-Za-z0-9_]+|\[(?:\d+|\*)\]/g) || []).length <= 16
      && [...path.matchAll(/\[(\d+)\]/g)].every((match) => Number(match[1]) <= 0xffffffff))) return { type: "unsupported" };
    return { type: "jsonPaths", paths: [...parser.paths], exclude: Array.isArray(parser.exclude) ? parser.exclude.map(String) : [] };
  }
  if (parser.type === "keys" && [",", "|", "json"].includes(parser.delimiter)) {
    return { type: "keys", delimiter: parser.delimiter };
  }
  if (parser.type === "json" && typeof parser.member === "string" && parser.member.trim()) {
    if (parser.ranges != null && (!Array.isArray(parser.ranges) || parser.ranges.some((range) =>
      !Array.isArray(range) || range.length !== 2
      || range.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffffffff)
      || range[0] > range[1]))) return { type: "unsupported" };
    const selector = parser.selector && typeof parser.selector === "object"
      && typeof parser.selector.member === "string" && parser.selector.member.trim()
      ? { member: parser.selector.member.trim(), value: String(parser.selector.value ?? "") } : null;
    if (parser.selector != null && !selector) return { type: "unsupported" };
    return {
      type: "json", member: parser.member.trim(),
      ...(selector ? { selector } : {}),
      ...(Array.isArray(parser.exclude) && parser.exclude.length ? { exclude: parser.exclude.map(String) } : {}),
      ...(parser.ranges?.length ? { ranges: parser.ranges.map((range) => [...range]) } : {}),
      ...(parser.outsideRanges ? { outsideRanges: true } : {}),
    };
  }
  if (parser.type === "condition") {
    return {
      type: "condition",
      ...(parser.prefix != null ? { prefix: String(parser.prefix) } : {}),
      ...(parser.valuePrefix != null ? { valuePrefix: String(parser.valuePrefix) } : {}),
    };
  }
  return { type: "unsupported" };
}

export function parseReferenceValues(text, rawParser) {
  const parser = normalizeReferenceParser(rawParser);
  const value = String(text ?? "").trim();
  if (EMPTY.has(value)) return [];
  if (!parser) return null;
  let values;
  if (parser.type === "prefix") {
    if (!atom(value)) return null;
    values = value.startsWith(parser.prefix) ? [value] : [];
  } else if (parser.type === "prefixed") {
    if (value.startsWith("function")) return null;
    if (parser.delimiter != null && parser.index != null) {
      const tokens = value.split(parser.delimiter).map((part) => part.trim());
      const stripped = tokens[parser.index] === undefined ? null : stripPrefixedToken(tokens[parser.index], parser.prefix);
      values = stripped === null ? [] : [stripped];
    } else if (parser.delimiter != null) {
      values = value.split(parser.delimiter).map((part) => stripPrefixedToken(part, parser.prefix)).filter((item) => item !== null);
    } else if (value.startsWith("{")) {
      return null;
    } else if (value.startsWith("[")) {
      let items;
      try { items = JSON.parse(value); } catch { return null; }
      if (!Array.isArray(items)) return null;
      const scalars = items.map(scalar);
      if (scalars.includes(null)) return null;
      values = scalars.map((part) => stripPrefixedToken(part, parser.prefix)).filter((item) => item !== null);
    } else {
      values = value.split(/[,|;\s]+/).map((part) => stripPrefixedToken(part, parser.prefix)).filter((item) => item !== null);
    }
  } else if (parser.type === "token") {
    const tokens = value.split(parser.delimiter).map((part) => part.trim());
    if (!tokens.every(atom)) return null;
    values = tokens[parser.index] === undefined ? [] : [tokens[parser.index]];
  } else if (parser.type === "jsonPaths") {
    let root;
    try { root = JSON.parse(value); } catch { return null; }
    values = [];
    for (const path of parser.paths) {
      let items = [root];
      const steps = path.slice(1).match(/\.[A-Za-z0-9_]+|\[(?:\d+|\*)\]/g) || [];
      for (const step of steps) {
        items = items.flatMap((item) => step === "[*]" ? (Array.isArray(item) ? item : [])
          : step.startsWith(".") ? (item && typeof item === "object" && !Array.isArray(item) && Object.hasOwn(item, step.slice(1)) ? [item[step.slice(1)]] : [])
          : (Array.isArray(item) && Number(step.slice(1, -1)) < item.length ? [item[Number(step.slice(1, -1))]] : []));
      }
      values.push(...items.map(scalar).filter((item) => item !== null && !parser.exclude.includes(item)));
    }
  } else if (parser.type === "keys") {
    if (parser.delimiter === "json") {
      let items;
      try { items = JSON.parse(value); } catch { return null; }
      if (!Array.isArray(items)) return null;
      values = items.map(scalar);
      if (values.includes(null)) return null;
    } else {
      values = value.split(parser.delimiter).map((part) => part.trim());
    }
    if (!values.every(atom)) return null;
  } else if (parser.type === "json") {
    let items;
    try { items = JSON.parse(value); } catch { return null; }
    if (!Array.isArray(items)) return null;
    values = [];
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)
        || Object.values(item).some((entry) => entry !== null && typeof entry === "object")) return null;
      if (parser.selector && scalar(member(item, parser.selector.member)) !== parser.selector.value) continue;
      const found = scalar(member(item, parser.member));
      const rangeMatch = !parser.ranges?.length || (/^\d+$/.test(found || "")
        && parser.ranges.some(([min, max]) => Number(found) >= min && Number(found) <= max) !== Boolean(parser.outsideRanges));
      if (found !== null && !parser.exclude?.includes(found) && rangeMatch) values.push(found);
    }
  } else if (parser.type === "condition") {
    const [operation, ...parts] = value.split("|").map((part) => part.trim());
    if (!["and", "or", "not"].includes(operation)) return null;
    values = [];
    for (const part of parts.filter(Boolean)) {
      const match = /^([A-Za-z]+_?)(.*)$/.exec(part);
      if (!match) return null;
      const [, prefix, argument] = match;
      if (parser.prefix === undefined) values.push(prefix);
      else if (parser.prefix === prefix) {
        const key = prefix === "G" ? argument.split("_")[0] : argument;
        if (parser.valuePrefix === undefined || key.startsWith(parser.valuePrefix)) values.push(key);
      }
    }
  } else return null;
  return [...new Set(values.filter((item) => !EMPTY.has(item)))];
}

export function relationHasMultipleValues(relation) {
  return relation?.kind === "list" || (relation?.parser && relation.parser.type !== "unsupported");
}
