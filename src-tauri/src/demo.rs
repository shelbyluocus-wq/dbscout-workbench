use std::collections::HashMap;

use crate::db::{
    normalize_page_offset, normalize_page_request, primary_keys, value_search_preview,
};
use crate::types::*;

const STRESS_DB_COUNT: usize = 12;
const STRESS_TABLES_PER_DATABASE: usize = 800;
const STRESS_DEFAULT_CONNECTION_ID: &str = "demo-stress";
const STRESS_DEFAULT_DATABASE: &str = "game_db_01";
const STRESS_LARGE_TABLE_SUFFIX: &str = "0000_large_table_5000";
const STRESS_LARGE_TABLE_ROWS: usize = 5_000;
const CORE_GAME_TABLE_NAMES: &[&str] = &[
    "player",
    "hero",
    "item",
    "equip",
    "skill",
    "quest",
    "stage",
    "monster",
    "shop",
    "mail",
    "guild",
    "achievement",
    "activity",
    "buff",
    "drop_table",
    "user",
    "users",
    "user_profile",
    "user_profiles",
    "order",
    "orders",
    "order_item",
    "order_items",
    "ui_edge_case_values",
];

pub fn stress_connection_id() -> &'static str {
    STRESS_DEFAULT_CONNECTION_ID
}

pub fn stress_default_database() -> &'static str {
    STRESS_DEFAULT_DATABASE
}

pub fn stress_databases(_connection_id: &str) -> Vec<String> {
    (1..=STRESS_DB_COUNT)
        .map(|index| format!("game_db_{index:02}"))
        .collect()
}

fn stress_database_index(database: &str) -> usize {
    database
        .rsplit('_')
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1)
}

fn stress_table_index(table_name: &str) -> usize {
    table_name
        .rsplit('_')
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1)
}

fn stress_domain(table_index: usize) -> (&'static str, &'static str) {
    const DOMAINS: [(&str, &str); 10] = [
        ("config", "配置"),
        ("activity", "活动"),
        ("inventory", "库存"),
        ("economy", "经济"),
        ("localization", "多语言"),
        ("quest", "任务"),
        ("analytics", "分析"),
        ("mail", "邮件"),
        ("combat", "战斗"),
        ("audit", "审计"),
    ];
    DOMAINS[(table_index - 1) % DOMAINS.len()]
}

fn stress_table_name(database: &str, table_index: usize) -> String {
    let database_index = stress_database_index(database);
    if table_index == 1 {
        return format!("db{database_index:02}_{STRESS_LARGE_TABLE_SUFFIX}");
    }
    let (domain, _) = stress_domain(table_index);
    format!("db{database_index:02}_{domain}_{table_index:04}")
}

fn stress_column(name: &str, typ: &str, comment: &str, pk: bool, nullable: bool) -> ColumnMeta {
    ColumnMeta::with_basic(name, typ, comment, pk, nullable)
}

fn stress_columns(table_index: usize) -> Vec<ColumnMeta> {
    let (_, domain_label) = stress_domain(table_index);
    let mut columns = vec![
        stress_column("id", "int", "压力测试主键ID", true, false),
        stress_column(
            "name",
            "varchar(96)",
            &format!("{domain_label}名称"),
            false,
            false,
        ),
        stress_column("category", "varchar(32)", "业务分类", false, false),
        stress_column(
            "status",
            "tinyint",
            "状态(0关闭1开启2灰度3归档)",
            false,
            false,
        ),
        stress_column("owner", "varchar(64)", "负责人或系统来源", false, true),
        stress_column("priority", "int", "排序优先级", false, false),
        stress_column("version", "varchar(32)", "配置版本", false, false),
        stress_column("start_time", "datetime", "开始时间", false, true),
        stress_column("end_time", "datetime", "结束时间", false, true),
        stress_column("payload", "text", "JSON配置或日志内容", false, true),
        stress_column(
            "remark",
            "text",
            "较长备注，用于测试 inspector 和网格文本渲染",
            false,
            true,
        ),
        stress_column("updated_at", "datetime", "更新时间", false, false),
    ];

    if table_index % 17 == 0 {
        for metric_index in 1..=28 {
            columns.push(stress_column(
                &format!("metric_{metric_index:02}"),
                "decimal(12,4)",
                &format!("宽表指标列 {metric_index:02}"),
                false,
                true,
            ));
        }
    } else if table_index % 13 == 0 {
        for segment_index in 1..=12 {
            columns.push(stress_column(
                &format!("segment_{segment_index:02}"),
                "varchar(64)",
                &format!("分群字段 {segment_index:02}"),
                false,
                true,
            ));
        }
    }

    columns
}

pub fn stress_schema_for(database: &str) -> Vec<TableMeta> {
    (1..=STRESS_TABLES_PER_DATABASE)
        .map(|table_index| {
            let table_name = stress_table_name(database, table_index);
            let (_, domain_label) = stress_domain(table_index);
            TableMeta {
                table_name,
                table_comment: if table_index == 1 {
                    "5000 行大表，固定排在调试表列表首位，用于滚动、搜索和排序性能检测".into()
                } else {
                    format!("{domain_label}压力表 #{table_index:04}，用于开发模式性能检测")
                },
                columns: stress_columns(table_index),
            }
        })
        .collect()
}

pub fn stress_total_rows(table_name: &str) -> usize {
    if table_name.ends_with(STRESS_LARGE_TABLE_SUFFIX) {
        return STRESS_LARGE_TABLE_ROWS;
    }
    let table_index = stress_table_index(table_name);
    if table_index % 20 == 0 {
        5000
    } else if table_index % 10 == 0 {
        3000
    } else if table_index % 5 == 0 {
        1000
    } else {
        400 + (table_index % 7) * 50
    }
}

fn stress_cell_value(table: &TableMeta, column: &ColumnMeta, row_number: usize) -> String {
    match column.column_name.as_str() {
        "id" => row_number.to_string(),
        "name" => format!("{}_row_{row_number:05}", table.table_name),
        "category" => ["system", "combat", "economy", "event", "ops"][row_number % 5].to_string(),
        "status" => (row_number % 4).to_string(),
        "owner" => ["designer", "ops", "server", "client", "analytics"][row_number % 5].to_string(),
        "priority" => ((row_number * 7) % 1000).to_string(),
        "version" => format!(
            "{}.{}.{}",
            row_number % 3 + 1,
            row_number % 12,
            row_number % 30
        ),
        "start_time" => format!(
            "2026-{:02}-{:02} {:02}:00:00",
            row_number % 12 + 1,
            row_number % 28 + 1,
            row_number % 24
        ),
        "end_time" => format!(
            "2026-{:02}-{:02} {:02}:30:00",
            (row_number + 1) % 12 + 1,
            (row_number + 7) % 28 + 1,
            row_number % 24
        ),
        "payload" => format!(
            r#"{{"table":"{}","row":{},"enabled":{},"weight":{}}}"#,
            table.table_name,
            row_number,
            row_number % 2 == 0,
            row_number % 97
        ),
        "remark" => format!(
            "压力测试备注：{} 第 {row_number} 行，包含中文、English identifiers 和较长文本。",
            table.table_comment
        ),
        "updated_at" => format!(
            "2026-{:02}-{:02} {:02}:{:02}:00",
            row_number % 12 + 1,
            row_number % 28 + 1,
            row_number % 24,
            row_number % 60
        ),
        name if name.starts_with("metric_") => {
            format!("{:.4}", (row_number as f64 * 1.137) + name.len() as f64)
        }
        name if name.starts_with("segment_") => format!("segment_{}_{}", row_number % 16, name),
        _ => format!("{}_{}", column.column_name, row_number),
    }
}

pub fn stress_row(table: &TableMeta, row_number: usize) -> HashMap<String, String> {
    table
        .columns
        .iter()
        .map(|column| {
            (
                column.column_name.clone(),
                stress_cell_value(table, column, row_number),
            )
        })
        .collect()
}

pub fn materialize_stress_rows(table: &TableMeta) -> Vec<HashMap<String, String>> {
    (1..=stress_total_rows(&table.table_name))
        .map(|row_number| stress_row(table, row_number))
        .collect()
}

pub fn read_stress_demo_page(
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
) -> TableSessionPage {
    let (page, page_size) = normalize_page_request(request);
    let offset = normalize_page_offset(request, page, page_size);
    let needs_materialized_rows = request.filter.is_some() || request.sort.is_some();
    let total_rows = stress_total_rows(&table.table_name);

    let page_rows = if needs_materialized_rows {
        let rows = apply_demo_request(materialize_stress_rows(table), &table.columns, request);
        let start = usize::try_from(offset)
            .unwrap_or(usize::MAX)
            .min(rows.len());
        let end = (start + page_size as usize).min(rows.len());
        if start < rows.len() {
            rows[start..end].to_vec()
        } else {
            Vec::new()
        }
    } else {
        let start = usize::try_from(offset)
            .unwrap_or(usize::MAX)
            .min(total_rows)
            + 1;
        let end = (start + page_size as usize).min(total_rows + 1);
        (start..end)
            .map(|row_number| stress_row(table, row_number))
            .collect()
    };

    let (total_rows, total_rows_exact, has_more) =
        crate::db::count_metadata_without_total(page_rows.len(), page_size, offset);
    let null_cells = page_rows
        .iter()
        .map(|row| {
            table
                .columns
                .iter()
                .filter(|column| !row.contains_key(&column.column_name))
                .map(|column| column.column_name.clone())
                .collect()
        })
        .collect();
    TableSessionPage {
        session_id: session_id.into(),
        table_name: table.table_name.clone(),
        table_comment: table.table_comment.clone(),
        columns: table.columns.clone(),
        primary_keys: primary_keys(table),
        rows: page_rows,
        null_cells,
        total_rows,
        total_rows_exact,
        has_more,
        page,
        page_size,
    }
}

pub fn read_stress_or_materialized_page(
    materialized_rows: Option<&Vec<HashMap<String, String>>>,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
) -> TableSessionPage {
    if let Some(rows) = materialized_rows {
        read_demo_page_from_rows(rows.clone(), table, session_id, request)
    } else {
        read_stress_demo_page(table, session_id, request)
    }
}

