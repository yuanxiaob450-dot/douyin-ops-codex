// 抖音小店经营诊断分析器 —— 把已识别的抖店/罗盘/千川导出数据转成「十段式」诊断结果对象。
// 设计原则（与淘宝包同源，口径全部按抖音重写）：
//   1) 不脑补：任何算不出来的指标一律进 dataGaps，绝不给假设值。
//   2) 可回溯：每个指标都带 method(怎么算) / files(来自哪些文件) / caliber(口径说明)。
//   3) 不跨平台：只处理抖音导出；混入淘宝/京东/拼多多/小红书文件一律拒收并说明。
//   4) 分场结算：内容场（短视频/直播）、货架场（商品卡/搜索/商城）、联盟场（达人）分开看，
//      三者流量逻辑不同，合并成一个数字只会掩盖问题。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// ---------------- 默认参数（必须按自己类目校准，见 kb/calibration.md） ----------------
export const DEFAULT_ASSUMPTIONS = {
  gross_margin: 0.40,          // 毛利率 —— 抖音保本 ROI 的第一参数，默认 40% 必须替换
  platform_rate: 0.05,         // 平台扣点（技术服务费按类目）
  ad_ratio_target: 0.15,       // 推广费占比目标
  aftersale_rate: 0.03,        // 售后损耗率
  sign_rate: 0.97,             // 签收率
  logistics_cost: 4.5,         // 单均物流成本（元）
  refund_rate_assumed: 0.08,   // 退款率（抖音食品/快消常见 8%–12%，必须用本地退款明细校准）
  min_aov_health: 45,          // 客单价健康线
  ctr_min: 0.03,               // 商品卡/主图点击率红线
  cart_rate_min: 0.06,         // 加购率基线
  conv_min: 0.02,              // 支付转化率基线
  sell_through_min: 0.60,      // 动销率基线（抖音比淘宝更看动销）
  in_pool_rate_min: 0.30,      // 商品卡入池率基线
  finish_rate_min: 0.25,       // 短视频完播率基线
  reply3min_min: 0.85,         // 飞鸽 3 分钟人工回复率门槛
  ship24h_min: 0.90,           // 24 小时发货率门槛
  pickup_rate_min: 0.90,       // 揽收及时率门槛
  exp_score_floor: 60,         // 体验分红线（百分制）
  exp_score_target: 80,        // 体验分达标线（百分制）
  exp_score_legacy_floor: 3.8, // 老 5 分制口径下的红线（仅当数据源是 5 分制时使用）
  exp_score_legacy_target: 4.6,
  gmv_target_month: null,      // 月度 GMV 目标（未提供时不做达成率结论）
};
export const ASSUMPTION_SOURCES = {
  gross_margin: '内置默认值：按类目毛利结构取，必须用自己类目实际毛利替换（保本 ROI = 1 ÷ 毛利率）',
  platform_rate: '内置默认值：抖音小店技术服务费按类目，以抖店后台费率页为准',
  ad_ratio_target: '内置默认值：千川/随心推花费占 GMV 的目标比例，按阶段计提',
  aftersale_rate: '内置默认值：售后损耗按退款率与退货成本计提',
  sign_rate: '内置默认值：保本 ROI 含退货口径时使用，需用本地退款明细校准',
  logistics_cost: '内置默认值：单均物流成本，按实际快递报价替换',
  refund_rate_assumed: '内置默认值：退款率未知时的保守口径，必须用本地退款明细校准',
  in_pool_rate_min: '内置默认值：商品卡入池率 30% 为常见治理线，按类目与店铺阶段校准',
  exp_score_floor: '内置默认值：抖店商家体验分 2026 为百分制，红线与达标线以抖店后台展示为准',
};

const pct = (n, d = 1) => (n == null || !Number.isFinite(n) ? '—' : (n * 100).toFixed(d) + '%');
const num = (n, d = 0) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const money = (n) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const wan = (n) => (n == null || !Number.isFinite(n) ? '—' : (n / 10000).toFixed(2));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sum = (a, f) => a.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const uniq = (a) => [...new Set(a)];
// div：分母为 0 时返回 null 而不是 0 或 NaN。
// 0÷0 若返回 0，会让「没有数据」被当成「真实值就是 0%」，进而生成假问题项
// （真实踩过：商品卡表没有点击数据，整体点击率被算成 0.00% 并报 P1）。
const div = (a, b) => (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || b === 0 ? null : a / b);
// sumOrNull：列完全不存在时返回 null，而不是 0。
// 「列不存在」与「列存在且全是 0」必须区分——否则缺列会被算成真实 0，
// 进而生成假结论（真实踩过：商品卡表没有点击次数列，整体点击率被算成 0.00% 并报 P1）。
// 注意 f 是**取值函数**（与 sum 同签名），不是属性名——写成 r[f] 会永远取不到值、
// 让每个指标静默变成 null（也真实踩过）。
const hasField = (rows, f) => rows.some((r) => f(r) != null);
const sumOrNull = (rows, f) => (hasField(rows, f) ? sum(rows, f) : null);

// 未付款/已取消/已关闭（不含「付款后全额退款关闭」——那种必须计入 GMV）
const UNPAID_RE = /(等待买家付款|等待付款|未付款|付款失败|已取消|买家取消|超时未付款|交易关闭)/;
const REFUNDED_RE = /(已退款|退款成功|全额退款|售后完成)/;

