// Browser-mock "relation lab": a generated game-config database for trying
// and measuring the relation graph at the sizes real config databases reach.
// Open the preview with `?relationLab=<tables>` (50–5000) and the demo
// server gains a `relation_lab` database. Like real ones it has a few hub
// tables referenced from everywhere (items, rewards, attributes…), modules
// whose tables mostly reference their own module, chains inside a module,
// rare links across modules, list cells, self references, and a sprinkling
// of relations in conflict or gone stale. Generation is deterministic: one
// size always yields the same tables, columns, rows and relations.

export const RELATION_LAB_DATABASE = "relation_lab";
export const RELATION_LAB_SIZE = Object.freeze({ min: 50, max: 5000 });

const ROWS_PER_TABLE = 4;

const MODULES = Object.freeze([
  ["item", "道具"], ["reward", "奖励"], ["attr", "属性"], ["skill", "技能"], ["hero", "英雄"],
  ["monster", "怪物"], ["equip", "装备"], ["buff", "状态"], ["drop", "掉落"], ["stage", "关卡"],
  ["quest", "任务"], ["shop", "商店"], ["mail", "邮件"], ["guild", "公会"], ["activity", "活动"],
  ["achievement", "成就"], ["pet", "宠物"], ["mount", "坐骑"], ["title", "称号"], ["fashion", "时装"],
  ["rune", "符文"], ["gem", "宝石"], ["npc", "NPC"], ["dialog", "对话"], ["map", "地图"],
  ["dungeon", "副本"], ["arena", "竞技场"], ["rank", "排行"], ["vip", "VIP"], ["recharge", "充值"],
  ["sign", "签到"], ["task", "日常"], ["talent", "天赋"], ["formation", "阵型"], ["chapter", "章节"],
  ["story", "剧情"], ["battle", "战斗"], ["effect", "特效"], ["sound", "音效"], ["guide", "引导"],
]);

const ASPECTS = Object.freeze([
  ["level", "等级"], ["star", "星级"], ["cost", "消耗"], ["bonus", "加成"], ["pool", "池"],
  ["group", "分组"], ["growth", "成长"], ["unlock", "解锁"], ["rank", "排名"], ["config", "配置"],
  ["loot", "产出"], ["exchange", "兑换"], ["limit", "限制"], ["show", "展示"], ["text", "文本"],
  ["source", "来源"], ["upgrade", "升级"], ["break", "突破"], ["awake", "觉醒"], ["suit", "套装"],
  ["refine", "精炼"], ["compose", "合成"], ["mission", "目标"], ["skin", "皮肤"],
]);

// Which modules each module's base table references.
const MODULE_LINKS = Object.freeze({
  reward: ["item"], skill: ["buff", "effect"], hero: ["skill", "attr"], monster: ["skill", "drop", "attr"],
  equip: ["item", "attr"], buff: ["attr", "effect"], drop: ["item"], stage: ["monster", "drop", "map"],
  quest: ["reward", "npc"], shop: ["item"], mail: ["reward"], guild: ["reward"], activity: ["reward"],
  achievement: ["reward"], pet: ["skill", "attr"], mount: ["attr"], title: ["attr"], fashion: ["attr"],
  rune: ["attr"], gem: ["attr", "item"], npc: ["dialog"], dialog: ["story"], map: ["npc"],
  dungeon: ["stage", "reward"], arena: ["reward", "rank"], rank: ["reward"], vip: ["reward"],
  recharge: ["vip", "item"], sign: ["reward"], task: ["reward"], talent: ["attr", "skill"],
  formation: ["hero"], chapter: ["stage", "story"], story: ["dialog"], battle: ["effect", "skill"],
  effect: ["sound"], guide: ["story"],
});

// Hub tables any table may reference, with how likely each one is picked.
const HUBS = Object.freeze([["item", 0.34], ["reward", 0.22], ["attr", 0.16], ["skill", 0.12], ["hero", 0.09], ["monster", 0.07]]);

const cache = new Map();

export function requestedRelationLabSize(search = globalThis.location?.search || "") {
  try {
    const value = Number(new URLSearchParams(String(search || "")).get("relationLab"));
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(RELATION_LAB_SIZE.max, Math.max(RELATION_LAB_SIZE.min, Math.floor(value)));
  } catch {
    return 0;
  }
}

// A small deterministic generator (mulberry32).
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function column(name, type, comment, primary = false) {
  return { column_name: name, column_type: type, column_comment: comment, is_primary_key: primary, is_nullable: !primary };
}

