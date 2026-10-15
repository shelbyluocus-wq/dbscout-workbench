// The info card's content for one table of a relation graph: the tables it
// references and the tables referencing it (each named once, with its fields
// beneath and the worst status among them) and its self references. A
// hovered card keeps a few tables per section; a pinned one can scroll, so
// it lists many more before saying how many are left.
import { tableColumnComment, tableDisplayComment, tableDisplayName } from "./configRelations.js";
import { graphNodeRelations, groupByOtherTable } from "./relationGraph.js";

export const CARD_TABLES_PER_SECTION = Object.freeze({ hover: 4, pinned: 60 });

function cardSection(key, relations, id, { pinned, tables, currentTable }) {
  const groups = groupByOtherTable(relations, id);
  const shown = groups.slice(0, pinned ? CARD_TABLES_PER_SECTION.pinned : CARD_TABLES_PER_SECTION.hover);
  return {
    key,
    tableCount: groups.length,
    fieldCount: relations.length,
    groups: shown.map((group) => ({
      table: group.table,
      name: tableDisplayName(tables, group.table),
      comment: tableDisplayComment(tables, group.table),
      openable: group.table !== currentTable,
      status: group.status,
      fields: group.relations.map((relation) => ({
        id: relation.id,
        from: relation.sourceColumn,
        to: relation.targetColumn,
        // "table.field" and its comment, for the pinned card's hover cards.
        fromName: `${tableDisplayName(tables, relation.sourceTable)}.${relation.sourceColumn}`,
        fromComment: tableColumnComment(tables, relation.sourceTable, relation.sourceColumn),
        toName: `${tableDisplayName(tables, relation.targetTable)}.${relation.targetColumn}`,
        toComment: tableColumnComment(tables, relation.targetTable, relation.targetColumn),
        status: relation.status,
      })),
    })),
    more: groups.length - shown.length,
  };
}

/**
 * The card for table `id` of `graph`, or null when it is not drawn.
 * `explore` offers "center on this table" (the full-screen view).
 */
export function relationGraphCard(graph, id, { pinned = false, tables = {}, currentTable = "", explore = false } = {}) {
  const node = id ? graph?.nodes?.find((candidate) => candidate.id === id) : null;
  if (!node) return null;
  const relations = graphNodeRelations(graph, id);
  const context = { pinned, tables, currentTable };
  const sections = [
    cardSection("references", relations.references, id, context),
    cardSection("referencedBy", relations.referencedBy, id, context),
    cardSection("self", relations.self, id, context),
  ].filter((section) => section.fieldCount);
  return {
    id,
    pinned,
    side: node.depth === 0 ? "center" : node.side,
    name: tableDisplayName(tables, id),
    comment: tableDisplayComment(tables, id),
    center: node.depth === 0,
    openable: id !== currentTable,
    focusable: explore && node.depth !== 0,
    total: node.referencedBy,
    sections,
  };
}
