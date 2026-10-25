// Exclusion rules for copying a development client over a platform client.
// One rule per entry, gitignore-like: a trailing "/" names a folder, "*"
// matches within one path segment and "**" across segments, and a rule
// without an inner "/" matches that name at any depth. Paths compare
// case-insensitively with "/" separators. Version-control folders are always
// excluded.

export const ALWAYS_EXCLUDED_RULES = Object.freeze([".svn/"]);

const REGEXP_SPECIALS = /[.+^${}()|[\]\\]/g;

function globToPattern(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        pattern += ".*";
        index += 1;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(REGEXP_SPECIALS, "\\$&");
    }
  }
  return pattern;
}

export function normalizeClientPath(path) {
  return String(path ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export function normalizeExclusionRule(rule) {
  return normalizeClientPath(rule).replace(/\/{2,}/g, "/");
}

export function compileExclusionRule(rule) {
  let text = normalizeExclusionRule(rule);
  const folder = text.endsWith("/");
  text = text.replace(/\/+$/, "");
  const anchored = text.includes("/");
  text = text.replace(/^\/+/, "");
  if (!text) return null;
  const prefix = anchored ? "^" : "(?:^|/)";
  const suffix = folder ? "/" : "(?:$|/)";
  return new RegExp(`${prefix}${globToPattern(text)}${suffix}`, "i");
}

/** The first rule excluding `path`, or "" when the file is copied. */
export function excludingRule(path, rules) {
  const target = normalizeClientPath(path);
  for (const rule of [...ALWAYS_EXCLUDED_RULES, ...rules]) {
    const pattern = compileExclusionRule(rule);
    if (pattern?.test(target)) return normalizeExclusionRule(rule);
  }
  return "";
}

/** Unique, normalized, non-empty rules in their original order. */
export function cleanExclusionRules(rules) {
  const seen = new Set();
  const result = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    const value = normalizeExclusionRule(rule);
    const key = value.toLowerCase();
    if (!value || seen.has(key) || ALWAYS_EXCLUDED_RULES.includes(value)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/** "folder" (ends with "/"), "pattern" (has * or ?) or "file". */
export function exclusionRuleKind(rule) {
  const value = normalizeExclusionRule(rule);
  if (/[*?]/.test(value)) return "pattern";
  return value.endsWith("/") ? "folder" : "file";
}

/**
 * The rule for a file or folder chosen inside the client: anchored to the
 * client folder, so it never matches a namesake deeper in the tree.
 */
export function ruleForPick(relative, kind) {
  const path = normalizeExclusionRule(relative).replace(/^\/+|\/+$/g, "");
  if (!path) return "";
  const anchored = path.includes("/") ? path : `/${path}`;
  return kind === "folder" ? `${anchored}/` : anchored;
}
