//! Explicit jswz contracts that cannot be recovered from a column name alone.
//! Never infer a relation just because two columns contain overlapping numbers.

use super::catalog::DbSnapshot;
use super::constraints::RowConstraint;
use super::model::{RelationKey, RelationKind};
use super::parser::ReferenceParser;

pub struct ProjectRelation {
    pub key: RelationKey,
    pub parser: Option<ReferenceParser>,
    pub constraints: Vec<RowConstraint>,
    pub note: String,
}

fn guard(column: &str, values: &[&str]) -> RowConstraint {
    RowConstraint { column: column.into(), values: values.iter().map(|value| (*value).into()).collect() }
}

fn paths(paths: &[&str], exclude: &[&str]) -> ReferenceParser {
    ReferenceParser::JsonPaths { paths: paths.iter().map(|path| (*path).into()).collect(),
        exclude: exclude.iter().map(|value| (*value).into()).collect() }
}

struct Builder<'a> {
    snapshot: &'a DbSnapshot,
    rules: Vec<ProjectRelation>,
}

impl Builder<'_> {
    fn add(&mut self, source: &str, column: &str, target: &str, key: &str,
           parser: Option<ReferenceParser>, constraints: Vec<RowConstraint>, note: &str) {
        let (Some(column), Some(key)) = (self.snapshot.column_name(source, column), self.snapshot.column_name(target, key)) else { return };
        if constraints.iter().any(|guard| self.snapshot.column_name(source, &guard.column).is_none()) { return; }
        self.rules.push(ProjectRelation {
            key: RelationKey { source_table: source.into(), source_column: column.into(), target_table: target.into(), target_column: key.into(), kind: RelationKind::Value },
            parser, constraints, note: note.into(),
        });
    }
}

