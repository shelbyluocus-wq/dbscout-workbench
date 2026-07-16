import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const sqlHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.operatorKeyword], color: "var(--wb-sql-keyword)", fontWeight: "600" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--wb-sql-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--wb-sql-number)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--wb-sql-comment)", fontStyle: "italic" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--wb-sql-type)" },
  { tag: [tags.function(tags.variableName), tags.standard(tags.name)], color: "var(--wb-sql-function)" },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: "var(--wb-sql-operator)" },
  { tag: [tags.name, tags.variableName, tags.propertyName], color: "var(--wb-sql-identifier)" },
  { tag: tags.invalid, color: "var(--wb-sql-invalid)", textDecoration: "underline wavy" },
]);

export const sqlSyntaxHighlighting = syntaxHighlighting(sqlHighlightStyle, { fallback: true });
