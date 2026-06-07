import { mockSchema } from "./mockSchema.js";

function generateMockRows() {
  const rows = {};
  const elements = ["火","水","风","雷","光","暗"];
  const qualities = ["普通","精良","稀有","史诗","传说"];
  const qualityIds = [1,2,3,4,5];
  const heroNames = ["炎龙骑士","冰霜法师","雷霆战神","暗影刺客","圣光牧师","风暴射手","大地守卫","幻影忍者","血魔领主","星辰贤者","碧海巫女","赤焰狂战","紫电剑圣","苍穹行者","幽冥术士","金钢罗汉","翡翠德鲁伊","银河游侠","朱雀舞者","玄武铁壁"];
  const itemNames = ["小生命药水","大生命药水","小法力药水","大法力药水","复活卷轴","传送石","经验加倍卡","金袋子","强化石","精炼矿石","龙鳞碎片","秘银锭","暗铁块","魔法粉尘","灵魂宝石","生命之叶","力量护符","速度羽毛","防御水晶","幸运硬币"];
  const equipNames = ["烈焰之剑","寒冰法杖","雷霆战锤","暗影匕首","圣光之盾","风暴长弓","大地重甲","幻影斗篷","血魔头盔","星辰项链","碧海戒指","赤焰护腕","紫电腰带","苍穹战靴","幽冥法袍","金钢护肩","翡翠手镯","银河利刃","朱雀羽冠","玄武重盾"];
  const skillNames = ["火球术","冰冻箭","闪电链","暗影突袭","圣光治愈","风暴斩","岩石护甲","幻影步","血之狂暴","星辰陨落","海啸","烈焰风暴","雷霆一击","暗夜潜行","神圣庇护","旋风斩","地震波","瞬移","生命汲取","时间静止"];
  const questNames = ["初出茅庐","勇者试炼","龙之传说","暗影迷宫","圣光守护","风暴前夕","大地之怒","幻影迷踪","血色黄昏","星辰之路","碧海潮生","赤焰焚天","紫电神雷","苍穹之巅","幽冥深渊","金刚不坏","翡翠森林","银河征途","朱雀涅槃","玄武归位"];
  const stageNames = ["幽暗森林","熔岩洞穴","冰封雪原","雷霆峡谷","圣光神殿","风暴高地","大地裂谷","幻影迷阵","血魔深渊","星辰塔","碧海龙宫","赤焰火山","紫电秘境","苍穹之顶","幽冥地宫","金钢石林","翡翠密林","银河星港","朱雀祭坛","玄武古墓"];
  const monsterNames = ["史莱姆","哥布林","骷髅兵","狼人","石像鬼","暗影蝙蝠","火焰蜥蜴","冰霜巨人","雷鸟","死亡骑士","暗影龙","火焰领主","冰晶凤凰","雷神巨像","深渊魔虫","幽灵船长","熔岩魔像","风暴元素","虚空行者","混沌巨兽"];
  const shopNames = ["新手礼包","进阶礼包","豪华礼包","月度特惠","周卡","英雄碎片包","装备宝箱","皮肤礼包","经验药水套装","金币袋","钻石礼包","技能书礼包","强化大礼包","稀有英雄卡","传说装备箱","限时折扣包","VIP专属礼包","节日限定包","回归礼包","公会福利包"];
  const mailTitles = ["系统公告","活动奖励","战斗结算","公会通知","好友赠送","每日签到","成就达成","等级奖励","VIP特权","节日祝福","版本更新","补偿邮件","新手引导","任务完成","竞技场结算","副本通关","世界BOSS","公会战奖励","赛季结算","周年庆典"];
  const guildNames = ["龙之谷","暗夜精灵","圣光骑士团","风暴军团","大地之怒","幻影旅团","血色黄昏","星辰守望","碧海潮声","赤焰战歌","紫电联盟","苍穹之翼","幽冥殿","金刚寺","翡翠林","银河舰队","朱雀阁","玄武堂","天命","破军"];
  const achievementNames = ["初露锋芒","百战百胜","收集大师","探索先锋","社交达人","传奇猎人","勇者无惧","智者千虑","富甲一方","速度之王","钢铁之躯","元素使者","暗夜行者","圣光守护","风暴驾驭","不朽传说","至尊王者","万物归一","天选之人","永恒之光"];
  const activityNames = ["七日签到","限定抽卡","深渊副本","消费返利","节日狂欢","新手冲刺","公会争霸","跨服竞技","世界BOSS","秘境探险","限时挑战","积分兑换","幸运转盘","排行冲刺","Boss Rush","经验副本","金币副本","材料副本","英雄试炼","装备锻造"];
  const buffNames = ["力量强化","防御强化","速度强化","暴击提升","闪避提升","生命回复","法力回复","经验加成","金币加成","掉落加成","攻击弱化","防御弱化","中毒","灼烧","冰冻","眩晕","沉默","减速","流血","诅咒"];
  const dropNames = ["史莱姆掉落","哥布林掉落","骷髅兵掉落","狼人掉落","石像鬼掉落","暗影蝙蝠掉落","火焰蜥蜴掉落","冰霜巨人掉落","雷鸟掉落","死亡骑士掉落","暗影龙掉落","火焰领主掉落","冰晶凤凰掉落","雷神巨像掉落","深渊魔虫掉落","幽灵船长掉落","熔岩魔像掉落","风暴元素掉落","虚空行者掉落","混沌巨兽掉落"];
  const slotNames = ["武器","头盔","铠甲","鞋子","饰品"];
  const conditionTypes = ["kill_count","collect_count","explore_count","friend_count","level_reach","boss_kill","pvp_win","quest_complete","equip_enchant","hero_own","stage_clear","login_days","guild_join","achievement_earn","diamond_spend","gold_earn","item_use","skill_level","vip_reach","arena_rank"];
  const triggerEvents = ["level_up","login","quest_complete","boss_kill","pvp_win","guild_join","achievement_earn","first_recharge","daily_reset","weekly_reset","event_start","event_end","new_hero","vip_upgrade","stage_clear","arena_rank","guild_war","world_boss","season_end","anniversary"];
  const sources = ["副本掉落","商店购买","活动奖励","合成制作","BOSS掉落","公会商店","竞技场","世界BOSS","签到奖励","成就奖励"];
  const senderNames = ["系统","GM小助手","活动中心","客服","公会管理员","竞技场裁判","商城精灵","任务指引","福利大使","版本公告"];
  const pick = (arr, i) => arr[(i - 1) % arr.length];
  const randBetween = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const pad2 = (n) => String(n).padStart(2, "0");
  function fakeDate(i, offsetYearsAgo = 0) {
    const y = 2025 - offsetYearsAgo;
    const m = pad2(((i * 3) % 12) + 1);
    const d = pad2(((i * 7) % 28) + 1);
    return `${y}-${m}-${d} ${pad2((i * 5) % 24)}:${pad2((i * 11) % 60)}:${pad2((i * 3) % 60)}`;
  }
  function fakeFutureDate(i) {
    const y = 2026;
    const m = pad2(((i * 2) % 12) + 1);
    const d = pad2(((i * 5) % 28) + 1);
    return `${y}-${m}-${d} ${pad2((i * 4) % 24)}:${pad2((i * 9) % 60)}:${pad2((i * 7) % 60)}`;
  }
  const similarRows = (tableName) => ({
    count: 16,
    cols: (i) => ({
      id: String(i),
      name: `${tableName}_name_${String(i).padStart(2, "0")}`,
      remark: `${tableName} 与其它相似表名用于测试搜索命中和用户辨识。这是一段较长备注 ${i}，应该能在备注面板里自动换行。`,
    }),
  });

  const tableConfigs = {
    player: {
      count: 500,
      cols: (i) => ({
        id: String(i),
        username: `user_${String(i).padStart(4, "0")}`,
        nickname: `冒险者${String(i).padStart(3, "0")}`,
        level: String(Math.min(100, Math.floor(i * 1.8) + 1)),
        exp: String(Math.floor(i * 12345.67)),
        vip_level: String(Math.min(15, Math.floor(i / 4))),
        gold: String(Math.floor(i * 56789)),
        diamond: String(Math.floor(i * 234)),
        last_login: i % 7 === 0 ? null : fakeDate(i, 0),
        status: i === 13 ? "1" : "0",
        create_time: fakeDate(i, 1),
        guild_id: i % 5 === 0 ? String((i % 20) + 1) : null,
      }),
    },
    hero: {
      count: 500,
      cols: (i) => ({
        id: String(i),
        name: pick(heroNames, i),
        rarity: String(Math.min(5, Math.ceil(i / 10))),
        element: pick(elements, i),
        hp_base: String(800 + i * 120 + randBetween(0, 50)),
        atk_base: String(50 + i * 15 + randBetween(0, 10)),
        def_base: String(30 + i * 10 + randBetween(0, 8)),
        spd_base: String(80 + i * 3 + randBetween(0, 5)),
        skill_id: String(((i - 1) % 20) + 1),
        passive_id: i % 3 === 0 ? String(((i - 1) % 20) + 21) : null,
        description: `${pick(heroNames, i)}，${pick(elements, i)}属性英雄，擅长前线作战`,
        is_available: i <= 40 ? "1" : "0",
      }),
    },
    item: {
      count: 500,
      cols: (i) => ({
        id: String(i),
        name: pick(itemNames, i),
        type: String(((i - 1) % 4) + 1),
        quality: String(qualityIds[(i - 1) % 5]),
        max_stack: i <= 20 ? "999" : "99",
        sell_price: i % 3 === 0 ? String(i * 100) : null,
        use_level: i % 4 === 0 ? String(Math.min(80, i)) : null,
        effect_id: i % 5 === 0 ? String(i) : null,
        description: `${pick(itemNames, i)}，品质${pick(qualities, i)}，游戏中的常用道具`,
        icon: `icons/item_${String(i).padStart(4, "0")}.png`,
        expire_days: i % 7 === 0 ? "7" : "0",
        is_tradable: i % 3 === 0 ? "0" : "1",
      }),
    },
    equip: {
      count: 500,
      cols: (i) => ({
        id: String(i),
        name: pick(equipNames, i),
        slot: String(((i - 1) % 5) + 1),
        rarity: String(Math.min(5, Math.ceil(i / 10))),
        hp_bonus: String(50 + i * 30),
        atk_bonus: String(20 + i * 15),
        def_bonus: String(15 + i * 10),
        set_id: i % 4 === 0 ? String(Math.ceil(i / 4)) : null,
        required_level: String(Math.min(100, i * 2)),
        enchant_max: String(Math.min(15, Math.ceil(i / 4))),
        description: `${pick(equipNames, i)}，${slotNames[(i - 1) % 5]}位装备，稀有度${Math.min(5, Math.ceil(i / 10))}`,
        source: pick(sources, i),
      }),
    },
    skill: {
      count: 500,
      cols: (i) => ({
        id: String(i),
        name: pick(skillNames, i),
        type: String(((i - 1) % 3) + 1),
        element: i % 6 === 0 ? null : pick(elements, i),
        cooldown: String(((i * 3) % 15 + 3) + ".00"),
        mp_cost: String(20 + i * 8),
        damage_rate: String((1.2 + (i % 10) * 0.3).toFixed(2)),
        target_type: String(((i - 1) % 3) + 1),
        unlock_level: String(Math.min(80, i * 2)),
        max_level: String(i % 3 === 0 ? "5" : "10"),
        description: `${pick(skillNames, i)}，${pick(elements, i)}属性技能，造成大量伤害`,
        icon: `icons/skill_${String(i).padStart(4, "0")}.png`,
      }),
    },
    quest: {
      count: 500,
      cols: (i) => ({
        id: String(i),
        name: pick(questNames, i),
        type: String(((i - 1) % 4) + 1),
        chapter: i % 4 === 0 ? String(Math.ceil(i / 5)) : null,
        required_level: String(Math.min(80, i)),
        pre_quest: i > 5 && i % 3 === 0 ? String(i - 1) : null,
        reward_exp: String(500 + i * 200),
        reward_gold: String(1000 + i * 300),
        reward_item_id: i % 4 === 0 ? String(((i - 1) % 20) + 1) : null,
        reward_item_count: i % 4 === 0 ? String(Math.ceil(i / 10)) : null,
        description: `完成${pick(questNames, i)}任务，获得丰厚奖励`,
        is_repeatable: i % 4 === 3 ? "1" : "0",
      }),
    },
    stage: {
      count: 500,
      cols: (i) => ({
        id: String(i),
        name: pick(stageNames, i),
        chapter: String(Math.ceil(i / 5)),
        difficulty: String(((i - 1) % 3) + 1),
        stamina_cost: String(10 + Math.ceil(i / 5) * 5),
        recommended_level: String(Math.min(100, i * 2)),
        boss_id: i % 3 === 0 ? String(((i - 1) % 20) + 1) : null,
        drop_table_id: i % 2 === 0 ? String(i) : null,
        reward_exp: String(300 + i * 150),
        reward_gold: String(500 + i * 200),
        star_condition: i % 3 === 0 ? `无阵亡通关且回合数不超过${5 + Math.ceil(i / 5)}` : null,
        is_unlocked: i <= 30 ? "1" : "0",
      }),
    },
    monster: {
      count: 500,
      cols: (i) => ({
        id: String(i),
        name: pick(monsterNames, i),
        type: String(((i - 1) % 3) + 1),
        element: i % 5 === 0 ? null : pick(elements, i),
        hp: String(200 + i * 500 + (i % 3 === 2 ? i * 1000 : 0)),
        atk: String(30 + i * 25 + (i % 3 === 2 ? i * 50 : 0)),
        def: String(20 + i * 15 + (i % 3 === 2 ? i * 30 : 0)),
        spd: String(50 + i * 5),
        skill_id_1: i % 3 !== 0 ? String(((i - 1) % 20) + 1) : null,
        skill_id_2: i % 3 === 2 ? String(((i - 1) % 20) + 21) : null,
        drop_table_id: i % 2 === 0 ? String(i) : null,
        description: `${pick(monsterNames, i)}，${i % 3 === 2 ? "BOSS级" : i % 3 === 1 ? "精英级" : "普通"}怪物`,
      }),
    },
    shop: {
      count: 500,
      cols: (i) => ({
        id: String(i),
        name: pick(shopNames, i),
        category: String(((i - 1) % 4) + 1),
        item_id: i % 4 === 0 ? String(((i - 1) % 20) + 1) : null,
        price_type: i % 3 === 0 ? "2" : "1",
        price: String(i % 3 === 0 ? 100 + i * 50 : 1000 + i * 500),
        original_price: i % 4 === 0 ? String(Math.floor((100 + i * 50) * 1.3)) : null,
        stock_limit: i % 5 === 0 ? "0" : String(Math.ceil(i / 5)),
        refresh_cycle: String(((i - 1) % 3)),
        required_vip: String(Math.min(15, Math.floor(i / 5))),
        start_time: i % 3 === 0 ? fakeDate(i, 0) : null,
        end_time: i % 3 === 0 ? fakeFutureDate(i) : null,
      }),
    },
    mail: {
      count: 500,
      cols: (i) => ({
        id: String(i),
        title: pick(mailTitles, i),
        sender: pick(senderNames, (i * 3) % 10 + 1),
        content: `尊敬的玩家，${pick(mailTitles, i)}。感谢您的支持，请查收附件奖励。`,
        reward_item_id: i % 3 === 0 ? String(((i - 1) % 20) + 1) : null,
        reward_count: i % 3 === 0 ? String(Math.ceil(i / 5)) : null,
        expire_hours: String(24 * (1 + (i % 7))),
        priority: String(Math.min(5, Math.ceil(i / 10))),
        trigger_event: i % 4 === 0 ? pick(triggerEvents, i) : null,
        is_system: i % 3 === 0 ? "1" : "0",
        create_time: fakeDate(i, 0),
        is_read: i % 5 === 0 ? "0" : "1",
      }),
    },
    guild: {
      count: 500,
      cols: (i) => ({
        id: String(i),
        name: pick(guildNames, i) + (i > 20 ? String(i) : ""),
        level: String(Math.min(30, Math.ceil(i / 2))),
        leader_id: String(i),
        member_count: String(Math.min(50, 5 + i)),
        max_members: String(30 + Math.ceil(i / 5) * 10),
        exp: String(Math.floor(i * 98765.43)),
        notice: i % 3 === 0 ? `${pick(guildNames, i)}欢迎各位勇士加入！团结协作，共创辉煌。` : null,
        create_time: fakeDate(i, 1),
        is_recruiting: i <= 40 ? "1" : "0",
        min_join_level: String(Math.min(60, i * 2)),
        icon_id: i % 3 === 0 ? String(i) : null,
      }),
    },
    achievement: {
      count: 500,
      cols: (i) => ({
        id: String(i),
        name: pick(achievementNames, i),
        category: String(((i - 1) % 4) + 1),
        condition_type: pick(conditionTypes, i),
        condition_value: String(i * 10),
        reward_diamond: String(10 + i * 5),
        reward_title: i % 3 === 0 ? `${pick(achievementNames, i)}称号` : null,
        points: String(5 + i * 2),
        is_hidden: i % 7 === 0 ? "1" : "0",
        parent_id: i > 10 && i % 5 === 0 ? String(i - 5) : null,
        description: `达成条件：${pick(conditionTypes, i)}达到${i * 10}`,
        icon: `icons/achievement_${String(i).padStart(4, "0")}.png`,
      }),
    },
    activity: {
      count: 500,
      cols: (i) => ({
        id: String(i),
        name: pick(activityNames, i),
        type: String(((i - 1) % 4) + 1),
        start_time: fakeDate(i, 0),
        end_time: fakeFutureDate(i),
        reward_pool: i % 3 === 0 ? `[{"item_id":${((i - 1) % 20) + 1},"count":${Math.ceil(i / 5)}},{"item_id":${((i + 5) % 20) + 1},"count":1}]` : null,
        daily_limit: i % 4 === 0 ? String(3 + (i % 5)) : null,
        total_limit: i % 4 === 0 ? String(30 + i) : null,
        required_level: String(Math.min(50, i)),
        is_active: i <= 35 ? "1" : "0",
        description: `${pick(activityNames, i)}限时开启，参与即有丰厚奖励！`,
        sort_order: String(i),
      }),
    },
    buff: {
      count: 500,
      cols: (i) => ({
        id: String(i),
        name: pick(buffNames, i),
        icon: `icons/buff_${String(i).padStart(4, "0")}.png`,
        stack_max: String(i % 3 === 0 ? 1 : 5 + (i % 6)),
        duration: i % 5 === 0 ? "0.00" : String((i % 4 + 1) * 30 + (i % 10) + ".00"),
        effect_type: String(((i - 1) % 8) + 1),
        value_type: i % 3 === 0 ? "2" : "1",
        value: String((i % 3 === 0 ? 5 + i * 2 : 50 + i * 10) + ".00"),
        is_debuff: i > 30 ? "1" : "0",
        is_dispel: i % 4 === 0 ? "0" : "1",
        description: `${pick(buffNames, i)}，${i > 30 ? "减益" : "增益"}效果，持续一定回合`,
        source: i % 6 === 0 ? null : pick(sources, i),
      }),
    },
    drop_table: {
      count: 500,
      cols: (i) => ({
        id: String(i),
        name: pick(dropNames, i),
        item_id: String(((i - 1) % 20) + 1),
        min_count: "1",
        max_count: String(1 + (i % 5)),
        weight: String(100 - i),
        rarity: String(qualityIds[(i - 1) % 5]),
        is_guaranteed: i % 10 === 0 ? "1" : "0",
        condition: i % 5 === 0 ? `level>=${i * 2}` : null,
        group_id: i % 4 === 0 ? String(Math.ceil(i / 4)) : null,
        description: `${pick(dropNames, i)}，权重${100 - i}，稀有度${qualityIds[(i - 1) % 5]}`,
        is_enabled: i <= 45 ? "1" : "0",
      }),
    },
    user: similarRows("user"),
    users: similarRows("users"),
    user_profile: similarRows("user_profile"),
    user_profiles: similarRows("user_profiles"),
    order: similarRows("order"),
    orders: similarRows("orders"),
    order_item: similarRows("order_item"),
    order_items: similarRows("order_items"),
    ui_edge_case_values: {
      count: 12,
      cols: (i) => ({
        id: String(i),
        name: `边界用例_${i}`,
        long_remark: `这是第 ${i} 条超长备注，用于测试自动换行。它包含中文段落、English identifiers like veryLongRemarkField、连续描述以及标点符号，应该在右侧备注区域自然换行显示，而不是把面板横向撑开。`,
        json_value: JSON.stringify({ id: i, enabled: i % 2 === 0, tags: ["json", "preview", `case-${i}`], limits: { daily: i * 3, total: null } }),
        ts_function: i % 2 === 0 ? `export const calculateReward = <T extends Player>(player: T) => {\n  const bonus = player.level > ${i} ? 2 : 1;\n  return { gold: ${i * 100} * bonus, tags: ["edge", player.id] };\n};` : `async function validateCase(input: { id: number; name?: string }) {\n  if (!input.name) return false;\n  return input.id > ${i};\n}`,
        case_key: i % 3 === 0 ? "ALPHA" : i % 3 === 1 ? "Alpha" : "alpha",
        mixedCaseColumn: `mixedCaseValue${i}`,
        snake_case_column: `snake_case_value_${i}`,
      }),
    },

    // --- New table row generators ---

    config_entry: {
      count: 50,
      cols: (i) => ({
        id: String(i),
        config_key: pick(["max_player_level","daily_reset_hour","pvp_season_length","guild_max_level","shop_refresh_interval","exp_rate","drop_rate_bonus","stamina_regen_min","max_friend_count","mail_expire_days","enchant_success_base","hero_summon_cost","guild_create_cost","arena_max_attempts","vip_exp_rate"], i),
        config_value: String(Math.floor(Math.random() * 100) + 1),
        category: pick(["system","combat","social","economy","event"], i),
        updated_at: fakeDate(i, 0),
        description: `第${i}条全局配置项，控制游戏核心行为参数`,
      }),
    },
    localization: {
      count: 200,
      cols: (i) => {
        const locale = pick(["en","zh","ja","ko","de","fr"], i);
        const keys = ["btn_ok","btn_cancel","btn_confirm","msg_welcome","msg_levelup","msg_quest_complete","label_username","label_password","label_nickname","title_shop","title_guild","title_arena","err_network","err_timeout","err_auth_failed","loading_tips","daily_reward","achievement_unlock","guild_notice","event_start"];
        return {
          id: String(i),
          locale,
          msg_key: pick(keys, Math.ceil(i / 6)),
          msg_value: `[${locale}] ${pick(keys, Math.ceil(i / 6))} 翻译文本 #${i}`,
          is_rtl: locale === "ar" ? "1" : "0",
        };
      },
    },
    version_info: {
      count: 30,
      cols: (i) => ({
        id: String(i),
        version_code: `1.${Math.floor(i / 6)}.${i % 6}`,
        platform: pick(["ios","android","windows","mac"], i),
        release_notes: `版本 1.${Math.floor(i / 6)}.${i % 6} 更新说明：修复已知问题，优化游戏体验，新增活动内容。`,
        is_mandatory: i % 5 === 0 ? "1" : "0",
        released_at: fakeDate(i, 0),
      }),
    },
    feature_flag: {
      count: 20,
      cols: (i) => ({
        id: String(i),
        flag_key: pick(["new_shop_ui","guild_war_v2","hero_awakening","cross_server_chat","dark_mode","auto_battle","battle_pass","pet_system","achievement_v2","social_share","live_ops","anti_cheat_v2","newbie_guide_v3","reward_optimization","server_merge","data_export","push_notification","rank_season_reset","guild_donation","daily_dungeon"], i),
        is_enabled: i % 3 === 0 ? "0" : "1",
        target_group: i % 4 === 0 ? "vip_only" : i % 3 === 0 ? "beta_testers" : null,
        description: `功能开关 #${i}，控制新功能的灰度发布`,
      }),
    },
    staging_migration: {
      count: 40,
      cols: (i) => ({
        id: String(i),
        migration_name: `V${String(i).padStart(3, "0")}__${pick(["add_column","create_index","alter_table","add_table","drop_column","rename_column","data_migration"], i)}_${pick(["player","hero","guild","item","quest","shop","mail","achievement"], i)}.sql`,
        applied_at: fakeDate(i, 0),
        checksum: `sha256_${String(i).padStart(8, "0")}_${pick(["a","b","c","d","e","f"], i)}${pick(["0","1","2","3","4","5","6","7","8","9"], i * 3)}`,
        status: i % 10 === 0 ? "1" : i % 20 === 0 ? "2" : "0",
      }),
    },
    staging_flag: {
      count: 25,
      cols: (i) => ({
        id: String(i),
        flag_name: `staging_${pick(["mock_payment","fake_drop_rate","debug_log","slow_query","cache_bypass","rate_limit_off","maintenance","verbose_error","test_account","god_mode","infinite_stamina","unlock_all","max_vip","free_gacha","double_exp","no_cooldown","auto_win","show_ids","log_queries","skip_tutorial","force_update","benchmark_mode","perf_profile","memory_dump","api_mock"], i)}`,
        enabled: i % 3 === 0 ? "0" : "1",
        description: `Staging环境测试开关 #${i}`,
        toggled_by: pick(["dev_team","qa_team","auto_test","ops","sre"], i),
      }),
    },
    staging_override: {
      count: 30,
      cols: (i) => ({
        id: String(i),
        config_key: pick(["max_player_level","drop_rate_bonus","exp_rate","stamina_regen","shop_prices","guild_max_members","arena_reward","vip_benefits"], i),
        override_value: String(Math.floor(Math.random() * 200) + 10),
        reason: i % 3 === 0 ? "性能测试需要调高数值" : i % 3 === 1 ? "QA回归测试覆盖边界值" : "临时调试使用",
        created_at: fakeDate(i, 0),
      }),
    },
    event_log: {
      count: 300,
      cols: (i) => ({
        id: String(i),
        event_name: pick(["login","logout","purchase","level_up","quest_complete","gacha_pull","guild_join","arena_battle","stage_clear","item_use","friend_add","chat_send","achievement_unlock","daily_reward","vip_upgrade"], i),
        user_id: String(((i * 7) % 500) + 1),
        properties: i % 3 === 0 ? `{"source":"${pick(["main_menu","push","deep_link","ads"], i)}","duration":${i * 30}}` : null,
        occurred_at: fakeDate(i, 0),
        platform: pick(["ios","android","windows","mac"], i),
      }),
    },
    daily_active_user: {
      count: 60,
      cols: (i) => {
        const m = pad2(((i - 1) % 12) + 1);
        const d = pad2(((i * 3 - 1) % 28) + 1);
        return {
          id: String(i),
          stat_date: `2025-${m}-${d} 00:00:00`,
          dau_count: String(5000 + Math.floor(Math.random() * 3000)),
          new_users: String(Math.floor(Math.random() * 500) + 50),
          returning_users: String(Math.floor(Math.random() * 2000) + 1000),
          platform: pick(["ios","android","all"], i),
        };
      },
    },
    revenue_report: {
      count: 60,
      cols: (i) => {
        const m = pad2(((i - 1) % 12) + 1);
        const d = pad2(((i * 3 - 1) % 28) + 1);
        return {
          id: String(i),
          report_date: `2025-${m}-${d} 00:00:00`,
          total_revenue: String((Math.random() * 50000 + 5000).toFixed(2)),
          currency: pick(["CNY","USD","JPY","KRW"], i),
          transaction_count: String(Math.floor(Math.random() * 800) + 100),
          top_item_id: i % 3 === 0 ? String(((i - 1) % 20) + 1) : null,
        };
      },
    },
    retention_cohort: {
      count: 80,
      cols: (i) => ({
        id: String(i),
        cohort_date: `2025-${pad2(((i - 1) % 12) + 1)}-01 00:00:00`,
        day_offset: String(((i - 1) % 30) + 1),
        retained_count: String(Math.max(10, 500 - i * 5 + Math.floor(Math.random() * 50))),
        cohort_size: "1000",
        retention_rate: String(Math.max(0.01, (500 - i * 5) / 1000 + (Math.random() * 0.05 - 0.025)).toFixed(4)),
      }),
    },
    ab_test_config: {
      count: 20,
      cols: (i) => ({
        id: String(i),
        experiment_name: pick(["new_onboarding","shop_redesign","battle_ui_v2","reward_popup","guild_discovery","hero_detail","daily_mission_flow","push_frequency","loading_screen","payment_flow"], i),
        variant: pick(["control","variant_a","variant_b","variant_c"], i),
        traffic_pct: String(pick([10, 20, 25, 50], i)),
        is_active: i <= 15 ? "1" : "0",
        description: `A/B测试 #${i}：${pick(["优化转化率","提升留存","增加付费","改善体验"], i)}`,
      }),
    },
    test_case: {
      count: 60,
      cols: (i) => ({
        id: String(i),
        case_name: `TC_${String(i).padStart(3, "0")}_${pick(["login_flow","purchase_flow","guild_create","arena_battle","gacha_pull","level_up","quest_submit","item_use","friend_add","chat_send","mail_read","shop_refresh","achievement_check","daily_reset","stamina_recover"], i)}`,
        module: pick(["combat","shop","guild","social","quest","system","payment","performance"], i),
        expected_result: `期望：${pick(["正常完成流程","返回成功状态码","数据正确写入","界面正确展示","不产生异常日志"], i)}`,
        priority: String(Math.min(5, Math.ceil(i / 12))),
        is_automated: i % 3 === 0 ? "0" : "1",
      }),
    },
    test_result: {
      count: 100,
      cols: (i) => ({
        id: String(i),
        test_case_id: String(((i - 1) % 60) + 1),
        status: pick(["pass","pass","pass","fail","skip"], i),
        executed_at: fakeDate(i, 0),
        duration_ms: String(Math.floor(Math.random() * 5000) + 100),
        error_message: i % 5 === 4 ? `AssertionError: expected 200 but got ${pick(["404","500","403","401","502"], i)} at ${pick(["login_flow","purchase_flow","guild_create","arena_battle"], i)}` : null,
      }),
    },
    archived_player: {
      count: 100,
      cols: (i) => ({
        id: String(i),
        original_id: String(i + 10000),
        username: `archived_user_${String(i).padStart(4, "0")}`,
        level: String(Math.min(100, Math.floor(i * 1.5) + 1)),
        last_active: fakeDate(i, 2),
        archived_at: fakeDate(i, 1),
      }),
    },
    archived_guild: {
      count: 30,
      cols: (i) => ({
        id: String(i),
        original_id: String(i + 500),
        name: `${pick(["旧龙之谷","消散暗影","落幕圣光","残风","尘封大地"], i)}${i > 5 ? String(i) : ""}`,
        member_count: String(Math.min(50, 3 + i * 2)),
        disbanded_at: fakeDate(i, 1),
      }),
    },
    archived_mail: {
      count: 50,
      cols: (i) => ({
        id: String(i),
        original_id: String(i + 8000),
        title: pick(["过期活动奖励","节日祝福(历史)","旧版本补偿","已结束赛事奖励","归档系统通知"], i),
        sender: pick(["系统","运营","客服","活动中心"], i),
        expired_at: fakeDate(i, 1),
      }),
    },
    archived_activity: {
      count: 40,
      cols: (i) => ({
        id: String(i),
        original_id: String(i + 3000),
        name: pick(["往期七日签到","旧限定抽卡","历史深渊副本","过期消费返利","往期节日狂欢","旧新手冲刺"], i),
        ended_at: fakeDate(i, 1),
        participant_count: String(Math.floor(Math.random() * 8000) + 500),
      }),
    },
    archive_metadata: {
      count: 20,
      cols: (i) => ({
        id: String(i),
        source_table: pick(["player","guild","mail","activity","log"], i),
        row_count: String(Math.floor(Math.random() * 50000) + 1000),
        archived_at: fakeDate(i, 1),
        archive_reason: pick(["数据过期清理","用户注销归档","活动结束归档","定期数据归档","合规要求归档"], i),
      }),
    },
  };

  for (const [tableName, config] of Object.entries(tableConfigs)) {
    rows[tableName] = [];
    for (let i = 1; i <= config.count; i++) {
      rows[tableName].push(config.cols(i));
    }
  }
  return rows;
}

const mockRows = generateMockRows();

const rowCache = new Map();

export function getOrInitRows(connectionId, database, tableName) {
  const key = `${connectionId || "demo"}/${database || "game_db"}/${tableName}`;
  let cached = rowCache.get(key);
  if (!cached) {
    const source = mockRows[tableName] || [];
    cached = source.map((row) => ({ ...row }));
    rowCache.set(key, cached);
  }
  return cached;
}

export { generateMockRows, mockRows, rowCache };