export function loadMetricsSpec() {
  const p = path.join(ROOT, 'kb', 'metrics.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// 阈值抽取：默认参数 → 再用 kb/metrics.json 的 value 覆盖（表里有的以表为准）
export function extractThresholds(spec, A) {
  const T = { ...A };
  const flat = {};
  if (spec) for (const g of spec.groups || []) for (const m of g.metrics || []) flat[m.id] = m;
  T.breakeven_roi = 1 / A.gross_margin;
  T.breakeven_roi_with_returns = 1 / A.gross_margin / A.sign_rate;
  T.spec = flat;
  if (flat.gross_red_line?.value) T.gross_red_line = flat.gross_red_line.value;
  if (flat.exp_score_lines?.value) {
    T.exp_lines = flat.exp_score_lines.value;
    if (flat.exp_score_lines.value.floor_100 != null) T.exp_score_floor = flat.exp_score_lines.value.floor_100;
    if (flat.exp_score_lines.value.target_100 != null) T.exp_score_target = flat.exp_score_lines.value.target_100;
  }
  if (flat.neg_feedback_rate?.value) T.neg_feedback = flat.neg_feedback_rate.value;
  if (flat.service_thresholds?.value) {
    T.service_thresholds = flat.service_thresholds.value;
    if (flat.service_thresholds.value.reply3min != null) T.reply3min_min = flat.service_thresholds.value.reply3min;
  }
  if (flat.fulfillment_thresholds?.value) {
    T.fulfillment_thresholds = flat.fulfillment_thresholds.value;
    if (flat.fulfillment_thresholds.value.ship24h != null) T.ship24h_min = flat.fulfillment_thresholds.value.ship24h;
    if (flat.fulfillment_thresholds.value.pickup_rate != null) T.pickup_rate_min = flat.fulfillment_thresholds.value.pickup_rate;
  }
  if (flat.ctr_main?.value?.pass != null) T.ctr_min = flat.ctr_main.value.pass;
  if (flat.cart_rate?.value) { T.cart_rate_min = flat.cart_rate.value.cart_min ?? T.cart_rate_min; }
  if (flat.conv_rate?.value?.pass != null) T.conv_min = flat.conv_rate.value.pass;
  if (flat.sell_through?.value?.pass != null) T.sell_through_min = flat.sell_through.value.pass;
  if (flat.in_pool_rate?.value?.pass != null) T.in_pool_rate_min = flat.in_pool_rate.value.pass;
  if (flat.finish_rate?.value?.pass != null) T.finish_rate_min = flat.finish_rate.value.pass;
  return T;
}

// ---------------- 交易日历过滤 ----------------
function dateKey(s) {
  const m = String(s ?? '').match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  return m ? `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}` : null;
}
function pickDateField(row) { return row.date || row.datetime || null; }
function filterWindow(rows, { from, to, days, asOf }) {
  const hasDates = rows.some((r) => dateKey(pickDateField(r)));
  if (!hasDates) return { rows, filtered: false, distinctDays: null, from: null, to: null };
  const keys = [...new Set(rows.map((r) => dateKey(pickDateField(r))).filter(Boolean))].sort();
  if (!keys.length) return { rows, filtered: false, distinctDays: null, from: null, to: null };
  const spanFrom = keys[0], spanTo = keys[keys.length - 1];
  let hi = to || spanTo;
  let lo = from;
  if (!lo && asOf) { const d = new Date(asOf + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - (days || 31) + 1); lo = d.toISOString().slice(0, 10); }
  if (!lo && days) { const d = new Date(hi + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - days + 1); lo = d.toISOString().slice(0, 10); }
  if (!lo) return { rows, filtered: false, distinctDays: keys.length, from: spanFrom, to: spanTo, spanFrom, spanTo };
  const kept = rows.filter((r) => { const k = dateKey(pickDateField(r)); return !k || (k >= lo && k <= hi); });
  return {
    rows: kept, filtered: true, distinctDays: keys.length, spanFrom, spanTo, from: lo, to: hi,
    dropped: rows.length - kept.length,
    droppedDays: keys.length - [...new Set(kept.map((r) => dateKey(pickDateField(r))).filter(Boolean))].length,
  };
}

// ---------------- 小工具 ----------------
// 按「数据形状」收集表：shape 在 sh.detected.shape 上，不在 sheet 顶层
// （踩过的坑：写 set.has(sh.shape) 会永远命中不到，导致所有指标段静默为空、只输出一堆数据缺口）。
function shapeOf(sh) { return (sh.detected && sh.detected.shape) || sh.shape; }
function rowsOf(files, shapes) {
  const set = new Set(shapes);
  const out = [];
  for (const f of files) {
    for (const sh of f.sheets || []) {
      if (sh.ok && set.has(shapeOf(sh))) out.push({ file: f.base, sheet: sh.sheetName, shape: shapeOf(sh), rows: sh.data, mapping: sh.mapping, type: sh.detected });
    }
  }
  return out;
}
function fieldsOf(inv) { return uniq(inv.flatMap((x) => Object.keys(x.mapping))); }
function filesOf(inv) { return uniq(inv.map((x) => x.file)); }

const DOW_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function dowOf(s) { const d = new Date(String(s).slice(0, 10) + 'T00:00:00Z'); return Number.isNaN(d.getTime()) ? null : d.getUTCDay(); }

// ================================================================
export function analyze(files, opts = {}) {
  const A = { ...DEFAULT_ASSUMPTIONS, ...(opts.assumptions || {}) };
  const T = extractThresholds(loadMetricsSpec(), A);
  const store = opts.store || '抖音小店';
  const period = opts.period || null;

  const accepted = [], rejected = [], foreign = [];
  for (const f of files) {
    if (f.error) { rejected.push({ file: f.base, reason: '读取失败：' + f.error }); continue; }
    for (const sh of f.sheets || []) {
      if (!sh.ok) { rejected.push({ file: f.base, sheet: sh.sheetName, reason: sh.reason }); continue; }
      const tag = { file: f.base, sheet: sh.sheetName, type: sh.detected.id, typeName: sh.detected.name, shape: sh.detected.shape, rows: sh.rowCount, fields: sh.fields, alternatives: sh.detected.alternatives, unmapped: sh.unmappedHeaders, platform: sh.platform, skipped: sh.skipped };
      if (!sh.platform.isDouyin) { foreign.push({ ...tag, platforms: sh.platform.foreign.map((x) => x.name), reason: sh.platform.evidence, notes: sh.platform.notes }); continue; }
      if (sh.detected.id === 'unknown') { rejected.push({ file: f.base, sheet: sh.sheetName, reason: '未识别为抖音经营报表（字段：' + sh.fields.slice(0, 8).join('、') + '）' }); continue; }
      accepted.push(tag);
    }
  }

  const dataGaps = [];
  const notes = [];
  const G = (need, unlock, backend, priority = 'P1') => dataGaps.push({ need, unlock, backend, priority });

  const aggInv = rowsOf(files, ['aggregate']);
  const prodInv = rowsOf(files, ['product_rows']);
  const chanInv = rowsOf(files, ['channel_rows']);
  const adInv = rowsOf(files, ['ad_rows']);
  const orderInv = rowsOf(files, ['order_lines']);
  const svcInv = rowsOf(files, ['service_rows']);
  const scoreInv = rowsOf(files, ['score_snapshot']);
  const liveInv = rowsOf(files, ['live_rows']);
  const contentInv = rowsOf(files, ['content_rows']);
  const talentInv = rowsOf(files, ['talent_rows']);
  const fulfillInv = rowsOf(files, ['fulfill_rows']);

  const M = {};
  const win = { days: 31, asOf: opts.asOf || null, from: opts.from || null, to: opts.to || null };

  // ---------- 一、规模与节奏 ----------
  if (aggInv.length) {
    const all = aggInv.flatMap((x) => x.rows);
    const f = filterWindow(all, win);
    const rows = f.rows;
    if (process.env.DY_DEBUG) console.error('[dbg] rows=' + rows.length + ' row0=' + JSON.stringify(rows[0]) + ' sumVisitors=' + sumOrNull(rows, (r) => r.visitors));
    const visitors = sumOrNull(rows, (r) => r.visitors);
    const impressions = sumOrNull(rows, (r) => r.impressions);
    const gmv = sumOrNull(rows, (r) => r.gmv);
    const buyers = sumOrNull(rows, (r) => r.buyers);
    const orders = sumOrNull(rows, (r) => r.orders);
    const items = sumOrNull(rows, (r) => r.items);
    const clicks = sumOrNull(rows, (r) => r.productClicks);
    const refundAmount = sumOrNull(rows, (r) => r.refundAmount);
    const days = f.distinctDays || uniq(rows.map((r) => dateKey(pickDateField(r))).filter(Boolean)).length || 1;
    const conv = div(buyers, visitors) ?? mean(rows.map((r) => r.conv).filter((x) => x != null));
    M.scale = {
      period: f.filtered ? `${f.from} 至 ${f.to}` : (period || '数据周期未标注'),
      days, impressions, visitors, clicks, buyers, orders, items, gmv,
      gmvPerDay: div(gmv, days), visitorsPerDay: div(visitors, days),
      conv, aov: div(gmv, buyers), unitPrice: div(gmv, items), itemsPerOrder: div(items, orders),
      uvValue: div(gmv, visitors), refundAmount,
      ctr: div(clicks, impressions) ?? mean(rows.map((r) => r.ctr).filter((x) => x != null)),
      filtered: f.filtered, window: f.filtered ? { from: f.from, to: f.to, dropped: f.dropped } : null,
      method: '店铺级汇总表按日期求和；转化率 = 支付买家数 ÷ 商品访客数；客单价 = 支付GMV ÷ 支付买家数',
      files: filesOf(aggInv),
    };
    // 星期节奏
    const byDow = [];
    for (let d = 0; d < 7; d++) {
      const g = rows.filter((r) => dateKey(pickDateField(r)) && dowOf(pickDateField(r)) === d);
      if (!g.length) continue;
      byDow.push({ label: DOW_CN[d], n: g.length, gmvAvg: div(sum(g, (r) => r.gmv), g.length), visitorsAvg: div(sum(g, (r) => r.visitors), g.length), ordersAvg: div(sum(g, (r) => r.orders), g.length), impressionsAvg: div(sum(g, (r) => r.impressions), g.length) });
    }
    if (byDow.length >= 4) M.rhythm = { byDow };
    // 月度目标达成
    if (A.gmv_target_month) {
      M.scale.target = A.gmv_target_month;
      M.scale.achieveRate = div(gmv, A.gmv_target_month);
    }
  } else {
    G('店铺级经营概览（抖店后台 → 电商罗盘 → 经营概览，或交易概况导出）', '店铺整体规模、转化率、客单价、退款与日均节奏', '抖店后台 → 电商罗盘 → 经营概览 → 导出', 'P0');
  }

  // ---------- 二、商品卡（货架场） ----------
  if (prodInv.length) {
    const all = prodInv.flatMap((x) => x.rows);
    const f = filterWindow(all, win);
    const rows = f.rows;
    const byTitle = new Map();
    for (const r of rows) {
      const k = r.productTitle || r.productCardName || ('行' + r.__row);
      if (!byTitle.has(k)) byTitle.set(k, { title: k, visitors: 0, impressions: 0, clicks: 0, gmv: 0, orders: 0, buyers: 0, cartUsers: 0, cartItems: 0, ctrList: [], convList: [], inPool: null, quality: null });
      const t = byTitle.get(k);
      t.visitors += Number(r.visitors) || 0;
      t.impressions += Number(r.impressions) || 0;
      t.clicks += Number(r.productClicks) || 0;
      t.gmv += Number(r.gmv) || 0;
      t.orders += Number(r.orders) || 0;
      t.buyers += Number(r.buyers) || 0;
      t.cartUsers += Number(r.cartUsers) || 0;
      t.cartItems += Number(r.cartItems) || 0;
      if (r.ctr != null) t.ctrList.push(r.ctr);
      if (r.conv != null) t.convList.push(r.conv);
      if (r.inPoolRate != null) t.inPool = r.inPoolRate;
      if (r.qualityScore != null) t.quality = r.qualityScore;
    }
    const items = [...byTitle.values()].map((t) => {
      const ctr = div(t.clicks, t.impressions) ?? mean(t.ctrList);
      const conv = div(t.buyers, t.visitors) ?? mean(t.convList);
      return { ...t, ctr, conv, cartRate: div(t.cartUsers, t.visitors), pitGmv: t.gmv };
    });
    const withVisitors = items.filter((t) => t.visitors > 0);
    const active = items.filter((t) => t.gmv > 0 || t.orders > 0);
    const gmvTotal = sum(items, (t) => t.gmv) || null;
    const sorted = [...items].sort((a, b) => (b.gmv || 0) - (a.gmv || 0));
    const inPoolItems = items.filter((t) => t.inPool != null);
    // 四象限（点击率 × 转化率），数据前提：有曝光或点击才有判定意义
    const analysable = items.filter((t) => (t.clicks || 0) >= 30 || (t.impressions || 0) >= 300);
    const ctrMed = mean(analysable.map((t) => t.ctr).filter((x) => x != null));
    const convMed = mean(analysable.map((t) => t.conv).filter((x) => x != null));
    const quadrantOf = (t) => {
      if (t.ctr == null || t.conv == null) return '数据不足';
      const hiC = (ctrMed == null ? T.ctr_min : ctrMed);
      const hiV = (convMed == null ? T.conv_min : convMed);
      if (t.ctr >= hiC && t.conv >= hiV) return '高点击高转化';
      if (t.ctr >= hiC && t.conv < hiV) return '高点击低转化';
      if (t.ctr < hiC && t.conv >= hiV) return '低点击高转化';
      return '低点击低转化';
    };
    for (const t of analysable) t.quadrant = quadrantOf(t);
    const quad = {};
    for (const q of ['高点击高转化', '高点击低转化', '低点击高转化', '低点击低转化', '数据不足']) {
      const g = items.filter((t) => (t.quadrant || '数据不足') === q);
      quad[q] = { count: g.length, gmv: sum(g, (t) => t.gmv) || null, items: g.sort((a, b) => (b.gmv || 0) - (a.gmv || 0)).slice(0, 10) };
    }
    // 商品卡整体点击率：优先用「点击次数 ÷ 曝光人数」；只有任一侧有真实数据才算，
    // 都没有时退回表里点击率列的均值（而不是算成 0%）。
    const ctrSum = div(sumOrNull(items, (t) => t.clicks), sumOrNull(items, (t) => t.impressions));
    M.product = {
      skuCount: items.length, skuWithVisitors: withVisitors.length, skuActive: active.length,
      sellThrough: div(active.length, items.length),
      inPoolRate: inPoolItems.length ? div(inPoolItems.filter((t) => (t.inPool || 0) > 0).length, inPoolItems.length) : null,
      inPoolReportedAvg: inPoolItems.length ? mean(inPoolItems.map((t) => t.inPool)) : null,
      ctr: ctrSum ?? mean(items.map((t) => t.ctr).filter((x) => x != null)),
      conv: div(sumOrNull(items, (t) => t.buyers), sumOrNull(items, (t) => t.visitors)) ?? mean(items.map((t) => t.conv).filter((x) => x != null)),
      cartRate: div(sumOrNull(items, (t) => t.cartUsers), sumOrNull(items, (t) => t.visitors)),
      qualityScoreAvg: mean(items.map((t) => t.quality).filter((x) => x != null)),
      gmv: gmvTotal,
      concentration: gmvTotal ? { top5: div(sum(sorted.slice(0, 5), (t) => t.gmv), gmvTotal), top20: div(sum(sorted.slice(0, 20), (t) => t.gmv), gmvTotal) } : null,
      top: sorted.slice(0, 12),
      dead: items.filter((t) => !t.visitors && !t.clicks).length,
      quadrant: quad,
      ctrBasis: '点击率 = 商品点击次数 ÷ 商品曝光人数（若表里只有点击人数/曝光人数则同口径）',
      countedRows: rows.length, droppedRows: all.length - rows.length,
      method: '按商品标题聚合（同一商品多天/多渠道行先求和再算比率）；点击率与转化率用汇总值计算，避免小样本比率被平均',
      files: filesOf(prodInv),
    };
  } else {
    G('商品卡/商品效果明细（抖店后台 → 电商罗盘 → 商品卡 → 导出）', '入池率、单品点击率与转化率、商品四象限与死链接清单', '抖店后台 → 电商罗盘 → 商品卡 → 商品卡列表 → 导出', 'P0');
  }

  // ---------- 三、千川投放（付费） ----------
  if (adInv.length) {
    const all = adInv.flatMap((x) => x.rows);
    const f = filterWindow(all, win);
    const rows = f.rows;
    const cost = sumOrNull(rows, (r) => r.cost);
    const adGmv = sumOrNull(rows, (r) => r.adGmv);
    const adOrders = sumOrNull(rows, (r) => r.adOrders);
    const impressions = sumOrNull(rows, (r) => r.adImpressions);
    const clicks = sumOrNull(rows, (r) => r.adClicks);
    const roi = div(adGmv, cost) ?? mean(rows.map((r) => r.roi).filter((x) => x != null));
    const byKey = new Map();
    for (const r of rows) {
      const k = r.planName || r.creativeName || r.keyword || ('行' + r.__row);
      if (!byKey.has(k)) byKey.set(k, { name: k, cost: 0, gmv: 0, orders: 0, impressions: 0, clicks: 0, convCostList: [] });
      const t = byKey.get(k);
      t.cost += Number(r.cost) || 0; t.gmv += Number(r.adGmv) || 0; t.orders += Number(r.adOrders) || 0;
      t.impressions += Number(r.adImpressions) || 0; t.clicks += Number(r.adClicks) || 0;
      if (r.costPerConv != null) t.convCostList.push(r.costPerConv);
    }
    const plans = [...byKey.values()].map((t) => ({
      ...t, roi: div(t.gmv, t.cost), ctr: div(t.clicks, t.impressions),
      cvr: div(t.orders, t.clicks), cpc: div(t.cost, t.clicks), cpm: div(t.cost, t.impressions) ? div(t.cost, t.impressions) * 1000 : null,
      convCost: div(t.cost, t.orders) ?? mean(t.convCostList),
    })).sort((a, b) => (b.cost || 0) - (a.cost || 0));
    const breakEven = T.breakeven_roi;
    const losers = plans.filter((p) => p.cost >= (opts.loserCostFloor || 100) && p.roi != null && p.roi < breakEven);
    M.promotion = {
      cost, adGmv, adOrders: adOrders || null, roi, impressions: impressions || null, clicks: clicks || null,
      ctr: div(clicks, impressions), cvr: div(adOrders, clicks), cpc: div(cost, clicks),
      cpm: div(cost, impressions) ? div(cost, impressions) * 1000 : null,
      convCost: div(cost, adOrders),
      costShare: M.scale?.gmv ? div(cost, M.scale.gmv) : null,
      costShareOfAdGmv: div(cost, adGmv),
      roiMargin: roi != null ? roi / breakEven - 1 : null,
      breakeven: breakEven, breakevenWithReturns: T.breakeven_roi_with_returns,
      breakEvenGap: roi != null ? breakEven - roi : null,
      plans: plans.slice(0, 20),
      losers: losers.slice(0, 12),
      loserCost: sum(losers, (p) => p.cost) || null,
      winners: plans.filter((p) => p.roi != null && p.roi >= breakEven * 1.2).slice(0, 10),
      countedRows: rows.length,
      method: '按计划（无计划名则按素材/关键词）聚合消耗与成交，ROI = 成交金额 ÷ 消耗；账户 ROI 用汇总值算，不用计划 ROI 平均',
      roiCaliberNote: '这里的 ROI 是「支付 ROI」（含未退款口径）。要算净成交 ROI，必须用退款明细扣减退款金额，否则会被退款吞掉真实产出',
      files: filesOf(adInv),
    };
    if (!M.scale) notes.push('千川花费已识别，但缺少店铺 GMV，无法计算推广费占比');
  } else {
    G('千川/随心推投放报表（巨量千川后台 → 数据 → 报表 → 导出）', '保本 ROI 对照、亏损计划清单、素材消耗结构', '巨量千川后台 → 数据 → 广告数据 → 按计划/素材导出', 'P1');
  }

  // ---------- 四、内容场（直播 / 短视频） ----------
  if (liveInv.length) {
    const all = liveInv.flatMap((x) => x.rows);
    const sessions = all.length;
    const watch = sumOrNull(all, (r) => r.watchCount);
    const liveGmv = sumOrNull(all, (r) => r.liveGmv);
    const sorted = [...all].sort((a, b) => (Number(b.liveGmv) || 0) - (Number(a.liveGmv) || 0));
    M.live = {
      sessions, watchCount: watch, gmv: liveGmv, orders: sum(all, (r) => r.liveOrders) || null,
      gpm: div(liveGmv, watch) ? div(liveGmv, watch) * 1000 : mean(all.map((r) => r.gpm).filter((x) => x != null)),
      enterRate: mean(all.map((r) => r.enterRate).filter((x) => x != null)),
      avgWatchMin: mean(all.map((r) => r.avgWatchMin).filter((x) => x != null)),
      onlineMaxAvg: mean(all.map((r) => r.onlineMax).filter((x) => x != null)),
      interactRate: div(sum(all, (r) => r.interactUsers), watch),
      durationAvg: mean(all.map((r) => r.liveDuration).filter((x) => x != null)),
      top: sorted.slice(0, 8).map((r) => ({ name: r.liveTitle || ('场次 ' + r.__row), gmv: Number(r.liveGmv) || null, watch: Number(r.watchCount) || null, enterRate: r.enterRate ?? null, gpm: r.gpm ?? (div(r.liveGmv, r.watchCount) ? div(r.liveGmv, r.watchCount) * 1000 : null) })),
      // 两极分化：前 25% 场次贡献的 GMV 占比
      concentration: liveGmv ? div(sum(sorted.slice(0, Math.max(1, Math.ceil(sessions * 0.25))), (r) => r.liveGmv), liveGmv) : null,
      method: '按场次求和；GPM = 直播间成交金额 ÷ 观看人次 × 1000；曝光进入率与人均观看时长取场次算术平均'
        + '（这两个指标逐场波动极大，均值只作趋势参考；若要月度口径，应把 31 天按当日订单量加权，'
        + '两种算法会差 2 个百分点以内，报告统一用算术平均）。',
      files: filesOf(liveInv),
    };
  } else if (scoreInv.length || chanInv.length) {
    G('直播场次报表（抖店后台 → 电商罗盘 → 直播 → 场次明细导出）', '直播间漏斗（曝光→进入→停留→互动→转化）与 GPM 诊断', '抖店后台 → 电商罗盘 → 直播 → 场次列表 → 导出', 'P1');
  }
  if (contentInv.length) {
    const all = contentInv.flatMap((x) => x.rows);
    const plays = sumOrNull(all, (r) => r.playCount);
    const rows = all.filter((r) => (r.playCount || 0) >= 200);
    M.content = {
      count: all.length, playCount: plays,
      finishRate: mean(rows.map((r) => r.finishRate).filter((x) => x != null)),
      play5sRate: mean(rows.map((r) => r.play5sRate).filter((x) => x != null)),
      interactRate: mean(rows.map((r) => r.interactRate).filter((x) => x != null)),
      followRate: mean(rows.map((r) => r.followRate).filter((x) => x != null)),
      gmv: sum(all, (r) => r.gmv) || null,
      highFinish: rows.filter((r) => (r.finishRate || 0) >= 0.35).length,
      lowFinish: rows.filter((r) => (r.finishRate || 0) < T.finish_rate_min).length,
      countedRows: rows.length,
      top: [...all].sort((a, b) => (Number(b.playCount) || 0) - (Number(a.playCount) || 0)).slice(0, 10).map((r) => ({ name: r.videoTitle || ('作品 ' + r.__row), play: Number(r.playCount) || null, finishRate: r.finishRate ?? null, gmv: Number(r.gmv) || null })),
      method: '完播率/互动率只统计播放量 ≥200 的作品（低播放样本比率失真）；均值口径为作品算术平均',
      files: filesOf(contentInv),
    };
  }

  // ---------- 五、精选联盟（达人场） ----------
  if (talentInv.length) {
    const all = talentInv.flatMap((x) => x.rows);
    const gmv = sumOrNull(all, (r) => r.talentGmv);
    const byTalent = new Map();
    for (const r of all) {
      const k = r.talentName || r.talentId || ('行' + r.__row);
      if (!byTalent.has(k)) byTalent.set(k, { name: k, gmv: 0, orders: 0, commission: 0, samples: 0, refundRateList: [], rateList: [] });
      const t = byTalent.get(k);
      t.gmv += Number(r.talentGmv) || 0; t.orders += Number(r.talentOrders) || 0;
      t.commission += Number(r.commission) || 0; t.samples += Number(r.sampleCount) || 0;
      if (r.talentRefundRate != null) t.refundRateList.push(r.talentRefundRate);
      if (r.commissionRate != null) t.rateList.push(r.commissionRate);
    }
    const talents = [...byTalent.values()].map((t) => ({ ...t, refundRate: mean(t.refundRateList), commissionRate: mean(t.rateList), roi: div(t.gmv, t.commission) })).sort((a, b) => b.gmv - a.gmv);
    M.talent = {
      count: talents.length, gmv, orders: sum(all, (r) => r.talentOrders) || null,
      commission: sum(all, (r) => r.commission) || null, samples: sum(all, (r) => r.sampleCount) || null,
      commissionRateAvg: mean(all.map((r) => r.commissionRate).filter((x) => x != null)),
      refundRateAvg: mean(all.map((r) => r.talentRefundRate).filter((x) => x != null)),
      top: talents.slice(0, 12),
      repeatable: talents.filter((t) => t.gmv > 0 && (t.refundRate == null || t.refundRate < (T.neg_feedback?.neg_feedback_max ?? 0.05) * 2)),
      concentration: gmv ? div(sum(talents.slice(0, 3), (t) => t.gmv), gmv) : null,
      method: '按达人聚合；可复投判定 = 有真实成交且退款率未显著高于店铺均值（否则是「卖得越多退得越多」）',
      files: filesOf(talentInv),
    };
  }

  // ---------- 六、订单与退款（本地口径） ----------
  if (orderInv.length) {
    const all = orderInv.flatMap((x) => x.rows);
    const f = filterWindow(all, win);
    const rows = f.rows;
    const keys = rows.map((r) => r.orderId || r.subOrderId).filter(Boolean);
    const dup = keys.length - new Set(keys).size;
    const notPaid = rows.filter((r) => !r.payTime && r.orderStatus && UNPAID_RE.test(String(r.orderStatus)));
    const valid = rows.filter((r) => !notPaid.includes(r));
    const gmvValid = sumOrNull(valid, (r) => r.paidAmount);
    const refundAmount = sumOrNull(valid, (r) => r.refundAmount);
    const refundedRows = valid.filter((r) => (Number(r.refundAmount) || 0) > 0 || (r.refundStatus && REFUNDED_RE.test(String(r.refundStatus))));
    const reasonMap = new Map();
    for (const r of valid) {
      const amt = Number(r.refundAmount) || 0;
      if (!amt) continue;
      const k = r.refundReason || r.refundType || '未标注原因';
      reasonMap.set(k, (reasonMap.get(k) || 0) + amt);
    }
    const buyers = uniq(valid.map((r) => r.buyerNick).filter(Boolean));
    M.orders = {
      rows: rows.length, validRows: valid.length, duplicateKeys: dup, closedRows: notPaid.length,
      gmvValid, refundAmount, refundRate: div(refundAmount, gmvValid),
      refundedRows: refundedRows.length, refundRateIncl: div(refundedRows.length, valid.length),
      aov: div(gmvValid, buyers.length || M.scale?.buyers),
      aovBasis: buyers.length ? 'local' : 'platform',
      buyerCountLocal: buyers.length || null, buyerCountPlatform: M.scale?.buyers ?? null,
      reasonTop: [...reasonMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, weight]) => ({ reason, weight })),
      method: '订单明细按主订单号去重后求和；退款率 = 退款金额 ÷ 有效订单实付金额',
      caliber: '平台口径的「退款率」通常按退款订单数/成交订单数算，与本地的金额口径不同，两者不可直接对比',
      files: filesOf(orderInv),
    };
  }

  // ---------- 七、体验分 ----------
  if (scoreInv.length) {
    const all = scoreInv.flatMap((x) => x.rows);
    const withDate = all.filter((r) => dateKey(pickDateField(r)));
    const latest = withDate.length ? withDate.reduce((a, b) => (dateKey(pickDateField(a)) >= dateKey(pickDateField(b)) ? a : b)) : all[all.length - 1];
    const allScores = all.map((r) => r.expScore).filter((x) => x != null);
    // 百分制 vs 5 分制：源数据可能是 4.7 也可能是 78，必须按量纲判定，不能混算
    const isFivePoint = allScores.length > 0 && allScores.every((x) => x <= 5);
    const score100 = latest?.expScore == null ? null : (isFivePoint ? latest.expScore * 20 : latest.expScore);
    const norm = (v) => (v == null ? null : (isFivePoint ? v * 20 : v));
    M.experience = {
      scale: isFivePoint ? '5分制（已换算为百分制）' : '百分制',
      score: latest?.expScore ?? null, score100,
      goods: norm(latest?.expGoods), logistics: norm(latest?.expLogistics), service: norm(latest?.expService),
      negFeedback: latest?.negFeedback ?? mean(all.map((r) => r.negFeedback).filter((x) => x != null)),
      goodRate: latest?.goodRate ?? mean(all.map((r) => r.goodRate).filter((x) => x != null)),
      complaintRate: latest?.complaintRate ?? mean(all.map((r) => r.complaintRate).filter((x) => x != null)),
      snapshotDate: latest ? dateKey(pickDateField(latest)) : null,
      weeks: withDate.length >= 3 ? withDate.map((r) => ({ date: dateKey(pickDateField(r)), score100: norm(r.expScore), goods: norm(r.expGoods), logistics: norm(r.expLogistics), service: norm(r.expService) })).sort((a, b) => String(a.date).localeCompare(String(b.date))) : null,
      // 三维短板：只在与满分 100 的差距上比
      shortest: (() => {
        const dims = [['商品体验', norm(latest?.expGoods)], ['物流体验', norm(latest?.expLogistics)], ['服务体验', norm(latest?.expService)]].filter(([, v]) => v != null);
        if (dims.length < 2) return null;
        return dims.sort((a, b) => a[1] - b[1])[0];
      })(),
      floor100: T.exp_score_floor, target100: T.exp_score_target,
      method: '取时间序列中最新一条为当期值；若源数据为 5 分制则 ×20 换算，换算后与百分制阈值比较，并在报告中标注量纲',
      files: filesOf(scoreInv),
    };
  } else {
    G('商家体验分（抖店后台 → 店铺 → 商家体验分，含三维子分导出）', '体验分闸门判断（限流/准入/活动资格）与三维短板定位', '抖店后台 → 店铺 → 商家体验分 → 导出明细', 'P0');
  }

  // ---------- 八、客服（飞鸽） ----------
  if (svcInv.length) {
    const all = svcInv.flatMap((x) => x.rows);
    const hasService = all.some((r) => r.reply3min != null || r.helpRate != null || r.imResponseRate != null);
    if (hasService) {
      const byAgent = new Map();
      for (const r of all) {
        const k = r.agent || ('行' + r.__row);
        if (!byAgent.has(k)) byAgent.set(k, { name: k, reply3minList: [], firstReplyList: [], satisfactionList: [], consult: 0, helpList: [] });
        const t = byAgent.get(k);
        if (r.reply3min != null) t.reply3minList.push(r.reply3min);
        if (r.firstReplySec != null) t.firstReplyList.push(r.firstReplySec);
        if (r.satisfaction != null) t.satisfactionList.push(r.satisfaction);
        if (r.helpRate != null) t.helpList.push(r.helpRate);
        t.consult += Number(r.consultUsers) || 0;
      }
      M.service = {
        reply3min: mean(all.map((r) => r.reply3min).filter((x) => x != null)),
        firstReplySec: mean(all.map((r) => r.firstReplySec).filter((x) => x != null)),
        satisfaction: mean(all.map((r) => r.satisfaction).filter((x) => x != null)),
        helpRate: mean(all.map((r) => r.helpRate).filter((x) => x != null)),
        imResponseRate: mean(all.map((r) => r.imResponseRate).filter((x) => x != null)),
        consultUsers: sum(all, (r) => r.consultUsers) || null,
        agents: [...byAgent.values()].map((t) => ({ name: t.name, reply3min: mean(t.reply3minList), firstReplySec: mean(t.firstReplyList), satisfaction: mean(t.satisfactionList), helpRate: mean(t.helpList), consult: t.consult || null })).sort((a, b) => (a.reply3min ?? 1) - (b.reply3min ?? 1)),
        method: '按客服逐人取算术平均（该指标是比率，不能把各行比率相加；也没有按咨询人数加权）。'
          + '若后台的「整体回复率」是按会话量加权算的，本报告的均值会与后台不同——差异方向通常是：'
          + '咨询量小的坐席把均值拉低。要精确对齐请以后台汇总值为准，本项仅用于定位短板坐席。',
        files: filesOf(svcInv),
      };
    }
    // 售后聚合表（有退款率/退款时长字段的）也算服务侧
    const hasAfter = all.some((r) => r.refundHours != null || r.refundRate != null);
    if (hasAfter && !M.orders) {
      M.aftersale = {
        refundRate: mean(all.map((r) => r.refundRate).filter((x) => x != null)),
        refundHours: mean(all.map((r) => r.refundHours).filter((x) => x != null)),
        aftersaleRate: mean(all.map((r) => r.aftersaleRate).filter((x) => x != null)),
        method: '取报表展示值（平台口径），与订单明细的金额口径不同，报告中已分列',
        files: filesOf(svcInv),
      };
    }
  }

  // ---------- 九、发货履约 ----------
  if (fulfillInv.length) {
    const all = fulfillInv.flatMap((x) => x.rows);
    M.fulfillment = {
      ship24h: mean(all.map((r) => r.shipRate24h).filter((x) => x != null)),
      ship48h: mean(all.map((r) => r.shipRate48h).filter((x) => x != null)),
      pickupRate: mean(all.map((r) => r.pickupRate).filter((x) => x != null)),
      shipHoursAvg: mean(all.map((r) => r.shipHours).filter((x) => x != null)),
      abnormal: sum(all, (r) => r.logisticsAbnormal) || null,
      lateOrders: sum(all, (r) => r.lateShipOrders) || null,
      signRate: mean(all.map((r) => r.signRateField).filter((x) => x != null)),
      method: '比率字段按天取均值；异常单量与延迟单量为求和（它们是可数事件，不能平均）',
      files: filesOf(fulfillInv),
    };
  }

  // ---------- 十、流量结构（渠道） ----------
  if (chanInv.length) {
    const all = chanInv.flatMap((x) => x.rows);
    const byChannel = new Map();
    for (const r of all) {
      const k = r.channel || '未标注渠道';
      if (!byChannel.has(k)) byChannel.set(k, { name: k, visitors: 0, gmv: 0, buyers: 0, impressions: 0 });
      const t = byChannel.get(k);
      t.visitors += Number(r.visitors) || 0; t.gmv += Number(r.gmv) || 0;
      t.buyers += Number(r.buyers) || 0; t.impressions += Number(r.impressions) || 0;
    }
    const chans = [...byChannel.values()].map((t) => ({ ...t, conv: div(t.buyers, t.visitors), gmvShare: null })).sort((a, b) => b.gmv - a.gmv);
    const gmvAll = sum(chans, (c) => c.gmv) || null;
    const visAll = sum(chans, (c) => c.visitors) || null;
    for (const c of chans) { c.gmvShare = div(c.gmv, gmvAll); c.visitorShare = div(c.visitors, visAll); }
    const paid = chans.filter((c) => /付费|千川|广告|随心推|投流/.test(c.name));
    const content = chans.filter((c) => /直播|短视频|视频|内容/.test(c.name));
    const shelf = chans.filter((c) => /搜索|商城|猜你喜欢|购后|商品卡|频道|货架/.test(c.name));
    M.channel = {
      channels: chans,
      gmv: gmvAll, visitors: visAll,
      paidShare: div(sum(paid, (c) => c.gmv), gmvAll),
      contentShare: div(sum(content, (c) => c.gmv), gmvAll),
      shelfShare: div(sum(shelf, (c) => c.gmv), gmvAll),
      method: '按渠道求和后算占比；渠道命名按后台原样保留，不做语义合并（后台未拆分渠道时此段不可用）',
      files: filesOf(chanInv),
    };
  }

  // ---------- 评分卡（八维） ----------
  const scorecard = buildScorecard(M, T, A);

  // ---------- 问题诊断 ----------
  const findings = buildFindings(M, T, A);

  // ---------- 解决方案 + 落地表 ----------
  const solutions = findings.map((f) => ({ id: f.id, level: f.level, title: f.title, steps: f.solution || [] }));
  const landing = findings.flatMap((f) => (f.landing || []).map((l) => ({ priority: f.level, finding: f.title, ...l })));

  // ---------- 机会量化 ----------
  const benefits = buildBenefits(M, T, A);

  // ---------- 结论 ----------
  const conclusions = buildConclusions(M, T, findings, scorecard);

  // ---------- 数据缺口（按缺失的报表类型补齐） ----------
  if (!prodInv.length) { /* 已在上文补 */ }
  if (!M.scale) G('店铺级 GMV 与访客数据', '所有比率型结论的分母，缺此项时推广费占比、UV 价值都无法计算', '罗盘 → 经营概览', 'P0');
  if (!M.promotion && (M.scale?.gmv || 0) > 0) notes.push('未识别到千川报表：无法判断付费是否亏损，也无法算保本 ROI 对照');

  const dataBasis = accepted.map((x) => `${x.file}${x.sheet && x.sheet !== 'CSV' ? ' #' + x.sheet : ''}（${x.typeName}）`);

  return {
    meta: {
      schema: 'douyin-diag/v1',
      platform: 'douyin',
      platformName: '抖音小店',
      engine: 'douyin-shop-ops-expert diag engine',
      store, period: M.scale?.period || period || null,
      generatedAt: new Date().toISOString(),
      assumptions: A, thresholds: T,
      dataBasis, inputFiles: opts.inputFiles || [],
      readErrors: opts.readErrors || [],
      disclaimer: '本报告的阈值与基准值是行业经验值与操作经验线，用于建立判断标准，不是平台承诺值。金额与比率口径已逐项标注，平台口径与本地计算口径存在差异时以平台后台展示为准。校准参数（毛利率/扣点/退款率/签收率）未替换为本店真实值时，涉及收益测算的结论只能当作方向参考。',
    },
    accepted, rejected, foreign,
    metrics: M, scorecard, findings, solutions, landing, benefits,
    dataGaps, notes, conclusions,
  };
}