pub fn read_stress_search_scan_page(
    materialized_rows: Option<&Vec<HashMap<String, String>>>,
    table: &TableMeta,
    offset: u64,
    limit: u32,
    sort: Option<&TablePageSort>,
) -> Vec<HashMap<String, String>> {
    if let Some(rows) = materialized_rows {
        return read_demo_search_scan_page(rows.clone(), table, offset, limit, sort);
    }
    let direct_order = sort.is_none_or(|sort| {
        table
            .columns
            .iter()
            .find(|column| column.is_primary_key)
            .is_some_and(|column| column.column_name.eq_ignore_ascii_case(&sort.column_name))
    });
    if !direct_order {
        return read_demo_search_scan_page(
            materialize_stress_rows(table),
            table,
            offset,
            limit,
            sort,
        );
    }
    let row_count = stress_total_rows(&table.table_name);
    let start = usize::try_from(offset).unwrap_or(usize::MAX).min(row_count);
    let end = start
        .saturating_add(limit.clamp(1, 512) as usize)
        .min(row_count);
    let descending = sort.is_some_and(|sort| sort.descending);
    (start..end)
        .map(|absolute_index| {
            let row_number = if descending {
                row_count - absolute_index
            } else {
                absolute_index + 1
            };
            stress_row(table, row_number)
        })
        .collect()
}

pub fn count_stress_or_materialized_rows(
    materialized_rows: Option<&Vec<HashMap<String, String>>>,
    table: &TableMeta,
    request: &TablePageRequest,
) -> u64 {
    if materialized_rows.is_none() && request.filter.is_none() {
        return stress_total_rows(&table.table_name) as u64;
    }
    let rows = materialized_rows
        .cloned()
        .unwrap_or_else(|| materialize_stress_rows(table));
    rows.iter()
        .filter(|row| row_matches_filter(row, &table.columns, request.filter.as_ref()))
        .count() as u64
}

pub fn sample_stress_rows(table: &TableMeta, limit: usize) -> Vec<HashMap<String, String>> {
    let total = stress_total_rows(&table.table_name).min(limit);
    (1..=total)
        .map(|row_number| stress_row(table, row_number))
        .collect()
}

pub fn demo_schema() -> Vec<TableMeta> {
    fn cm(name: &str, typ: &str, comment: &str, pk: bool, nullable: bool) -> ColumnMeta {
        ColumnMeta::with_basic(name, typ, comment, pk, nullable)
    }
    fn similar_columns() -> Vec<ColumnMeta> {
        vec![
            cm("id", "int", "主键ID", true, false),
            cm("name", "varchar(64)", "名称字段：与其它相似表名只差单复数或下划线。", false, false),
            cm("remark", "text", "很长的字段备注，用于验证右侧备注面板可以自动换行展示，而不是单行省略或横向撑开布局。", false, true),
        ]
    }
    vec![
        TableMeta { table_name: "player".into(), table_comment: "玩家账号表".into(), columns: vec![
            cm("id", "int", "玩家ID", true, false), cm("username", "varchar(32)", "用户名", false, false),
            cm("nickname", "varchar(64)", "昵称", false, false), cm("level", "int", "等级", false, false),
            cm("exp", "bigint", "经验值", false, false), cm("vip_level", "tinyint", "VIP等级", false, false),
            cm("gold", "bigint", "金币", false, false), cm("diamond", "int", "钻石", false, false),
            cm("last_login", "datetime", "最后登录", false, true), cm("status", "tinyint", "状态(0正常1封禁)", false, false),
            cm("create_time", "datetime", "注册时间", false, false), cm("guild_id", "int", "公会ID", false, true),
        ]},
        TableMeta { table_name: "hero".into(), table_comment: "英雄配置表".into(), columns: vec![
            cm("id", "int", "英雄ID", true, false), cm("name", "varchar(32)", "名称", false, false),
            cm("rarity", "tinyint", "稀有度(1-5)", false, false), cm("element", "varchar(16)", "元素属性", false, false),
            cm("hp_base", "int", "基础生命", false, false), cm("atk_base", "int", "基础攻击", false, false),
            cm("def_base", "int", "基础防御", false, false), cm("spd_base", "int", "基础速度", false, false),
            cm("skill_id", "int", "主动技能ID", false, false), cm("passive_id", "int", "被动技能ID", false, true),
            cm("description", "text", "描述", false, true), cm("is_available", "tinyint", "是否可用", false, false),
        ]},
        TableMeta { table_name: "item".into(), table_comment: "道具配置表".into(), columns: vec![
            cm("id", "int", "道具ID", true, false), cm("name", "varchar(64)", "名称", false, false),
            cm("type", "tinyint", "类型(1消耗2材料3装备4任务)", false, false), cm("quality", "tinyint", "品质(1白2绿3蓝4紫5橙)", false, false),
            cm("max_stack", "int", "最大堆叠", false, false), cm("sell_price", "int", "出售价格", false, true),
            cm("use_level", "tinyint", "使用等级", false, true), cm("effect_id", "int", "效果ID", false, true),
            cm("description", "text", "描述", false, true), cm("icon", "varchar(64)", "图标路径", false, true),
            cm("expire_days", "int", "过期天数(0永久)", false, false), cm("is_tradable", "tinyint", "是否可交易", false, false),
        ]},
        TableMeta { table_name: "equip".into(), table_comment: "装备配置表".into(), columns: vec![
            cm("id", "int", "装备ID", true, false), cm("name", "varchar(64)", "名称", false, false),
            cm("slot", "tinyint", "部位(1武器2头盔3铠甲4鞋子5饰品)", false, false), cm("rarity", "tinyint", "稀有度", false, false),
            cm("hp_bonus", "int", "生命加成", false, false), cm("atk_bonus", "int", "攻击加成", false, false),
            cm("def_bonus", "int", "防御加成", false, false), cm("set_id", "int", "套装ID", false, true),
            cm("required_level", "int", "需求等级", false, false), cm("enchant_max", "tinyint", "最大附魔等级", false, false),
            cm("description", "text", "描述", false, true), cm("source", "varchar(32)", "获取途径", false, true),
        ]},
        TableMeta { table_name: "skill".into(), table_comment: "技能配置表".into(), columns: vec![
            cm("id", "int", "技能ID", true, false), cm("name", "varchar(32)", "名称", false, false),
            cm("type", "tinyint", "类型(1主动2被动3终极)", false, false), cm("element", "varchar(16)", "元素", false, true),
            cm("cooldown", "decimal(5,2)", "冷却时间(秒)", false, false), cm("mp_cost", "int", "法力消耗", false, false),
            cm("damage_rate", "decimal(5,2)", "伤害倍率", false, false), cm("target_type", "tinyint", "目标类型(1单体2群体3自身)", false, false),
            cm("unlock_level", "int", "解锁等级", false, false), cm("max_level", "tinyint", "最大等级", false, false),
            cm("description", "text", "描述", false, true), cm("icon", "varchar(64)", "图标", false, true),
        ]},
        TableMeta { table_name: "quest".into(), table_comment: "任务配置表".into(), columns: vec![
            cm("id", "int", "任务ID", true, false), cm("name", "varchar(64)", "名称", false, false),
            cm("type", "tinyint", "类型(1主线2支线3日常4活动)", false, false), cm("chapter", "int", "章节", false, true),
            cm("required_level", "int", "需求等级", false, false), cm("pre_quest", "int", "前置任务ID", false, true),
            cm("reward_exp", "int", "奖励经验", false, false), cm("reward_gold", "int", "奖励金币", false, false),
            cm("reward_item_id", "int", "奖励道具ID", false, true), cm("reward_item_count", "int", "奖励道具数量", false, true),
            cm("description", "text", "描述", false, true), cm("is_repeatable", "tinyint", "是否可重复", false, false),
        ]},
        TableMeta { table_name: "stage".into(), table_comment: "关卡配置表".into(), columns: vec![
            cm("id", "int", "关卡ID", true, false), cm("name", "varchar(64)", "名称", false, false),
            cm("chapter", "int", "章节", false, false), cm("difficulty", "tinyint", "难度(1普通2困难3地狱)", false, false),
            cm("stamina_cost", "int", "体力消耗", false, false), cm("recommended_level", "int", "推荐等级", false, false),
            cm("boss_id", "int", "BOSS怪物ID", false, true), cm("drop_table_id", "int", "掉落表ID", false, true),
            cm("reward_exp", "int", "奖励经验", false, false), cm("reward_gold", "int", "奖励金币", false, false),
            cm("star_condition", "varchar(128)", "三星条件", false, true), cm("is_unlocked", "tinyint", "默认解锁", false, false),
        ]},
        TableMeta { table_name: "monster".into(), table_comment: "怪物配置表".into(), columns: vec![
            cm("id", "int", "怪物ID", true, false), cm("name", "varchar(32)", "名称", false, false),
            cm("type", "tinyint", "类型(1普通2精英3BOSS)", false, false), cm("element", "varchar(16)", "元素", false, true),
            cm("hp", "int", "生命值", false, false), cm("atk", "int", "攻击力", false, false),
            cm("def", "int", "防御力", false, false), cm("spd", "int", "速度", false, false),
            cm("skill_id_1", "int", "技能1", false, true), cm("skill_id_2", "int", "技能2", false, true),
            cm("drop_table_id", "int", "掉落表ID", false, true), cm("description", "text", "描述", false, true),
        ]},
        TableMeta { table_name: "shop".into(), table_comment: "商店配置表".into(), columns: vec![
            cm("id", "int", "商品ID", true, false), cm("name", "varchar(64)", "商品名", false, false),
            cm("category", "tinyint", "分类(1道具2英雄3皮肤4礼包)", false, false), cm("item_id", "int", "关联道具ID", false, true),
            cm("price_type", "tinyint", "货币类型(1金币2钻石)", false, false), cm("price", "int", "价格", false, false),
            cm("original_price", "int", "原价", false, true), cm("stock_limit", "int", "限购数量(0无限)", false, false),
            cm("refresh_cycle", "tinyint", "刷新周期(0不刷新1日2周)", false, false), cm("required_vip", "tinyint", "需求VIP", false, false),
            cm("start_time", "datetime", "开始时间", false, true), cm("end_time", "datetime", "结束时间", false, true),
        ]},
        TableMeta { table_name: "mail".into(), table_comment: "邮件模板表".into(), columns: vec![
            cm("id", "int", "模板ID", true, false), cm("title", "varchar(128)", "标题", false, false),
            cm("sender", "varchar(32)", "发送者", false, false), cm("content", "text", "内容", false, false),
            cm("reward_item_id", "int", "附件道具ID", false, true), cm("reward_count", "int", "附件数量", false, true),
            cm("expire_hours", "int", "过期时间(小时)", false, false), cm("priority", "tinyint", "优先级", false, false),
            cm("trigger_event", "varchar(32)", "触发事件", false, true), cm("is_system", "tinyint", "是否系统邮件", false, false),
            cm("create_time", "datetime", "创建时间", false, false), cm("is_read", "tinyint", "默认已读", false, false),
        ]},
        TableMeta { table_name: "guild".into(), table_comment: "公会配置表".into(), columns: vec![
            cm("id", "int", "公会ID", true, false), cm("name", "varchar(32)", "公会名", false, false),
            cm("level", "tinyint", "公会等级", false, false), cm("leader_id", "int", "会长ID", false, false),
            cm("member_count", "int", "成员数", false, false), cm("max_members", "int", "最大成员数", false, false),
            cm("exp", "bigint", "公会经验", false, false), cm("notice", "varchar(256)", "公告", false, true),
            cm("create_time", "datetime", "创建时间", false, false), cm("is_recruiting", "tinyint", "是否招募中", false, false),
            cm("min_join_level", "int", "最低加入等级", false, false), cm("icon_id", "int", "公会图标ID", false, true),
        ]},
        TableMeta { table_name: "achievement".into(), table_comment: "成就配置表".into(), columns: vec![
            cm("id", "int", "成就ID", true, false), cm("name", "varchar(64)", "名称", false, false),
            cm("category", "tinyint", "分类(1战斗2收集3探索4社交)", false, false), cm("condition_type", "varchar(32)", "条件类型", false, false),
            cm("condition_value", "int", "条件数值", false, false), cm("reward_diamond", "int", "奖励钻石", false, false),
            cm("reward_title", "varchar(32)", "奖励称号", false, true), cm("points", "int", "成就点数", false, false),
            cm("is_hidden", "tinyint", "是否隐藏", false, false), cm("parent_id", "int", "父成就ID", false, true),
            cm("description", "text", "描述", false, true), cm("icon", "varchar(64)", "图标", false, true),
        ]},
        TableMeta { table_name: "activity".into(), table_comment: "活动配置表".into(), columns: vec![
            cm("id", "int", "活动ID", true, false), cm("name", "varchar(64)", "名称", false, false),
            cm("type", "tinyint", "类型(1签到2抽卡3副本4消费返利)", false, false), cm("start_time", "datetime", "开始时间", false, false),
            cm("end_time", "datetime", "结束时间", false, false), cm("reward_pool", "text", "奖励池(JSON)", false, true),
            cm("daily_limit", "int", "每日次数限制", false, true), cm("total_limit", "int", "总次数限制", false, true),
            cm("required_level", "int", "需求等级", false, false), cm("is_active", "tinyint", "是否启用", false, false),
            cm("description", "text", "描述", false, true), cm("sort_order", "int", "排序权重", false, false),
        ]},
        TableMeta { table_name: "buff".into(), table_comment: "增益效果配置表".into(), columns: vec![
            cm("id", "int", "增益ID", true, false), cm("name", "varchar(32)", "名称", false, false),
            cm("icon", "varchar(64)", "图标", false, true), cm("stack_max", "int", "最大叠加层数", false, false),
            cm("duration", "decimal(8,2)", "持续秒数(0永久)", false, false), cm("effect_type", "tinyint", "效果类型", false, false),
            cm("value_type", "tinyint", "数值类型(1固定值2百分比)", false, false), cm("value", "decimal(8,2)", "效果数值", false, false),
            cm("is_debuff", "tinyint", "是否减益", false, false), cm("is_dispel", "tinyint", "可否驱散", false, false),
            cm("description", "text", "描述", false, true), cm("source", "varchar(32)", "来源", false, true),
        ]},
        TableMeta { table_name: "drop_table".into(), table_comment: "掉落配置表".into(), columns: vec![
            cm("id", "int", "掉落ID", true, false), cm("name", "varchar(64)", "名称", false, false),
            cm("item_id", "int", "道具ID", false, false), cm("min_count", "int", "最小数量", false, false),
            cm("max_count", "int", "最大数量", false, false), cm("weight", "int", "权重", false, false),
            cm("rarity", "tinyint", "稀有度", false, false), cm("is_guaranteed", "tinyint", "是否保底", false, false),
            cm("condition", "varchar(64)", "掉落条件", false, true), cm("group_id", "int", "掉落组ID", false, true),
            cm("description", "text", "描述", false, true), cm("is_enabled", "tinyint", "是否启用", false, false),
        ]},
        TableMeta { table_name: "user".into(), table_comment: "相似表名测试：user，用于验证搜索和备注换行。".into(), columns: similar_columns() },
        TableMeta { table_name: "users".into(), table_comment: "相似表名测试：users，只比 user 多一个 s。".into(), columns: similar_columns() },
        TableMeta { table_name: "user_profile".into(), table_comment: "相似表名测试：user_profile，下划线命名。".into(), columns: similar_columns() },
        TableMeta { table_name: "user_profiles".into(), table_comment: "相似表名测试：user_profiles，复数下划线命名。".into(), columns: similar_columns() },
        TableMeta { table_name: "order".into(), table_comment: "相似表名测试：order，和 orders/order_item 相近。".into(), columns: similar_columns() },
        TableMeta { table_name: "orders".into(), table_comment: "相似表名测试：orders，复数订单表。".into(), columns: similar_columns() },
        TableMeta { table_name: "order_item".into(), table_comment: "相似表名测试：order_item，订单明细单数。".into(), columns: similar_columns() },
        TableMeta { table_name: "order_items".into(), table_comment: "相似表名测试：order_items，订单明细复数。".into(), columns: similar_columns() },
        TableMeta { table_name: "ui_edge_case_values".into(), table_comment: "UI边界测试表：包含超长备注、嵌套JSON、TypeScript函数、大小写相近字段和 snake/camel 命名。".into(), columns: vec![
            cm("id", "int", "边界用例ID", true, false), cm("name", "varchar(64)", "用例名称", false, false),
            cm("long_remark", "text", "这是一个非常非常长的字段备注，包含中文、English words、符号以及连续描述，用来确认备注面板中的字段说明会自动换行。", false, true),
            cm("json_value", "text", "JSON字符串：右侧详情应该格式化为更容易阅读的结构，并对 key/string/number/boolean/null 做颜色标注。", false, true),
            cm("ts_function", "text", "TypeScript函数文本：右侧详情应按 TS-like 语法进行轻量高亮。", false, true),
            cm("case_key", "varchar(64)", "大小写敏感测试值", false, true),
            cm("mixedCaseColumn", "varchar(64)", "camelCase字段名测试", false, true),
            cm("snake_case_column", "varchar(64)", "snake_case字段名测试", false, true),
        ]},
    ]
}

