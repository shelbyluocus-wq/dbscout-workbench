const cm = (name, type, comment, pk = false, nullable = false) =>
  ({ column_name: name, column_type: type, column_comment: comment, is_primary_key: pk, is_nullable: nullable });

const similarColumns = (tableName) => [
  cm("id", "int", "主键ID", true, false),
  cm("name", "varchar(64)", `名称字段：${tableName} 与其它相似表名只差单复数或下划线。`, false, false),
  cm("remark", "text", "很长的字段备注，用于验证右侧备注面板可以自动换行展示，而不是单行省略或横向撑开布局。", false, true),
];

export const mockTableDefs = {
  player: {
    table_name: "player",
    table_comment: "玩家账号表",
    columns: [
      cm("id", "int", "玩家ID", true), cm("username", "varchar(32)", "用户名"), cm("nickname", "varchar(64)", "昵称"),
      cm("level", "int", "等级"), cm("exp", "bigint", "经验值"), cm("vip_level", "tinyint", "VIP等级"),
      cm("gold", "bigint", "金币"), cm("diamond", "int", "钻石"), cm("last_login", "datetime", "最后登录", false, true),
      cm("status", "tinyint", "状态(0正常1封禁)"), cm("create_time", "datetime", "注册时间"), cm("guild_id", "int", "公会ID", false, true),
    ],
  },
  hero: {
    table_name: "hero",
    table_comment: "英雄配置表",
    columns: [
      cm("id", "int", "英雄ID", true), cm("name", "varchar(32)", "名称"), cm("rarity", "tinyint", "稀有度(1-5)"),
      cm("element", "varchar(16)", "元素属性"), cm("hp_base", "int", "基础生命"), cm("atk_base", "int", "基础攻击"),
      cm("def_base", "int", "基础防御"), cm("spd_base", "int", "基础速度"), cm("skill_id", "int", "主动技能ID"),
      cm("passive_id", "int", "被动技能ID", false, true), cm("description", "text", "描述", false, true), cm("is_available", "tinyint", "是否可用"),
    ],
  },
  item: {
    table_name: "item",
    table_comment: "道具配置表",
    columns: [
      cm("id", "int", "道具ID", true), cm("name", "varchar(64)", "名称"), cm("type", "tinyint", "类型(1消耗2材料3装备4任务)"),
      cm("quality", "tinyint", "品质(1白2绿3蓝4紫5橙)"), cm("max_stack", "int", "最大堆叠"), cm("sell_price", "int", "出售价格", false, true),
      cm("use_level", "tinyint", "使用等级", false, true), cm("effect_id", "int", "效果ID", false, true),
      cm("description", "text", "描述", false, true), cm("icon", "varchar(64)", "图标路径", false, true),
      cm("expire_days", "int", "过期天数(0永久)"), cm("is_tradable", "tinyint", "是否可交易"),
    ],
  },
  equip: {
    table_name: "equip",
    table_comment: "装备配置表",
    columns: [
      cm("id", "int", "装备ID", true), cm("name", "varchar(64)", "名称"), cm("slot", "tinyint", "部位(1武器2头盔3铠甲4鞋子5饰品)"),
      cm("rarity", "tinyint", "稀有度"), cm("hp_bonus", "int", "生命加成"), cm("atk_bonus", "int", "攻击加成"),
      cm("def_bonus", "int", "防御加成"), cm("set_id", "int", "套装ID", false, true), cm("required_level", "int", "需求等级"),
      cm("enchant_max", "tinyint", "最大附魔等级"), cm("description", "text", "描述", false, true), cm("source", "varchar(32)", "获取途径", false, true),
    ],
  },
  skill: {
    table_name: "skill",
    table_comment: "技能配置表",
    columns: [
      cm("id", "int", "技能ID", true), cm("name", "varchar(32)", "名称"), cm("type", "tinyint", "类型(1主动2被动3终极)"),
      cm("element", "varchar(16)", "元素", false, true), cm("cooldown", "decimal(5,2)", "冷却时间(秒)"), cm("mp_cost", "int", "法力消耗"),
      cm("damage_rate", "decimal(5,2)", "伤害倍率"), cm("target_type", "tinyint", "目标类型(1单体2群体3自身)"),
      cm("unlock_level", "int", "解锁等级"), cm("max_level", "tinyint", "最大等级"),
      cm("description", "text", "描述", false, true), cm("icon", "varchar(64)", "图标", false, true),
    ],
  },
  quest: {
    table_name: "quest",
    table_comment: "任务配置表",
    columns: [
      cm("id", "int", "任务ID", true), cm("name", "varchar(64)", "名称"), cm("type", "tinyint", "类型(1主线2支线3日常4活动)"),
      cm("chapter", "int", "章节", false, true), cm("required_level", "int", "需求等级"), cm("pre_quest", "int", "前置任务ID", false, true),
      cm("reward_exp", "int", "奖励经验"), cm("reward_gold", "int", "奖励金币"),
      cm("reward_item_id", "int", "奖励道具ID", false, true), cm("reward_item_count", "int", "奖励道具数量", false, true),
      cm("description", "text", "描述", false, true), cm("is_repeatable", "tinyint", "是否可重复"),
    ],
  },
  stage: {
    table_name: "stage",
    table_comment: "关卡配置表",
    columns: [
      cm("id", "int", "关卡ID", true), cm("name", "varchar(64)", "名称"), cm("chapter", "int", "章节"),
      cm("difficulty", "tinyint", "难度(1普通2困难3地狱)"), cm("stamina_cost", "int", "体力消耗"),
      cm("recommended_level", "int", "推荐等级"), cm("boss_id", "int", "BOSS怪物ID", false, true),
      cm("drop_table_id", "int", "掉落表ID", false, true), cm("reward_exp", "int", "奖励经验"),
      cm("reward_gold", "int", "奖励金币"), cm("star_condition", "varchar(128)", "三星条件", false, true),
      cm("is_unlocked", "tinyint", "默认解锁"),
    ],
  },
  monster: {
    table_name: "monster",
    table_comment: "怪物配置表",
    columns: [
      cm("id", "int", "怪物ID", true), cm("name", "varchar(32)", "名称"), cm("type", "tinyint", "类型(1普通2精英3BOSS)"),
      cm("element", "varchar(16)", "元素", false, true), cm("hp", "int", "生命值"), cm("atk", "int", "攻击力"),
      cm("def", "int", "防御力"), cm("spd", "int", "速度"), cm("skill_id_1", "int", "技能1", false, true),
      cm("skill_id_2", "int", "技能2", false, true), cm("drop_table_id", "int", "掉落表ID", false, true),
      cm("description", "text", "描述", false, true),
    ],
  },
  shop: {
    table_name: "shop",
    table_comment: "商店配置表",
    columns: [
      cm("id", "int", "商品ID", true), cm("name", "varchar(64)", "商品名"), cm("category", "tinyint", "分类(1道具2英雄3皮肤4礼包)"),
      cm("item_id", "int", "关联道具ID", false, true), cm("price_type", "tinyint", "货币类型(1金币2钻石)"),
      cm("price", "int", "价格"), cm("original_price", "int", "原价", false, true), cm("stock_limit", "int", "限购数量(0无限)"),
      cm("refresh_cycle", "tinyint", "刷新周期(0不刷新1日2周)"), cm("required_vip", "tinyint", "需求VIP"),
      cm("start_time", "datetime", "开始时间", false, true), cm("end_time", "datetime", "结束时间", false, true),
    ],
  },
  mail: {
    table_name: "mail",
    table_comment: "邮件模板表",
    columns: [
      cm("id", "int", "邮件ID", true), cm("title", "varchar(128)", "标题"), cm("sender", "varchar(32)", "发送者"),
      cm("content", "text", "内容"), cm("reward_item_id", "int", "附件道具ID", false, true),
      cm("reward_count", "int", "附件数量", false, true), cm("expire_hours", "int", "过期时间(小时)"),
      cm("priority", "tinyint", "优先级"), cm("trigger_event", "varchar(32)", "触发事件", false, true),
      cm("is_system", "tinyint", "是否系统邮件"), cm("create_time", "datetime", "创建时间"), cm("is_read", "tinyint", "默认已读"),
    ],
  },
  guild: {
    table_name: "guild",
    table_comment: "公会配置表",
    columns: [
      cm("id", "int", "公会ID", true), cm("name", "varchar(32)", "公会名"), cm("level", "tinyint", "公会等级"),
      cm("leader_id", "int", "会长ID"), cm("member_count", "int", "成员数"), cm("max_members", "int", "最大成员数"),
      cm("exp", "bigint", "公会经验"), cm("notice", "varchar(256)", "公告", false, true),
      cm("create_time", "datetime", "创建时间"), cm("is_recruiting", "tinyint", "是否招募中"),
      cm("min_join_level", "int", "最低加入等级"), cm("icon_id", "int", "公会图标ID", false, true),
    ],
  },
  achievement: {
    table_name: "achievement",
    table_comment: "成就配置表",
    columns: [
      cm("id", "int", "成就ID", true), cm("name", "varchar(64)", "名称"), cm("category", "tinyint", "分类(1战斗2收集3探索4社交)"),
      cm("condition_type", "varchar(32)", "条件类型"), cm("condition_value", "int", "条件数值"),
      cm("reward_diamond", "int", "奖励钻石"), cm("reward_title", "varchar(32)", "奖励称号", false, true),
      cm("points", "int", "成就点数"), cm("is_hidden", "tinyint", "是否隐藏"), cm("parent_id", "int", "父成就ID", false, true),
      cm("description", "text", "描述", false, true), cm("icon", "varchar(64)", "图标", false, true),
    ],
  },
  activity: {
    table_name: "activity",
    table_comment: "活动配置表",
    columns: [
      cm("id", "int", "活动ID", true), cm("name", "varchar(64)", "名称"), cm("type", "tinyint", "类型(1签到2抽卡3副本4消费返利)"),
      cm("start_time", "datetime", "开始时间"), cm("end_time", "datetime", "结束时间"),
      cm("reward_pool", "text", "奖励池(JSON)", false, true), cm("daily_limit", "int", "每日次数限制", false, true),
      cm("total_limit", "int", "总次数限制", false, true), cm("required_level", "int", "需求等级"),
      cm("is_active", "tinyint", "是否启用"), cm("description", "text", "描述", false, true), cm("sort_order", "int", "排序权重"),
    ],
  },
  buff: {
    table_name: "buff",
    table_comment: "增益效果配置表",
    columns: [
      cm("id", "int", "增益ID", true), cm("name", "varchar(32)", "名称"), cm("icon", "varchar(64)", "图标", false, true),
      cm("stack_max", "int", "最大叠加层数"), cm("duration", "decimal(8,2)", "持续秒数(0永久)"),
      cm("effect_type", "tinyint", "效果类型"), cm("value_type", "tinyint", "数值类型(1固定值2百分比)"),
      cm("value", "decimal(8,2)", "效果数值"), cm("is_debuff", "tinyint", "是否减益"),
      cm("is_dispel", "tinyint", "可否驱散"), cm("description", "text", "描述", false, true), cm("source", "varchar(32)", "来源", false, true),
    ],
  },
  drop_table: {
    table_name: "drop_table",
    table_comment: "掉落配置表",
    columns: [
      cm("id", "int", "掉落ID", true), cm("name", "varchar(64)", "名称"), cm("item_id", "int", "道具ID"),
      cm("min_count", "int", "最小数量"), cm("max_count", "int", "最大数量"), cm("weight", "int", "权重"),
      cm("rarity", "tinyint", "稀有度"), cm("is_guaranteed", "tinyint", "是否保底"),
      cm("condition", "varchar(64)", "掉落条件", false, true), cm("group_id", "int", "掉落组ID", false, true),
      cm("description", "text", "描述", false, true), cm("is_enabled", "tinyint", "是否启用"),
    ],
  },
  // Similar-name test tables
  ...Object.fromEntries(["user", "users", "user_profile", "user_profiles", "order", "orders", "order_item", "order_items"].map((tn) => [
    tn, { table_name: tn, table_comment: `相似表名测试：${tn}，用于验证搜索、切换和备注换行时不会混淆 user/users/order/orders 等名称相近的表。`, columns: similarColumns(tn) },
  ])),
  ui_edge_case_values: {
    table_name: "ui_edge_case_values",
    table_comment: "UI边界测试表：包含超长备注、嵌套JSON、TypeScript函数、大小写相近字段和 snake/camel 命名，用于验收右侧备注面板、搜索和格式化预览。",
    columns: [
      cm("id", "int", "边界用例ID", true), cm("name", "varchar(64)", "用例名称"),
      cm("long_remark", "text", "这是一个非常非常长的字段备注，包含中文、English words、符号以及连续描述，用来确认备注面板中的字段说明会自动换行，不会因为 nowrap 导致横向滚动或布局被撑破。", false, true),
      cm("json_value", "text", "JSON字符串：右侧详情应该格式化为更容易阅读的结构，并对 key/string/number/boolean/null 做颜色标注。", false, true),
      cm("ts_function", "text", "TypeScript函数文本：右侧详情应按 TS-like 语法进行轻量高亮。", false, true),
      cm("case_key", "varchar(64)", "大小写敏感测试值", false, true), cm("mixedCaseColumn", "varchar(64)", "camelCase字段名测试", false, true),
      cm("snake_case_column", "varchar(64)", "snake_case字段名测试", false, true),
    ],
  },

  // --- New tables for additional databases ---

  // demo / game_config
  config_entry: {
    table_name: "config_entry",
    table_comment: "游戏配置键值表",
    columns: [
      cm("id", "int", "配置ID", true), cm("config_key", "varchar(64)", "配置键"), cm("config_value", "text", "配置值"),
      cm("category", "varchar(32)", "分类"), cm("updated_at", "datetime", "更新时间"), cm("description", "text", "说明", false, true),
    ],
  },
  localization: {
    table_name: "localization",
    table_comment: "多语言文案表",
    columns: [
      cm("id", "int", "文案ID", true), cm("locale", "varchar(8)", "语言代码"), cm("msg_key", "varchar(128)", "消息键"),
      cm("msg_value", "text", "翻译文本"), cm("is_rtl", "tinyint", "是否RTL语言"),
    ],
  },
  version_info: {
    table_name: "version_info",
    table_comment: "版本信息表",
    columns: [
      cm("id", "int", "版本ID", true), cm("version_code", "varchar(32)", "版本号"), cm("platform", "varchar(16)", "平台"),
      cm("release_notes", "text", "更新说明", false, true), cm("is_mandatory", "tinyint", "是否强制更新"), cm("released_at", "datetime", "发布时间"),
    ],
  },
  feature_flag: {
    table_name: "feature_flag",
    table_comment: "功能开关表",
    columns: [
      cm("id", "int", "开关ID", true), cm("flag_key", "varchar(64)", "开关键名"), cm("is_enabled", "tinyint", "是否启用"),
      cm("target_group", "varchar(32)", "目标用户组", false, true), cm("description", "text", "说明", false, true),
    ],
  },

  // demo-staging / game_db extras
  staging_migration: {
    table_name: "staging_migration",
    table_comment: "Staging迁移记录表",
    columns: [
      cm("id", "int", "迁移ID", true), cm("migration_name", "varchar(128)", "迁移名称"), cm("applied_at", "datetime", "执行时间"),
      cm("checksum", "varchar(64)", "校验和"), cm("status", "tinyint", "状态(0成功1失败2回滚)"),
    ],
  },
  staging_flag: {
    table_name: "staging_flag",
    table_comment: "Staging环境开关表",
    columns: [
      cm("id", "int", "开关ID", true), cm("flag_name", "varchar(64)", "开关名称"), cm("enabled", "tinyint", "是否启用"),
      cm("description", "text", "说明", false, true), cm("toggled_by", "varchar(32)", "操作人"),
    ],
  },
  staging_override: {
    table_name: "staging_override",
    table_comment: "Staging配置覆盖表",
    columns: [
      cm("id", "int", "覆盖ID", true), cm("config_key", "varchar(64)", "配置键"), cm("override_value", "text", "覆盖值"),
      cm("reason", "text", "原因", false, true), cm("created_at", "datetime", "创建时间"),
    ],
  },

  // demo-staging / analytics_db
  event_log: {
    table_name: "event_log",
    table_comment: "事件日志表",
    columns: [
      cm("id", "int", "事件ID", true), cm("event_name", "varchar(64)", "事件名称"), cm("user_id", "int", "用户ID"),
      cm("properties", "text", "事件属性(JSON)", false, true), cm("occurred_at", "datetime", "发生时间"), cm("platform", "varchar(16)", "平台"),
    ],
  },
  daily_active_user: {
    table_name: "daily_active_user",
    table_comment: "日活跃用户统计表",
    columns: [
      cm("id", "int", "统计ID", true), cm("stat_date", "datetime", "统计日期"), cm("dau_count", "int", "DAU数量"),
      cm("new_users", "int", "新增用户"), cm("returning_users", "int", "回流用户"), cm("platform", "varchar(16)", "平台"),
    ],
  },
  revenue_report: {
    table_name: "revenue_report",
    table_comment: "收入报表",
    columns: [
      cm("id", "int", "报表ID", true), cm("report_date", "datetime", "报表日期"), cm("total_revenue", "decimal(12,2)", "总收入"),
      cm("currency", "varchar(8)", "货币"), cm("transaction_count", "int", "交易笔数"), cm("top_item_id", "int", "畅销商品ID", false, true),
    ],
  },
  retention_cohort: {
    table_name: "retention_cohort",
    table_comment: "留存队列分析表",
    columns: [
      cm("id", "int", "队列ID", true), cm("cohort_date", "datetime", "队列日期"), cm("day_offset", "int", "天数偏移"),
      cm("retained_count", "int", "留存人数"), cm("cohort_size", "int", "队列总人数"), cm("retention_rate", "decimal(5,4)", "留存率"),
    ],
  },
  ab_test_config: {
    table_name: "ab_test_config",
    table_comment: "A/B测试配置表",
    columns: [
      cm("id", "int", "实验ID", true), cm("experiment_name", "varchar(64)", "实验名称"), cm("variant", "varchar(32)", "变体"),
      cm("traffic_pct", "tinyint", "流量百分比"), cm("is_active", "tinyint", "是否启用"), cm("description", "text", "说明", false, true),
    ],
  },

  // demo-test / game_db extras
  test_case: {
    table_name: "test_case",
    table_comment: "测试用例表",
    columns: [
      cm("id", "int", "用例ID", true), cm("case_name", "varchar(128)", "用例名称"), cm("module", "varchar(32)", "模块"),
      cm("expected_result", "text", "期望结果", false, true), cm("priority", "tinyint", "优先级(1-5)"), cm("is_automated", "tinyint", "是否自动化"),
    ],
  },
  test_result: {
    table_name: "test_result",
    table_comment: "测试结果表",
    columns: [
      cm("id", "int", "结果ID", true), cm("test_case_id", "int", "用例ID"), cm("status", "varchar(16)", "状态(pass/fail/skip)"),
      cm("executed_at", "datetime", "执行时间"), cm("duration_ms", "int", "耗时(毫秒)"), cm("error_message", "text", "错误信息", false, true),
    ],
  },

  // demo-test / game_db_archive
  archived_player: {
    table_name: "archived_player",
    table_comment: "归档玩家表",
    columns: [
      cm("id", "int", "归档ID", true), cm("original_id", "int", "原始ID"), cm("username", "varchar(32)", "用户名"),
      cm("level", "int", "等级"), cm("last_active", "datetime", "最后活跃", false, true), cm("archived_at", "datetime", "归档时间"),
    ],
  },
  archived_guild: {
    table_name: "archived_guild",
    table_comment: "归档公会表",
    columns: [
      cm("id", "int", "归档ID", true), cm("original_id", "int", "原始ID"), cm("name", "varchar(32)", "公会名"),
      cm("member_count", "int", "成员数"), cm("disbanded_at", "datetime", "解散时间"),
    ],
  },
  archived_mail: {
    table_name: "archived_mail",
    table_comment: "归档邮件表",
    columns: [
      cm("id", "int", "归档ID", true), cm("original_id", "int", "原始ID"), cm("title", "varchar(128)", "标题"),
      cm("sender", "varchar(32)", "发送者"), cm("expired_at", "datetime", "过期时间"),
    ],
  },
  archived_activity: {
    table_name: "archived_activity",
    table_comment: "归档活动表",
    columns: [
      cm("id", "int", "归档ID", true), cm("original_id", "int", "原始ID"), cm("name", "varchar(64)", "活动名"),
      cm("ended_at", "datetime", "结束时间"), cm("participant_count", "int", "参与人数"),
    ],
  },
  archive_metadata: {
    table_name: "archive_metadata",
    table_comment: "归档元数据表",
    columns: [
      cm("id", "int", "元数据ID", true), cm("source_table", "varchar(64)", "来源表"), cm("row_count", "int", "行数"),
      cm("archived_at", "datetime", "归档时间"), cm("archive_reason", "text", "归档原因", false, true),
    ],
  },
};

