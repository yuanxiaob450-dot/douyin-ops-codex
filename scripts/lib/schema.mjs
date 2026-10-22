// 抖音（抖店 / 电商罗盘 / 巨量千川 / 飞鸽 / 精选联盟）导出文件字段字典。
//
// 设计三条铁律（与淘宝包同源，抖音口径重写）：
//   1) 别名只写「能唯一定位该列的核心词」，绝不写「金额」「数量」这类泛词——
//      泛词会把「支付金额」抢成「花费」，导致交易概况被误判成推广表。
//   2) 平台判定**只看表头**，不看文件名、不看数据单元格：
//      「抖音女装_商品卡.csv」是合法淘宝文件名，而商品标题里出现「抖音同款」也不是平台事实。
//   3) 强特征词（抖店/千川/巨量/随心推…）命中 1 个即判定；弱特征词（抖音/直播间/口碑分…）
//      必须同行表头命中 ≥2 个才判定，因为淘宝直播报表里也会出现「直播间成交金额」。
//
// 别名匹配规则：把表头与别名都做 normalize（去空格/括号内容/单位/大小写/全角转半角）后做包含匹配。
//
// ⚠️ 别名纪律（真实踩过的坑，改动前先读）：
//   ① **不要写裸泛词**。写「商品」会把「商品点击率」「商品访客数」全吃成 productTitle，
//      进而触发 productTitle 的 veto，把店铺级「交易概况」整张表误判成商品级明细。
//      同理不写「计划」「时间」「曝光」「件数」。
//   ② **列级别名必须能唯一区分同形不同义的列**。抖音上「成交金额」在店铺表与千川表里含义不同，
//      因此店铺侧只留「支付GMV/成交GMV」，广告侧只留「广告成交金额/直接成交金额」。
//   ③ 短别名（uv/pv/ctr/roi/gmv）只在**精确相等**时生效，模糊匹配时会被忽略（见 parse.mjs）。