pub fn rules(snapshot: &DbSnapshot) -> Vec<ProjectRelation> {
    let mut b = Builder { snapshot, rules: Vec::new() };
    for (prefix, target, key) in [("G", "activegroupprop", "GroupID"), ("S", "activesingleprop", "SingleID")] {
        b.add("activebaseprop", "SubID", target, key, Some(ReferenceParser::Prefix { prefix: prefix.into() }), Vec::new(),
            "活动入口：G开头指向组合活动，S开头指向单活动；另一种前缀不参与匹配。");
    }
    for (kind, target, key) in [("1", "shoptypeprop", "ShopType"), ("2", "vipshopprop", "ID"), ("3", "vipweekcardprop", "Type")] {
        b.add("altarsuggestbuyprop", "Param1", target, key, None, vec![guard("Type", &[kind])],
            "AltarSuggestMgr：Type决定Param1的含义，1为普通商店类型、2为商城格子ID、3为周卡类型；Type自身不是引用ID。");
    }
    for (source, column, target, key) in [
        ("guidedetailprop", "ShowIDP1", "condguideeventprop", "ID"),
        ("guidedetailprop", "ShowIDP1", "guidecutsceneprop", "CutsceneID"),
        ("comgrowthunitopenprop", "ID", "heroskinprop", "SkinID"),
        ("limitgiftbagencprop", "ThemeID", "comnpcshowprop", "ThemeID"),
    ] {
        b.add(source, column, target, key, Some(ReferenceParser::Unsupported), Vec::new(),
            "此字段还需要其他表的类型或面板条件才能定位，暂不按单个数值匹配，避免串表；保留表间用途供核查。");
    }
    // Inventory identity and subtype extensions: ItemMgr, ItemBoxMgr,
    // ItemComposeM, ItemSourceMgr and CultivateMgr. Reverse navigation uses
    // these same edges; do not manufacture a reciprocal edge for every item.
    for (source, columns, target, key) in [
        ("boxprop", "BoxID", "goodsprop", "ID"),
        ("goodscompprop", "DestID FrontID", "goodsprop", "ID"),
        ("goodsdecomposeprop", "DestID", "goodsprop", "ID"),
        ("goodstransprop", "ID", "goodsprop", "ID"),
        ("goodscheckprop", "ID", "goodsprop", "ID"),
        ("goodscheckactprop", "ID", "goodsprop", "ID"),
        ("insonhookspeedupitemprop", "ItemID", "goodsprop", "ID"),
        ("heroprop", "ClipItemID", "goodsprop", "ID"),
        ("heroprop", "MapPingID", "heroprop", "ID"),
        ("heroskinprop", "NeedGoodsID", "goodsprop", "ID"),
        ("orderprop", "ScoreID", "goodsprop", "ID"),
        ("relicbaseprop", "RevivalGoodsID", "goodsprop", "ID"),
        ("vipbaseprop", "CashCouponID CashCouponID2 CashCouponID3", "goodsprop", "ID"),
        ("vipmonthcardprop", "ActivateGoodID", "goodsprop", "ID"),
        ("act7jifen1prop", "ResID", "goodsprop", "ID"),
        ("swarcityroadresprop", "BoxID", "boxprop", "BoxID"),
        ("delayopenzoneprop", "ID", "heroprop", "ID"),
        ("wikiprop", "ID", "heroprop", "ID"),
        ("callerprop", "ModelID", "heroprop", "ID"),
        ("heroartifactskilldesprop", "HeroID", "heroprop", "ID"),
        ("altardrawprop", "FirstTarID", "heroprop", "ID"),
        ("altarxjdrawprop", "FirstURHeroID FirstURSacSpiritID FirstURMountID FirstURPetID", "heroprop", "ID"),
        ("heroprop", "SkillID", "skilldataprop", "HeroID"),
        ("heroskinprop", "SkillHeroID", "skilldataprop", "HeroID"),
        ("skilldataprop", "HeroID", "heroprop", "ID"),
        ("skilldecprop", "HeroID", "heroprop", "ID"),
        ("taskprop", "TaskType", "taskshowprop", "TaskType"),
        ("taskprop", "JumpId", "condjumpprop", "JumpId"),
        ("activecondprop", "JumpId", "condjumpprop", "JumpId"),
        ("tasksimplifyprop", "SourceId", "condjumpprop", "JumpId"),
        ("buildopenplatprop", "BuildID", "buildopenprop", "BuildID"),
        ("buildopenzoneprop", "BuildID", "buildopenprop", "BuildID"),
        ("buildopenprop", "OpenBuildID", "buildopenprop", "BuildID"),
        ("assistprop", "BuildID", "buildopenprop", "BuildID"),
        ("insonhookprop", "BuildID", "buildopenprop", "BuildID"),
        ("mailplayerlvlprop", "BuidID", "buildopenprop", "BuildID"),
        ("goodssourceprop", "BuildId", "buildopenprop", "BuildID"),
        ("guideprop", "PreGuideID", "guideprop", "GuideID"),
        ("guidedetailprop", "GuideID", "guideprop", "GuideID"),
        ("onekeycultivateprogressprop", "GuideID", "guideprop", "GuideID"),
        ("guidebaseprop", "ManualSkipInsID", "ins1prop", "ID"),
        ("onekeycultivateprogressprop", "MainInsID", "ins1prop", "ID"),
        ("onekeycultivateprogressprop", "EliteInsID", "ins2prop", "ID"),
        ("onekeycultivateprogressprop", "HardInsID", "ins3prop", "ID"),
        ("onekeycultivateprogressprop", "DreamInsID", "ins4prop", "ID"),
        ("arenatypeprop", "GuideInsID CrossGuardInsID", "ins5prop", "ID"),
        ("forestsecretlandbaseprop", "CrossGuardInsID", "ins5prop", "ID"),
        ("forestsecretlandchlgprop", "UnlockNeedInsID", "ins5prop", "ID"),
        ("forestsecretlandmineprop", "DefInsID", "ins5prop", "ID"),
        ("magicstoneescortguardprop", "GuardInsID", "ins5prop", "ID"),
        ("skyarenabaseprop", "Guard2InsID Guard3InsID", "ins5prop", "ID"),
        ("skyarenascoreprop", "InsID", "ins5prop", "ID"),
        ("teamupbosshardlvlprop", "BossInsID UnlockInsID", "ins5prop", "ID"),
        ("worldbossintroprop", "InsID", "ins5prop", "ID"),
        ("worldbosslvlprop", "GuardInsID", "ins5prop", "ID"),
        ("vipfuncdesprop", "VipFID", "conditionvipprop", "VipFID"),
        ("planegrouppointprop", "PointAttrType", "planepointattrprop", "PointAttrType"),
    ] {
        for column in columns.split_whitespace() {
            b.add(source, column, target, key, None, Vec::new(),
                "决胜2配置约定：此字段存放目标表的标识，依据字段含义和读表用途建立关联，不按数字重合猜测。");
        }
    }
    for (source, columns, target, key, delimiter) in [
        ("act11zhihuan1prop", "LockLst", "heroprop", "ID", "json"),
        ("act305urqiyuan1prop", "P1Lst LastP1Lst", "heroprop", "ID", "json"),
        ("act301ssrzhaomu1prop", "P2 P3", "heroprop", "ID", "json"),
        ("act501shengxingjihua1prop", "P1", "heroprop", "ID", "json"),
        ("challengeentranceprop", "Reward", "goodsprop", "ID", "json"),
        ("orderprop", "OptionList", "orderrewardopenprop", "OptionID", "json"),
        ("altardrawprop", "ReRandID", "heroprop", "ID", "json"),
        ("fmtkindprop", "BuildIDLst", "buildopenprop", "BuildID", "json"),
        ("guidebaseprop", "ManualSkipGuideIDs", "guideprop", "GuideID", "json"),
        ("evilinshighprop", "InsIDLst", "ins5prop", "ID", "json"),
        ("evilinslowprop", "InsIDLst", "ins5prop", "ID", "json"),
        ("insonhookspeedupitemprop", "SpeedUpIDLst", "goodsprop", "ID", ","),
        ("planestairsshowprop", "GroupShowLst", "planegrouppointprop", "GroupID", "json"),
    ] {
        for column in columns.split_whitespace() {
            b.add(source, column, target, key, Some(ReferenceParser::Keys { delimiter: delimiter.into() }), Vec::new(),
                "决胜2配置约定：逐项读取标识列表；数量、位置和权重不作为引用。");
        }
    }
    for table in snapshot.tables.values() {
        for column in &table.columns {
            if table.name == "growupfmtmodelprop" && (column.name == "HeroFmt"
                || column.name.starts_with("PetFmt") || column.name.starts_with("SacspiritFmt")) {
                b.add(&table.name, &column.name, "heroprop", "ID", Some(paths(&["$[*]"], &["P"])), Vec::new(),
                    "CAttrInstanceProp：阵容列表保存单位ID；P是战宠站位标记，不是单位ID。");
            }
            if column.comment.contains("属性") && matches!(column.name.as_str(), "Attr" | "EquipAttr")
                && matches!(column.data_type.as_str(), "json" | "text") {
                b.add(&table.name, &column.name, "attrkindprop", "AttrID", Some(ReferenceParser::json("ID")), Vec::new(),
                    "attrCommDef.CAttrJson：ID代表属性类型，Val代表属性值；不关联到物品表。");
            }
        }
    }
    for table in ["ins1prop", "ins2prop", "ins3prop", "ins4prop", "ins5prop"] {
        b.add(table, "Fmt", "heroprop", "ID", Some(paths(&["$[*].Init[*].HeroID", "$[*].Dyn[*].HeroID", "$[*].Npc[*].HeroID"], &[])), Vec::new(),
            "CAttrInstanceProp / BPropDefine：只读取Init、Dyn、Npc中的HeroID；怪物序号、阵位和出生参数不作为单位引用。");
        for column in ["MineSkill", "EnemySkill"] {
            b.add(table, column, "skilldataprop", "HeroID", Some(paths(&["$[*].HeroID"], &[])), Vec::new(),
                "BPropDefine：战场技能的HeroID选择技能组；组内SkillID需要所属组信息，不能单独跨组匹配。");
        }
    }
    for (column, target, key, member) in [
        ("Caller", "callerprop", "ID", "CallerID"),
        ("Buff", "skillbuffdesprop", "ID", "BuffID"),
        ("ChangeAttr1", "attrkindprop", "AttrID", "AttrID"),
        ("ChangeAttr2", "attrkindprop", "AttrID", "AttrID"),
    ] {
        b.add("skillprop", column, target, key, Some(ReferenceParser::json(member)), Vec::new(),
            "BPropDefine：只读取指定的召唤物、效果或属性ID；不把数值和表达式当成ID，也不执行函数。");
    }
    for column in ["AntiqueInfo", "AncientToolInfo"] {
        b.add("growuptempprop", column, "antiquesuitattrprop", "SuitID", Some(paths(&["$[*][0]"], &[])), Vec::new(),
            "attrPropMgr / antiqueAttrModuleHandler：[套装ID,星级]中只取第一项，星级不作为套装引用。");
    }
    for column in ["AttrID1", "AttrID2"] {
        b.add("herocampstifleprop", column, "attrkindprop", "AttrID", None, Vec::new(), "阵营克制配置：此字段代表属性ID，不是加成百分比。");
    }
    // Activity tables renamed without updating historical column comments.
    // Resolve exact known contracts, not fuzzy table-name similarities.
    for (source, column, target, key) in [
        ("act101zuanshengzuan1prop", "EncModelID", "act101zuanshengzuan2prop", "EncModelID"),
        ("act103hengjingzhuanpan1prop", "EncModelID", "act103hengjingzhuanpan2prop", "EncModelID"),
        ("act103hengjingzhuanpan2prop", "RateModelID", "act103hengjingzhuanpan3prop", "RateModelID"),
        ("act107beishuzhuanpan1prop", "EncModelID", "act107beishuzhuanpan2prop", "EncModelID"),
        ("act109pinzhizhuanpan1prop", "EncModelID", "act109pinzhizhuanpan2prop", "EncModelID"),
        ("act53xuyuanshu1prop", "EncModelID", "act53xuyuanshu2prop", "EncModelID"),
        ("act55qiandao1prop", "EncModelID", "act55qiandao2prop", "EncModelID"),
        ("act31duolun1prop", "EncModelID", "act31duolun2prop", "EncModelID"),
        ("vipljcontinuercmodelprop", "EncModelID", "vipljcontinuercencmodelprop", "ModelID"),
    ] {
        b.add(source, column, target, key, None, Vec::new(),
            "决胜2当前活动模板与奖励表的对应关系；字段注释仍使用旧表名，按当前表结构与读表用途修正。");
    }
    for (kind, target, key) in [("1", "conditionprop", "Type"), ("2", "conditionvipprop", "VipFID"), ("3", "conditionactiveprop", "Type")] {
        b.add("activecondprop", "CondTypeID", target, key, None, vec![guard("Kind", &[kind])],
            "activecondprop.Kind决定条件表：1为任务条件，2为VIP条件，3为特殊活动条件。");
    }
    for column in ["Param2", "Param3", "Param4"] {
        let mut codes = vec!["20053", "20101", "20103", "20105", "20107", "20109", "20201",
            "20203", "20205", "20211", "20213", "20215", "20217", "20231", "20233", "20301", "20309"];
        if column != "Param4" { codes.push("20305"); }
        if column == "Param2" { codes.push("20241"); }
        b.add("activecondprop", column, "goodsprop", "ID", None,
            vec![guard("Kind", &["3"]), guard("CondTypeID", &codes)],
            "conditionactiveprop的参数说明：仅这些特殊活动把此参数用作限时道具或货币ID；其他活动的次数、等级不参与匹配。");
    }
    for table in snapshot.tables.values() {
        if !table.name.starts_with("act") || !table.name.ends_with("1prop") || table.column("ModelID").is_none() { continue; }
        let digits = table.name[3..].chars().take_while(char::is_ascii_digit).collect::<String>();
        let Ok(number) = digits.parse::<u32>() else { continue };
        // act25duolun is the retired pre-rename family, not activity 20025.
        if table.name == "act25duolun1prop" { continue; }
        let condition = (20000 + number).to_string();
        b.add("activecondprop", "Param1", &table.name, "ModelID", None,
            vec![guard("Kind", &["3"]), guard("CondTypeID", &[&condition])],
            "特殊活动配置：Kind=3且CondTypeID匹配该活动时，Param1才引用对应模板；不把模板ID当成条件类型ID。");
    }
    b.add("activecondprop", "Param1", "actclosebetarebatemodelprop", "ModelID", None,
        vec![guard("Kind", &["3"]), guard("CondTypeID", &["25998", "25999"])], "内测返利：Param1是返利模板ID，不是条件类型ID。");
    for (kind, target, key) in [("3", "shoptypeprop", "ShopType"), ("4", "boxprop", "Provence")] {
        b.add("goodssourceprop", "Param", target, key, Some(ReferenceParser::Token { delimiter: ",".into(), index: 0 }),
            vec![guard("Type", &[kind])], "ItemSourceMgr.createSourceData：只取Param逗号列表第一项；Type=3对应商店类型，Type=4对应宝箱的Provence分类，不是BoxID。");
    }
    for (source, column) in [
        ("activemodelprop", "P5"),
        ("comnpcshowprop", "P5"),
        ("guideshowprop", "P5"),
        ("teamupbosshardlvlprop", "Action"),
        ("wikiprop", "Image"),
    ] {
        b.add(
            source,
            column,
            "heroprop",
            "ID",
            Some(ReferenceParser::Prefixed {
                prefix: "npc_".into(),
                delimiter: Some(",".into()),
                index: Some(0),
            }),
            Vec::new(),
            "立绘动画参数：首项以 npc_ 开头时，去掉 npc_ 前缀后的编号对应 heroprop.ID；纯数字图片和后续缩放/偏移参数不参与匹配。",
        );
    }
    // Language overlays share the base identity, not the resource/text values.
    for table in snapshot.tables.values() {
        let Some((base, suffix)) = table.name.rsplit_once('_') else { continue };
        if !matches!(suffix, "en" | "kr") || base != "vipbuyprop" { continue; }
        for key in &table.primary_keys {
            b.add(&table.name, key, base, key, None, Vec::new(), "决胜2语言表：按标识对应主表，不按翻译文本建立引用。");
        }
    }
    b.rules
}