pub fn demo_rows() -> HashMap<String, Vec<HashMap<String, String>>> {
    let mut out = HashMap::new();
    let elements = ["火", "水", "风", "雷", "光", "暗"];
    let qualities = ["普通", "精良", "稀有", "史诗", "传说"];
    let names_prefix = [
        "暗影", "圣光", "风暴", "烈焰", "寒冰", "雷霆", "龙魂", "星辰", "月华", "天命", "苍穹",
        "破晓",
    ];
    let names_suffix = [
        "之剑", "使者", "守护", "猎人", "法师", "战士", "游侠", "祭司", "刺客", "骑士",
    ];
    let adjectives = [
        "古老的",
        "神秘的",
        "闪耀的",
        "坚固的",
        "锋利的",
        "华美的",
        "朴素的",
        "传说中的",
        "被诅咒的",
        "祝福的",
    ];
    let nouns = [
        "长剑", "法杖", "盾牌", "战靴", "头盔", "护甲", "项链", "戒指", "弓箭", "匕首",
    ];
    let quests = [
        "击败", "收集", "护送", "探索", "消灭", "寻找", "修复", "守护", "调查", "夺回",
    ];
    let targets = [
        "哥布林",
        "巨龙",
        "暗影骑士",
        "精灵守卫",
        "亡灵法师",
        "石像鬼",
        "森林巨魔",
        "海妖",
        "凤凰",
        "恶魔领主",
    ];
    let areas = [
        "幽暗森林",
        "龙骨荒野",
        "水晶洞穴",
        "天空之城",
        "地下迷宫",
        "火山口",
        "冰封湖",
        "古战场",
        "精灵遗迹",
        "恶魔之门",
    ];

    let tables = demo_schema();
    for table in &tables {
        let count = match table.table_name.as_str() {
            "player" => 2000,
            "hero" | "item" | "equip" | "skill" | "monster" | "drop_table" => 500,
            "quest" | "stage" => 800,
            "shop" => 300,
            "mail" | "activity" | "achievement" => 400,
            "guild" | "buff" => 600,
            "ui_edge_case_values" => 12,
            "user" | "users" | "user_profile" | "user_profiles" | "order" | "orders"
            | "order_item" | "order_items" => 16,
            _ => 1000,
        };
        let mut rows = Vec::with_capacity(count);
        for i in 1..=count {
            let mut r = HashMap::new();
            for col in &table.columns {
                let v = if col.is_primary_key {
                    i.to_string()
                } else if table.table_name == "ui_edge_case_values" {
                    match col.column_name.as_str() {
                        "name" => format!("边界用例_{i}"),
                        "long_remark" => format!("这是第 {i} 条超长备注，用于测试自动换行。它包含中文段落、English identifiers like veryLongRemarkField、连续描述以及标点符号，应该在右侧备注区域自然换行显示，而不是把面板横向撑开。"),
                        "json_value" => format!(r#"{{"id":{i},"enabled":{},"tags":["json","preview","case-{i}"],"limits":{{"daily":{},"total":null}}}}"#, i % 2 == 0, i * 3),
                        "ts_function" => format!("export const calculateReward = <T extends Player>(player: T) => {{\n  const bonus = player.level > {i} ? 2 : 1;\n  return {{ gold: {} * bonus, tags: [\"edge\", player.id] }};\n}};", i * 100),
                        "case_key" => ["Alpha", "alpha", "ALPHA"][i % 3].to_string(),
                        "mixedCaseColumn" => format!("mixedCaseValue{i}"),
                        "snake_case_column" => format!("snake_case_value_{i}"),
                        _ => format!("edge_{i}"),
                    }
                } else if matches!(
                    table.table_name.as_str(),
                    "user"
                        | "users"
                        | "user_profile"
                        | "user_profiles"
                        | "order"
                        | "orders"
                        | "order_item"
                        | "order_items"
                ) {
                    match col.column_name.as_str() {
                        "name" => format!("{}_name_{i:02}", table.table_name),
                        "remark" => format!("{} 与其它相似表名用于测试搜索命中和用户辨识。这是一段较长备注 {i}，应该能在备注面板里自动换行。", table.table_name),
                        _ => format!("similar_{i}"),
                    }
                } else {
                    match col.column_type.as_str() {
                        "int" | "bigint" | "tinyint" => match col.column_name.as_str() {
                            "level" | "required_level" | "recommended_level" | "unlock_level"
                            | "required_vip" | "min_join_level" => ((i % 80) + 1).to_string(),
                            "hp" | "hp_base" | "hp_bonus" => ((i % 100) * 100 + 500).to_string(),
                            "atk" | "atk_base" | "atk_bonus" => ((i % 50) * 10 + 30).to_string(),
                            "def" | "def_base" | "def_bonus" => ((i % 40) * 8 + 20).to_string(),
                            "spd" | "spd_base" => ((i % 30) * 3 + 80).to_string(),
                            "exp" => (i as u64 * 1000 + 50000).to_string(),
                            "gold" => (i as u64 * 500 + 10000).to_string(),
                            "diamond" => (i % 1000).to_string(),
                            "vip_level" | "rarity" | "quality" | "max_stack" => {
                                ((i % 5) + 1).to_string()
                            }
                            "type" | "category" | "target_type" | "effect_type" | "value_type" => {
                                ((i % 4) + 1).to_string()
                            }
                            "cooldown" | "mp_cost" | "stamina_cost" => (i % 30 + 5).to_string(),
                            "damage_rate" | "weight" | "points" => (i % 200 + 10).to_string(),
                            "sell_price" | "price" | "original_price" => (i * 10 + 50).to_string(),
                            "stack_max" | "max_level" | "enchant_max" => ((i % 10) + 1).to_string(),
                            "reward_exp" | "reward_gold" => (i * 50 + 100).to_string(),
                            "reward_item_count" | "reward_diamond" | "reward_count" => {
                                ((i % 10) + 1).to_string()
                            }
                            "expire_days" | "expire_hours" => (i % 90 + 1).to_string(),
                            "chapter" | "difficulty" | "sort_order" => ((i % 12) + 1).to_string(),
                            "daily_limit" | "total_limit" | "stock_limit" => {
                                ((i % 5) * 3).to_string()
                            }
                            "use_level" | "condition_value" => ((i % 60) + 1).to_string(),
                            "priority" => ((i % 3) + 1).to_string(),
                            "member_count" | "max_members" => ((i % 40) + 10).to_string(),
                            "min_count" | "max_count" => ((i % 5) + 1).to_string(),
                            _ => (i % 1000).to_string(),
                        },
                        "decimal(5,2)" | "decimal(8,2)" => {
                            let base = (i % 100) as f64 / 10.0 + 1.0;
                            format!("{base:.2}")
                        }
                        "varchar(16)" | "varchar(32)" | "varchar(64)" | "varchar(128)"
                        | "varchar(256)" => match col.column_name.as_str() {
                            "element" => elements[i % elements.len()].to_string(),
                            "username" => format!("user_{i:04}"),
                            "nickname" => format!("冒险者{i}"),
                            "name" | "title" => match table.table_name.as_str() {
                                "hero" => format!(
                                    "{}{}{}",
                                    names_prefix[i % names_prefix.len()],
                                    names_suffix[i % names_suffix.len()],
                                    if i > 250 { "·改" } else { "" }
                                ),
                                "equip" => format!(
                                    "{}{}",
                                    adjectives[i % adjectives.len()],
                                    nouns[i % nouns.len()]
                                ),
                                "quest" => format!(
                                    "{}{}{}",
                                    quests[i % quests.len()],
                                    targets[i % targets.len()],
                                    if i > 400 { "·续" } else { "" }
                                ),
                                "stage" => format!(
                                    "{}·{}",
                                    areas[i % areas.len()],
                                    ["普通", "困难", "地狱"][i % 3]
                                ),
                                "monster" => format!(
                                    "{}{}",
                                    adjectives[i % adjectives.len()],
                                    targets[i % targets.len()]
                                ),
                                "shop" => format!("{}礼包{}", qualities[i % qualities.len()], i),
                                "buff" => format!(
                                    "{}之力{}",
                                    elements[i % elements.len()],
                                    if i % 2 == 0 { "·强化" } else { "" }
                                ),
                                _ => format!("{}_{i}", table.table_name),
                            },
                            "sender" => ["系统", "运营团队", "公会管理", "客服"][i % 4].to_string(),
                            "quality" => qualities[i % qualities.len()].to_string(),
                            "icon" => format!("icon_{}/{}", table.table_name, i % 50),
                            "star_condition" => format!("回合数≤{} 且 无阵亡", (i % 10) + 3),
                            "source" => {
                                ["副本掉落", "商店购买", "活动奖励", "合成获得", "成就解锁"][i % 5]
                                    .to_string()
                            }
                            "condition_type" => [
                                "kill_monster",
                                "collect_item",
                                "reach_level",
                                "clear_stage",
                                "join_guild",
                            ][i % 5]
                                .to_string(),
                            "trigger_event" => [
                                "level_up",
                                "login",
                                "first_recharge",
                                "guild_join",
                                "achievement_complete",
                            ][i % 5]
                                .to_string(),
                            "description" | "content" | "reward_pool" | "notice" => {
                                col.column_type.len().to_string()
                            }
                            _ => format!("{}_val_{i}", col.column_name),
                        },
                        "text" => match col.column_name.as_str() {
                            "description" => format!(
                                "这是{}的描述文本，包含了详细的功能说明和背景故事。编号：{}",
                                table.table_name, i
                            ),
                            "content" => format!(
                                "尊敬的玩家，感谢您参与活动，以下是您的奖励详情。编号：{}",
                                i
                            ),
                            "reward_pool" => format!(
                                "[{{\"itemId\":{},\"weight\":{}}},{{\"itemId\":{},\"weight\":{}}}]",
                                i % 100 + 1,
                                (i % 50) + 10,
                                i % 100 + 101,
                                (i % 30) + 5
                            ),
                            _ => format!("text_{i}"),
                        },
                        "datetime" => format!(
                            "2025-{:02}-{:02} {:02}:{:02}:00",
                            (i % 12) + 1,
                            (i % 28) + 1,
                            (i % 24),
                            (i % 60)
                        ),
                        _ => format!("{i}"),
                    }
                };
                r.insert(col.column_name.clone(), v);
            }
            rows.push(r);
        }
        out.insert(table.table_name.clone(), rows);
    }
    out
}

/// Returns the list of databases available for a demo connection.
pub fn demo_databases(connection_id: &str) -> Vec<String> {
    match connection_id {
        "demo" => vec!["game_db".into(), "game_config".into()],
        "demo-staging" => vec!["game_db".into(), "analytics_db".into()],
        "demo-test" => vec!["game_db".into(), "game_db_archive".into()],
        _ => vec!["game_db".into()],
    }
}

/// Returns the schema for a specific demo connection + database.
pub fn demo_schema_for(connection_id: &str, database: &str) -> Vec<TableMeta> {
    let all = demo_schema_all();
    let key = format!("{connection_id}/{database}");
    let names = match key.as_str() {
        "demo/game_config" => vec![
            "hero",
            "item",
            "equip",
            "skill",
            "config_entry",
            "localization",
            "version_info",
            "feature_flag",
        ],
        "demo-staging/game_db" => {
            core_game_table_names_with(&["staging_migration", "staging_flag", "staging_override"])
        }
        "demo-staging/analytics_db" => vec![
            "event_log",
            "daily_active_user",
            "revenue_report",
            "retention_cohort",
            "ab_test_config",
        ],
        "demo-test/game_db" => core_game_table_names_with(&["test_case", "test_result"]),
        "demo-test/game_db_archive" => vec![
            "archived_player",
            "archived_guild",
            "archived_mail",
            "archived_activity",
            "archive_metadata",
        ],
        _ => CORE_GAME_TABLE_NAMES.to_vec(),
    };
    names
        .iter()
        .filter_map(|n: &&str| all.get(*n).cloned())
        .collect()
}

fn core_game_table_names_with(extras: &[&'static str]) -> Vec<&'static str> {
    CORE_GAME_TABLE_NAMES
        .iter()
        .copied()
        .chain(extras.iter().copied())
        .collect()
}

/// Full table definition map (all tables across all databases).
fn demo_schema_all() -> HashMap<String, TableMeta> {
    let mut map = HashMap::new();
    for table in demo_schema() {
        map.insert(table.table_name.clone(), table);
    }
    // New tables for additional databases
    fn cm(name: &str, typ: &str, comment: &str, pk: bool, nullable: bool) -> ColumnMeta {
        ColumnMeta::with_basic(name, typ, comment, pk, nullable)
    }
    for table in vec![
        // demo / game_config
        TableMeta {
            table_name: "config_entry".into(),
            table_comment: "游戏配置键值表".into(),
            columns: vec![
                cm("id", "int", "配置ID", true, false),
                cm("config_key", "varchar(64)", "配置键", false, false),
                cm("config_value", "text", "配置值", false, false),
                cm("category", "varchar(32)", "分类", false, false),
                cm("updated_at", "datetime", "更新时间", false, false),
                cm("description", "text", "说明", false, true),
            ],
        },
        TableMeta {
            table_name: "localization".into(),
            table_comment: "多语言文案表".into(),
            columns: vec![
                cm("id", "int", "文案ID", true, false),
                cm("locale", "varchar(8)", "语言代码", false, false),
                cm("msg_key", "varchar(128)", "消息键", false, false),
                cm("msg_value", "text", "翻译文本", false, false),
                cm("is_rtl", "tinyint", "是否RTL语言", false, false),
            ],
        },
        TableMeta {
            table_name: "version_info".into(),
            table_comment: "版本信息表".into(),
            columns: vec![
                cm("id", "int", "版本ID", true, false),
                cm("version_code", "varchar(32)", "版本号", false, false),
                cm("platform", "varchar(16)", "平台", false, false),
                cm("release_notes", "text", "更新说明", false, true),
                cm("is_mandatory", "tinyint", "是否强制更新", false, false),
                cm("released_at", "datetime", "发布时间", false, false),
            ],
        },
        TableMeta {
            table_name: "feature_flag".into(),
            table_comment: "功能开关表".into(),
            columns: vec![
                cm("id", "int", "开关ID", true, false),
                cm("flag_key", "varchar(64)", "开关键名", false, false),
                cm("is_enabled", "tinyint", "是否启用", false, false),
                cm("target_group", "varchar(32)", "目标用户组", false, true),
                cm("description", "text", "说明", false, true),
            ],
        },
        // demo-staging / game_db extras
        TableMeta {
            table_name: "staging_migration".into(),
            table_comment: "Staging迁移记录表".into(),
            columns: vec![
                cm("id", "int", "迁移ID", true, false),
                cm("migration_name", "varchar(128)", "迁移名称", false, false),
                cm("applied_at", "datetime", "执行时间", false, false),
                cm("checksum", "varchar(64)", "校验和", false, false),
                cm("status", "tinyint", "状态(0成功1失败2回滚)", false, false),
            ],
        },
        TableMeta {
            table_name: "staging_flag".into(),
            table_comment: "Staging环境开关表".into(),
            columns: vec![
                cm("id", "int", "开关ID", true, false),
                cm("flag_name", "varchar(64)", "开关名称", false, false),
                cm("enabled", "tinyint", "是否启用", false, false),
                cm("description", "text", "说明", false, true),
                cm("toggled_by", "varchar(32)", "操作人", false, false),
            ],
        },
        TableMeta {
            table_name: "staging_override".into(),
            table_comment: "Staging配置覆盖表".into(),
            columns: vec![
                cm("id", "int", "覆盖ID", true, false),
                cm("config_key", "varchar(64)", "配置键", false, false),
                cm("override_value", "text", "覆盖值", false, false),
                cm("reason", "text", "原因", false, true),
                cm("created_at", "datetime", "创建时间", false, false),
            ],
        },
        // demo-staging / analytics_db
        TableMeta {
            table_name: "event_log".into(),
            table_comment: "事件日志表".into(),
            columns: vec![
                cm("id", "int", "事件ID", true, false),
                cm("event_name", "varchar(64)", "事件名称", false, false),
                cm("user_id", "int", "用户ID", false, false),
                cm("properties", "text", "事件属性(JSON)", false, true),
                cm("occurred_at", "datetime", "发生时间", false, false),
                cm("platform", "varchar(16)", "平台", false, false),
            ],
        },
        TableMeta {
            table_name: "daily_active_user".into(),
            table_comment: "日活跃用户统计表".into(),
            columns: vec![
                cm("id", "int", "统计ID", true, false),
                cm("stat_date", "datetime", "统计日期", false, false),
                cm("dau_count", "int", "DAU数量", false, false),
                cm("new_users", "int", "新增用户", false, false),
                cm("returning_users", "int", "回流用户", false, false),
                cm("platform", "varchar(16)", "平台", false, false),
            ],
        },
        TableMeta {
            table_name: "revenue_report".into(),
            table_comment: "收入报表".into(),
            columns: vec![
                cm("id", "int", "报表ID", true, false),
                cm("report_date", "datetime", "报表日期", false, false),
                cm("total_revenue", "decimal(12,2)", "总收入", false, false),
                cm("currency", "varchar(8)", "货币", false, false),
                cm("transaction_count", "int", "交易笔数", false, false),
                cm("top_item_id", "int", "畅销商品ID", false, true),
            ],
        },
        TableMeta {
            table_name: "retention_cohort".into(),
            table_comment: "留存队列分析表".into(),
            columns: vec![
                cm("id", "int", "队列ID", true, false),
                cm("cohort_date", "datetime", "队列日期", false, false),
                cm("day_offset", "int", "天数偏移", false, false),
                cm("retained_count", "int", "留存人数", false, false),
                cm("cohort_size", "int", "队列总人数", false, false),
                cm("retention_rate", "decimal(5,4)", "留存率", false, false),
            ],
        },
        TableMeta {
            table_name: "ab_test_config".into(),
            table_comment: "A/B测试配置表".into(),
            columns: vec![
                cm("id", "int", "实验ID", true, false),
                cm("experiment_name", "varchar(64)", "实验名称", false, false),
                cm("variant", "varchar(32)", "变体", false, false),
                cm("traffic_pct", "tinyint", "流量百分比", false, false),
                cm("is_active", "tinyint", "是否启用", false, false),
                cm("description", "text", "说明", false, true),
            ],
        },
        // demo-test / game_db extras
        TableMeta {
            table_name: "test_case".into(),
            table_comment: "测试用例表".into(),
            columns: vec![
                cm("id", "int", "用例ID", true, false),
                cm("case_name", "varchar(128)", "用例名称", false, false),
                cm("module", "varchar(32)", "模块", false, false),
                cm("expected_result", "text", "期望结果", false, true),
                cm("priority", "tinyint", "优先级(1-5)", false, false),
                cm("is_automated", "tinyint", "是否自动化", false, false),
            ],
        },
        TableMeta {
            table_name: "test_result".into(),
            table_comment: "测试结果表".into(),
            columns: vec![
                cm("id", "int", "结果ID", true, false),
                cm("test_case_id", "int", "用例ID", false, false),
                cm(
                    "status",
                    "varchar(16)",
                    "状态(pass/fail/skip)",
                    false,
                    false,
                ),
                cm("executed_at", "datetime", "执行时间", false, false),
                cm("duration_ms", "int", "耗时(毫秒)", false, false),
                cm("error_message", "text", "错误信息", false, true),
            ],
        },
        // demo-test / game_db_archive
        TableMeta {
            table_name: "archived_player".into(),
            table_comment: "归档玩家表".into(),
            columns: vec![
                cm("id", "int", "归档ID", true, false),
                cm("original_id", "int", "原始ID", false, false),
                cm("username", "varchar(32)", "用户名", false, false),
                cm("level", "int", "等级", false, false),
                cm("last_active", "datetime", "最后活跃", false, true),
                cm("archived_at", "datetime", "归档时间", false, false),
            ],
        },
        TableMeta {
            table_name: "archived_guild".into(),
            table_comment: "归档公会表".into(),
            columns: vec![
                cm("id", "int", "归档ID", true, false),
                cm("original_id", "int", "原始ID", false, false),
                cm("name", "varchar(32)", "公会名", false, false),
                cm("member_count", "int", "成员数", false, false),
                cm("disbanded_at", "datetime", "解散时间", false, false),
            ],
        },
        TableMeta {
            table_name: "archived_mail".into(),
            table_comment: "归档邮件表".into(),
            columns: vec![
                cm("id", "int", "归档ID", true, false),
                cm("original_id", "int", "原始ID", false, false),
                cm("title", "varchar(128)", "标题", false, false),
                cm("sender", "varchar(32)", "发送者", false, false),
                cm("expired_at", "datetime", "过期时间", false, false),
            ],
        },
        TableMeta {
            table_name: "archived_activity".into(),
            table_comment: "归档活动表".into(),
            columns: vec![
                cm("id", "int", "归档ID", true, false),
                cm("original_id", "int", "原始ID", false, false),
                cm("name", "varchar(64)", "活动名", false, false),
                cm("ended_at", "datetime", "结束时间", false, false),
                cm("participant_count", "int", "参与人数", false, false),
            ],
        },
        TableMeta {
            table_name: "archive_metadata".into(),
            table_comment: "归档元数据表".into(),
            columns: vec![
                cm("id", "int", "元数据ID", true, false),
                cm("source_table", "varchar(64)", "来源表", false, false),
                cm("row_count", "int", "行数", false, false),
                cm("archived_at", "datetime", "归档时间", false, false),
                cm("archive_reason", "text", "归档原因", false, true),
            ],
        },
    ] {
        map.insert(table.table_name.clone(), table);
    }
    map
}

/// Generate rows for new tables that don't exist in the base `demo_rows()`.
pub fn demo_rows_for_new_tables() -> HashMap<String, Vec<HashMap<String, String>>> {
    let mut out = HashMap::new();
    let config_keys = [
        "max_player_level",
        "daily_reset_hour",
        "pvp_season_length",
        "guild_max_level",
        "shop_refresh_interval",
        "exp_rate",
        "drop_rate_bonus",
        "stamina_regen_min",
    ];
    let config_cats = ["system", "combat", "social", "economy", "event"];
    let locales = ["en", "zh", "ja", "ko", "de", "fr"];
    let platforms = ["ios", "android", "windows", "mac"];
    let events = [
        "login",
        "logout",
        "purchase",
        "level_up",
        "quest_complete",
        "gacha_pull",
        "guild_join",
        "arena_battle",
        "stage_clear",
        "item_use",
    ];
    let modules = [
        "combat",
        "shop",
        "guild",
        "social",
        "quest",
        "system",
        "payment",
        "performance",
    ];

    // Helper: simple row builder
    let row = |cols: Vec<(&str, String)>| -> HashMap<String, String> {
        cols.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
    };

    // config_entry (50 rows)
    let entries: Vec<HashMap<String, String>> = (1..=50)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                ("config_key", config_keys[i % config_keys.len()].to_string()),
                ("config_value", ((i * 7) % 200).to_string()),
                ("category", config_cats[i % config_cats.len()].to_string()),
                (
                    "updated_at",
                    format!(
                        "2025-{:02}-{:02} {:02}:{:02}:00",
                        (i % 12) + 1,
                        (i % 28) + 1,
                        i % 24,
                        i % 60
                    ),
                ),
                (
                    "description",
                    format!("第{i}条全局配置项，控制游戏核心行为参数"),
                ),
            ])
        })
        .collect();
    out.insert("config_entry".into(), entries);

    // localization (200 rows)
    let entries: Vec<HashMap<String, String>> = (1..=200)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                ("locale", locales[i % locales.len()].to_string()),
                ("msg_key", format!("msg_key_{}", (i - 1) / 6 + 1)),
                (
                    "msg_value",
                    format!("[{}] 翻译文本 #{}", locales[i % locales.len()], i),
                ),
                ("is_rtl", "0".into()),
            ])
        })
        .collect();
    out.insert("localization".into(), entries);

    // version_info (30 rows)
    let entries: Vec<HashMap<String, String>> = (1..=30)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                ("version_code", format!("1.{}.{}", i / 6, i % 6)),
                ("platform", platforms[i % platforms.len()].to_string()),
                (
                    "release_notes",
                    format!("版本 1.{}.{} 更新说明", i / 6, i % 6),
                ),
                ("is_mandatory", if i % 5 == 0 { "1" } else { "0" }.into()),
                (
                    "released_at",
                    format!(
                        "2025-{:02}-{:02} {:02}:{:02}:00",
                        (i % 12) + 1,
                        (i % 28) + 1,
                        i % 24,
                        i % 60
                    ),
                ),
            ])
        })
        .collect();
    out.insert("version_info".into(), entries);

    // feature_flag (20 rows)
    let entries: Vec<HashMap<String, String>> = (1..=20)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                ("flag_key", format!("flag_{i:02}")),
                ("is_enabled", if i % 3 == 0 { "0" } else { "1" }.into()),
                (
                    "target_group",
                    if i % 4 == 0 {
                        "vip_only".into()
                    } else if i % 3 == 0 {
                        "beta_testers".into()
                    } else {
                        String::new()
                    },
                ),
                (
                    "description",
                    format!("功能开关 #{i}，控制新功能的灰度发布"),
                ),
            ])
        })
        .collect();
    out.insert("feature_flag".into(), entries);

    // staging_migration (40 rows)
    let entries: Vec<HashMap<String, String>> = (1..=40)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                ("migration_name", format!("V{:03}__migration_{i}.sql", i)),
                (
                    "applied_at",
                    format!(
                        "2025-{:02}-{:02} {:02}:{:02}:00",
                        (i % 12) + 1,
                        (i % 28) + 1,
                        i % 24,
                        i % 60
                    ),
                ),
                ("checksum", format!("sha256_{i:08}")),
                (
                    "status",
                    if i % 10 == 0 {
                        "1"
                    } else if i % 20 == 0 {
                        "2"
                    } else {
                        "0"
                    }
                    .into(),
                ),
            ])
        })
        .collect();
    out.insert("staging_migration".into(), entries);

    // staging_flag (25 rows)
    let entries: Vec<HashMap<String, String>> = (1..=25)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                ("flag_name", format!("staging_flag_{i:02}")),
                ("enabled", if i % 3 == 0 { "0" } else { "1" }.into()),
                ("description", format!("Staging环境测试开关 #{i}")),
                ("toggled_by", config_cats[i % config_cats.len()].to_string()),
            ])
        })
        .collect();
    out.insert("staging_flag".into(), entries);

    // staging_override (30 rows)
    let entries: Vec<HashMap<String, String>> = (1..=30)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                ("config_key", config_keys[i % config_keys.len()].to_string()),
                ("override_value", ((i * 13) % 200).to_string()),
                ("reason", format!("Staging配置覆盖原因 #{i}")),
                (
                    "created_at",
                    format!(
                        "2025-{:02}-{:02} {:02}:{:02}:00",
                        (i % 12) + 1,
                        (i % 28) + 1,
                        i % 24,
                        i % 60
                    ),
                ),
            ])
        })
        .collect();
    out.insert("staging_override".into(), entries);

    // event_log (300 rows)
    let entries: Vec<HashMap<String, String>> = (1..=300)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                ("event_name", events[i % events.len()].to_string()),
                ("user_id", ((i * 7) % 500 + 1).to_string()),
                (
                    "properties",
                    if i % 3 == 0 {
                        format!("{{\"source\":\"auto\",\"duration\":{}}}", i * 30)
                    } else {
                        String::new()
                    },
                ),
                (
                    "occurred_at",
                    format!(
                        "2025-{:02}-{:02} {:02}:{:02}:00",
                        (i % 12) + 1,
                        (i % 28) + 1,
                        i % 24,
                        i % 60
                    ),
                ),
                ("platform", platforms[i % platforms.len()].to_string()),
            ])
        })
        .collect();
    out.insert("event_log".into(), entries);

    // daily_active_user (60 rows)
    let entries: Vec<HashMap<String, String>> = (1..=60)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                (
                    "stat_date",
                    format!(
                        "2025-{:02}-{:02} 00:00:00",
                        (i - 1) % 12 + 1,
                        (i * 3 - 1) % 28 + 1
                    ),
                ),
                ("dau_count", (5000 + i * 50).to_string()),
                ("new_users", (50 + i * 3).to_string()),
                ("returning_users", (1000 + i * 20).to_string()),
                ("platform", platforms[i % platforms.len()].to_string()),
            ])
        })
        .collect();
    out.insert("daily_active_user".into(), entries);

    // revenue_report (60 rows)
    let entries: Vec<HashMap<String, String>> = (1..=60)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                (
                    "report_date",
                    format!(
                        "2025-{:02}-{:02} 00:00:00",
                        (i - 1) % 12 + 1,
                        (i * 3 - 1) % 28 + 1
                    ),
                ),
                ("total_revenue", format!("{:.2}", 5000.0 + i as f64 * 100.0)),
                ("currency", ["CNY", "USD", "JPY", "KRW"][i % 4].to_string()),
                ("transaction_count", (100 + i * 5).to_string()),
                (
                    "top_item_id",
                    if i % 3 == 0 {
                        ((i - 1) % 20 + 1).to_string()
                    } else {
                        String::new()
                    },
                ),
            ])
        })
        .collect();
    out.insert("revenue_report".into(), entries);

    // retention_cohort (80 rows)
    let entries: Vec<HashMap<String, String>> = (1..=80)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                (
                    "cohort_date",
                    format!("2025-{:02}-01 00:00:00", (i - 1) % 12 + 1),
                ),
                ("day_offset", ((i - 1) % 30 + 1).to_string()),
                ("retained_count", (500 - i * 5).max(10).to_string()),
                ("cohort_size", "1000".into()),
                (
                    "retention_rate",
                    format!("{:.4}", (500 - i * 5).max(10) as f64 / 1000.0),
                ),
            ])
        })
        .collect();
    out.insert("retention_cohort".into(), entries);

    // ab_test_config (20 rows)
    let entries: Vec<HashMap<String, String>> = (1..=20)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                ("experiment_name", format!("experiment_{i:02}")),
                (
                    "variant",
                    ["control", "variant_a", "variant_b", "variant_c"][i % 4].to_string(),
                ),
                ("traffic_pct", [10, 20, 25, 50][i % 4].to_string()),
                ("is_active", if i <= 15 { "1" } else { "0" }.into()),
                ("description", format!("A/B测试 #{i}")),
            ])
        })
        .collect();
    out.insert("ab_test_config".into(), entries);

    // test_case (60 rows)
    let entries: Vec<HashMap<String, String>> = (1..=60)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                (
                    "case_name",
                    format!("TC_{i:03}_{}", modules[i % modules.len()]),
                ),
                ("module", modules[i % modules.len()].to_string()),
                ("expected_result", format!("期望结果 #{i}")),
                ("priority", ((i - 1) % 5 + 1).to_string()),
                ("is_automated", if i % 3 == 0 { "0" } else { "1" }.into()),
            ])
        })
        .collect();
    out.insert("test_case".into(), entries);

    // test_result (100 rows)
    let entries: Vec<HashMap<String, String>> = (1..=100)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                ("test_case_id", ((i - 1) % 60 + 1).to_string()),
                (
                    "status",
                    ["pass", "pass", "pass", "fail", "skip"][i % 5].to_string(),
                ),
                (
                    "executed_at",
                    format!(
                        "2025-{:02}-{:02} {:02}:{:02}:00",
                        (i % 12) + 1,
                        (i % 28) + 1,
                        i % 24,
                        i % 60
                    ),
                ),
                ("duration_ms", (100 + i * 10).to_string()),
                (
                    "error_message",
                    if i % 5 == 3 {
                        format!("AssertionError: expected 200 but got 500 at step {i}")
                    } else {
                        String::new()
                    },
                ),
            ])
        })
        .collect();
    out.insert("test_result".into(), entries);

    // archived_player (100 rows)
    let entries: Vec<HashMap<String, String>> = (1..=100)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                ("original_id", (i + 10000).to_string()),
                ("username", format!("archived_user_{i:04}")),
                ("level", ((i % 100) + 1).to_string()),
                (
                    "last_active",
                    format!(
                        "2023-{:02}-{:02} {:02}:{:02}:00",
                        (i % 12) + 1,
                        (i % 28) + 1,
                        i % 24,
                        i % 60
                    ),
                ),
                (
                    "archived_at",
                    format!(
                        "2024-{:02}-{:02} {:02}:{:02}:00",
                        (i % 12) + 1,
                        (i % 28) + 1,
                        i % 24,
                        i % 60
                    ),
                ),
            ])
        })
        .collect();
    out.insert("archived_player".into(), entries);

    // archived_guild (30 rows)
    let guild_prefixes = ["旧龙之谷", "消散暗影", "落幕圣光", "残风", "尘封大地"];
    let entries: Vec<HashMap<String, String>> = (1..=30)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                ("original_id", (i + 500).to_string()),
                (
                    "name",
                    format!(
                        "{}{}",
                        guild_prefixes[i % guild_prefixes.len()],
                        if i > 5 { i.to_string() } else { String::new() }
                    ),
                ),
                ("member_count", (3 + i * 2).min(50).to_string()),
                (
                    "disbanded_at",
                    format!(
                        "2024-{:02}-{:02} {:02}:{:02}:00",
                        (i % 12) + 1,
                        (i % 28) + 1,
                        i % 24,
                        i % 60
                    ),
                ),
            ])
        })
        .collect();
    out.insert("archived_guild".into(), entries);

    // archived_mail (50 rows)
    let mail_titles = [
        "过期活动奖励",
        "节日祝福(历史)",
        "旧版本补偿",
        "已结束赛事奖励",
        "归档系统通知",
    ];
    let senders = ["系统", "运营", "客服", "活动中心"];
    let entries: Vec<HashMap<String, String>> = (1..=50)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                ("original_id", (i + 8000).to_string()),
                ("title", mail_titles[i % mail_titles.len()].to_string()),
                ("sender", senders[i % senders.len()].to_string()),
                (
                    "expired_at",
                    format!(
                        "2024-{:02}-{:02} {:02}:{:02}:00",
                        (i % 12) + 1,
                        (i % 28) + 1,
                        i % 24,
                        i % 60
                    ),
                ),
            ])
        })
        .collect();
    out.insert("archived_mail".into(), entries);

    // archived_activity (40 rows)
    let act_names = [
        "往期七日签到",
        "旧限定抽卡",
        "历史深渊副本",
        "过期消费返利",
        "往期节日狂欢",
        "旧新手冲刺",
    ];
    let entries: Vec<HashMap<String, String>> = (1..=40)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                ("original_id", (i + 3000).to_string()),
                ("name", act_names[i % act_names.len()].to_string()),
                (
                    "ended_at",
                    format!(
                        "2024-{:02}-{:02} {:02}:{:02}:00",
                        (i % 12) + 1,
                        (i % 28) + 1,
                        i % 24,
                        i % 60
                    ),
                ),
                ("participant_count", (500 + i * 100).to_string()),
            ])
        })
        .collect();
    out.insert("archived_activity".into(), entries);

    // archive_metadata (20 rows)
    let sources = ["player", "guild", "mail", "activity", "log"];
    let reasons = [
        "数据过期清理",
        "用户注销归档",
        "活动结束归档",
        "定期数据归档",
        "合规要求归档",
    ];
    let entries: Vec<HashMap<String, String>> = (1..=20)
        .map(|i| {
            row(vec![
                ("id", i.to_string()),
                ("source_table", sources[i % sources.len()].to_string()),
                ("row_count", (1000 + i * 2500).to_string()),
                (
                    "archived_at",
                    format!(
                        "2024-{:02}-{:02} {:02}:{:02}:00",
                        (i % 12) + 1,
                        (i % 28) + 1,
                        i % 24,
                        i % 60
                    ),
                ),
                ("archive_reason", reasons[i % reasons.len()].to_string()),
            ])
        })
        .collect();
    out.insert("archive_metadata".into(), entries);

    out
}