function pascal(name) {
  return name.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

function createTables(size) {
  const tables = [];
  for (const [key, label] of MODULES) {
    if (tables.length >= size) break;
    tables.push({ name: key, comment: `${label}表`, module: key, label, base: true });
  }
  for (let variant = 0; tables.length < size; variant += 1) {
    for (const [aspect, aspectLabel] of ASPECTS) {
      for (const [key, label] of MODULES) {
        if (tables.length >= size) break;
        if (aspect === key) continue;
        const suffix = variant ? `_${variant + 1}` : "";
        tables.push({
          name: `${key}_${aspect}${suffix}`,
          comment: `${label}${aspectLabel}${variant ? variant + 1 : ""}表`,
          module: key,
          label: `${label}${aspectLabel}`,
          base: false,
        });
      }
      if (tables.length >= size) break;
    }
  }
  return tables;
}

function pickHub(random) {
  let roll = random();
  for (const [hub, weight] of HUBS) {
    roll -= weight;
    if (roll <= 0) return hub;
  }
  return HUBS[0][0];
}

function generate(size) {
  const random = seededRandom(20261014 + size);
  const tables = createTables(size);
  const byName = new Map(tables.map((table) => [table.name, table]));
  const byModule = new Map();
  const relations = [];
  const columns = new Map(tables.map((table) => [table.name, [
    column("id", "int", `${table.label}ID`, true),
    column("name", "varchar(64)", "名称"),
  ]]));

  function addReference(table, columnName, target, { kind = "value" } = {}) {
    const used = columns.get(table.name);
    let name = columnName;
    for (let index = 2; used.some((item) => item.column_name === name); index += 1) name = `${columnName.replace(/_id$/u, "")}_${index}_id`;
    const roll = random();
    const comment = roll < 0.86;
    const code = roll > 0.3 || !comment;
    const targetTable = byName.get(target);
    used.push(column(name, kind === "list" ? "varchar(255)" : "int", comment ? `关联${targetTable.label}(${target})` : "编号"));
    const relation = {
      lab: true,
      from: `${table.name}.${name}`,
      to: `${target}.id`,
      comment,
      kind,
      format: kind === "list",
      code: code ? [`lab/${table.module}/${pascal(table.name)}.ts`, 20 + Math.floor(random() * 400), `${pascal(target)}Prop.get(row.${name})`] : null,
      codeRevision: 1,
      stale: false,
    };
    relations.push(relation);
    // The comment names one table while the client reads another.
    if (comment && !code && random() < 0.04) {
      const other = pickHub(random);
      if (other !== target && byName.has(other)) {
        relations.push({
          lab: true,
          from: relation.from,
          to: `${other}.id`,
          comment: false,
          kind,
          format: false,
          code: [`lab/${table.module}/${pascal(table.name)}.ts`, 31, `${pascal(other)}Prop.get(row.${name})`],
          codeRevision: 1,
          stale: false,
        });
      }
    } else if (code && random() < 0.012) {
      // A lookup that changed after it was confirmed.
      relation.codeRevision = 2;
      relation.stale = true;
    }
  }

  tables.forEach((table, index) => {
    const siblings = byModule.get(table.module) || [];
    if (table.base) {
      for (const target of MODULE_LINKS[table.module] || []) {
        if (byName.has(target)) addReference(table, `${target}_id`, target);
      }
    } else {
      if (byName.has(table.module) && random() < 0.82) addReference(table, `${table.module}_id`, table.module);
      const hub = pickHub(random);
      if (hub !== table.module && byName.has(hub) && random() < 0.5) addReference(table, `${hub}_id`, hub);
      const chained = siblings.filter((sibling) => !sibling.base);
      if (chained.length && random() < 0.32) {
        const sibling = chained[Math.floor(random() * chained.length)];
        addReference(table, `${sibling.name.slice(table.module.length + 1)}_id`, sibling.name);
      }
      if (random() < 0.07) {
        const other = tables[Math.floor(random() * index)];
        if (other && other.module !== table.module) addReference(table, "link_id", other.name);
      }
      if (byName.has("item") && random() < 0.06) addReference(table, "reward_pool", "item", { kind: "list" });
    }
    if (random() < 0.025) addReference(table, "parent_id", table.name);
    siblings.push(table);
    byModule.set(table.module, siblings);
  });

  const schema = tables.map((table) => ({ table_name: table.name, table_comment: table.comment, columns: columns.get(table.name) }));
  return { size, schema, relations, byName: new Map(schema.map((table) => [table.table_name, table])) };
}

function lab(size) {
  if (!size) return null;
  if (!cache.has(size)) cache.set(size, generate(size));
  return cache.get(size);
}

export function relationLabSchema(size = requestedRelationLabSize()) {
  return lab(size)?.schema || [];
}

// Relation definitions in the mock catalog's shape (see mockConfigRelations.js).
export function relationLabRelations(size = requestedRelationLabSize()) {
  return lab(size)?.relations || [];
}

export function isRelationLabTable(name, size = requestedRelationLabSize()) {
  return Boolean(lab(size)?.byName.has(String(name || "").toLowerCase()));
}

// A few rows per table whose reference cells point at rows that exist.
export function relationLabRows(tableName, size = requestedRelationLabSize()) {
  const table = lab(size)?.byName.get(String(tableName || "").toLowerCase());
  if (!table) return [];
  return Array.from({ length: ROWS_PER_TABLE }, (_, index) => {
    const row = { id: index + 1, name: `${table.table_comment.replace(/表$/u, "")} ${index + 1}` };
    table.columns.slice(2).forEach((item, offset) => {
      row[item.column_name] = item.column_name === "reward_pool"
        ? JSON.stringify([{ ID: ((index + offset) % ROWS_PER_TABLE) + 1, Num: index + 1 }])
        : ((index + offset + 1) % ROWS_PER_TABLE) + 1;
    });
    return row;
  });
}