export const COL = {
  // ---------- 时间 ----------
  date: ['日期', '统计日期', '数据日期', 'date'],
  datetime: ['订单创建时间', '下单时间', '创建时间', '支付时间', '付款时间', '成交时间', '支付完成时间'],
  hour: ['小时', '时段', '开播时段'],

  // ---------- 规模与成交（天级/店铺级汇总） ----------
  // 抖音「曝光」优先指商品/内容曝光人数，与淘宝「访客」不是一回事，因此单列。
  impressions: ['曝光人数', '商品曝光人数', '曝光次数', '曝光量', '展现量', '内容曝光人数'],
  visitors: ['商品访客数', '访客数', '商品卡访客数', '店铺访客数', '访客', 'uv'],
  productClicks: ['商品点击次数', '点击次数', '点击量', '商品点击量'],
  ctr: ['商品点击率', '曝光点击率', '点击率', 'ctr'],
  buyers: ['支付买家数', '成交人数', '支付人数', '成交买家数', '下单人数', '买家数'],
  orders: ['支付订单数', '成交订单数', '支付子订单数', '成交单量', '订单数'],
  items: ['支付件数', '成交件数', '支付商品件数'],
  gmv: ['支付gmv', '成交gmv', '支付金额', '成交金额', '销售额', 'gmv'],
  conv: ['支付转化率', '成交转化率', '下单转化率', '转化率'],
  aov: ['客单价', '件单价'],
  uvValue: ['uv价值', '访客价值'],
  // 抖音特有：坑产（单链接/单坑位产出）与净成交口径
  pitGmv: ['坑产', '单坑产出', '坑位产出'],
  netGmv: ['净成交金额', '净成交gmv', '退款后成交金额', '净成交'],

  // ---------- 内容场（短视频 / 直播） ----------
  videoTitle: ['视频标题', '作品标题', '短视频标题', '内容标题'],
  videoId: ['视频id', '作品id', '内容id'],
  playCount: ['播放量', '播放次数', '视频播放量', 'vv'],
  finishRate: ['完播率', '视频完播率'],
  play5sRate: ['5s完播率', '5秒完播率', '3秒完播率', '3s完播率'],
  interactRate: ['互动率', '点赞率', '评论率'],
  likeCount: ['点赞数', '点赞量'],
  commentCount: ['评论数', '评论量'],
  shareCount: ['分享数', '转发数'],
  favCount: ['收藏数', '收藏量'],
  followCount: ['涨粉数', '新增粉丝数', '转粉数'],
  followRate: ['转粉率', '涨粉率'],
  liveTitle: ['直播间名称', '直播场次', '场次', '直播标题'],
  liveDuration: ['直播时长', '开播时长', '时长'],
  watchCount: ['观看人次', '场观', '观看人数', '累计观看人次'],
  avgWatchMin: ['人均观看时长', '平均观看时长', '停留时长'],
  enterRate: ['曝光进入率', '进入率', '直播间进入率'],
  onlineMax: ['最高在线', '在线人数峰值', '最高在线人数'],
  onlineAvg: ['平均在线', '平均在线人数'],
  interactUsers: ['互动人数', '评论人数', '互动人次'],
  gpm: ['gpm', '千次观看成交额', '千次观看成交金额'],
  liveGmv: ['直播间成交金额', '直播成交金额', '直播间gmv'],
  liveOrders: ['直播间成交订单数', '直播成交订单数', '直播间成交单量'],

  // ---------- 商品级 ----------
  productId: ['商品id', '商品编号', '商品spu'],
  productTitle: ['商品标题', '商品名称', '商品名', '商品卡名称'],
  cartUsers: ['加购人数', '加购买家数'],
  cartItems: ['加购件数', '加购数'],
  favUsers: ['收藏人数', '商品收藏人数'],
  stockQty: ['库存数量', '可售库存', '库存'],
  sellThrough: ['动销率', '商品动销率'],
  inPoolRate: ['入池率', '商城入池率'],
  qualityScore: ['商品信息质量分', '质量分', '信息质量分'],
  channel: ['流量来源', '访客来源', '流量渠道', '流量类型', '渠道', '来源'],

  // ---------- 订单级 ----------
  orderId: ['主订单编号', '订单编号', '订单号', '主订单号'],
  subOrderId: ['子订单编号', '子订单号'],
  orderStatus: ['订单状态', '交易状态', '订单状态描述'],
  payTime: ['支付时间', '付款时间', '订单付款时间', '买家付款时间'],
  createTime: ['订单创建时间', '下单时间', '创建时间'],
  buyerNick: ['买家昵称', '用户昵称', '买家账号', '会员名'],
  qty: ['购买数量', '商品数量', '购买件数', '数量'],
  paidAmount: ['买家实际支付金额', '实付金额', '实际支付金额', '买家实付'],
  refundAmount: ['退款金额', '已退款金额', '售后退款金额'],
  refundStatus: ['退款状态', '售后状态'],
  refundReason: ['退款原因', '售后原因', '退款说明'],
  refundType: ['售后类型', '退款类型', '服务类型'],

  // ---------- 推广（巨量千川 / 随心推） ----------
  planName: ['计划名称', '广告计划', '推广计划', '单元名称', '计划'],
  campaignType: ['营销目标', '推广目标', '转化目标', '投放方式'],
  creativeName: ['素材名称', '视频名称', '创意名称'],
  keyword: ['关键词', '搜索词', '关键词名称'],
  cost: ['消耗', '花费', '总消耗', '消耗金额', '推广消耗'],
  // 注意：adGmv 可以含「成交金额」——抖音千川后台的成交列就叫这个名字。
  // 会不会把店铺 GMV 抢走，取决于映射顺序（parse.mjs 里「精确别名优先于模糊别名」）：
  // 店铺表的「支付GMV」是 gmv 的精确别名，会在第一轮就被 gmv 独占，
  // 因此到 adGmv（对「支付GMV」只是模糊命中）时那一列已被占用，抢不走。
  // 真实踩过：早前一轮按分数贪心，adGmv 靠「成交金额」把店铺 GMV 抢走，导致店铺 GMV 为空。
  adGmv: ['成交金额', '广告成交金额', '直接成交金额', '整体成交金额', '千川成交金额'],
  adOrders: ['成交订单数', '广告成交订单数', '直接成交订单数', '千川成交订单数'],
  adCvr: ['成交转化率', '广告成交转化率'],
  roi: ['支付roi', '整体roi', 'roi', '投产比', '净成交roi'],
  cpc: ['平均点击单价', '点击单价', 'cpc'],
  cpm: ['千次展现费用', 'cpm', '平均千次展现费用'],
  adImpressions: ['展现量', '展示次数', '广告曝光量'],
  adClicks: ['点击量', '广告点击量'],
  costPerConv: ['转化成本', '成交成本', '下单成本', '实际转化成本'],

  // ---------- 精选联盟 / 达人 ----------
  talentName: ['达人昵称', '达人名称', '带货达人', '达人'],
  talentId: ['达人id', '达人uid'],
  commissionRate: ['佣金率', '佣金比例', '达人佣金率'],
  commission: ['佣金金额', '佣金支出', '预估佣金'],
  serviceRate: ['服务费率', '服务费'],
  talentGmv: ['达人成交金额', '带货成交金额', '达人gmv'],
  talentOrders: ['达人成交订单数', '带货订单数'],
  talentRefundRate: ['达人退款率', '带货退款率'],
  sampleCount: ['寄样数', '样品数'],

  // ---------- 客服（飞鸽） ----------
  agent: ['客服账号', '客服昵称', '客服', '坐席'],
  reply3min: ['3分钟人工回复率', '3分钟回复率', '三分钟人工回复率', '人工回复率'],
  firstReplySec: ['平均首次响应时长', '首次响应时长', '平均响应时长', '首响时长'],
  satisfaction: ['满意度', '客户满意度', '满意率'],
  consultUsers: ['咨询人数', '咨询量', '接待人数'],
  helpRate: ['平台求助率', '求助率'],
  imResponseRate: ['im回复率', '消息回复率'],

  // ---------- 体验分（抖店商家体验分，2026 为百分制） ----------
  expScore: ['商家体验分', '体验分总分', '店铺体验分', '体验分'],
  expGoods: ['商品体验分', '商品体验', '商品分'],
  expLogistics: ['物流体验分', '物流体验', '物流分'],
  expService: ['服务体验分', '服务体验', '服务分'],
  negFeedback: ['商品负反馈率', '负反馈率', '品退率', '品质退货率'],
  goodRate: ['好评率', '商品好评率'],
  complaintRate: ['投诉率', '纠纷率'],

  // ---------- 履约 ----------
  shipHours: ['发货时长', '平均发货时长', '支付到发货时长'],
  shipRate24h: ['24小时发货率', '24h发货率', '及时发货率'],
  shipRate48h: ['48小时发货率', '48h发货率'],
  pickupRate: ['揽收及时率', '24小时揽收率'],
  signRateField: ['签收率', '妥投率'],
  logisticsAbnormal: ['物流异常单量', '物流异常数'],
  lateShipOrders: ['延迟发货订单数', '超时发货订单数'],

  // ---------- 退款/售后聚合 ----------
  refundRate: ['退款率', '售后退款率', '仅退款率'],
  refundHours: ['退款时长', '平均退款时长', '退款处理时长'],
  aftersaleRate: ['售后率', '售后申请率'],
};