pub fn resolve_demo_table(table_name: &str, schema: &[TableMeta]) -> Result<TableMeta, String> {
    schema
        .iter()
        .find(|table| table.table_name.eq_ignore_ascii_case(table_name.trim()))
        .cloned()
        .ok_or_else(|| format!("表不存在: {table_name}"))
}

pub(crate) fn apply_demo_request(
    mut rows: Vec<HashMap<String, String>>,
    columns: &[ColumnMeta],
    request: &TablePageRequest,
) -> Vec<HashMap<String, String>> {
    rows.retain(|row| row_matches_filter(row, columns, request.filter.as_ref()));

    if let Some(sort) = request.sort.as_ref() {
        let column = sort.column_name.trim();
        if !column.is_empty() {
            rows.sort_by(|left, right| {
                let a = left.get(column).cloned().unwrap_or_default();
                let b = right.get(column).cloned().unwrap_or_default();
                let cmp = compare_sort_values(&a, &b);
                if sort.descending {
                    cmp.reverse()
                } else {
                    cmp
                }
            });
        }
    }
    rows
}

pub fn read_demo_search_scan_page(
    rows: Vec<HashMap<String, String>>,
    table: &TableMeta,
    offset: u64,
    limit: u32,
    sort: Option<&TablePageSort>,
) -> Vec<HashMap<String, String>> {
    let rows = apply_demo_request(
        rows,
        &table.columns,
        &TablePageRequest {
            sort: sort.cloned(),
            ..Default::default()
        },
    );
    let start = usize::try_from(offset)
        .unwrap_or(usize::MAX)
        .min(rows.len());
    let end = start
        .saturating_add(limit.clamp(1, 512) as usize)
        .min(rows.len());
    rows[start..end].to_vec()
}