const coreGameTables = [
  "player", "hero", "item", "equip", "skill", "quest", "stage", "monster",
  "shop", "mail", "guild", "achievement", "activity", "buff", "drop_table",
];
const similarNameTables = ["user", "users", "user_profile", "user_profiles", "order", "orders", "order_item", "order_items"];
const uiTestTables = ["ui_edge_case_values"];
const defaultGameDb = [...coreGameTables, ...similarNameTables, ...uiTestTables];
const STRESS_TABLE_PREFIX = "stress_table_";

const initialMockDatabaseSchemas = {
  "demo/game_db": defaultGameDb,
  "demo/game_config": ["hero", "item", "equip", "skill", "config_entry", "localization", "version_info", "feature_flag"],
  "demo-staging/game_db": [...defaultGameDb, "staging_migration", "staging_flag", "staging_override"],
  "demo-staging/analytics_db": ["event_log", "daily_active_user", "revenue_report", "retention_cohort", "ab_test_config"],
  "demo-test/game_db": [...defaultGameDb, "test_case", "test_result"],
  "demo-test/game_db_archive": ["archived_player", "archived_guild", "archived_mail", "archived_activity", "archive_metadata"],
};

export const mockDatabaseSchemas = {};

export function resetMockDatabaseSchemas() {
  for (const key of Object.keys(mockDatabaseSchemas)) delete mockDatabaseSchemas[key];
  for (const [key, tableNames] of Object.entries(initialMockDatabaseSchemas)) {
    mockDatabaseSchemas[key] = [...tableNames];
  }
}

