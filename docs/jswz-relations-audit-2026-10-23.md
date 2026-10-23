# 决胜2 4区字段关联逐表核查

- 导出时间：2026-10-23T09:01:47.586Z 至 2026-10-23T09:02:28.023Z。
- 范围：newsg_4cfg，336张表、2893列、140196行；读取错误0项。
- 关系：1230条；对比本轮优化前的同库基线1125条，新增172条、移除67条。同一条关系的解析方式修正不重复计入新增。
- 客户端：扫描1771个源文件；本次只读副本清单SHA-256：`90232d93f7cef80a617feb87015aa078a2d07421fb157e28908cf846db67ffc8`。
- 数据库正在使用中，导出不是事务冻结快照；核对期间月影登楼两张表被清空，已重读后重跑。客户端也在更新，验收扫描使用本次只读副本，未修改客户端。
- 核查范围是每张表的结构、注释、客户端静态读取和完整导出数据。遍历全部表不等于证明全部动态玩法规则；函数、运行时参数和复合上下文明确保留为待核查。

## 重点修正

- 宝箱：BoxID引用物品ID；ItemCfg按物品/核心单位拆分，能够反查产出该物品的宝箱。
- 来源：逗号来源列表逐项匹配；宝箱来源按Provence分类；Param只取客户端使用的第一项，商店与宝箱按Type隔离。
- 活动：模板参数按Kind和CondTypeID限定；限时道具参数仅在对应活动生效；旧活动表名和反向注释不再产生错误引用。
- 格式：阵容嵌套字段、套装二元组、条件前缀、奖励特殊标记各自解析；不把数量、星级、权重、占位P或描述文本当ID。
- 一致性：正向目标、反向数量、展开记录及跳转筛选共用解析和类型限制；反查不再静默截断300条。

## 逐表清单

出/入是字段关系数，不是记录数；增/删仅统计本表作为引用方。待解析是行×关系次数；缺目标也是引用次数，不直接判为配置错误。