// 统一数字字段
export const NUMERIC_FIELDS = new Set([
  'impressions', 'visitors', 'productClicks', 'ctr', 'buyers', 'orders', 'items', 'gmv', 'conv',
  'aov', 'uvValue', 'pitGmv', 'netGmv', 'playCount', 'finishRate', 'play5sRate', 'interactRate',
  'likeCount', 'commentCount', 'shareCount', 'favCount', 'followCount', 'followRate', 'liveDuration',
  'watchCount', 'avgWatchMin', 'enterRate', 'onlineMax', 'onlineAvg', 'interactUsers', 'gpm',
  'liveGmv', 'liveOrders', 'cartUsers', 'cartItems', 'favUsers', 'stockQty', 'sellThrough',
  'inPoolRate', 'qualityScore', 'qty', 'paidAmount', 'refundAmount', 'cost', 'adGmv', 'adOrders',
  'adCvr', 'roi', 'cpc', 'cpm', 'adImpressions', 'adClicks', 'costPerConv', 'commissionRate',
  'commission', 'serviceRate', 'talentGmv', 'talentOrders', 'talentRefundRate', 'sampleCount',
  'reply3min', 'firstReplySec', 'satisfaction', 'consultUsers', 'helpRate', 'imResponseRate',
  'expScore', 'expGoods', 'expLogistics', 'expService', 'negFeedback', 'goodRate', 'complaintRate',
  'shipHours', 'shipRate24h', 'shipRate48h', 'pickupRate', 'signRateField', 'logisticsAbnormal',
  'lateShipOrders', 'refundRate', 'refundHours', 'aftersaleRate',
]);