pub(crate) fn row_matches_filter(
    row: &HashMap<String, String>,
    columns: &[ColumnMeta],
    filter: Option<&TablePageFilter>,
) -> bool {
    let Some(filter) = filter else {
        return true;
    };
    let raw_query = filter.query.trim();
    if raw_query.is_empty() {
        return true;
    }
    let query = raw_query.to_lowercase();
    let exact = filter
        .mode
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("exact"));
    let continuous = filter
        .mode
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("continuous"));
    let requested = filter
        .columns
        .iter()
        .map(|value| value.to_lowercase())
        .collect::<Vec<_>>();
    columns.iter().any(|column| {
        (requested.is_empty() || requested.contains(&column.column_name.to_lowercase()))
            && row.get(&column.column_name).is_some_and(|value| {
                if exact {
                    value == raw_query
                } else {
                    let haystack = value.to_lowercase();
                    haystack.contains(&query)
                        || (!continuous && subsequence_match(&haystack, &query))
                }
            })
    })
}

/// Compare two raw cell strings for sorting, preferring numeric ordering when
/// both values parse as finite numbers so that "10" sorts after "9" instead of
/// before it lexicographically (#7). Falls back to string comparison.
fn compare_sort_values(a: &str, b: &str) -> std::cmp::Ordering {
    match (a.parse::<f64>(), b.parse::<f64>()) {
        (Ok(num_a), Ok(num_b)) if num_a.is_finite() && num_b.is_finite() => num_a
            .partial_cmp(&num_b)
            .unwrap_or(std::cmp::Ordering::Equal),
        _ => a.cmp(b),
    }
}