// ---------------- 评分卡（八维） ----------------
function buildScorecard(M, T, A) {
  const S = [];
  const push = (key, name, score, detail, evidence) => S.push({ key, name, score: score == null ? null : Math.max(0, Math.min(100, Math.round(score))), detail, evidence });
  // 1 规模与增长
  {
    let s = null, d = '缺少店铺级经营概览，无法评估';
    if (M.scale?.gmv != null) {
      s = 60;
      if (M.scale.achieveRate != null) s = Math.min(100, M.scale.achieveRate * 100);
      else if (M.scale.gmvPerDay != null) s = M.scale.gmvPerDay >= 10000 ? 80 : M.scale.gmvPerDay >= 3000 ? 68 : 55;
      d = `GMV ${wan(M.scale.gmv)} 万元 / ${M.scale.days} 天，日均 ${wan(M.scale.gmvPerDay)} 万元`;
    }
    push('scale', '规模与达成', s, d);
  }
  // 2 转化效率
  {
    const conv = M.scale?.conv ?? M.product?.conv;
    let s = null;
    if (conv != null) s = Math.min(100, 40 + (conv / T.conv_min) * 45);
    push('conv', '转化效率', s, conv == null ? '缺少访客与支付买家数据' : `全店转化率 ${pct(conv, 2)}（基线 ${pct(T.conv_min, 1)}）`);
  }
  // 3 内容场（点击率/完播率）
  {
    const ctr = M.product?.ctr;
    const fin = M.content?.finishRate;
    const parts = [];
    if (ctr != null) parts.push(Math.min(100, 40 + (ctr / T.ctr_min) * 40));
    if (fin != null) parts.push(Math.min(100, 40 + (fin / T.finish_rate_min) * 40));
    push('content', '内容与素材', parts.length ? mean(parts) : null,
      [ctr != null ? `商品卡点击率 ${pct(ctr, 2)}（红线 ${pct(T.ctr_min, 1)}）` : null, fin != null ? `短视频完播率 ${pct(fin, 1)}（基线 ${pct(T.finish_rate_min, 0)}）` : null].filter(Boolean).join('；') || '缺少商品卡与短视频数据');
  }
  // 4 货架场（入池率/动销率）
  {
    const parts = [];
    if (M.product?.inPoolReportedAvg != null) parts.push(Math.min(100, (M.product.inPoolReportedAvg / T.in_pool_rate_min) * 70));
    else if (M.product?.inPoolRate != null) parts.push(Math.min(100, (M.product.inPoolRate / T.in_pool_rate_min) * 70));
    if (M.product?.sellThrough != null) parts.push(Math.min(100, (M.product.sellThrough / T.sell_through_min) * 70));
    push('shelf', '货架场健康', parts.length ? mean(parts) : null,
      [
        M.product?.inPoolReportedAvg != null ? `商品卡入池率 ${pct(M.product.inPoolReportedAvg, 1)}（治理线 ${pct(T.in_pool_rate_min, 0)}）` : (M.product?.inPoolRate != null ? `有曝光链接占比 ${pct(M.product.inPoolRate, 1)}` : null),
        M.product?.sellThrough != null ? `动销率 ${pct(M.product.sellThrough, 1)}（基线 ${pct(T.sell_through_min, 0)}）` : null,
      ].filter(Boolean).join('；') || '缺少商品卡明细');
  }
  // 5 付费效率
  {
    let s = null, d = '未识别到千川报表';
    if (M.promotion?.roi != null) {
      s = Math.min(100, (M.promotion.roi / T.breakeven_roi) * 75);
      d = `ROI ${M.promotion.roi.toFixed(2)}（保本 ${T.breakeven_roi.toFixed(2)}）`;
      if (M.promotion.costShare != null) d += `，推广费占比 ${pct(M.promotion.costShare, 1)}`;
    }
    push('paid', '付费投放效率', s, d);
  }
  // 6 体验分
  {
    let s = null, d = '未识别到体验分数据';
    if (M.experience?.score100 != null) {
      const v = M.experience.score100;
      s = v <= T.exp_score_floor ? 20 : Math.min(100, 40 + ((v - T.exp_score_floor) / Math.max(1, T.exp_score_target - T.exp_score_floor)) * 60);
      d = `体验分 ${v.toFixed(0)}（${M.experience.scale}，红线 ${T.exp_score_floor} / 达标 ${T.exp_score_target}）`;
      if (M.experience.shortest) d += `，短板 ${M.experience.shortest[0]} ${M.experience.shortest[1].toFixed(0)}`;
    }
    push('experience', '体验分与口碑', s, d);
  }
  // 7 服务与售后
  {
    const parts = [];
    if (M.service?.reply3min != null) parts.push(Math.min(100, (M.service.reply3min / T.reply3min_min) * 80));
    if (M.orders?.refundRate != null) parts.push(Math.max(0, 100 - (M.orders.refundRate / Math.max(0.01, (A.refund_rate_assumed || 0.08))) * 45));
    else if (M.experience?.negFeedback != null) parts.push(Math.max(0, 100 - (M.experience.negFeedback / 0.015) * 45));
    push('service', '服务与售后', parts.length ? mean(parts) : null,
      [
        M.service?.reply3min != null ? `3 分钟人工回复率 ${pct(M.service.reply3min, 1)}（门槛 ${pct(T.reply3min_min, 0)}）` : null,
        M.orders?.refundRate != null ? `退款率（金额口径）${pct(M.orders.refundRate, 1)}` : null,
      ].filter(Boolean).join('；') || '缺少客服与退款数据');
  }
  // 8 履约
  {
    const parts = [];
    if (M.fulfillment?.ship24h != null) parts.push(Math.min(100, (M.fulfillment.ship24h / T.ship24h_min) * 85));
    if (M.fulfillment?.pickupRate != null) parts.push(Math.min(100, (M.fulfillment.pickupRate / T.pickup_rate_min) * 85));
    push('fulfil', '发货与履约', parts.length ? mean(parts) : null,
      [
        M.fulfillment?.ship24h != null ? `24h 发货率 ${pct(M.fulfillment.ship24h, 1)}（门槛 ${pct(T.ship24h_min, 0)}）` : null,
        M.fulfillment?.pickupRate != null ? `揽收及时率 ${pct(M.fulfillment.pickupRate, 1)}（门槛 ${pct(T.pickup_rate_min, 0)}）` : null,
        M.fulfillment?.lateOrders ? `延迟发货 ${num(M.fulfillment.lateOrders)} 单` : null,
      ].filter(Boolean).join('；') || '缺少履约数据');
  }
  return S;
}