// 比例型字段（0.032 / 3.2 / "3.2%" 三种形态都要归一）
export const RATIO_FIELDS = new Set([
  'ctr', 'conv', 'adCvr', 'finishRate', 'play5sRate', 'interactRate', 'followRate', 'enterRate',
  'sellThrough', 'inPoolRate', 'refundRate', 'aftersaleRate', 'negFeedback', 'goodRate',
  'complaintRate', 'reply3min', 'satisfaction', 'helpRate', 'imResponseRate', 'shipRate24h',
  'shipRate48h', 'pickupRate', 'signRateField', 'talentRefundRate', 'commissionRate', 'serviceRate',
]);

// 计数型字段（不做百分数归一）
export const COUNT_FIELDS = new Set([
  'impressions', 'visitors', 'productClicks', 'buyers', 'orders', 'items', 'playCount', 'likeCount',
  'commentCount', 'shareCount', 'favCount', 'followCount', 'watchCount', 'onlineMax', 'onlineAvg',
  'interactUsers', 'liveOrders', 'cartUsers', 'cartItems', 'favUsers', 'stockQty', 'qty',
  'adOrders', 'adImpressions', 'adClicks', 'talentOrders', 'sampleCount', 'consultUsers',
  'logisticsAbnormal', 'lateShipOrders',
]);

