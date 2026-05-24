use std::collections::HashMap;

use crate::db::{normalize_page_request, primary_keys};
use crate::types::*;

pub fn demo_schema() -> Vec<TableMeta> {
    fn cm(name: &str, typ: &str, comment: &str, pk: bool, nullable: bool) -> ColumnMeta {
        ColumnMeta { column_name: name.into(), column_type: typ.into(), column_comment: comment.into(), is_primary_key: pk, is_nullable: nullable }
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
    ]
}

pub fn demo_rows() -> HashMap<String, Vec<HashMap<String, String>>> {
    let mut out = HashMap::new();
    let elements = ["火", "水", "风", "雷", "光", "暗"];
    let qualities = ["普通", "精良", "稀有", "史诗", "传说"];
    let names_prefix = ["暗影", "圣光", "风暴", "烈焰", "寒冰", "雷霆", "龙魂", "星辰", "月华", "天命", "苍穹", "破晓"];
    let names_suffix = ["之剑", "使者", "守护", "猎人", "法师", "战士", "游侠", "祭司", "刺客", "骑士"];
    let adjectives = ["古老的", "神秘的", "闪耀的", "坚固的", "锋利的", "华美的", "朴素的", "传说中的", "被诅咒的", "祝福的"];
    let nouns = ["长剑", "法杖", "盾牌", "战靴", "头盔", "护甲", "项链", "戒指", "弓箭", "匕首"];
    let quests = ["击败", "收集", "护送", "探索", "消灭", "寻找", "修复", "守护", "调查", "夺回"];
    let targets = ["哥布林", "巨龙", "暗影骑士", "精灵守卫", "亡灵法师", "石像鬼", "森林巨魔", "海妖", "凤凰", "恶魔领主"];
    let areas = ["幽暗森林", "龙骨荒野", "水晶洞穴", "天空之城", "地下迷宫", "火山口", "冰封湖", "古战场", "精灵遗迹", "恶魔之门"];

    let tables = demo_schema();
    for table in &tables {
        let count = match table.table_name.as_str() {
            "player" => 2000,
            "hero" | "item" | "equip" | "skill" | "monster" | "drop_table" => 500,
            "quest" | "stage" => 800,
            "shop" => 300,
            "mail" | "activity" | "achievement" => 400,
            "guild" | "buff" => 600,
            _ => 1000,
        };
        let mut rows = Vec::with_capacity(count);
        for i in 1..=count {
            let mut r = HashMap::new();
            for col in &table.columns {
                let v = if col.is_primary_key {
                    i.to_string()
                } else {
                    match col.column_type.as_str() {
                        "int" | "bigint" | "tinyint" => match col.column_name.as_str() {
                            "level" | "required_level" | "recommended_level" | "unlock_level" | "required_vip" | "min_join_level" => ((i % 80) + 1).to_string(),
                            "hp" | "hp_base" | "hp_bonus" => ((i % 100) * 100 + 500).to_string(),
                            "atk" | "atk_base" | "atk_bonus" => ((i % 50) * 10 + 30).to_string(),
                            "def" | "def_base" | "def_bonus" => ((i % 40) * 8 + 20).to_string(),
                            "spd" | "spd_base" => ((i % 30) * 3 + 80).to_string(),
                            "exp" => (i as u64 * 1000 + 50000).to_string(),
                            "gold" => (i as u64 * 500 + 10000).to_string(),
                            "diamond" => (i % 1000).to_string(),
                            "vip_level" | "rarity" | "quality" | "max_stack" => ((i % 5) + 1).to_string(),
                            "type" | "category" | "target_type" | "effect_type" | "value_type" => ((i % 4) + 1).to_string(),
                            "cooldown" | "mp_cost" | "stamina_cost" => (i % 30 + 5).to_string(),
                            "damage_rate" | "weight" | "points" => (i % 200 + 10).to_string(),
                            "sell_price" | "price" | "original_price" => (i * 10 + 50).to_string(),
                            "stack_max" | "max_level" | "enchant_max" => ((i % 10) + 1).to_string(),
                            "reward_exp" | "reward_gold" => (i * 50 + 100).to_string(),
                            "reward_item_count" | "reward_diamond" | "reward_count" => ((i % 10) + 1).to_string(),
                            "expire_days" | "expire_hours" => (i % 90 + 1).to_string(),
                            "chapter" | "difficulty" | "sort_order" => ((i % 12) + 1).to_string(),
                            "daily_limit" | "total_limit" | "stock_limit" => ((i % 5) * 3).to_string(),
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
                        "varchar(16)" | "varchar(32)" | "varchar(64)" | "varchar(128)" | "varchar(256)" => {
                            match col.column_name.as_str() {
                                "element" => elements[i % elements.len()].to_string(),
                                "username" => format!("user_{i:04}"),
                                "nickname" => format!("冒险者{i}"),
                                "name" | "title" => match table.table_name.as_str() {
                                    "hero" => format!("{}{}{}",
                                        names_prefix[i % names_prefix.len()],
                                        names_suffix[i % names_suffix.len()],
                                        if i > 250 { "·改" } else { "" }),
                                    "equip" => format!("{}{}", adjectives[i % adjectives.len()], nouns[i % nouns.len()]),
                                    "quest" => format!("{}{}{}", quests[i % quests.len()], targets[i % targets.len()], if i > 400 { "·续" } else { "" }),
                                    "stage" => format!("{}·{}", areas[i % areas.len()], ["普通", "困难", "地狱"][i % 3]),
                                    "monster" => format!("{}{}", adjectives[i % adjectives.len()], targets[i % targets.len()]),
                                    "shop" => format!("{}礼包{}", qualities[i % qualities.len()], i),
                                    "buff" => format!("{}之力{}", elements[i % elements.len()], if i % 2 == 0 { "·强化" } else { "" }),
                                    _ => format!("{}_{i}", table.table_name),
                                },
                                "sender" => ["系统", "运营团队", "公会管理", "客服"][i % 4].to_string(),
                                "quality" => qualities[i % qualities.len()].to_string(),
                                "icon" => format!("icon_{}/{}", table.table_name, i % 50),
                                "star_condition" => format!("回合数≤{} 且 无阵亡", (i % 10) + 3),
                                "source" => ["副本掉落", "商店购买", "活动奖励", "合成获得", "成就解锁"][i % 5].to_string(),
                                "condition_type" => ["kill_monster", "collect_item", "reach_level", "clear_stage", "join_guild"][i % 5].to_string(),
                                "trigger_event" => ["level_up", "login", "first_recharge", "guild_join", "achievement_complete"][i % 5].to_string(),
                                "description" | "content" | "reward_pool" | "notice" => col.column_type.len().to_string(),
                                _ => format!("{}_val_{i}", col.column_name),
                            }
                        }
                        "text" => match col.column_name.as_str() {
                            "description" => format!("这是{}的描述文本，包含了详细的功能说明和背景故事。编号：{}", table.table_name, i),
                            "content" => format!("尊敬的玩家，感谢您参与活动，以下是您的奖励详情。编号：{}", i),
                            "reward_pool" => format!("[{{\"itemId\":{},\"weight\":{}}},{{\"itemId\":{},\"weight\":{}}}]", i % 100 + 1, (i % 50) + 10, i % 100 + 101, (i % 30) + 5),
                            _ => format!("text_{i}"),
                        },
                        "datetime" => format!("2025-{:02}-{:02} {:02}:{:02}:00", (i % 12) + 1, (i % 28) + 1, (i % 24), (i % 60)),
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
    if let Some(filter) = request.filter.as_ref() {
        let query = filter.query.trim().to_lowercase();
        if !query.is_empty() {
            let requested = filter
                .columns
                .iter()
                .map(|value| value.to_lowercase())
                .collect::<Vec<_>>();
            rows.retain(|row| {
                columns.iter().any(|column| {
                    (requested.is_empty() || requested.contains(&column.column_name.to_lowercase()))
                        && row
                            .get(&column.column_name)
                            .map(|value| value.to_lowercase().contains(&query))
                            .unwrap_or(false)
                })
            });
        }
    }

    if let Some(sort) = request.sort.as_ref() {
        let column = sort.column_name.trim();
        if !column.is_empty() {
            rows.sort_by(|left, right| {
                let a = left.get(column).cloned().unwrap_or_default();
                let b = right.get(column).cloned().unwrap_or_default();
                if sort.descending { b.cmp(&a) } else { a.cmp(&b) }
            });
        }
    }
    rows
}

pub fn read_demo_page(
    demo_rows: &HashMap<String, Vec<HashMap<String, String>>>,
    table: &TableMeta,
    session_id: &str,
    request: &TablePageRequest,
) -> TableSessionPage {
    let (page, page_size) = normalize_page_request(request);
    let rows = apply_demo_request(
        demo_rows.get(&table.table_name).cloned().unwrap_or_default(),
        &table.columns,
        request,
    );
    let total_rows = rows.len() as u64;
    let start = ((page - 1) * page_size) as usize;
    let end = (start + page_size as usize).min(rows.len());
    let page_rows = if start < rows.len() { rows[start..end].to_vec() } else { Vec::new() };

    TableSessionPage {
        session_id: session_id.into(),
        table_name: table.table_name.clone(),
        table_comment: table.table_comment.clone(),
        columns: table.columns.clone(),
        primary_keys: primary_keys(table),
        rows: page_rows,
        total_rows,
        page,
        page_size,
    }
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
            filter: Some(TablePageFilter { query: "user_0001".into(), columns: vec!["username".into()] }),
            sort: Some(TablePageSort { column_name: "level".into(), descending: true }),
        };

        let page = read_demo_page(&demo_rows(), table, "session-1", &request);

        assert_eq!(page.total_rows, 1);
        assert!(page.rows[0].get("username").map(String::as_str).unwrap_or("").contains("user_0001"));
        assert_eq!(page.primary_keys, vec!["id"]);
    }
}