| 表 | 行数 | 出 / 入 | 增 / 删 | 待解析 / 缺目标 | 核查备注 |
| --- | ---: | ---: | ---: | ---: | --- |
| `act101zuanshengzuan1prop` | 1 | 6 / 1 | 1 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act101zuanshengzuan2prop` | 55 | 0 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act103hengjingzhuanpan1prop` | 4 | 10 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act103hengjingzhuanpan2prop` | 109 | 1 / 1 | 1 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act103hengjingzhuanpan3prop` | 70 | 0 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act105shuangcengzhuanpan1prop` | 2 | 5 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act105shuangcengzhuanpan2prop` | 4 | 2 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act105shuangcengzhuanpan3prop` | 46 | 4 / 2 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act107beishuzhuanpan1prop` | 1 | 5 / 1 | 1 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途）；不支持格式：Weight, LittleFloorContent, BigFloorContent |
| `act107beishuzhuanpan2prop` | 12 | 4 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act109pinzhizhuanpan1prop` | 1 | 5 / 1 | 1 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act109pinzhizhuanpan2prop` | 18 | 0 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途）；不支持格式：EncFunc, ResetQualityWeight；含函数：EncFunc |
| `act11zhihuan1prop` | 4 | 6 / 1 | 1 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act1shouchong1prop` | 3 | 6 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act1shouchong2prop` | 9 | 4 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act201zhutichoujiang1prop` | 4 | 5 / 2 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act201zhutichoujiang2prop` | 12 | 5 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act203zhanbeichoujiang1prop` | 2 | 11 / 3 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act203zhanbeichoujiang2prop` | 4 | 5 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act203zhanbeichoujiang3prop` | 7 | 5 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act205zixuanchoujiang1prop` | 1 | 3 / 3 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途）；不支持格式：NeedEncFunc, ExtaEncFunc；含函数：NeedEncFunc, ExtaEncFunc |
| `act205zixuanchoujiang2prop` | 2 | 6 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act205zixuanchoujiang3prop` | 2 | 10 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act211denglou1prop` | 0 | 3 / 3 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act211denglou2prop` | 0 | 3 / 2 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途）；不支持格式：NeedEncFunc, ExtaEncFunc |
| `act211denglou3prop` | 0 | 6 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act211denglou4prop` | 0 | 6 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act213baoku1prop` | 0 | 3 / 1 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act213baoku2prop` | 0 | 6 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途）；不支持格式：ExtaEncfunc |
| `act213baoku3prop` | 0 | 5 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act213baoku4prop` | 0 | 5 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act215tianjie1prop` | 1 | 3 / 3 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act215tianjie2prop` | 6 | 3 / 2 | 0 / 0 | 6 / 0 | 未发现客户端读取（不代表无服务端用途）；不支持格式：NeedEncFunc, ExtaEncFunc；含函数：NeedEncFunc, ExtaEncFunc |
| `act215tianjie3prop` | 4 | 6 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act215tianjie4prop` | 27 | 6 / 1 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act217mitu1prop` | 1 | 3 / 3 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act217mitu2prop` | 30 | 8 / 1 | 0 / 0 | 30 / 0 | 未发现客户端读取（不代表无服务端用途）；不支持格式：ExtaEncFunc；含函数：ExtaEncFunc |
| `act217mitu3prop` | 4 | 6 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act217mitu4prop` | 24 | 5 / 2 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act21zhanling1prop` | 828 | 14 / 2 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act21zhanling2prop` | 2760 | 2 / 0 | 0 / 4 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act231bushuleiquan1prop` | 4 | 15 / 3 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act231bushuleiquan2prop` | 88 | 5 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act231bushuleiquan3prop` | 12 | 6 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act233lianxianjiesuo1prop` | 2 | 14 / 2 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act233lianxianjiesuo2prop` | 4 | 2 / 2 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act233lianxianjiesuo3prop` | 52 | 5 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act23mizang1prop` | 3 | 5 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act23mizang2prop` | 42 | 4 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act241jiedianshop1prop` | 15 | 4 / 2 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act241jiedianshop2prop` | 45 | 10 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act25duolun1prop` | 0 | 2 / 0 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act25duolun2prop` | 0 | 0 / 1 | 0 / 3 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act25leiling1prop` | 3 | 3 / 2 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act25leiling2prop` | 12 | 9 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act301ssrzhaomu1prop` | 5 | 4 / 1 | 2 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act301ssrzhaomu2prop` | 1 | 9 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act305urqiyuan1prop` | 5 | 4 / 3 | 2 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act305urqiyuan2prop` | 2 | 10 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act305urqiyuan3prop` | 5 | 5 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act309surqiyue1prop` | 2 | 6 / 4 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act309surqiyue2prop` | 1 | 10 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act309surqiyue3prop` | 5 | 5 / 1 | 0 / 2 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act309surqiyue4prop` | 3 | 5 / 1 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act31duolun1prop` | 8 | 6 / 1 | 1 / 2 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act31duolun2prop` | 20 | 4 / 1 | 0 / 3 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act33lianchong1prop` | 6 | 5 / 2 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act33lianchong2prop` | 20 | 10 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act3shilian1prop` | 24 | 5 / 1 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act501shengxingjihua1prop` | 2 | 2 / 1 | 1 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act501shengxingjihua2prop` | 12 | 9 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act51fengwang1prop` | 3 | 6 / 2 | 0 / 2 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act51fengwang2prop` | 14 | 5 / 1 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act53xuyuanshu1prop` | 4 | 10 / 1 | 1 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途）；不支持格式：FirstFloor |
| `act53xuyuanshu2prop` | 32 | 4 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act55qiandao1prop` | 8 | 9 / 1 | 1 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act55qiandao2prop` | 98 | 4 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act7jifen1prop` | 70 | 9 / 16 | 1 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `act9zaixian1prop` | 6 | 4 / 1 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `actclosebetarebatemodelprop` | 4 | 8 / 1 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `activebaseprop` | 33 | 4 / 0 | 0 / 1 | 30 / 1 | 未发现客户端读取（不代表无服务端用途）；不支持格式：ItemSrc |
| `activecondprop` | 132 | 49 / 3 | 37 / 2 | 0 / 3 | 未发现客户端读取（不代表无服务端用途） |
| `activegroupprop` | 45 | 2 / 1 | 0 / 1 | 0 / 11 | 未发现客户端读取（不代表无服务端用途） |
| `activemodelprop` | 5 | 3 / 3 | 0 / 0 | 0 / 4 | 未发现客户端读取（不代表无服务端用途） |
| `activemodpopprop` | 3 | 1 / 1 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `activesingleprop` | 64 | 5 / 2 | 0 / 3 | 0 / 3 | 未发现客户端读取（不代表无服务端用途） |
| `alliancesprop` | 24 | 3 / 0 | 0 / 0 | 0 / 0 | 5处读取来源待追踪；不支持格式：AdditionRatio；含函数：AdditionRatio |
| `altardrawprop` | 5 | 14 / 0 | 2 / 0 | 0 / 0 | 12处读取来源待追踪；不支持格式：SmallLoopFirstNum, MidlLoopFirstNum, LargeLoopFirstNum |
| `altarfmtencprop` | 10 | 6 / 0 | 0 / 0 | 0 / 0 | 1处读取来源待追踪；不支持格式：HeroTxt |
| `altarscoreprop` | 8 | 6 / 0 | 0 / 0 | 0 / 0 | 17处读取来源待追踪 |
| `altarsuggestbuyprop` | 12 | 4 / 0 | 2 / 2 | 0 / 0 | 3处读取来源待追踪 |
| `altarxjdrawprop` | 2 | 8 / 0 | 4 / 0 | 0 / 0 | 1处读取来源待追踪；不支持格式：Wish2ShipFunc；含函数：Wish2ShipFunc |
| `altarxjmodelencprop` | 48 | 5 / 0 | 0 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `antiqueattrprop` | 10 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；不支持格式：AttrFunc；含函数：AttrFunc |
| `antiquebaseattrprop` | 24 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `antiquesuitattrprop` | 24 | 0 / 2 | 0 / 0 | 0 / 0 | 不支持格式：AttrFunc；含函数：AttrFunc |
| `arenachlgencprop` | 82 | 4 / 0 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `arenanpcprop` | 36 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途）；不支持格式：Fmt；含函数：Fmt |
| `arenatypeprop` | 3 | 10 / 0 | 2 / 0 | 0 / 0 | 8处读取来源待追踪；不支持格式：ChlgLstFunc；含函数：ChlgLstFunc |
| `assistprop` | 28 | 1 / 0 | 1 / 0 | 0 / 21 | 未发现客户端读取（不代表无服务端用途） |
| `atlaslvlprop` | 600 | 1 / 0 | 1 / 0 | 0 / 0 | 2处读取来源待追踪 |
| `atlasstarprop` | 18 | 6 / 0 | 1 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `atlastypeprop` | 4 | 4 / 0 | 0 / 0 | 0 / 0 | 11处读取来源待追踪 |
| `attrkindprop` | 74 | 0 / 11 | 0 / 0 | 0 / 0 | 7处读取来源待追踪；不支持格式：ToPowerConvFactor；含函数：ToPowerConvFactor |
| `boxprop` | 300 | 5 / 2 | 0 / 0 | 0 / 0 | 15处读取来源待追踪 |
| `buildopenplatprop` | 11 | 1 / 0 | 1 / 0 | 0 / 6 | 未发现客户端读取（不代表无服务端用途） |
| `buildopenprop` | 134 | 6 / 30 | 1 / 0 | 0 / 97 | 77处读取来源待追踪 |
| `buildopenzoneprop` | 38 | 1 / 5 | 1 / 0 | 0 / 0 | 75处读取来源待追踪 |
| `callerprop` | 45 | 1 / 1 | 1 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `challengeentranceprop` | 10 | 1 / 0 | 1 / 0 | 0 / 0 | 2处读取来源待追踪 |
| `challenginskindprop` | 4 | 6 / 0 | 0 / 0 | 0 / 0 | 5处读取来源待追踪 |
| `challenginsprop` | 472 | 9 / 0 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `chatbanexprop` | 4 | 0 / 1 | 0 / 0 | 0 / 0 | 不支持格式：BanTime, BanAddTime；含函数：BanTime, BanAddTime |
| `chatbaseprop` | 1 | 1 / 0 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `chatsysprop` | 74 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；2处读取来源待追踪；不支持格式：Text |
| `comgrowthtypeprop` | 247 | 0 / 7 | 0 / 0 | 0 / 0 | 60处读取来源待追踪 |
| `comgrowthunitopenprop` | 27 | 1 / 0 | 0 / 0 | 27 / 0 | 未发现客户端读取（不代表无服务端用途）；不支持格式：ID |
| `commonprop` | 1 | 1 / 2 | 0 / 0 | 0 / 0 | 不支持格式：FmtURLimitNum, FmtURLimitFunc；含函数：FmtURLimitFunc |
| `comnpcshow2prop` | 407 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `comnpcshowprop` | 42 | 0 / 2 | 0 / 0 | 0 / 0 | 4处读取来源待追踪 |
| `condguideeventprop` | 60 | 0 / 2 | 0 / 0 | 0 / 0 | 不支持格式：UINode |
| `conditionactiveprop` | 39 | 0 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `conditionopencondprop` | 15 | 0 / 73 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途）；不支持格式：Desc2 |
| `conditionplatprop` | 3 | 0 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `conditionprop` | 241 | 0 / 11 | 0 / 0 | 0 / 0 | 2处读取来源待追踪 |
| `conditionunionprop` | 14 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `conditionvipprop` | 52 | 4 / 4 | 0 / 0 | 0 / 0 | 不支持格式：BuyFunc；含函数：BuyFunc |
| `condjumpprop` | 117 | 0 / 4 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `condmodelactivedesprop` | 83 | 0 / 2 | 0 / 1 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `confengwangtypeprop` | 41 | 0 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `delayopenbaseprop` | 4 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `delayopenzoneprop` | 65 | 1 / 0 | 1 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `dungeonexplorebaseprop` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途）；不支持格式：BattleRewardFunc, HighBattleRewardFunc；含函数：BattleRewardFunc, HighBattleRewardFunc |
| `dungeonexplorebossskillprop` | 24 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `dungeonexploredifficultyprop` | 2 | 6 / 0 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途）；不支持格式：TempLvl, TempSID；含函数：TempLvl, TempSID |
| `dungeonexplorenodeprop` | 9 | 0 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `dungeonexploreroadprop` | 18 | 1 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `dungeonexploreshopprop` | 6 | 9 / 0 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `etowerbaseprop` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；不支持格式：FirstPassRewardFunc；含函数：FirstPassRewardFunc |
| `etowerbreakrewardprop` | 100 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；4处读取来源待追踪；不支持格式：BreakRewardFunc；含函数：BreakRewardFunc |
| `etowerdailyrewardprop` | 5 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；不支持格式：GetEncByLayerFunc；含函数：GetEncByLayerFunc |
| `etowernpcpower` | 8004 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `etowernpcprop` | 10000 | 4 / 0 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `etowernpcversion_legacy_1788695428763` | 1 | 1 / 0 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `evilbaseprop` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；不支持格式：SlowReward, HighReward, KillScoreFunc；含函数：SlowReward, HighReward, KillScoreFunc |
| `evilinshighprop` | 25 | 1 / 0 | 1 / 0 | 0 / 0 | 不支持格式：HelpPerFunc, TempLvl；含函数：HelpPerFunc, TempLvl |
| `evilinslowprop` | 25 | 1 / 0 | 1 / 0 | 0 / 0 | 不支持格式：TempLvl；含函数：TempLvl |
| `fazhenprop` | 7 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；不支持格式：AddAttrFunc, LvlUpCostFunc, LvlUpNeedPFunc, LvlUpNeedMainFunc；含函数：AddAttrFunc, LvlUpCostFunc, LvlUpNeedPFunc, LvlUpNeedMainFunc |
| `fmtkindprop` | 60 | 1 / 0 | 1 / 0 | 0 / 0 | 25处读取来源待追踪 |
| `forestsecretlandbaseprop` | 1 | 1 / 0 | 1 / 0 | 0 / 0 | 不支持格式：RobFunc, RobFailFunc, AddFunc；含函数：RobFunc, RobFailFunc, AddFunc |
| `forestsecretlandchlgprop` | 44 | 5 / 0 | 1 / 0 | 0 / 0 | 15处读取来源待追踪 |
| `forestsecretlandmineprop` | 44 | 9 / 0 | 1 / 0 | 0 / 0 | 25处读取来源待追踪 |
| `friendsbaseprop` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系 |
| `giftoptionalprop` | 495 | 6 / 180 | 0 / 0 | 0 / 0 | 8处读取来源待追踪 |
| `goodscheckactprop` | 2 | 1 / 0 | 1 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `goodscheckprop` | 6 | 1 / 0 | 1 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `goodscomponekeyprop` | 112 | 1 / 0 | 0 / 0 | 0 / 0 | 6处读取来源待追踪 |
| `goodscompprop` | 3571 | 6 / 0 | 2 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `goodsdecomposeprop` | 3510 | 6 / 0 | 1 / 0 | 0 / 0 | 8处读取来源待追踪 |
| `goodskindprop` | 55 | 2 / 3 | 0 / 0 | 0 / 4 | 2处读取来源待追踪 |
| `goodsprop` | 4807 | 5 / 217 | 0 / 0 | 0 / 0 | 128处读取来源待追踪 |
| `goodssourceprop` | 92 | 5 / 2 | 2 / 1 | 0 / 66 | 1处读取来源待追踪 |
| `goodstransprop` | 65 | 5 / 0 | 1 / 0 | 0 / 0 | 2处读取来源待追踪 |
| `growupbaseprop` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系 |
| `growupfmtmodelprop` | 983 | 13 / 11 | 13 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `growupscoreprop` | 16 | 2 / 0 | 0 / 0 | 0 / 22 | 不支持格式：ScoreFunc；含函数：ScoreFunc |
| `growuptempprop` | 2001 | 2 / 4 | 2 / 0 | 2 / 0 | 不支持格式：StarInfo, ArtifactInfo, LvlInfo, HeroEquipInfo, SacEquipInfo, MountEquipInfo, PetEquipInfo, HeroForgeInfo, AtlasInfo, AllianceInfo, SolderInfo, GroupArtifactInfo, FazhenInfo, PlanetariumInfo, ArmorySkinInfo, SoulTreeInfo, AntiqueInfo, AncientToolInfo |
| `guidebaseprop` | 1 | 6 / 0 | 2 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `guidecutsceneprop` | 18 | 2 / 1 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `guidedetailprop` | 38 | 5 / 1 | 1 / 0 | 52 / 0 | 不支持格式：ShowIDP1 |
| `guideprop` | 7 | 3 / 4 | 1 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `guideshowprop` | 15 | 0 / 2 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `headprop` | 22 | 1 / 0 | 0 / 1 | 0 / 0 | 18处读取来源待追踪 |
| `heroartifactforgeprop` | 201 | 4 / 0 | 0 / 0 | 0 / 0 | 7处读取来源待追踪；不支持格式：AttrFunc；含函数：AttrFunc |
| `heroartifactskilldesprop` | 268 | 1 / 0 | 1 / 0 | 0 / 12 | 2处读取来源待追踪 |
| `heroartifactstarprop` | 71 | 1 / 0 | 0 / 0 | 0 / 0 | 23处读取来源待追踪；不支持格式：AttrFunc, MajorNodeAttrFunc, UpStarPreviewText；含函数：AttrFunc, MajorNodeAttrFunc |
| `heroartifactwashbaseprop` | 1 | 1 / 0 | 0 / 0 | 0 / 0 | 不支持格式：WashCostFunc, FloorRuleFunc；含函数：WashCostFunc, FloorRuleFunc |
| `heroartifactwashquaprop` | 24 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；9处读取来源待追踪 |
| `herocampstifleprop` | 4 | 2 / 1 | 2 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `herocommprop` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；不支持格式：RebornCost, SameHeroConvert, LvlAttrFunc, CareerAttr, StarLimitFunc, StrengthenCost, StrengthenAttrFunc, SkillIDFunc, TaskAddAttrFunc；含函数：RebornCost, SameHeroConvert, LvlAttrFunc, CareerAttr, StarLimitFunc, StrengthenCost, StrengthenAttrFunc, SkillIDFunc, TaskAddAttrFunc |
| `heroequipprop` | 120 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；2处读取来源待追踪；不支持格式：AttrFunc；含函数：AttrFunc |
| `heroequipsuitattrprop` | 20 | 1 / 0 | 1 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `herogemprop` | 60 | 1 / 0 | 0 / 0 | 0 / 0 | 2处读取来源待追踪；不支持格式：AttrFunc, ExclusiveAttrFunc；含函数：AttrFunc, ExclusiveAttrFunc |
| `heroprop` | 493 | 9 / 245 | 4 / 0 | 0 / 0 | 378处读取来源待追踪 |
| `heroskillupprop` | 18 | 0 / 1 | 0 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `heroskinprop` | 13 | 3 / 1 | 2 / 0 | 0 / 2 | 11处读取来源待追踪 |
| `herostarprop` | 118 | 1 / 0 | 0 / 0 | 0 / 0 | 23处读取来源待追踪；不支持格式：CostFunc, AttrFunc；含函数：CostFunc, AttrFunc |
| `heroupgradeprop` | 2001 | 4 / 0 | 0 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `ins1prop` | 7025 | 12 / 5 | 3 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途）；不支持格式：Fmt |
| `ins2prop` | 7025 | 11 / 6 | 3 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途）；不支持格式：Fmt |
| `ins3prop` | 7025 | 11 / 4 | 3 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途）；不支持格式：Fmt |
| `ins4prop` | 7025 | 11 / 3 | 3 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途）；不支持格式：Fmt |
| `ins5prop` | 1679 | 11 / 16 | 3 / 0 | 0 / 0 | 1处读取来源待追踪；不支持格式：Fmt, MineSkill, EnemySkill |
| `inschapterprop` | 1440 | 2 / 1 | 0 / 0 | 0 / 0 | 43处读取来源待追踪 |
| `insfirstpassrewardprop` | 4 | 4 / 0 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `inskindprop` | 39 | 0 / 5 | 0 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `insonhookprop` | 815 | 1 / 0 | 1 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `insonhookspecialrewardprop` | 188 | 1 / 0 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `insonhookspeedupitemprop` | 14 | 2 / 0 | 2 / 0 | 0 / 0 | 4处读取来源待追踪 |
| `insplacebaseprop` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；不支持格式：CostDia, GetOnhookWeightFunc, ChapterPassEncFunc, ChapterDropEncFunc；含函数：CostDia, GetOnhookWeightFunc, ChapterPassEncFunc, ChapterDropEncFunc |
| `instestprop` | 28 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `langcharrangeprop` | 3 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；2处读取来源待追踪；不支持格式：CharRange, Dsc |
| `limitgiftbagcondprop` | 216 | 4 / 1 | 0 / 6 | 0 / 0 | 38处读取来源待追踪 |
| `limitgiftbagencprop` | 425 | 10 / 1 | 1 / 1 | 425 / 0 | 31处读取来源待追踪；不支持格式：ThemeID |
| `loadingtipsprop` | 41 | 1 / 0 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `magicstoneescortbaseprop` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `magicstoneescortguardprop` | 52 | 20 / 1 | 1 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `mailcontentprop` | 25 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；2处读取来源待追踪 |
| `mailplayerlvlprop` | 17 | 5 / 0 | 1 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `maincityentranceprop` | 24 | 3 / 1 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `mountartifactstarprop` | 71 | 1 / 0 | 0 / 0 | 0 / 0 | 22处读取来源待追踪；不支持格式：AttrFunc, MajorNodeAttrFunc；含函数：AttrFunc, MajorNodeAttrFunc |
| `mountcommprop` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；不支持格式：RebornCost, SameMountConvert, BeMountAttrFunc, BeMountLimitFunc, SkillIDFunc, LvlAttrFunc, StarLimitFunc, StrengthenCost, StrengthenAttrFunc, Skill2AttrFunc；含函数：RebornCost, SameMountConvert, BeMountAttrFunc, BeMountLimitFunc, SkillIDFunc, LvlAttrFunc, StarLimitFunc, StrengthenCost, StrengthenAttrFunc, Skill2AttrFunc |
| `mountequipprop` | 120 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；2处读取来源待追踪；不支持格式：AttrFunc；含函数：AttrFunc |
| `mountequipsuitattrprop` | 20 | 1 / 0 | 1 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `mountgemattrprop` | 13 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；3处读取来源待追踪；不支持格式：AttrVal；含函数：AttrVal |
| `mountgemposprop` | 143 | 1 / 1 | 0 / 0 | 0 / 0 | 17处读取来源待追踪 |
| `mountgemprop` | 50 | 1 / 0 | 0 / 0 | 0 / 0 | 2处读取来源待追踪；不支持格式：AttrFunc, ExclusiveAttrFunc；含函数：AttrFunc, ExclusiveAttrFunc |
| `mountskilllvlprop` | 18 | 0 / 1 | 0 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `mountstarprop` | 118 | 1 / 0 | 0 / 0 | 0 / 0 | 19处读取来源待追踪；不支持格式：CostFunc, AttrFunc；含函数：CostFunc, AttrFunc |
| `mountupgradeprop` | 2001 | 4 / 0 | 0 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `netdbdealtimeprop` | 4 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `nicknamefilterprop` | 67 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `nicknamefilterprop_en` | 67 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `nicknamepoolprop` | 303 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `nicknamepoolprop_en` | 303 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `onekeycultivateprogressprop` | 4 | 9 / 0 | 5 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `oplogskipnetcmdprop` | 8 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `orderprop` | 3 | 11 / 0 | 2 / 0 | 0 / 0 | 7处读取来源待追踪 |
| `orderrewardopenprop` | 5 | 2 / 1 | 0 / 0 | 0 / 0 | 2处读取来源待追踪 |
| `orderrewardprop` | 125 | 8 / 0 | 0 / 1 | 0 / 0 | 9处读取来源待追踪 |
| `petcommprop` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；不支持格式：RebornCost, SamePetConvert, BePetAttrFunc, BePetLimitFunc, SkillIDFunc, LvlAttrFunc, StarLimitFunc, PreFmtCareerLst, StrengthenCost, StrengthenAttrFunc；含函数：RebornCost, SamePetConvert, BePetAttrFunc, BePetLimitFunc, SkillIDFunc, LvlAttrFunc, StarLimitFunc, StrengthenCost, StrengthenAttrFunc |
| `petequipprop` | 120 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；2处读取来源待追踪；不支持格式：AttrFunc；含函数：AttrFunc |
| `petequipsuitattrprop` | 20 | 1 / 0 | 1 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `petevolveattrprop` | 142 | 1 / 0 | 0 / 0 | 0 / 0 | 31处读取来源待追踪；不支持格式：AttrFunc, MajorNodeAttrFunc；含函数：AttrFunc, MajorNodeAttrFunc |
| `petevolvekilllvlprop` | 30 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；2处读取来源待追踪 |
| `petevolveprop` | 54 | 3 / 0 | 0 / 0 | 0 / 0 | 2处读取来源待追踪 |
| `petgemposprop` | 37 | 2 / 0 | 0 / 0 | 0 / 12 | 16处读取来源待追踪；不支持格式：EnergyVal, BaseAttr, SpeAttr, UpgradeEnergy；含函数：EnergyVal, BaseAttr, SpeAttr, UpgradeEnergy |
| `petgemprop` | 50 | 1 / 0 | 0 / 0 | 0 / 0 | 2处读取来源待追踪；不支持格式：AttrFunc, ExclusiveAttrFunc；含函数：AttrFunc, ExclusiveAttrFunc |
| `petskilllvlprop` | 18 | 0 / 1 | 0 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `petstarprop` | 118 | 1 / 0 | 0 / 0 | 0 / 0 | 19处读取来源待追踪；不支持格式：CostFunc, AttrFunc；含函数：CostFunc, AttrFunc |
| `petupgradeprop` | 2001 | 4 / 0 | 0 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `planegrouppointprop` | 405 | 1 / 1 | 1 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `planepointattrprop` | 18 | 0 / 1 | 0 / 0 | 0 / 0 | 不支持格式：Attr, PointCost, GetStarSoulFunc；含函数：Attr, PointCost, GetStarSoulFunc |
| `planestairsshowprop` | 300 | 1 / 0 | 1 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `planetariumbaseprop` | 1 | 2 / 0 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `platspecfgtable` | 0 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `playerdefaultcfgprop` | 1 | 8 / 0 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `playerlvladdprop` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；不支持格式：LocalAddFunc, CrossAddFunc；含函数：LocalAddFunc, CrossAddFunc |
| `playerupgradeprop` | 200 | 4 / 0 | 0 / 0 | 0 / 0 | 3处读取来源待追踪 |
| `pvpsyncversion` | 1 | 1 / 0 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `pvptypedpsprop` | 34 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；1处读取来源待追踪 |
| `ranklistprop` | 47 | 2 / 0 | 0 / 0 | 0 / 43 | 23处读取来源待追踪 |
| `relicbaseprop` | 1 | 1 / 0 | 1 / 0 | 0 / 0 | 不支持格式：RelicRefreshFunc, HighRelicRefreshFunc, BattleRewardFunc, HighBattleRewardFunc；含函数：RelicRefreshFunc, HighRelicRefreshFunc, BattleRewardFunc, HighBattleRewardFunc |
| `relicdifficultyprop` | 152 | 8 / 0 | 0 / 0 | 0 / 0 | 3处读取来源待追踪；不支持格式：TempLvl, TempSID, ExtAddAndDedHurtPerFunc；含函数：TempLvl, TempSID, ExtAddAndDedHurtPerFunc |
| `relicnodeprop` | 14 | 0 / 1 | 0 / 0 | 0 / 0 | 9处读取来源待追踪；不支持格式：Param2；含函数：Param2 |
| `relicprop` | 188 | 1 / 1 | 0 / 0 | 0 / 0 | 13处读取来源待追踪；不支持格式：P1；含函数：P1 |
| `relicroadprop` | 240 | 1 / 1 | 0 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `relicshopprop` | 108 | 9 / 0 | 0 / 0 | 0 / 0 | 3处读取来源待追踪 |
| `sacspiritartifactstarprop` | 71 | 1 / 0 | 0 / 0 | 0 / 0 | 22处读取来源待追踪；不支持格式：AttrFunc, MajorNodeAttrFunc；含函数：AttrFunc, MajorNodeAttrFunc |
| `sacspiritcommprop` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；不支持格式：RebornCost, SameSpiritConvert, BeMountAttrFunc, BeMountLimitFunc, SkillIDFunc, LvlAttrFunc, StarLimitFunc, StrengthenCost, StrengthenAttrFunc；含函数：RebornCost, SameSpiritConvert, BeMountAttrFunc, BeMountLimitFunc, SkillIDFunc, LvlAttrFunc, StarLimitFunc, StrengthenCost, StrengthenAttrFunc |
| `sacspiritequipprop` | 120 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；2处读取来源待追踪；不支持格式：AttrFunc；含函数：AttrFunc |
| `sacspiritequipsuitattrprop` | 20 | 1 / 0 | 1 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `sacspiritgridprop` | 50 | 1 / 0 | 0 / 0 | 0 / 0 | 2处读取来源待追踪；不支持格式：AttrFunc, ExclusiveAttrFunc；含函数：AttrFunc, ExclusiveAttrFunc |
| `sacspiritgridunlockprop` | 32 | 1 / 0 | 0 / 0 | 0 / 0 | 6处读取来源待追踪 |
| `sacspiritskilllvlprop` | 18 | 0 / 1 | 0 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `sacspiritstarprop` | 118 | 1 / 0 | 0 / 0 | 0 / 0 | 19处读取来源待追踪；不支持格式：CostFunc, AttrFunc；含函数：CostFunc, AttrFunc |
| `sacspiritupgradeprop` | 2001 | 4 / 0 | 0 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `shopaltarprop` | 177 | 9 / 0 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `shoparenanprop` | 160 | 10 / 0 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `shopdiaprop` | 104 | 10 / 0 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `shopprop` | 10 | 9 / 0 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `shoprelicprop` | 86 | 9 / 0 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `shoptypeprop` | 16 | 3 / 3 | 0 / 0 | 0 / 0 | 17处读取来源待追踪 |
| `skillaninameprop` | 164 | 1 / 0 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `skillbuffdesprop` | 69 | 0 / 1 | 0 / 0 | 0 / 0 | 不支持格式：Param2, Param3, Param4 |
| `skillconditionprop` | 18 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `skilldataprop` | 2516 | 1 / 12 | 1 / 0 | 0 / 0 | 不支持格式：Passive, MidConfig, PreExtend, MidExtend, LastExtend, FirstUse, CD, KillEffect |
| `skilldecprop` | 2516 | 1 / 0 | 1 / 0 | 0 / 0 | 18处读取来源待追踪；不支持格式：PreViewDesc, Notes |
| `skillkillmpprop` | 2 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系 |
| `skillprop` | 2516 | 5 / 0 | 4 / 0 | 40 / 0 | 3处读取来源待追踪；不支持格式：Power, V1_Value, V2_Value, V3_Value, L_Value, R_Value, S_Value, K1_Value, K2_Value, Target1, Target2, Target3, RepeatHurt, NormalControl, HurtControl, SceneBuff；含函数：Power, V1_Value, V2_Value, V3_Value, L_Value, R_Value, S_Value, K1_Value, K2_Value |
| `skyarenabaseprop` | 1 | 8 / 0 | 2 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途）；不支持格式：ScoreChangeFunc, ChallEncFunc；含函数：ScoreChangeFunc, ChallEncFunc |
| `skyarenarankencprop` | 31 | 4 / 0 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `skyarenascoreprop` | 36 | 1 / 0 | 1 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `soultreeattrprop` | 7 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；不支持格式：AttrFunc；含函数：AttrFunc |
| `soultreebaseprop` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；不支持格式：ShipFunc；含函数：ShipFunc |
| `swararenagradeprop` | 12 | 4 / 0 | 0 / 0 | 0 / 12 | 未发现客户端读取（不代表无服务端用途） |
| `swarbaseprop` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途）；不支持格式：GetPScore, BackHomeBuyCost；含函数：GetPScore, BackHomeBuyCost |
| `swarchapter1npcprop` | 10 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途）；不支持格式：MainCityDfNpcIns, BigCityDfNpcIns, SmallCityDfNpcIns, GateCityDfNpcIns, InnerCityDfNpcIns, MainChapterOfNpcIns, BigChapterOfNpcIns, SmallChapterOfNpcIns, GateChapterOfNpcIns, InnerChapterOfNpcIns |
| `swarchapter2npcprop` | 10 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途）；不支持格式：MainCityDfNpcIns, BigCityDfNpcIns, SmallCityDfNpcIns, GateCityDfNpcIns, InnerCityDfNpcIns, MainChapterOfNpcIns, BigChapterOfNpcIns, SmallChapterOfNpcIns, GateChapterOfNpcIns, InnerChapterOfNpcIns |
| `swarchapter3npcprop` | 10 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途）；不支持格式：MainCityDfNpcIns, BigCityDfNpcIns, SmallCityDfNpcIns, GateCityDfNpcIns, InnerCityDfNpcIns, MainChapterOfNpcIns, BigChapterOfNpcIns, SmallChapterOfNpcIns, GateChapterOfNpcIns, InnerChapterOfNpcIns |
| `swarchapter4npcprop` | 10 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途）；不支持格式：MainCityDfNpcIns, BigCityDfNpcIns, SmallCityDfNpcIns, GateCityDfNpcIns, InnerCityDfNpcIns, MainChapterOfNpcIns, BigChapterOfNpcIns, SmallChapterOfNpcIns, GateChapterOfNpcIns, InnerChapterOfNpcIns |
| `swarchapter5npcprop` | 10 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途）；不支持格式：MainCityDfNpcIns, BigCityDfNpcIns, SmallCityDfNpcIns, GateCityDfNpcIns, InnerCityDfNpcIns, MainChapterOfNpcIns, BigChapterOfNpcIns, SmallChapterOfNpcIns, GateChapterOfNpcIns, InnerChapterOfNpcIns |
| `swarchapterbaseprop` | 3 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `swarcityroadprop` | 340 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `swarcityroadresprop` | 102 | 1 / 0 | 1 / 0 | 0 / 102 | 未发现客户端读取（不代表无服务端用途） |
| `swarcitys1prop` | 225 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `swarcitys2prop` | 225 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `swarsessionprop` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `tasklvlprop` | 71 | 8 / 0 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `taskpointprop` | 12 | 5 / 0 | 0 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `taskprop` | 142 | 9 / 1 | 2 / 1 | 0 / 0 | 6处读取来源待追踪 |
| `taskshowprop` | 14 | 6 / 1 | 0 / 0 | 0 / 14 | 3处读取来源待追踪 |
| `tasksimplifyprop` | 157 | 4 / 1 | 1 / 1 | 0 / 2 | 11处读取来源待追踪；不支持格式：EncFunc, Param1；含函数：EncFunc, Param1 |
| `teamupbossbaseprop` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系 |
| `teamupbosshardlvlprop` | 55 | 11 / 0 | 2 / 0 | 0 / 0 | 25处读取来源待追踪；不支持格式：BaseRandRewardFunc, HpRandRewardFunc；含函数：BaseRandRewardFunc, HpRandRewardFunc |
| `teamupbosshprewardprop` | 8 | 4 / 1 | 0 / 1 | 0 / 0 | 已逐列检查现有证据 |
| `teamupbossintroprop` | 1 | 1 / 0 | 0 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `textparamtranslateprop` | 22 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途） |
| `vipbaseprop` | 1 | 4 / 0 | 3 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `vipbuy4productidmapingprop` | 0 | 4 / 0 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `vipbuy4productidprop` | 17 | 0 / 3 | 0 / 0 | 0 / 0 | 3处读取来源待追踪 |
| `vipbuyprop` | 285 | 6 / 179 | 0 / 0 | 0 / 0 | 22处读取来源待追踪 |
| `vipbuyprop_kr` | 276 | 1 / 0 | 1 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `vipcrystalcostprop` | 27 | 4 / 0 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `vipdailydealsprop` | 5 | 8 / 0 | 0 / 0 | 0 / 0 | 2处读取来源待追踪 |
| `vipfuncdesprop` | 21 | 1 / 0 | 1 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `vipfuncprop` | 15 | 1 / 0 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `vipgoldprop` | 8 | 8 / 0 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `vipljcontinuercencmodelprop` | 90 | 4 / 2 | 0 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `vipljcontinuercmodelprop` | 6 | 3 / 0 | 1 / 0 | 0 / 0 | 3处读取来源待追踪 |
| `viplvlprop` | 20 | 25 / 0 | 0 / 0 | 0 / 0 | 7处读取来源待追踪 |
| `vipmonthcardpointencprop` | 3 | 4 / 0 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `vipmonthcardprop` | 4 | 17 / 0 | 1 / 1 | 0 / 0 | 4处读取来源待追踪；不支持格式：ExtraReward；含函数：ExtraReward |
| `vipmonthfuncprop` | 12 | 1 / 0 | 0 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `vipshopprop` | 94 | 10 / 1 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `vipshoptypeprop` | 16 | 4 / 0 | 0 / 0 | 0 / 2 | 15处读取来源待追踪 |
| `vipweekcardprop` | 4 | 14 / 1 | 0 / 0 | 0 / 0 | 4处读取来源待追踪 |
| `wikiprop` | 200 | 1 / 0 | 1 / 0 | 0 / 0 | 不支持格式：SuggestFmt1, SuggestFmt2, SuggestMount1, SuggestMount2, SuggestSacspirit1, SuggestSacspirit2, SuggestFmtAlt1, SuggestFmtAlt2 |
| `wordfilterprop` | 22035 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途）；不支持格式：words |
| `wordfilterprop_en` | 17519 | 0 / 0 | 0 / 0 | 0 / 0 | 未建立静态表间关系；未发现客户端读取（不代表无服务端用途）；不支持格式：words |
| `worldbossbaseprop` | 1 | 2 / 0 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |
| `worldbossbattleincreasebuffprop` | 32 | 1 / 0 | 0 / 0 | 0 / 0 | 1处读取来源待追踪 |
| `worldbosshprewardprop` | 40 | 4 / 1 | 0 / 0 | 0 / 0 | 已逐列检查现有证据 |
| `worldbossintroprop` | 12 | 2 / 0 | 1 / 0 | 0 / 0 | 3处读取来源待追踪 |
| `worldbosslvlprop` | 110 | 8 / 0 | 1 / 0 | 0 / 0 | 10处读取来源待追踪；不支持格式：BaseRandRewardFunc, HpRandRewardFunc；含函数：BaseRandRewardFunc, HpRandRewardFunc |
| `worldbossrankrewardprop` | 28 | 4 / 0 | 0 / 0 | 0 / 0 | 未发现客户端读取（不代表无服务端用途） |

## 本轮新增关系

- `act101zuanshengzuan1prop.encmodelid>act101zuanshengzuan2prop.encmodelid`
- `act103hengjingzhuanpan2prop.ratemodelid>act103hengjingzhuanpan3prop.ratemodelid`
- `act107beishuzhuanpan1prop.encmodelid>act107beishuzhuanpan2prop.encmodelid`
- `act109pinzhizhuanpan1prop.encmodelid>act109pinzhizhuanpan2prop.encmodelid`
- `act11zhihuan1prop.locklst>heroprop.id`
- `act301ssrzhaomu1prop.p2>heroprop.id`
- `act301ssrzhaomu1prop.p3>heroprop.id`
- `act305urqiyuan1prop.lastp1lst>heroprop.id`
- `act305urqiyuan1prop.p1lst>heroprop.id`
- `act31duolun1prop.encmodelid>act31duolun2prop.encmodelid`
- `act501shengxingjihua1prop.p1>heroprop.id`
- `act53xuyuanshu1prop.encmodelid>act53xuyuanshu2prop.encmodelid`
- `act55qiandao1prop.encmodelid>act55qiandao2prop.encmodelid`
- `act7jifen1prop.resid>goodsprop.id`
- `activecondprop.jumpid>condjumpprop.jumpid`
- `activecondprop.param1>act101zuanshengzuan1prop.modelid`，仅限 Kind=3 且 CondTypeID=20101
- `activecondprop.param1>act103hengjingzhuanpan1prop.modelid`，仅限 Kind=3 且 CondTypeID=20103
- `activecondprop.param1>act105shuangcengzhuanpan1prop.modelid`，仅限 Kind=3 且 CondTypeID=20105
- `activecondprop.param1>act107beishuzhuanpan1prop.modelid`，仅限 Kind=3 且 CondTypeID=20107
- `activecondprop.param1>act109pinzhizhuanpan1prop.modelid`，仅限 Kind=3 且 CondTypeID=20109
- `activecondprop.param1>act11zhihuan1prop.modelid`，仅限 Kind=3 且 CondTypeID=20011
- `activecondprop.param1>act1shouchong1prop.modelid`，仅限 Kind=3 且 CondTypeID=20001
- `activecondprop.param1>act201zhutichoujiang1prop.modelid`，仅限 Kind=3 且 CondTypeID=20201
- `activecondprop.param1>act203zhanbeichoujiang1prop.modelid`，仅限 Kind=3 且 CondTypeID=20203
- `activecondprop.param1>act205zixuanchoujiang1prop.modelid`，仅限 Kind=3 且 CondTypeID=20205
- `activecondprop.param1>act211denglou1prop.modelid`，仅限 Kind=3 且 CondTypeID=20211
- `activecondprop.param1>act213baoku1prop.modelid`，仅限 Kind=3 且 CondTypeID=20213
- `activecondprop.param1>act215tianjie1prop.modelid`，仅限 Kind=3 且 CondTypeID=20215
- `activecondprop.param1>act217mitu1prop.modelid`，仅限 Kind=3 且 CondTypeID=20217
- `activecondprop.param1>act21zhanling1prop.modelid`，仅限 Kind=3 且 CondTypeID=20021
- `activecondprop.param1>act231bushuleiquan1prop.modelid`，仅限 Kind=3 且 CondTypeID=20231
- `activecondprop.param1>act233lianxianjiesuo1prop.modelid`，仅限 Kind=3 且 CondTypeID=20233
- `activecondprop.param1>act23mizang1prop.modelid`，仅限 Kind=3 且 CondTypeID=20023
- `activecondprop.param1>act241jiedianshop1prop.modelid`，仅限 Kind=3 且 CondTypeID=20241
- `activecondprop.param1>act25leiling1prop.modelid`，仅限 Kind=3 且 CondTypeID=20025
- `activecondprop.param1>act301ssrzhaomu1prop.modelid`，仅限 Kind=3 且 CondTypeID=20301
- `activecondprop.param1>act305urqiyuan1prop.modelid`，仅限 Kind=3 且 CondTypeID=20305
- `activecondprop.param1>act309surqiyue1prop.modelid`，仅限 Kind=3 且 CondTypeID=20309
- `activecondprop.param1>act31duolun1prop.modelid`，仅限 Kind=3 且 CondTypeID=20031
- `activecondprop.param1>act33lianchong1prop.modelid`，仅限 Kind=3 且 CondTypeID=20033
- `activecondprop.param1>act3shilian1prop.modelid`，仅限 Kind=3 且 CondTypeID=20003
- `activecondprop.param1>act501shengxingjihua1prop.modelid`，仅限 Kind=3 且 CondTypeID=20501
- `activecondprop.param1>act51fengwang1prop.modelid`，仅限 Kind=3 且 CondTypeID=20051
- `activecondprop.param1>act53xuyuanshu1prop.modelid`，仅限 Kind=3 且 CondTypeID=20053
- `activecondprop.param1>act55qiandao1prop.modelid`，仅限 Kind=3 且 CondTypeID=20055
- `activecondprop.param1>act7jifen1prop.modelid`，仅限 Kind=3 且 CondTypeID=20007
- `activecondprop.param1>act9zaixian1prop.modelid`，仅限 Kind=3 且 CondTypeID=20009
- `activecondprop.param1>actclosebetarebatemodelprop.modelid`，仅限 Kind=3 且 CondTypeID=25998/25999
- `activecondprop.param2>goodsprop.id`，仅限 Kind=3 且 CondTypeID=20053/20101/20103/20105/20107/20109/20201/20203/20205/20211/20213/20215/20217/20231/20233/20301/20309/20305/20241
- `activecondprop.param3>goodsprop.id`，仅限 Kind=3 且 CondTypeID=20053/20101/20103/20105/20107/20109/20201/20203/20205/20211/20213/20215/20217/20231/20233/20301/20309/20305
- `activecondprop.param4>goodsprop.id`，仅限 Kind=3 且 CondTypeID=20053/20101/20103/20105/20107/20109/20201/20203/20205/20211/20213/20215/20217/20231/20233/20301/20309
- `altardrawprop.firsttarid>heroprop.id`
- `altardrawprop.rerandid>heroprop.id`
- `altarsuggestbuyprop.param1>shoptypeprop.shoptype`，仅限 Type=1
- `altarsuggestbuyprop.param1>vipshopprop.id`，仅限 Type=2
- `altarxjdrawprop.firsturheroid>heroprop.id`
- `altarxjdrawprop.firsturmountid>heroprop.id`
- `altarxjdrawprop.firsturpetid>heroprop.id`
- `altarxjdrawprop.firstursacspiritid>heroprop.id`
- `arenatypeprop.crossguardinsid>ins5prop.id`
- `arenatypeprop.guideinsid>ins5prop.id`
- `assistprop.buildid>buildopenprop.buildid`
- `atlaslvlprop.attr>attrkindprop.attrid`
- `atlasstarprop.attr>attrkindprop.attrid`
- `buildopenplatprop.buildid>buildopenprop.buildid`
- `buildopenprop.openbuildid>buildopenprop.buildid`
- `buildopenzoneprop.buildid>buildopenprop.buildid`
- `callerprop.modelid>heroprop.id`
- `challengeentranceprop.reward>goodsprop.id`
- `delayopenzoneprop.id>heroprop.id`
- `evilinshighprop.insidlst>ins5prop.id`
- `evilinslowprop.insidlst>ins5prop.id`
- `fmtkindprop.buildidlst>buildopenprop.buildid`
- `forestsecretlandbaseprop.crossguardinsid>ins5prop.id`
- `forestsecretlandchlgprop.unlockneedinsid>ins5prop.id`
- `forestsecretlandmineprop.definsid>ins5prop.id`
- `goodscheckactprop.id>goodsprop.id`
- `goodscheckprop.id>goodsprop.id`
- `goodscompprop.destid>goodsprop.id`
- `goodscompprop.frontid>goodsprop.id`
- `goodsdecomposeprop.destid>goodsprop.id`
- `goodssourceprop.param>boxprop.provence`，仅限 Type=4
- `goodssourceprop.param>shoptypeprop.shoptype`，仅限 Type=3
- `goodstransprop.id>goodsprop.id`
- `growupfmtmodelprop.herofmt>heroprop.id`
- `growupfmtmodelprop.petfmtn>heroprop.id`
- `growupfmtmodelprop.petfmtr>heroprop.id`
- `growupfmtmodelprop.petfmtsr>heroprop.id`
- `growupfmtmodelprop.petfmtssr>heroprop.id`
- `growupfmtmodelprop.petfmtsur>heroprop.id`
- `growupfmtmodelprop.petfmtur>heroprop.id`
- `growupfmtmodelprop.sacspiritfmtn>heroprop.id`
- `growupfmtmodelprop.sacspiritfmtr>heroprop.id`
- `growupfmtmodelprop.sacspiritfmtsr>heroprop.id`
- `growupfmtmodelprop.sacspiritfmtssr>heroprop.id`
- `growupfmtmodelprop.sacspiritfmtsur>heroprop.id`
- `growupfmtmodelprop.sacspiritfmtur>heroprop.id`
- `growuptempprop.ancienttoolinfo>antiquesuitattrprop.suitid`
- `growuptempprop.antiqueinfo>antiquesuitattrprop.suitid`
- `guidebaseprop.manualskipguideids>guideprop.guideid`
- `guidebaseprop.manualskipinsid>ins1prop.id`
- `guidedetailprop.guideid>guideprop.guideid`
- `guideprop.preguideid>guideprop.guideid`
- `heroartifactskilldesprop.heroid>heroprop.id`
- `herocampstifleprop.attrid1>attrkindprop.attrid`
- `herocampstifleprop.attrid2>attrkindprop.attrid`
- `heroequipsuitattrprop.equipattr>attrkindprop.attrid`
- `heroprop.attr>attrkindprop.attrid`
- `heroprop.clipitemid>goodsprop.id`
- `heroprop.mappingid>heroprop.id`
- `heroprop.skillid>skilldataprop.heroid`
- `heroskinprop.needgoodsid>goodsprop.id`
- `heroskinprop.skillheroid>skilldataprop.heroid`
- `ins1prop.enemyskill>skilldataprop.heroid`
- `ins1prop.fmt>heroprop.id`
- `ins1prop.mineskill>skilldataprop.heroid`
- `ins2prop.enemyskill>skilldataprop.heroid`
- `ins2prop.fmt>heroprop.id`
- `ins2prop.mineskill>skilldataprop.heroid`
- `ins3prop.enemyskill>skilldataprop.heroid`
- `ins3prop.fmt>heroprop.id`
- `ins3prop.mineskill>skilldataprop.heroid`
- `ins4prop.enemyskill>skilldataprop.heroid`
- `ins4prop.fmt>heroprop.id`
- `ins4prop.mineskill>skilldataprop.heroid`
- `ins5prop.enemyskill>skilldataprop.heroid`
- `ins5prop.fmt>heroprop.id`
- `ins5prop.mineskill>skilldataprop.heroid`
- `insonhookprop.buildid>buildopenprop.buildid`
- `insonhookspeedupitemprop.itemid>goodsprop.id`
- `insonhookspeedupitemprop.speedupidlst>goodsprop.id`
- `limitgiftbagencprop.themeid>comnpcshowprop.themeid`
- `magicstoneescortguardprop.guardinsid>ins5prop.id`
- `mailplayerlvlprop.buidid>buildopenprop.buildid`
- `mountequipsuitattrprop.equipattr>attrkindprop.attrid`
- `onekeycultivateprogressprop.dreaminsid>ins4prop.id`
- `onekeycultivateprogressprop.eliteinsid>ins2prop.id`
- `onekeycultivateprogressprop.guideid>guideprop.guideid`
- `onekeycultivateprogressprop.hardinsid>ins3prop.id`
- `onekeycultivateprogressprop.maininsid>ins1prop.id`
- `orderprop.optionlist>orderrewardopenprop.optionid`
- `orderprop.scoreid>goodsprop.id`
- `petequipsuitattrprop.equipattr>attrkindprop.attrid`
- `planegrouppointprop.pointattrtype>planepointattrprop.pointattrtype`
- `planestairsshowprop.groupshowlst>planegrouppointprop.groupid`
- `relicbaseprop.revivalgoodsid>goodsprop.id`
- `sacspiritequipsuitattrprop.equipattr>attrkindprop.attrid`
- `skilldataprop.heroid>heroprop.id`
- `skilldecprop.heroid>heroprop.id`
- `skillprop.buff>skillbuffdesprop.id`
- `skillprop.caller>callerprop.id`
- `skillprop.changeattr1>attrkindprop.attrid`
- `skillprop.changeattr2>attrkindprop.attrid`
- `skyarenabaseprop.guard2insid>ins5prop.id`
- `skyarenabaseprop.guard3insid>ins5prop.id`
- `skyarenascoreprop.insid>ins5prop.id`
- `swarcityroadresprop.boxid>boxprop.boxid`
- `taskprop.jumpid>condjumpprop.jumpid`
- `taskprop.tasktype>taskshowprop.tasktype`
- `tasksimplifyprop.sourceid>condjumpprop.jumpid`
- `teamupbosshardlvlprop.bossinsid>ins5prop.id`
- `teamupbosshardlvlprop.unlockinsid>ins5prop.id`
- `vipbaseprop.cashcouponid>goodsprop.id`
- `vipbaseprop.cashcouponid2>goodsprop.id`
- `vipbaseprop.cashcouponid3>goodsprop.id`
- `vipbuyprop_kr.pid>vipbuyprop.pid`
- `vipfuncdesprop.vipfid>conditionvipprop.vipfid`
- `vipljcontinuercmodelprop.encmodelid>vipljcontinuercencmodelprop.modelid`
- `vipmonthcardprop.activategoodid>goodsprop.id`
- `wikiprop.id>heroprop.id`
- `worldbossintroprop.insid>ins5prop.id`
- `worldbosslvlprop.guardinsid>ins5prop.id`

## 移除的旧推断

包含被引用说明误读成正向引用、数量误作ID、描述参数误作ID及旧表名。人工确认历史不删除；失去依据的人工关系显示待复核且不继续错误匹配。

- `act201zhutichoujiang1prop.modelid>conditionactiveprop.type`
- `act203zhanbeichoujiang1prop.modelid>conditionactiveprop.type`
- `act205zixuanchoujiang1prop.modelid>conditionactiveprop.type`
- `act211denglou1prop.modelid>conditionactiveprop.type`
- `act213baoku1prop.modelid>conditionactiveprop.type`
- `act215tianjie1prop.modelid>conditionactiveprop.type`
- `act215tianjie4prop.type>act215tianjie3prop.bigmid`
- `act217mitu1prop.modelid>conditionactiveprop.type`
- `act217mitu4prop.littlemid>act217mitu2prop.littlemid1`
- `act21zhanling1prop.modelid>activecondprop.condid`
- `act21zhanling2prop.modelid>activecondprop.condid`
- `act21zhanling2prop.param1>conditionprop.param1`
- `act21zhanling2prop.param2>conditionprop.param2`
- `act21zhanling2prop.param3>conditionprop.param3`
- `act231bushuleiquan1prop.modelid>conditionactiveprop.type`
- `act233lianxianjiesuo1prop.modelid>conditionactiveprop.type`
- `act241jiedianshop1prop.modelid>conditionactiveprop.type`
- `act25duolun1prop.modelid>activecondprop.param1`
- `act25duolun2prop.encmodelid>act25duolun1prop.encmodelid`
- `act25duolun2prop.param2>conditionprop.type`
- `act25duolun2prop.param3>conditionprop.type`
- `act301ssrzhaomu1prop.modelid>conditionactiveprop.type`
- `act305urqiyuan1prop.modelid>conditionactiveprop.type`
- `act309surqiyue1prop.modelid>conditionactiveprop.type`
- `act309surqiyue3prop.encp1>heroprop.id`
- `act309surqiyue3prop.encsouln>heroprop.clipitemid`
- `act309surqiyue4prop.encsouln>heroprop.clipitemid`
- `act31duolun1prop.encmodelid>act25duolun2prop.encmodelid`
- `act31duolun1prop.modelid>activecondprop.param1`
- `act31duolun2prop.encmodelid>act25duolun1prop.encmodelid`
- `act31duolun2prop.param2>conditionprop.type`
- `act31duolun2prop.param3>conditionprop.type`
- `act33lianchong1prop.modelid>activecondprop.param1`
- `act3shilian1prop.param1>conditionprop.param1`
- `act501shengxingjihua1prop.modelid>conditionactiveprop.type`
- `act51fengwang1prop.param>confengwangtypeprop.param`
- `act51fengwang1prop.text>act51fengwang2prop.need`
- `act51fengwang2prop.need>confengwangtypeprop.issmall`
- `act55qiandao1prop.modelid>conditionactiveprop.type`
- `act7jifen1prop.modelid>activecondprop.param1`
- `act9zaixian1prop.modelid>activecondprop.param1`
- `actclosebetarebatemodelprop.modelid>conditionactiveprop.type`
- `activebaseprop.ignoreactivedelayday>delayopenbaseprop.activedelayday`
- `activecondprop.condid>activesingleprop.condaid`
- `activecondprop.itemtitle>activesingleprop.itemtitle`
- `activegroupprop.groupid>activebaseprop.subid`
- `activemodpopprop.popid>activebaseprop.popid`
- `activesingleprop.itemtitle>activecondprop.condid`
- `activesingleprop.singleid>activebaseprop.subid`
- `activesingleprop.singleid>activegroupprop.singleid`
- `altarsuggestbuyprop.type>shoptypeprop.shoptype`
- `altarsuggestbuyprop.type>vipshopprop.id`
- `condmodelactivedesprop.frameid>activemodelprop.frameid`
- `goodssourceprop.des>shoptypeprop.shoptype`
- `headprop.pictureid>heroprop.id`
- `limitgiftbagcondprop.param1>conditionprop.type`
- `limitgiftbagcondprop.param1>conditionvipprop.vipfid`
- `limitgiftbagcondprop.param2>conditionprop.type`
- `limitgiftbagcondprop.param2>conditionvipprop.vipfid`
- `limitgiftbagcondprop.param3>conditionprop.type`
- `limitgiftbagcondprop.param3>conditionvipprop.vipfid`
- `limitgiftbagencprop.themeid>comnpcshowprop.id`
- `orderrewardprop.neednum>orderprop.scoreid`
- `taskprop.tasktype>taskshowprop.kind`
- `tasksimplifyprop.sourceid>goodssourceprop.jumpid`
- `teamupbosshprewardprop.hprewardmodelid>teamupbosshardlvlprop.hprewardmodelid`
- `vipmonthcardprop.activategoodid>vipbaseprop.maxviplvl`

## 尚未证明的部分

- 动态函数不执行；函数内部可能存在更多引用，不以零关系或零命中宣告没有引用。
- 技能组内SkillID、同GroupID的前置星点、赛季城池等需要复合上下文，不能用一个相同数字替代完整条件。
- 没有客户端读取的表可能由服务端或工具使用，未据此删除表或判定废弃。
- 缺目标只说明本次导出的对应键未找到，可能是旧配置、示例数据或变化中的配置；未改库、未补造数据。
- UI验收使用私有导出回放和当前前端；数据库谓词另行在4区只读执行。不是对已安装旧版桌面应用的验收。