#[allow(dead_code)]
pub fn search_demo_values(
    schema: &[TableMeta],
    rows: &HashMap<String, Vec<HashMap<String, String>>>,
    query: &str,
    limit: usize,
) -> Vec<SearchValueItem> {
    search_demo_values_with_priority(schema, rows, query, limit, &[])
}

#[allow(dead_code)]
pub fn search_demo_values_with_priority(
    schema: &[TableMeta],
    rows: &HashMap<String, Vec<HashMap<String, String>>>,
    query: &str,
    limit: usize,
    priority_tables: &[String],
) -> Vec<SearchValueItem> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() || limit == 0 {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut ordered_schema = schema.iter().collect::<Vec<_>>();
    if !priority_tables.is_empty() {
        let priority = priority_tables
            .iter()
            .map(|name| name.trim().to_lowercase())
            .filter(|name| !name.is_empty())
            .collect::<Vec<_>>();
        ordered_schema.sort_by_key(|table| {
            priority
                .iter()
                .position(|name| name == &table.table_name.to_lowercase())
                .unwrap_or(usize::MAX)
        });
    }
    for table in ordered_schema {
        let Some(table_rows) = rows.get(&table.table_name) else {
            continue;
        };
        for column in &table.columns {
            let mut found = None;
            for row in table_rows {
                let value = row.get(&column.column_name).cloned().unwrap_or_default();
                if value.to_lowercase().contains(&needle) {
                    found = Some(SearchValueItem {
                        table_name: table.table_name.clone(),
                        table_comment: table.table_comment.clone(),
                        column_name: column.column_name.clone(),
                        preview_value: value_search_preview(&value, &needle, 80),
                        row_identity: None,
                    });
                    break;
                }
            }
            if let Some(item) = found {
                out.push(item);
                if out.len() >= limit {
                    break;
                }
            }
        }
        if out.len() >= limit {
            break;
        }
    }
    out
}