// ---------- 文件类型识别 ----------
// required：每组至少命中一个字段；requiredAny：组内二选一；veto：命中即否决该类型。
// 分数 = 100 - priority*0.1 + 文件名关键词 40/表头关键词 8 + prefer 命中 3。
export const FILE_TYPES = [
  {
    id: 'dx_overview', name: '抖店经营概览 / 交易概况（含分天）', shape: 'aggregate', priority: 8,
    keywords: ['经营概览', '交易概况', '交易_概况', '店铺概况', '经营概况', '核心数据', '店铺数据', '数据概览', '概况'],
    required: [['impressions', 'visitors', 'gmv', 'buyers', 'orders']],
    prefer: ['date', 'buyers', 'orders', 'conv', 'aov', 'ctr', 'items', 'netGmv', 'refundAmount'],
    // 有订单编号 = 订单级；有商品标题 = 商品级；都不是才是店铺级天级汇总。
    veto: [['orderId'], ['productTitle'], ['subOrderId'], ['channel'], ['talentName']],
  },
  {
    id: 'dx_traffic', name: '流量来源结构（内容场/货架场/付费）', shape: 'channel_rows', priority: 25,
    keywords: ['流量来源', '流量结构', '流量看板', '渠道分析', '来源分析'],
    required: [['channel'], ['visitors']],
    prefer: ['impressions', 'buyers', 'gmv', 'conv', 'ctr'],
  },
  {
    id: 'dx_product_card', name: '商品卡 / 商品效果（货架场单品）', shape: 'product_rows', priority: 20,
    keywords: ['商品卡', '商品效果', '单品分析', '商品分析', '商品列表', '商品明细'],
    required: [['productTitle'], ['visitors']],
    prefer: ['impressions', 'ctr', 'cartItems', 'cartUsers', 'gmv', 'buyers', 'conv', 'inPoolRate', 'qualityScore', 'pitGmv'],
  },
  {
    id: 'dx_order_detail', name: '订单明细 / 已卖出的宝贝', shape: 'order_lines', priority: 15,
    keywords: ['订单明细', '订单列表', '订单导出', '已卖出', '成交明细'],
    required: [['orderId'], ['paidAmount']],
    prefer: ['orderStatus', 'qty', 'refundAmount', 'datetime', 'productTitle', 'paidAmount'],
  },
  {
    id: 'dx_qianchuan', name: '巨量千川 / 随心推 投放报表', shape: 'ad_rows', priority: 30,
    keywords: ['千川', '随心推', '巨量', '投放报表', '广告报表', '推广报表', '广告数据'],
    requiredAny: [['cost', 'adGmv']],
    prefer: ['roi', 'adImpressions', 'adClicks', 'cpc', 'cpm', 'adOrders', 'adCvr', 'planName', 'costPerConv', 'creativeName'],
  },
  {
    id: 'dx_ad_plan', name: '千川计划级 / 素材级报表', shape: 'ad_rows', priority: 31,
    keywords: ['计划', '素材', '创意', '单元'],
    requiredAny: [['cost', 'adGmv']],
    prefer: ['planName', 'creativeName', 'roi', 'adImpressions', 'cpc'],
  },
  {
    id: 'dx_live', name: '直播场次 / 直播间数据', shape: 'live_rows', priority: 28,
    keywords: ['直播', '场次', '直播间', '开播'],
    requiredAny: [['watchCount', 'liveGmv', 'liveDuration']],
    prefer: ['enterRate', 'avgWatchMin', 'onlineMax', 'gpm', 'interactUsers', 'liveOrders', 'date'],
  },
  {
    id: 'dx_video', name: '短视频 / 内容数据', shape: 'content_rows', priority: 29,
    keywords: ['短视频', '视频数据', '作品数据', '内容数据', '视频分析'],
    requiredAny: [['playCount', 'videoTitle']],
    prefer: ['finishRate', 'play5sRate', 'interactRate', 'followCount', 'likeCount', 'gmv', 'ctr'],
  },
  {
    id: 'dx_talent', name: '精选联盟 / 达人带货报表', shape: 'talent_rows', priority: 33,
    keywords: ['精选联盟', '达人', '带货', '联盟', '招商'],
    requiredAny: [['talentGmv', 'commission', 'talentName']],
    prefer: ['commissionRate', 'talentOrders', 'talentRefundRate', 'sampleCount', 'serviceRate'],
  },
  {
    id: 'dx_experience', name: '商家体验分 / 店铺诊断', shape: 'score_snapshot', priority: 35,
    keywords: ['体验分', '店铺诊断', '店铺体检', '商家体验分'],
    required: [['expScore']],
    prefer: ['expGoods', 'expLogistics', 'expService', 'negFeedback', 'goodRate', 'complaintRate'],
  },
  {
    id: 'dx_service', name: '飞鸽客服绩效 / 售后响应', shape: 'service_rows', priority: 45,
    keywords: ['飞鸽', '客服', '客服绩效', '客服报表', '响应'],
    requiredAny: [['reply3min', 'helpRate', 'imResponseRate']],
    prefer: ['agent', 'satisfaction', 'firstReplySec', 'consultUsers', 'refundHours'],
  },
  {
    id: 'dx_aftersale', name: '售后 / 退款明细', shape: 'service_rows', priority: 40,
    keywords: ['售后', '退款', '退货', '纠纷'],
    required: [['refundAmount']],
    prefer: ['refundReason', 'refundType', 'orderId', 'refundStatus', 'refundHours', 'refundRate'],
    veto: [['visitors', 'buyers'], ['channel'], ['productTitle']],
  },
  {
    id: 'dx_fulfillment', name: '发货履约 / 物流时效', shape: 'fulfill_rows', priority: 42,
    keywords: ['履约', '发货', '物流', '时效', '揽收'],
    requiredAny: [['shipRate24h', 'shipRate48h', 'pickupRate', 'lateShipOrders', 'shipHours']],
    prefer: ['logisticsAbnormal', 'date', 'signRateField'],
  },
  {
    id: 'dx_inventory', name: '库存 / 滞销明细', shape: 'product_rows', priority: 50,
    keywords: ['库存', '滞销', '库存明细', '库存健康'],
    required: [['stockQty']],
    prefer: ['productTitle', 'sellThrough', 'gmv', 'visitors'],
  },
  {
    id: 'dx_generic', name: '未细分渠道的汇总表', shape: 'aggregate', priority: 60,
    keywords: ['汇总', '报表', '数据'],
    required: [['date']],
    prefer: ['gmv', 'cost', 'visitors', 'impressions'],
  },
];