resetMockDatabaseSchemas();

function readRequestedMockTableCount() {
  try {
    const params = new URLSearchParams(globalThis.location?.search || "");
    const count = Number(params.get("mockTables"));
    return Number.isFinite(count) ? Math.max(0, Math.min(2000, Math.floor(count))) : 0;
  } catch {
    return 0;
  }
}

function createStressTable(index) {
  const suffix = String(index).padStart(3, "0");
  return {
    table_name: `${STRESS_TABLE_PREFIX}${suffix}`,
    table_comment: `压力测试表 ${suffix}`,
    columns: [
      cm("id", "int", "压力测试ID", true, false),
      cm("name", "varchar(64)", "压力测试名称", false, false),
      cm("updated_at", "datetime", "更新时间", false, true),
    ],
  };
}

function expandStressSchema(schema, requestedCount) {
  if (!requestedCount || requestedCount <= schema.length) return schema;
  const extraCount = requestedCount - schema.length;
  return [
    ...schema,
    ...Array.from({ length: extraCount }, (_, index) => createStressTable(index + 1)),
  ];
}

function createFallbackTableDef(name) {
  return {
    table_name: name,
    table_comment: "",
    columns: [
      cm("id", "int", "主键ID", true, false),
    ],
  };
}

export function resolveMockSchema(connectionId, database, { tableCount = readRequestedMockTableCount() } = {}) {
  const key = `${connectionId || "demo"}/${database || "game_db"}`;
  const tableNames = mockDatabaseSchemas[key] || mockDatabaseSchemas["demo/game_db"];
  const schema = tableNames.map((name) => mockTableDefs[name] || createFallbackTableDef(name));
  return (database || "game_db") === "game_db" ? expandStressSchema(schema, tableCount) : schema;
}

export const mockSchema = resolveMockSchema("demo", "game_db");