// ---------------- 问题诊断 ----------------
// 每条 finding 固定五段：数据证据 → 量化影响 → 根因链 → 依据（模块-小节）→ 可照做的解决方案。
function buildFindings(M, T, A) {
  const F = [];
  const add = (o) => F.push({
    id: o.id, level: o.level, dim: o.dim, title: o.title,
    evidence: o.evidence, impact: o.impact, rootCause: o.rootCause,
    kb: o.kb || [], solution: o.solution || [], landing: o.landing || [],
  });

  // ===== 体验分（闸门，最高优先级）=====
  if (M.experience?.score100 != null) {
    const v = M.experience.score100;
    if (v < T.exp_score_target) {
      const short = M.experience.shortest;
      const lvl = v < T.exp_score_floor ? 'P0' : 'P1';
      add({
        id: 'EXP-LOW', level: lvl, dim: '体验分', title: `商家体验分 ${v.toFixed(0)} 低于达标线 ${T.exp_score_target}${v < T.exp_score_floor ? '，已跌破红线' : ''}`,
        evidence: `体验分 ${v.toFixed(0)}（${M.experience.scale}；商品 ${M.experience.goods == null ? '—' : M.experience.goods.toFixed(0)} / 物流 ${M.experience.logistics == null ? '—' : M.experience.logistics.toFixed(0)} / 服务 ${M.experience.service == null ? '—' : M.experience.service.toFixed(0)}）${M.experience.snapshotDate ? '，快照日期 ' + M.experience.snapshotDate : ''}`,
        impact: v < T.exp_score_floor
          ? '体验分跌破红线会同时触发三件事：商城与搜索推荐限流、精选联盟与部分活动准入被挡、系统对商品的信任加权下降。此时继续加投放等于在关着的闸门前加水。'
          : '体验分未达标会压缩自然流量入口与活动报名资格，付费流量缺少自然流量承接，ROI 会被动变差。',
        rootCause: short ? `三维中最弱的是「${short[0]}」${short[1].toFixed(0)} 分，短板决定总分上限；先修短板，不要平均用力。` : '三维子分不完整，需先补齐子分数据再定位短板。',
        kb: ['M09 体验分 · 一、底层逻辑与平台机制', 'M09 体验分 · 六、避坑清单与合规实战'],
        solution: [
          `先定位短板维度：${short ? '「' + short[0] + '」' : '三维子分'}，按维度拆子指标（商品：负反馈率/好评率；物流：发货与揽收；服务：飞鸽响应/售后审核/平台求助率）。`,
          '商品维度：把差评与负反馈落到具体 SKU，凡是「描述不符」集中的 SKU 先改详情与主图卖点，再谈投放。',
          '物流维度：核对电子面单与快递时效，把承诺发货时效设成能稳定做到的档位，宁可承诺长一点也不要超时。',
          '服务维度：飞鸽设自动回复 + 高峰人工值守，售后审核当日清；平台求助率高的会话逐单复盘。',
          '整改期间暂停新增投放，用 7 天为一个观察窗，看体验分与子分是否回升再决定恢复投放。',
        ],
        landing: [
          { action: '拉出体验分三维子分与扣分项，锁定短板维度', owner: '运营负责人', window: '24 小时内', kpi: `体验分 ≥ ${T.exp_score_target}` },
          { action: '按短板维度出整改清单并逐项销项', owner: '商品/物流/客服各归口', window: '7 天', kpi: '短板子分回升 ≥ 5 分' },
        ],
      });
    }
    if (M.experience.negFeedback != null && M.experience.negFeedback > 0.015) {
      add({
        id: 'EXP-NEG', level: 'P1', dim: '体验分', title: `商品负反馈率 ${pct(M.experience.negFeedback, 2)} 高于 1.5% 预警线`,
        evidence: `商品负反馈率 ${pct(M.experience.negFeedback, 2)}（预警线 1.5%）`,
        impact: '负反馈率直接进商品体验子分，且会压低商品在商城/搜索的推荐权重。',
        rootCause: '通常是三类原因：描述与实物不符、品质波动、发货与物流体验外溢。',
        kb: ['M09 体验分 · 一、底层逻辑与平台机制', 'M10 客服与售后 · 六、避坑清单与合规实战'],
        solution: [
          '把负反馈工单按 SKU 与原因归类，找出贡献 TOP3 的 SKU。',
          '描述不符类：改主图与详情中的规格/材质/数量表述，删掉极限词与夸大表述。',
          '品质波动类：与供应商对批次做抽检，必要时换批次或换供应商。',
          '物流外溢类：同步修发货时效与包裹完好度，见履约段动作。',
        ],
        landing: [{ action: '输出负反馈 TOP3 SKU 与原因分布，逐款改主图/详情/供应商', owner: '运营 + 商品', window: '7 天', kpi: '负反馈率 ≤ 1.5%' }],
      });
    }
  }

  // ===== 千川 ROI =====
  if (M.promotion?.roi != null) {
    const roi = M.promotion.roi, be = T.breakeven_roi;
    if (roi < be) {
      const gap = (be - roi) / be;
      add({
        id: 'AD-ROI', level: gap > 0.2 ? 'P0' : 'P1', dim: '付费投放', title: `千川 ROI ${roi.toFixed(2)} 低于保本线 ${be.toFixed(2)}`,
        evidence: `消耗 ${money(M.promotion.cost)} 元、成交 ${money(M.promotion.adGmv)} 元、ROI ${roi.toFixed(2)}；保本 ROI = 1 ÷ 毛利率 ${pct(A.gross_margin, 0)} = ${be.toFixed(2)}${M.promotion.costShare != null ? `；推广费占全店 GMV ${pct(M.promotion.costShare, 1)}` : ''}`,
        impact: `按当前消耗规模测算，距保本线差 ${pct(gap, 1)}；要么把 ROI 拉到达标，要么把亏损计划的消耗关掉。亏损计划合计消耗 ${money(M.promotion.loserCost)} 元，是止损的第一刀。`,
        rootCause: 'ROI 不达标一般不是出价问题，而是素材与人群匹配问题：素材断档 → 系统找不到人 → 消耗跑在宽泛人群上 → 转化成本抬升。计划层面往往还伴随学习期内频繁改价。',
        kb: ['M07 千川投放 · 一、底层逻辑与平台机制', 'M07 千川投放 · 六、避坑清单与合规实战'],
        solution: [
          `先做止损：把 ROI 低于保本线且累计消耗 ≥100 元的计划列出（本报告已给清单），关停或直接压价 30% 起，不要小步试。`,
          '再看素材：账户常备 3–5 条可跑素材，近 7 天新上线素材消耗占比不低于 30%；素材平台期通常 3–7 天，断档必然出现消耗真空。',
          '学习期内单日改价/改定向不超过 2 次、单次幅度不超过 10%，否则模型反复重置，且丧失成本保障赔付资格。',
          '把跑通的计划按 10%–20% 阶梯放量，不要一次翻倍；放量后先看 24 小时消耗稳定性，再看 ROI 是否守住保本线。',
          '用退款后的净成交口径复核一遍 ROI，避免被退款吞掉真实产出。',
        ],
        landing: [
          { action: '关停/压价低于保本线的亏损计划（清单见报告正文）', owner: '投放手', window: '当日', kpi: `关停后账户 ROI ≥ ${be.toFixed(2)}` },
          { action: '建立素材储备：常备 3–5 条可跑素材并排上线节奏', owner: '内容 + 投放', window: '7 天', kpi: '近 7 天新素材消耗占比 ≥ 30%' },
          { action: '把达标计划按 10%–20% 阶梯放量并每日盯保本线', owner: '投放手', window: '持续', kpi: '放量后 ROI 不低于保本线' },
        ],
      });
    } else if (M.promotion.costShare != null && M.promotion.costShare > 0.35) {
      add({
        id: 'AD-SHARE', level: 'P1', dim: '付费投放', title: `推广费占全店 GMV ${pct(M.promotion.costShare, 1)}，付费依赖偏高`,
        evidence: `消耗 ${money(M.promotion.cost)} 元 ÷ 全店 GMV ${money(M.scale?.gmv)} 元 = ${pct(M.promotion.costShare, 1)}（目标 ${pct(A.ad_ratio_target, 0)}）`,
        impact: '付费占比越高，停投归零的风险越大；自然流量与内容场没有同步长起来时，店铺利润被投放吃掉。',
        rootCause: '增长主要靠付费推力，商品卡内功（点击率/转化率/评价）与内容场产出没有跟上。',
        kb: ['M01 平台认知与流量逻辑 · 三、收益最大化（含极致打法）', 'M05 商品卡与商城流量 · 三、收益最大化（含极致打法）'],
        solution: [
          '把已跑通的爆款用商品卡内功承接：主图点击率、搜索词覆盖、评价与优惠券补齐，让免费流量接得住。',
          '同步起内容场（短视频测素材 + 直播承接），付费只用于放大已被验证的模型。',
          '按周盯「自然流量占比」，把它当成比 ROI 更重要的结构指标。',
        ],
        landing: [{ action: '出自然流量占比周报，锁定第一批可承接免费流量的链接', owner: '运营负责人', window: '每周', kpi: '推广费占比降至 30% 以内' }],
      });
    }
  }

  // ===== 商品卡（入池 / 点击率 / 四象限）=====
  if (M.product) {
    const inPool = M.product.inPoolReportedAvg != null ? M.product.inPoolReportedAvg : M.product.inPoolRate;
    if (inPool != null && inPool < T.in_pool_rate_min) {
      add({
        id: 'CARD-POOL', level: inPool < T.in_pool_rate_min * 0.5 ? 'P0' : 'P1', dim: '商品卡', title: `商品卡入池率 ${pct(inPool, 1)} 低于治理线 ${pct(T.in_pool_rate_min, 0)}`,
        evidence: `在架 ${M.product.skuCount} 款，有访客 ${M.product.skuWithVisitors} 款，零曝光 ${M.product.dead} 款；入池率 ${pct(inPool, 1)}`,
        impact: '未入池链接做任何详情优化都看不到效果——它们连展示机会都没有。入池率低还会拉低全店动销，触发低动销治理，形成「越铺越没量」的死循环。',
        rootCause: '常见三类：① 商品信息质量分不够（基础信息/属性/标题不全）；② 关键词与行业搜索词不匹配；③ 同一批铺货导致同质化被系统判定劣质重复。',
        kb: ['M05 商品卡与商城流量 · 一、底层逻辑与平台机制', 'M05 商品卡与商城流量 · 二、逐步操作 SOP'],
        solution: [
          '先查准入：上架次日查「商城展示准入」状态与未达标原因，未入池的先改准入项，不要先改价格。',
          '把低曝光词换成近期热搜词，用「标题优化托管（手动）」；不要用智能托管批量改，会把本来有流量的链接改坏。',
          '商品信息质量分（60 分基础 + 40 分优化）逐项补齐到 85 分以上，主图视频与卖点属于优化分，属于「低成本高确定性」项。',
          '同一批重复铺货做差异化（标题/场景/角度/去水印），再上新；同质化链接不是资产是负债。',
          '定一个入池率目标（如 30%）和每周检查节奏，未达标先停上新再修存量。',
        ],
        landing: [
          { action: '导出未入池链接清单，按未达标原因分类并逐条整改', owner: '商品运营', window: '7 天', kpi: `入池率 ≥ ${pct(T.in_pool_rate_min, 0)}` },
          { action: '全部在架链接跑一遍商品信息质量分，低于 85 分的补齐', owner: '商品运营', window: '7 天', kpi: '质量分达标率 ≥ 80%' },
        ],
      });
    }
    if (M.product.ctr != null && M.product.ctr < T.ctr_min) {
      add({
        id: 'CARD-CTR', level: 'P1', dim: '商品卡', title: `商品卡整体点击率 ${pct(M.product.ctr, 2)} 低于红线 ${pct(T.ctr_min, 1)}`,
        evidence: `曝光 ${num(M.product.impressions ?? (M.scale?.impressions))}、点击 ${num(M.product.clicks)}、点击率 ${pct(M.product.ctr, 2)}；点击率口径：${M.product.ctrBasis}`,
        impact: '点击率是曝光的乘数杠杆：点击率从 3% 提到 4%，同曝光下访客 +33%，等效于白拿三分之一流量，比加预算便宜得多。',
        rootCause: '首图没讲清「是什么 + 为什么值」，或主体占比/卖点文案不合规；也可能是首图与搜索词意图不匹配（点进来的人不是要这个）。',
        kb: ['M05 商品卡与商城流量 · 一、底层逻辑与平台机制', 'M03 短视频内容制作与起号 · 二、逐步操作 SOP'],
        solution: [
          '测图只看「猜你喜欢」渠道的点击率——搜索与猜你喜欢最不受人为干预，最能反映主图真实表现；汇总点击率会被渠道结构掩盖。',
          '首图规范：场景图或卖点图、主体占比 ≥70%、卖点文案不超过 5 字、无水印无拼接无第三方导流、无未授权品牌元素。',
          '扒竞品：把同价格带前列同行按该渠道点击率排序，直接模仿其排版与信息顺序，不要凭审美改图。',
          '一轮只改首图首帧，测 3 轮以上再下结论；同时把白底图单独上传供公域调用。',
        ],
        landing: [{ action: '对点击率低于红线的 TOP20 链接做首图重做与 3 轮测图', owner: '视觉 + 运营', window: '14 天', kpi: `点击率 ≥ ${pct(T.ctr_min, 1)}` }],
      });
    }
    const hi = M.product.quadrant?.['高点击高转化'];
    if (hi && hi.count >= 1 && (M.product.concentration?.top5 ?? 0) > 0.5) {
      add({
        id: 'CARD-CONC', level: 'P2', dim: '商品卡', title: `GMV 集中度偏高：TOP5 占 ${pct(M.product.concentration.top5, 0)}`,
        evidence: `高点击高转化链接 ${hi.count} 款，TOP5 占 GMV ${pct(M.product.concentration.top5, 0)}、TOP20 占 ${pct(M.product.concentration.top20, 0)}`,
        impact: '单链接波动直接决定全店业绩；同时平台看的是店铺整体动销，头部过重而长尾全死会被判低动销。',
        rootCause: '资源与维护动作过度集中在少数链接，长尾链接入池与优化缺位。',
        kb: ['M01 平台认知与流量逻辑 · 一、底层逻辑与平台机制', 'M06 选品与爆品逻辑 · 三、收益最大化（含极致打法）'],
        solution: [
          '对高点击高转化链接做「列变」（同品裂变多条链接）放大免费流量，这是成本最低的放量方式。',
          '把已验证爆款的同款/相似款做成差异化链接，用真实主图与真实货源截流，不搬运不违规比价。',
          '长尾定为「小链接矩阵」：一百个每天赚几十块的链接，比赌两三个爆款更抗波动。',
        ],
        landing: [{ action: '对高点击高转化链接做列变，产出 3–5 条差异化新链接', owner: '运营 + 商品', window: '14 天', kpi: 'TOP5 GMV 占比降至 50% 以内且总 GMV 不降' }],
      });
    }
  }

  // ===== 退款 =====
  if (M.orders?.refundRate != null) {
    const rr = M.orders.refundRate;
    const assumed = A.refund_rate_assumed || 0.08;
    if (rr > assumed) {
      const top = (M.orders.reasonTop || []).slice(0, 3).map((r) => `${r.reason}（${money(r.weight)} 元）`).join('、');
      add({
        id: 'AFTER-REFUND', level: rr > assumed * 2 ? 'P0' : 'P1', dim: '售后', title: `退款率（金额口径）${pct(rr, 2)} 高于假设基线 ${pct(assumed, 1)}`,
        evidence: `有效订单 ${num(M.orders.validRows)} 行、实付 ${money(M.orders.gmvValid)} 元、退款 ${money(M.orders.refundAmount)} 元；退款原因金额权重 TOP：${top || '未标注原因'}`,
        impact: `退款直接吃掉到手 GMV：${money(M.orders.refundAmount)} 元的退款相当于把同等规模的毛利清零。同时退款率是体验分的扣分项，会反向压缩流量。`,
        rootCause: '从原因分布看，退款集中在少数原因上（见上）；发货/物流类原因说明履约没兜住，描述不符类说明详情与实物不一致。',
        kb: ['M10 客服与售后 · 二、逐步操作 SOP', 'M11 发货与履约 · 一、底层逻辑与平台机制'],
        solution: [
          '按退款原因做金额权重排序，只打贡献最大的两类原因，不要平均整改。',
          '物流类原因：核对发货时效承诺与快递揽收表现，把时效改成稳定可达的档位；拦截在途异常单主动联系用户。',
          '描述不符类：改主图/详情表述，删除极限词；对高退款 SKU 先降权处理（减投放、减曝光）再整改。',
          '客服侧：售后审核当日清掉，避免「等处理」拖成平台介入与负反馈。',
        ],
        landing: [
          { action: '输出退款原因金额权重 TOP3 的整改责任单', owner: '售后主管', window: '3 天', kpi: `退款率 ≤ ${pct(assumed, 1)}` },
          { action: '建立高退款 SKU 预警（退款率 >10% 自动降投放）', owner: '运营', window: '14 天', kpi: '高退款 SKU 数量下降 50%' },
        ],
      });
    }
  } else if (M.experience?.negFeedback != null && M.experience.negFeedback > 0.015) {
    // 已有负反馈 finding 覆盖
  } else if (!M.orders) {
    dataGapNoop();
  }

  // ===== 履约 =====
  if (M.fulfillment) {
    const { ship24h, pickupRate, lateOrders, abnormal } = M.fulfillment;
    if ((ship24h != null && ship24h < T.ship24h_min) || (pickupRate != null && pickupRate < T.pickup_rate_min)) {
      add({
        id: 'FUL-LATE', level: 'P0', dim: '发货履约', title: `发货/揽收时效未达标`,
        evidence: [
          ship24h != null ? `24h 发货率 ${pct(ship24h, 1)}（门槛 ${pct(T.ship24h_min, 0)}）` : null,
          pickupRate != null ? `揽收及时率 ${pct(pickupRate, 1)}（门槛 ${pct(T.pickup_rate_min, 0)}）` : null,
          lateOrders ? `延迟发货 ${num(lateOrders)} 单` : null,
          abnormal ? `物流异常 ${num(abnormal)} 单` : null,
        ].filter(Boolean).join('；'),
        impact: '发货超时与物流异常同时是平台违规项（有赔付与扣分风险）与体验分扣分项，属于「一次失误双倍损失」，优先级高于任何增长动作。',
        rootCause: '要么是对外承诺的时效比实际能力更短，要么是打单/交件流程有断点（缺货、漏打、快递未按时揽收）。',
        kb: ['M11 发货与履约 · 一、底层逻辑与平台机制', 'M11 发货与履约 · 二、逐步操作 SOP'],
        solution: [
          '先对齐承诺与实际：把发货时效承诺设成能稳定做到的档位（宁长勿超），再逐步压缩。',
          '定截止时间：每天设两个截单点，超时未打单的订单当日二次催办，责任人明确到人。',
          '电子面单与打单流程标准化，缺货订单当天做分单/换货/退款处理，不要让订单悬着。',
          '对物流异常单建立主动跟进话术，先联系用户再等投诉。',
        ],
        landing: [
          { action: '设定每日两个截单点并指定打单责任人', owner: '仓储/发货', window: '当日', kpi: `24h 发货率 ≥ ${pct(T.ship24h_min, 0)}` },
          { action: '把发货时效承诺调整到可达档位', owner: '运营', window: '3 天', kpi: '延迟发货订单 −80%' },
        ],
      });
    }
  } else if (M.orders) {
    G('发货履约/物流时效报表（抖店后台 → 订单 → 发货履约，或物流看板导出）', '发货时效达标判断与延迟赔付风险量化', '抖店后台 → 订单 → 履约/物流 → 导出', 'P1');
  }

  // ===== 客服 =====
  if (M.service?.reply3min != null && M.service.reply3min < T.reply3min_min) {
    const worst = (M.service.agents || []).filter((a) => a.reply3min != null).sort((a, b) => a.reply3min - b.reply3min)[0];
    add({
      id: 'SVC-REPLY', level: 'P1', dim: '客服服务', title: `3 分钟人工回复率 ${pct(M.service.reply3min, 1)} 低于门槛 ${pct(T.reply3min_min, 0)}`,
      evidence: `整体 ${pct(M.service.reply3min, 1)}${worst ? `；最差坐席「${worst.name}」${pct(worst.reply3min, 1)}` : ''}${M.service.firstReplySec != null ? `；平均首次响应 ${M.service.firstReplySec.toFixed(0)} 秒` : ''}`,
      impact: '回复率是服务体验子分的直接考核项；高峰没人接单会同时损失转化（咨询未接 → 不下单）与体验分。',
      rootCause: '排班与咨询量曲线不匹配（高峰无人）、自动回复未覆盖高频问题、坐席负载不均。',
      kb: ['M10 客服与售后 · 一、底层逻辑与平台机制', 'M10 客服与售后 · 二、逐步操作 SOP'],
      solution: [
        '把咨询量按小时拉出来，按曲线排班，高峰时段人工必须在岗。',
        '飞鸽自动回复与快捷短语覆盖高频问题（发货时间、尺码/规格、优惠、售后退换）。',
        '按坐席看回复率与满意度，差的下钻到具体会话；排班与话术一起改。',
        '把「未接起会话」当成丢失的订单来复盘，而不是当成客服个人问题。',
      ],
      landing: [{ action: '按小时咨询曲线重排客服班次并配置自动回复', owner: '客服主管', window: '7 天', kpi: `3 分钟人工回复率 ≥ ${pct(T.reply3min_min, 0)}` }],
    });
  } else if (!M.service && M.experience?.service != null) {
    if (M.experience.service < T.exp_score_target) {
      add({
        id: 'SVC-DIM', level: 'P2', dim: '客服服务', title: `服务体验子分 ${M.experience.service.toFixed(0)} 偏低`,
        evidence: `服务体验 ${M.experience.service.toFixed(0)} / 达标线 ${T.exp_score_target}`,
        impact: '服务维度是体验分权重较高的一维，拖后腿会同时影响流量准入与活动资格。',
        rootCause: '缺少飞鸽明细，无法定位到具体子指标（回复率/满意度/售后审核/平台求助率）。',
        kb: ['M10 客服与售后 · 一、底层逻辑与平台机制'],
        solution: ['补导飞鸽客服明细，把服务维度拆成回复率、满意度、售后审核时长、平台求助率四项分别对标。'],
        landing: [{ action: '补导飞鸽客服绩效明细', owner: '客服主管', window: '3 天', kpi: '四项子指标各有基线' }],
      });
    }
  }

  // ===== 直播 =====
  if (M.live && M.live.sessions >= 4) {
    const weak = [];
    if (M.live.enterRate != null && M.live.enterRate < 0.15) weak.push(`曝光进入率 ${pct(M.live.enterRate, 1)}（低于 15% 常见线）`);
    if (M.live.avgWatchMin != null && M.live.avgWatchMin < 1) weak.push(`人均观看 ${M.live.avgWatchMin.toFixed(2)} 分钟（低于 1 分钟）`);
    if (M.live.concentration != null && M.live.concentration > 0.7) weak.push(`前 25% 场次贡献 ${pct(M.live.concentration, 0)} 的成交，两极分化严重`);
    if (weak.length) {
      add({
        id: 'LIVE-WEAK', level: 'P1', dim: '直播', title: '直播间漏斗前段表现偏弱',
        evidence: `共 ${M.live.sessions} 场，观看人次 ${num(M.live.watchCount)}，成交 ${money(M.live.gmv)}，GPM ${money(M.live.gpm)}；${weak.join('；')}`,
        impact: '直播是实时赛马：进入、停留不达标，系统在漏斗前两层就停止给量，后面的话术与转化再强也没有观众。',
        rootCause: '按漏斗定位即可：曝光进入率低 → 封面/标题/开播时段问题；停留短 → 人货场匹配与话术节奏问题；两极分化 → 起号期单场猛冲，没有连续多场的稳定数据。',
        kb: ['M08 直播运营 · 一、底层逻辑与平台机制', 'M08 直播运营 · 三、收益最大化（含极致打法）'],
        solution: [
          '按五层漏斗（曝光→进入→停留→互动→转化）先定位卡点，缺哪层补哪层，不要笼统归为「流量不精准」。',
          '进入率低：改封面与直播标题的利益点，开播时段对齐目标人群在线高峰。',
          '停留短：把开场 30 秒改成「价值前置 + 钩子」，排品按引流品→主推品→利润品的顺序排。',
          '起号期不要单场冲 GMV：先连续多场把停留与互动做稳，破层级靠的是连续稳定而不是单场爆冲。',
        ],
        landing: [
          { action: '按漏斗五层出单场复盘表，锁定卡点层级', owner: '直播运营', window: '每场', kpi: '进入率 ≥ 15%、人均观看 ≥ 1 分钟' },
          { action: '重排开场 30 秒话术与排品顺序', owner: '主播 + 中控', window: '7 天', kpi: 'GPM 环比提升 20%' },
        ],
      });
    }
  }

  // ===== 短视频 =====
  if (M.content && M.content.count >= 5) {
    if (M.content.finishRate != null && M.content.finishRate < T.finish_rate_min) {
      add({
        id: 'VIDEO-FINISH', level: 'P2', dim: '内容场', title: `短视频完播率 ${pct(M.content.finishRate, 1)} 低于基线 ${pct(T.finish_rate_min, 0)}`,
        evidence: `作品 ${M.content.count} 条、播放 ${num(M.content.playCount)}；完播率均值 ${pct(M.content.finishRate, 1)}，高完播（≥35%）${M.content.highFinish} 条、低完播 ${M.content.lowFinish} 条`,
        impact: '完播率决定内容能不能进下一层流量池：完播不达标，账号拿不到自然流量，只能靠付费补，获客成本结构性上升。',
        rootCause: '前 3 秒没有给出「看下去的理由」（钩子弱），或内容与目标人群/账号标签不匹配。',
        kb: ['M03 短视频内容制作与起号 · 一、底层逻辑与平台机制', 'M03 短视频内容制作与起号 · 二、逐步操作 SOP'],
        solution: [
          '拆解自己高完播的少数作品，把其钩子结构与节奏复用到新内容上。',
          '前 3 秒必须给结果或冲突，不要做冗长铺垫；单条时长与卖点数量做减法。',
          '保持账号标签一致性：起号期不要用多品类内容测爆款，标签一乱需要更长时间收敛。',
          '用「完播率 + 互动率」一起看：高完播低互动说明留人但不动人，钩子要更明确。',
        ],
        landing: [{ action: '按高完播作品的钩子结构重写 5 条脚本', owner: '内容编导', window: '14 天', kpi: `完播率 ≥ ${pct(T.finish_rate_min, 0)}` }],
      });
    }
  }

  // ===== 达人 =====
  if (M.talent && M.talent.count >= 3) {
    if (M.talent.concentration != null && M.talent.concentration > 0.6) {
      add({
        id: 'TALENT-CONC', level: 'P2', dim: '精选联盟', title: `达人带货集中在少数达人：TOP3 占 ${pct(M.talent.concentration, 0)}`,
        evidence: `合作达人 ${M.talent.count} 位，合计 ${money(M.talent.gmv)} 元，佣金 ${money(M.talent.commission)} 元${M.talent.refundRateAvg != null ? `，达人退款率均值 ${pct(M.talent.refundRateAvg, 1)}` : ''}`,
        impact: '单一达人停播即断供；且达人合作一旦只看 GMV 不看退款率，容易出现「卖得越多退得越多」的假增长。',
        rootCause: '招商动作集中在头部少数达人，没有形成可复投的分层池。',
        kb: ['M14 精选联盟与达人带货 · 二、逐步操作 SOP', 'M14 精选联盟与达人带货 · 三、收益最大化（含极致打法）'],
        solution: [
          '建达人分层池：把已合作达人按 GMV、退款率、佣金率三维分档，可复投的进入常规复投名单。',
          '复投用定向计划（专属佣金 + 优惠券）承接，而不是简单提佣金。',
          '对新达人先用小样与小佣金测，跑出模型再加码；避免一次性投入大量寄样。',
        ],
        landing: [{ action: '输出达人分层池与复投排期', owner: '招商/联盟运营', window: '14 天', kpi: 'TOP3 达人 GMV 占比降至 50% 以内' }],
      });
    }
    const badTalent = (M.talent.top || []).filter((t) => t.refundRate != null && t.refundRate > 0.15 && t.gmv > 0).slice(0, 5);
    if (badTalent.length) {
      add({
        id: 'TALENT-REFUND', level: 'P1', dim: '精选联盟', title: `${badTalent.length} 位达人退款率高于 15%，属于「卖出即退」`,
        evidence: badTalent.map((t) => `${t.name}：成交 ${money(t.gmv)} 元，退款率 ${pct(t.refundRate, 1)}`).join('；'),
        impact: '这类合作佣金照付、GMV 照算，但退款把毛利吃穿；同时退款率会进体验分，属双重损失。',
        rootCause: '达人对货不对口（人群与商品不匹配）、或过度承诺（话术超出商品实际）导致退货。',
        kb: ['M14 精选联盟与达人带货 · 六、避坑清单与合规实战', 'M10 客服与售后 · 二、逐步操作 SOP'],
        solution: [
          '对高退款达人暂停复投，先核对直播/短视频话术是否超出商品承诺。',
          '把退款率纳入达人复投判定门槛，与 GMV 同时看；只给「低退款 + 有量」的达人定向佣金。',
          '对高退款品类改做小规格/试用装，降低决策风险。',
        ],
        landing: [{ action: '更新达人复投白名单（退款率门槛）', owner: '联盟运营', window: '7 天', kpi: '达人退款率均值 ≤ 10%' }],
      });
    }
  }

  // ===== 流量结构（付费依赖）=====
  if (M.channel && M.channel.paidShare != null && M.channel.paidShare > 0.5) {
    add({
      id: 'FLOW-STRUCT', level: 'P1', dim: '流量结构', title: `付费渠道 GMV 占比 ${pct(M.channel.paidShare, 0)}，自然与内容场承接不足`,
      evidence: `付费 ${pct(M.channel.paidShare, 0)}、内容场 ${pct(M.channel.contentShare, 0)}、货架场 ${pct(M.channel.shelfShare, 0)}（按 GMV 口径）`,
      impact: '付费占比长期过半意味着停投即归零；健康的店应该让内容场与货架场承担至少一半的成交。',
      rootCause: '增长路径单一依赖投放，商品卡内功与内容场产出没同步建设。',
      kb: ['M01 平台认知与流量逻辑 · 一、底层逻辑与平台机制', 'M05 商品卡与商城流量 · 三、收益最大化（含极致打法）'],
      solution: [
        '把付费跑通的品同步做进商品卡（搜索词覆盖 + 主图点击率 + 评价），让免费流量接得住。',
        '每周盯三条曲线的占比变化：付费、内容场、货架场，把自然占比上升作为结构性 KPI。',
      ],
      landing: [{ action: '出付费/内容/货架三条流水的周度占比看板', owner: '运营负责人', window: '每周', kpi: '自然流量占比逐周上升' }],
    });
  }

  // 无问题时的兜底结论
  if (!F.length) {
    add({
      id: 'OK-BASE', level: 'P2', dim: '整体', title: '在已提交的数据范围内未触发红线项',
      evidence: `已识别 ${M.scale ? '店铺规模、' : ''}${M.product ? '商品卡、' : ''}${M.promotion ? '千川、' : ''}${M.experience ? '体验分、' : ''}${M.orders ? '订单退款、' : ''}${M.fulfillment ? '履约、' : ''}${M.service ? '客服、' : ''}${M.live ? '直播、' : ''}${M.content ? '短视频、' : ''}${M.talent ? '达人、' : ''}${M.channel ? '流量结构' : ''} 等数据`,
      impact: '但「没触发阈值」不等于「没有优化空间」——阈值只覆盖已知红线，增长空间要看结构指标（自然流量占比、动销率、集中度）。',
      rootCause: '当前判断基于本店提交的数据与内置阈值，未与同行分位数对比。',
      kb: ['M13 罗盘与数据复盘 · 二、逐步操作 SOP'],
      solution: ['补导同行对比与分渠道数据，把「是否达标」升级为「与同层竞品的相对位置」。', '建立日/周/月三级复盘节奏，把阈值检查固化成例行动作。'],
      landing: [{ action: '建立日周月三级复盘节奏并落到具体看板', owner: '运营负责人', window: '7 天', kpi: '每日 6 个核心数 5 分钟内可读' }],
    });
  }
  return F;
}
function dataGapNoop() { /* 保持分支对称，缺数据时由 dataGaps 统一承接 */ }