pub fn search_single_demo_table(
    table: &TableMeta,
    rows: &[HashMap<String, String>],
    query: &str,
    limit: usize,
) -> Vec<SearchValueItem> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() || limit == 0 {
        return Vec::new();
    }

    let mut out = Vec::new();
    for column in &table.columns {
        let mut found = None;
        for row in rows {
            let value = row.get(&column.column_name).cloned().unwrap_or_default();
            if value.to_lowercase().contains(&needle) {
                found = Some(SearchValueItem {
                    table_name: table.table_name.clone(),
                    table_comment: table.table_comment.clone(),
                    column_name: column.column_name.clone(),
                    preview_value: value_search_preview(&value, &needle, 80),
                    row_identity: None,
                });
                break;
            }
        }
        if let Some(item) = found {
            out.push(item);
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

fn subsequence_match(value: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let mut haystack = value.chars();
    for needle_char in needle.chars() {
        if !haystack.any(|candidate| candidate == needle_char) {
            return false;
        }
    }
    true
}

fn read_demo_page_from_rows(
    rows: Vec<HashMap<String, String>>,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
) -> TableSessionPage {
    let (page, page_size) = normalize_page_request(request);
    let offset = normalize_page_offset(request, page, page_size);
    let rows = apply_demo_request(rows, &table.columns, request);
    let start = usize::try_from(offset)
        .unwrap_or(usize::MAX)
        .min(rows.len());
    let end = (start + page_size as usize).min(rows.len());
    let page_rows = if start < rows.len() {
        rows[start..end].to_vec()
    } else {
        Vec::new()
    };

    let (total_rows, total_rows_exact, has_more) =
        crate::db::count_metadata_without_total(page_rows.len(), page_size, offset);
    let null_cells = page_rows
        .iter()
        .map(|row| {
            table
                .columns
                .iter()
                .filter(|column| !row.contains_key(&column.column_name))
                .map(|column| column.column_name.clone())
                .collect()
        })
        .collect();
    TableSessionPage {
        session_id: session_id.into(),
        table_name: table.table_name.clone(),
        table_comment: table.table_comment.clone(),
        columns: table.columns.clone(),
        primary_keys: primary_keys(table),
        rows: page_rows,
        null_cells,
        total_rows,
        total_rows_exact,
        has_more,
        page,
        page_size,
    }
}

pub fn read_demo_page(
    demo_rows: &HashMap<String, Vec<HashMap<String, String>>>,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
) -> TableSessionPage {
    read_demo_page_from_rows(
        demo_rows
            .get(&table.table_name)
            .cloned()
            .unwrap_or_default(),
        table,
        session_id,
        request,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_demo_page_filters_sorts_and_pages_rows() {
        let schema = demo_schema();
        let table = schema
            .iter()
            .find(|table| table.table_name == "player")
            .expect("demo table exists");
        let request = TablePageRequest {
            page: Some(1),
            page_size: Some(1),
            offset: None,
            include_total: None,
            filter: Some(TablePageFilter {
                query: "user_0001".into(),
                columns: vec!["username".into()],
                mode: None,
            }),
            sort: Some(TablePageSort {
                column_name: "level".into(),
                descending: true,
            }),
        };

        let page = read_demo_page(&demo_rows(), table, "session-1", &request);

        assert_eq!(page.total_rows, 1);
        assert!(page.rows[0]
            .get("username")
            .map(String::as_str)
            .unwrap_or("")
            .contains("user_0001"));
        assert_eq!(page.primary_keys, vec!["id"]);
    }

    #[test]
    fn demo_includes_ui_edge_case_values() {
        let schema = demo_schema();
        let table = schema
            .iter()
            .find(|table| table.table_name == "ui_edge_case_values")
            .expect("edge table exists");
        let page = read_demo_page(
            &demo_rows(),
            table,
            "session-edge",
            &TablePageRequest::default(),
        );

        assert_eq!(page.primary_keys, vec!["id"]);
        assert!(page.table_comment.contains("UI边界测试表"));
        assert!(page.rows[0]
            .get("json_value")
            .map(String::as_str)
            .unwrap_or("")
            .contains("\"tags\""));
        assert!(page.rows[0]
            .get("ts_function")
            .map(String::as_str)
            .unwrap_or("")
            .contains("calculateReward"));
        assert!(page.rows[0]
            .get("long_remark")
            .map(String::as_str)
            .unwrap_or("")
            .contains("超长备注"));
    }

    #[test]
    fn stress_demo_databases_match_requested_scale() {
        let databases = stress_databases("demo-stress");

        assert_eq!(databases.len(), 12);
        assert_eq!(databases.first().map(String::as_str), Some("game_db_01"));
        assert_eq!(databases.last().map(String::as_str), Some("game_db_12"));
    }

    #[test]
    fn stress_schema_has_800_tables_with_large_and_wide_tables() {
        let schema = stress_schema_for("game_db_01");
        let first_table = schema.first().expect("stress schema has a first table");
        let mut names = schema
            .iter()
            .map(|table| table.table_name.as_str())
            .collect::<Vec<_>>();
        names.sort_unstable();

        assert_eq!(schema.len(), 800);
        assert_eq!(first_table.table_name, "db01_0000_large_table_5000");
        assert_eq!(
            names.first().copied(),
            Some(first_table.table_name.as_str())
        );
        assert_eq!(
            stress_total_rows(&first_table.table_name),
            STRESS_LARGE_TABLE_ROWS,
        );
        assert!(schema
            .iter()
            .any(|table| stress_total_rows(&table.table_name) >= 5000));
        assert!(schema.iter().any(|table| table.columns.len() >= 30));
        assert!(schema
            .iter()
            .all(|table| table.table_name.starts_with("db01_")));
    }

    #[test]
    fn stress_page_generation_returns_only_requested_page_and_is_deterministic() {
        let schema = stress_schema_for("game_db_01");
        let table = schema
            .iter()
            .find(|table| table.table_name.ends_with("_0020"))
            .expect("stress table 20 exists");
        let request = TablePageRequest {
            page: Some(2),
            page_size: Some(25),
            offset: None,
            include_total: None,
            filter: None,
            sort: None,
        };

        let first = read_stress_demo_page(table, "stress-session", &request);
        let second = read_stress_demo_page(table, "stress-session", &request);

        assert_eq!(first.total_rows, 50);
        assert!(!first.total_rows_exact);
        assert_eq!(
            count_stress_or_materialized_rows(None, table, &request),
            5000,
        );
        assert_eq!(first.rows.len(), 25);
        assert_eq!(first.rows, second.rows);
        assert_eq!(first.rows[0].get("id").map(String::as_str), Some("26"));
    }

    #[test]
    fn demo_game_variants_append_profile_tables_after_the_shared_schema() {
        let core = demo_schema_for("demo", "game_db")
            .into_iter()
            .map(|table| table.table_name)
            .collect::<Vec<_>>();
        let staging = demo_schema_for("demo-staging", "game_db")
            .into_iter()
            .map(|table| table.table_name)
            .collect::<Vec<_>>();
        let test = demo_schema_for("demo-test", "game_db")
            .into_iter()
            .map(|table| table.table_name)
            .collect::<Vec<_>>();

        assert_eq!(&staging[..core.len()], core);
        assert_eq!(&test[..core.len()], core);
        assert_eq!(
            &staging[core.len()..],
            ["staging_migration", "staging_flag", "staging_override"]
        );
        assert_eq!(&test[core.len()..], ["test_case", "test_result"]);
    }

    #[test]
    fn search_demo_values_returns_one_preview_per_table() {
        let schema = demo_schema_for("demo", "game_db");
        let rows = demo_rows();

        let results = search_demo_values(&schema, &rows, "冒险者", 50);

        assert!(results.iter().any(|item| item.table_name == "player"));
        assert!(results.iter().all(|item| !item.preview_value.is_empty()));
        assert!(results.iter().all(|item| !item.column_name.is_empty()));
    }

    #[test]
    fn search_demo_values_requires_a_contiguous_match() {
        let schema = vec![TableMeta {
            table_name: "hero".into(),
            table_comment: String::new(),
            columns: vec![ColumnMeta::with_basic(
                "name",
                "varchar(64)",
                "",
                false,
                false,
            )],
        }];
        let rows = HashMap::from([(
            "hero".into(),
            vec![HashMap::from([("name".into(), "2,10,20".into())])],
        )]);

        let results = search_demo_values(&schema, &rows, "21020", 50);

        assert!(results.is_empty());
    }

    #[test]
    fn search_single_demo_table_matches_contiguous_text_case_insensitively() {
        let table = TableMeta {
            table_name: "hero".into(),
            table_comment: String::new(),
            columns: vec![ColumnMeta::with_basic(
                "name",
                "varchar(64)",
                "",
                false,
                false,
            )],
        };
        let rows = vec![HashMap::from([(
            "name".into(),
            "prefixAbC21020suffix".into(),
        )])];

        let results = search_single_demo_table(&table, &rows, "ABC21020", 50);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].preview_value, "prefixAbC21020suffix");
    }

    #[test]
    fn search_single_demo_table_rejects_subsequence_only_match() {
        let table = TableMeta {
            table_name: "hero".into(),
            table_comment: String::new(),
            columns: vec![ColumnMeta::with_basic(
                "name",
                "varchar(64)",
                "",
                false,
                false,
            )],
        };
        let rows = vec![HashMap::from([("name".into(), "2,10,20".into())])];

        let results = search_single_demo_table(&table, &rows, "21020", 50);

        assert!(results.is_empty());
    }

    #[test]
    fn demo_filtered_pages_match_value_search_subsequence_hits() {
        let table = TableMeta {
            table_name: "hero".into(),
            table_comment: String::new(),
            columns: vec![ColumnMeta::with_basic(
                "name",
                "varchar(64)",
                "",
                false,
                false,
            )],
        };
        let rows = vec![HashMap::from([("name".into(), "HeroProp".into())])];
        let request = TablePageRequest {
            page: Some(1),
            page_size: Some(10),
            offset: None,
            include_total: Some(true),
            filter: Some(TablePageFilter {
                query: "hrp".into(),
                columns: vec![],
                mode: None,
            }),
            sort: None,
        };

        let filtered = apply_demo_request(rows, &table.columns, &request);

        assert_eq!(filtered.len(), 1);
        assert_eq!(
            filtered[0].get("name").map(String::as_str),
            Some("HeroProp")
        );
    }

    #[test]
    fn demo_continuous_filter_rejects_subsequence_only_hits() {
        let table = TableMeta {
            table_name: "hero".into(),
            table_comment: String::new(),
            columns: vec![ColumnMeta::with_basic(
                "name",
                "varchar(64)",
                "",
                false,
                false,
            )],
        };
        let rows = vec![
            HashMap::from([("name".into(), "HeroProp".into())]),
            HashMap::from([("name".into(), "HRP Pack".into())]),
        ];
        let request = TablePageRequest {
            page: Some(1),
            page_size: Some(10),
            offset: None,
            include_total: Some(true),
            filter: Some(TablePageFilter {
                query: "hrp".into(),
                columns: vec![],
                mode: Some("continuous".into()),
            }),
            sort: None,
        };

        let filtered = apply_demo_request(rows, &table.columns, &request);

        assert_eq!(filtered.len(), 1);
        assert_eq!(
            filtered[0].get("name").map(String::as_str),
            Some("HRP Pack")
        );
    }

    #[test]
    fn search_demo_values_returns_multiple_matching_columns_per_table() {
        let schema = vec![TableMeta {
            table_name: "hero".into(),
            table_comment: String::new(),
            columns: vec![
                ColumnMeta::with_basic("name", "varchar(64)", "", false, false),
                ColumnMeta::with_basic("element", "varchar(64)", "", false, false),
                ColumnMeta::with_basic("description", "text", "", false, true),
            ],
        }];
        let rows = HashMap::from([(
            "hero".into(),
            vec![HashMap::from([
                ("name".into(), "寒冰英雄".into()),
                ("element".into(), "冰".into()),
                ("description".into(), "冰霜说明".into()),
            ])],
        )]);

        let results = search_demo_values(&schema, &rows, "冰", 50);
        let columns = results
            .iter()
            .map(|item| item.column_name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(columns, vec!["name", "element", "description"]);
    }

    #[test]
    fn search_demo_values_scans_priority_tables_before_limit() {
        let schema = vec![
            TableMeta {
                table_name: "first".into(),
                table_comment: String::new(),
                columns: vec![ColumnMeta::with_basic(
                    "name",
                    "varchar(64)",
                    "",
                    false,
                    false,
                )],
            },
            TableMeta {
                table_name: "hero".into(),
                table_comment: String::new(),
                columns: vec![ColumnMeta::with_basic(
                    "name",
                    "varchar(64)",
                    "",
                    false,
                    false,
                )],
            },
        ];
        let rows = HashMap::from([
            (
                "first".into(),
                vec![HashMap::from([("name".into(), "普通冰值".into())])],
            ),
            (
                "hero".into(),
                vec![HashMap::from([("name".into(), "优先冰值".into())])],
            ),
        ]);

        let results = search_demo_values_with_priority(&schema, &rows, "冰", 1, &["hero".into()]);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].table_name, "hero");
        assert_eq!(results[0].preview_value, "优先冰值");
    }

    #[test]
    fn compare_sort_values_uses_numeric_ordering_for_numbers() {
        // Numbers sort by magnitude, not lexicographically (#7).
        assert_eq!(compare_sort_values("9", "10"), std::cmp::Ordering::Less);
        assert_eq!(compare_sort_values("10", "9"), std::cmp::Ordering::Greater);
        assert_eq!(compare_sort_values("2", "2"), std::cmp::Ordering::Equal);

        // Non-numeric values fall back to string comparison.
        assert_eq!(
            compare_sort_values("apple", "banana"),
            std::cmp::Ordering::Less
        );
        // Mixed numeric/non-numeric falls back to string compare.
        assert_eq!(compare_sort_values("10", "apple"), std::cmp::Ordering::Less);
    }

    #[test]
    fn demo_sort_orders_numeric_column_by_value() {
        let table = TableMeta {
            table_name: "nums".into(),
            table_comment: String::new(),
            columns: vec![ColumnMeta::with_basic("level", "int", "", false, false)],
        };
        let rows: HashMap<String, Vec<HashMap<String, String>>> = HashMap::from([(
            "nums".into(),
            vec![
                HashMap::from([("level".into(), "9".into())]),
                HashMap::from([("level".into(), "10".into())]),
                HashMap::from([("level".into(), "100".into())]),
            ],
        )]);
        let request = TablePageRequest {
            sort: Some(TablePageSort {
                column_name: "level".into(),
                descending: false,
            }),
            ..Default::default()
        };

        let page = read_demo_page(&rows, &table, "session-num", &request);

        let levels: Vec<&str> = page
            .rows
            .iter()
            .map(|r| r.get("level").map(String::as_str).unwrap_or(""))
            .collect();
        assert_eq!(levels, vec!["9", "10", "100"]);
    }

    #[test]
    fn demo_search_scan_preserves_sort_and_uses_an_absolute_slice() {
        let table = TableMeta {
            table_name: "nums".into(),
            table_comment: String::new(),
            columns: vec![
                ColumnMeta::with_basic("id", "int", "", true, false),
                ColumnMeta::with_basic("level", "int", "", false, false),
            ],
        };
        let rows = vec![
            HashMap::from([("id".into(), "1".into()), ("level".into(), "9".into())]),
            HashMap::from([("id".into(), "2".into()), ("level".into(), "100".into())]),
            HashMap::from([("id".into(), "3".into()), ("level".into(), "10".into())]),
        ];
        let sort = TablePageSort {
            column_name: "level".into(),
            descending: false,
        };

        let page = read_demo_search_scan_page(rows, &table, 1, 1, Some(&sort));

        assert_eq!(page.len(), 1);
        assert_eq!(page[0].get("level").map(String::as_str), Some("10"));
    }

    #[test]
    fn stress_search_scan_generates_a_small_default_order_slice_lazily() {
        let table = stress_schema_for("game_db_01")
            .into_iter()
            .next()
            .expect("stress table exists");

        let rows = read_stress_search_scan_page(None, &table, 2, 2, None);

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get("id").map(String::as_str), Some("3"));
        assert_eq!(rows[1].get("id").map(String::as_str), Some("4"));
    }
}
