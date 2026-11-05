import { readFileSync } from "node:fs";
import zhCN from "../i18n/zhCN.js";

// Existing source-contract tests check layout and accessibility against the
// original Chinese copy. Materialize explicit catalog calls only; behavioral
// localization tests separately exercise the real bilingual runtime.
export function localizedContractSource(source) {
  const message = (key) => {
    if (!Object.hasOwn(zhCN, key)) throw new Error(`Missing localization key: ${key}`);
    return zhCN[key];
  };
  return source
    .replace(/\{\{\s*t\(['"](m_[a-f0-9]+)['"]\)\s*\}\}/g, (_, key) => message(key))
    .replace(/\{\{\s*tPlatform\(['"](m_[a-f0-9]+)['"]\)\s*\}\}/g, (_, key) => message(key))
    .replace(/:([\w-]+)="t\('((?:m_)[a-f0-9]+)'\)"/g, (_, attr, key) => `${attr}="${message(key)}"`)
    .replace(/:([\w-]+)="tPlatform\('((?:m_)[a-f0-9]+)'\)"/g, (_, attr, key) => `${attr}="${message(key)}"`)
    .replace(/tPlatform\(['"](m_[a-f0-9]+)['"]\)/g, (_, key) => `'${message(key).replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n")}'`)
    .replace(/t\(['"](m_[a-f0-9]+)['"]\)/g, (_, key) => `'${message(key).replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n")}'`);
}

export function readLocalizedContractSource(file, encoding = "utf8") {
  const source = readFileSync(file, encoding);
  return String(file).endsWith(".vue") ? localizedContractSource(source) : source;
}