// ---------------- 机会量化 ----------------
// 只量化「口径清楚、能算出来」的机会；算不出来的不编。
function buildBenefits(M, T, A) {
  const items = [];
  const period = M.scale?.days || 31;
  const gmv = M.scale?.gmv ?? null;
  if (M.product?.ctr != null && M.product.ctr < T.ctr_min && M.scale?.impressions) {
    const delta = T.ctr_min - M.product.ctr;
    const extraVisitors = M.scale.impressions * delta;
    const conv = M.scale.conv ?? M.product.conv;
    if (conv != null && M.scale.aov != null) {
      const extra = extraVisitors * conv * M.scale.aov;
      items.push({ label: '商品卡点击率提升到红线带来的增量 GMV', gmvPerPeriod: extra, basis: `曝光 ${num(M.scale.impressions)} × 点击率提升 ${(delta * 100).toFixed(2)}pp × 转化率 ${pct(conv, 2)} × 客单价 ${money(M.scale.aov)} 元；前提：曝光量不变、转化率不变` });
    }
  }
  if (M.promotion?.cost != null && M.promotion.roi != null && M.promotion.roi < T.breakeven_roi) {
    const needed = M.promotion.cost * T.breakeven_roi - (M.promotion.adGmv || 0);
    if (needed > 0) items.push({ label: '千川 ROI 拉回保本线需要补的成交额（或等额止损）', gmvPerPeriod: needed, basis: `消耗 ${money(M.promotion.cost)} 元 × 保本 ROI ${T.breakeven_roi.toFixed(2)} − 当前成交 ${money(M.promotion.adGmv)} 元；等价说法：把亏损计划的 ${money(M.promotion.loserCost)} 元消耗关掉即可减少等额损失` });
  }
  if (M.orders?.refundAmount && M.orders.refundAmount > 0) {
    const target = (A.refund_rate_assumed || 0.08);
    const save = M.orders.refundAmount - (M.orders.gmvValid || 0) * target;
    if (save > 0) items.push({ label: '退款率降到基线可挽回的成交额', gmvPerPeriod: save, basis: `退款 ${money(M.orders.refundAmount)} 元 − 实付 ${money(M.orders.gmvValid)} 元 × 基线退款率 ${pct(target, 1)}；前提：退款原因可整改` });
  }
  if (M.fulfillment && ((M.fulfillment.lateOrders || 0) > 0)) {
    items.push({ label: '延迟发货的赔付与售后风险敞口', gmvPerPeriod: null, basis: `延迟发货 ${num(M.fulfillment.lateOrders)} 单；赔付比例与上限按平台规则（见 kb/metrics.json 的 late_ship 条目），不同承诺时效档位赔付比例不同`, nonGmv: true });
  }
  const total = sum(items.filter((x) => !x.nonGmv), (x) => x.gmvPerPeriod) || null;
  return { items, totalGmvPerPeriod: total, period: M.scale?.period || null, note: total == null ? '当前数据不足以量化增量机会' : '以上为方向性测算：以「其他变量不变」为前提，实际叠加时会有相互影响，不要把这个数字当成承诺收益。' };
}