/// Known non-key mentions and superseded contracts. Keep manual review
/// history visible but disabled; auto-confirmed old guesses must not revive.
pub fn suppressed(key: &RelationKey) -> bool {
    let source = key.source_table.as_str();
    let column = key.source_column.to_ascii_lowercase();
    let target = key.target_table.as_str();
    if source.starts_with("act") && column == "modelid"
        && matches!(target, "conditionactiveprop" | "activecondprop") { return true; }
    if matches!(source, "act25duolun2prop" | "act31duolun2prop" | "limitgiftbagcondprop")
        && column.starts_with("param") && matches!(target, "conditionprop" | "conditionvipprop") { return true; }
    if source == "taskprop" && column == "tasktype" && target == "taskshowprop" {
        return !key.target_column.eq_ignore_ascii_case("TaskType");
    }
    matches!((source, column.as_str(), target),
        ("act215tianjie4prop", "type", "act215tianjie3prop")
        | ("act31duolun1prop", "encmodelid", "act25duolun2prop")
        | ("act31duolun2prop", "encmodelid", "act25duolun1prop")
        | ("act51fengwang2prop", "need", "confengwangtypeprop")
        | ("activebaseprop", "ignoreactivedelayday", "delayopenbaseprop")
        | ("vipmonthcardprop", "activategoodid", "vipbaseprop")
        | ("headprop", "pictureid", "heroprop")
        | ("act309surqiyue3prop", "encp1" | "encsouln", "heroprop")
        | ("act309surqiyue4prop", "encsouln", "heroprop")
        | ("orderrewardprop", "neednum", "orderprop")
        | ("activecondprop", "itemtitle", "activesingleprop")
        | ("activesingleprop", "itemtitle", "activecondprop")
        | ("act51fengwang1prop", "text", "act51fengwang2prop")
        | ("goodssourceprop", "des", "shoptypeprop")
        | ("altarsuggestbuyprop", "type", "shoptypeprop" | "vipshopprop")
        | ("activecondprop", "condid", "activesingleprop")
        | ("activegroupprop", "groupid", "activebaseprop")
        | ("activesingleprop", "singleid", "activebaseprop" | "activegroupprop")
        | ("activemodpopprop", "popid", "activebaseprop")
        | ("condmodelactivedesprop", "frameid", "activemodelprop")
        | ("act217mitu4prop", "littlemid", "act217mitu2prop")
        | ("tasksimplifyprop", "sourceid", "goodssourceprop"))
        || (source == "limitgiftbagencprop" && column == "themeid" && target == "comnpcshowprop"
            && key.target_column.eq_ignore_ascii_case("ID"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::catalog::test_support::{snapshot, table};
    use std::collections::HashMap;

    #[test]
    fn source_category_uses_only_the_selected_family_and_first_parameter() {
        let db = snapshot(vec![
            table("goodssourceprop", &[("Type", "int", "", false), ("Param", "text", "", false)]),
            table("boxprop", &[("Provence", "int", "", false)]),
            table("shoptypeprop", &[("ShopType", "int", "", false)]),
        ]);
        let rules = rules(&db);
        let row = HashMap::from([("Type".into(), "4".into()), ("Param".into(), "7,900".into())]);
        let matching = rules.iter().filter(|rule| super::super::constraints::matches(&rule.constraints, &row)).collect::<Vec<_>>();
        assert_eq!(matching.len(), 1);
        assert_eq!(matching[0].key.target_table, "boxprop");
        assert_eq!(matching[0].parser.as_ref().unwrap().values(&row["Param"]).unwrap(), ["7"]);
    }

    #[test]
    fn correcting_known_documentation_does_not_drop_unrelated_relations() {
        let key = |table: &str, column: &str, target: &str, target_column: &str| RelationKey {
            source_table: table.into(), source_column: column.into(), target_table: target.into(),
            target_column: target_column.into(), kind: RelationKind::Value,
        };
        assert!(suppressed(&key("act309surqiyue3prop", "EncSoulN", "heroprop", "ClipItemID")));
        assert!(!suppressed(&key("otherprop", "Text", "translationprop", "Text")));
        assert!(!suppressed(&key("otherprop", "Param1", "conditionprop", "Type")));
        assert!(!suppressed(&key("taskprop", "TaskType", "taskshowprop", "TaskType")));
        assert!(suppressed(&key("taskprop", "TaskType", "taskshowprop", "Kind")));
    }

    #[test]
    fn npc_portrait_columns_extract_hero_ids_without_matching_plain_images() {
        let db = snapshot(vec![
            table("activemodelprop", &[("CliModelID", "int", "", true), ("P5", "varchar", "", false)]),
            table("heroprop", &[("ID", "smallint", "", true)]),
        ]);
        let found = rules(&db)
            .into_iter()
            .find(|rule| rule.key.source_table == "activemodelprop" && rule.key.source_column == "P5")
            .expect("activemodelprop.P5 rule");
        assert_eq!(found.key.target_table, "heroprop");
        assert_eq!(found.key.target_column, "ID");
        let parser = found.parser.as_ref().expect("prefixed parser");
        assert_eq!(parser.values("npc_1041,70,0,0,0").unwrap(), ["1041"]);
        assert_eq!(parser.values("201,100,0,0,0").unwrap(), Vec::<String>::new());
        assert_eq!(parser.values("0").unwrap(), Vec::<String>::new());
    }
}