// ---------- 平台特征词（用于拒收非抖音导出，硬红线） ----------
// 只判表头。strong：平台专有名词，命中 1 个（2 分）即判定；
// weak：泛化词，同一行表头命中 2 个（各 1 分）才判定，阈值 2 分。
export const PLATFORM_MARKERS = {
  taobao: {
    name: '淘宝/天猫',
    strong: ['千牛', '生意参谋', '万相台', '引力魔方', '直通车', '达摩盘', '品销宝', '淘宝客', '逛逛',
      '真实体验分', '阿里妈妈', '超级推荐', '量子', '淘宝联盟', '聚划算', '淘抢购', '淘宝直播'],
    weak: ['淘宝', '天猫', '旺旺', '宝贝', '买家会员名', '支付宝'],
  },
  jd: {
    name: '京东',
    strong: ['京准通', '京东快车', '京挑客', '京麦', '京东商智', '海投', '京东联盟', '京东超市'],
    weak: ['京东', '商智', '店铺星级', '商品sku'],
  },
  pdd: {
    name: '拼多多',
    strong: ['多多搜索', '多多场景', '多多进宝', '多多视频', '放心推', '万人团', '拼单人数'],
    weak: ['拼多多', '多多', '拼单', '百亿补贴', '领航员', '拼团价'],
  },
  xhs: {
    name: '小红书',
    strong: ['小红书', '笔记浏览量', '薯条消耗', '蒲公英', '聚光投放', '专业号', '薯队长', '千帆'],
    weak: ['笔记', '薯条', '种草'],
  },
  other: {
    name: '其它平台',
    strong: ['快手小店', '视频号小店', '微信小商店', '唯品会', '得物'],
    weak: ['快手', '视频号'],
  },
};

// 抖音专有词：只有抖音会这么叫
export const DOUYIN_ONLY_MARKERS = [
  '抖店', '抖音小店', '抖音电商', '电商罗盘', '巨量千川', '千川', '巨量引擎', '巨量算数', '随心推',
  '全域推广', '直播中控台', '飞鸽', '精选联盟', '商家体验分', '商品卡', '商城展示准入', '入池',
  '曝光进入率', '千次观看', 'gpm', 'gmv', '坑产', '商品信息质量分', '商机中心', '达人带货',
  '直播伴侣', '蓝v', '口碑分', '体验分', '种草', '随心推',
];
// 抖音惯用但其它平台也可能出现的列名：只能作为辅助证据
export const DOUYIN_FLAVORED_MARKERS = [
  '曝光人数', '曝光次数', '成交金额', '支付订单数', '支付买家数', '支播时长',
];
// 泛化列名：任何平台都会有，不能作为平台证据
export const DOUYIN_MARKERS_GENERIC = [
  '访客数', '浏览量', '客单价', '点击率', '转化率', '退款金额', '退款率', '加购',
  '收藏', '消耗', '成交订单数', 'roi',
];

// ---------- 文本归一化 ----------
const FULLWIDTH = /[\uFF01-\uFF5E]/g;
export function normalizeHeader(h) {
  if (h == null) return '';
  let s = String(h);
  s = s.replace(FULLWIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.toLowerCase().trim();
  s = s.replace(/[（(\[【][^）)\]】]*[）)\]】]/g, '');
  s = s.replace(/[\s_\-—–·:：,，.。%/\\'"]/g, '');
  s = s.replace(/(元|个|件|次|人|天|小时|分钟|秒|日)$/g, '');
  return s;
}
export function normalizeAlias(a) { return normalizeHeader(a); }