// ---------------- 结论 ----------------
function buildConclusions(M, T, findings, scorecard) {
  const C = [];
  const avail = scorecard.filter((x) => x.score != null);
  const health = avail.length ? Math.round(mean(avail.map((x) => x.score))) : null;
  if (health != null) C.push(`综合健康度 ${health}/100（${health >= 85 ? '健康' : health >= 70 ? '需关注' : health >= 50 ? '预警' : '风险'}）：八维中最低的是「${avail.sort((a, b) => a.score - b.score)[0].name}」。`);
  const p0 = findings.filter((f) => f.level === 'P0');
  if (p0.length) C.push(`必须先处理的 P0 项 ${p0.length} 个：${p0.map((f) => f.title).join('；')}。`);
  if (M.scale?.gmv != null) C.push(`盘子：${M.scale.days} 天 GMV ${wan(M.scale.gmv)} 万元（日均 ${wan(M.scale.gmvPerDay)} 万元），转化率 ${pct(M.scale.conv, 2)}，客单价 ${money(M.scale.aov)} 元。`);
  if (M.promotion?.roi != null) C.push(`付费：ROI ${M.promotion.roi.toFixed(2)}（保本 ${T.breakeven_roi.toFixed(2)}），消耗 ${money(M.promotion.cost)} 元${M.promotion.costShare != null ? `，占 GMV ${pct(M.promotion.costShare, 1)}` : ''}。`);
  if (M.experience?.score100 != null) C.push(`体验分 ${M.experience.score100.toFixed(0)}（红线 ${T.exp_score_floor} / 达标 ${T.exp_score_target}）${M.experience.shortest ? `，短板「${M.experience.shortest[0]}」` : ''}——它是流量的闸门，优先级高于增长动作。`);
  if (M.product?.inPoolReportedAvg != null || M.product?.inPoolRate != null) C.push(`货架场：入池率 ${pct(M.product.inPoolReportedAvg ?? M.product.inPoolRate, 1)}、动销率 ${pct(M.product.sellThrough, 1)}、点击率 ${pct(M.product.ctr, 2)}。`);
  C.push('动作顺序建议：先修体验分与履约（闸门类）→ 再修商品卡内功（承接类）→ 最后调投放结构（放大类）。顺序反了，钱花得越多越被动。');
  return C.slice(0, 8);
}

export { DOW_CN, pct, num, money, wan };
