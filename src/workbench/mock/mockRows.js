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

export { generateMockRows, mockRows };
