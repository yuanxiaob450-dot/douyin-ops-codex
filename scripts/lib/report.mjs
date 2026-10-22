// 十段式诊断报告生成器（抖音小店版）—— 输出自包含 HTML（无外链、无 CDN、可离线打开）。
// 十段：数据整理 → 口径与数据质量声明 → P0/P1/P2 问题诊断 → 可照做方案 → 落地工作表 →
//       商品四象限 → 渠道与结构 → 八维评分卡 → 数据缺口清单 → 关键结论。
import fs from 'node:fs';
import path from 'node:path';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sum = (a, f) => a.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const pct = (n, d = 1) => (n == null || !Number.isFinite(n) ? '—' : (n * 100).toFixed(d) + '%');
const num = (n, d = 0) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const money = (n) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const wan = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : (n / 10000).toFixed(d));
const s = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : Number(n).toFixed(d));

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --acc:#161823; --acc2:#FE2C55; --acc3:#25F4EE;
  --bg:#f5f7fa; --surface:#fff; --ink:#141b2d; --ink2:#3d4759; --muted:#7b869c;
  --line:#e6eaf2; --line2:#eef1f7;
  --p0:#d92d20; --p0bg:#fef3f2; --p1:#e07b00; --p1bg:#fffaeb; --p2:#039855; --p2bg:#f0fdf4;
  --blue:#3b5bdb; --bluebg:#eef2ff;
  --r:16px; --sh:0 1px 2px rgba(16,24,40,.05),0 8px 24px -8px rgba(16,24,40,.10);
}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;
  background:var(--bg);color:var(--ink);line-height:1.7;-webkit-font-smoothing:antialiased;font-size:14.5px;padding-bottom:70px}
.wrap{max-width:1140px;margin:0 auto;padding:0 20px}
.hero{background:linear-gradient(128deg,#0b0c12 0%,#161823 46%,#2a1220 100%);color:#fff;padding:38px 0 92px;position:relative;overflow:hidden}
.hero:before{content:"";position:absolute;width:520px;height:520px;right:-140px;top:-220px;border-radius:50%;background:radial-gradient(circle,var(--acc2) 0%,transparent 68%);opacity:.32}
.hero:after{content:"";position:absolute;width:380px;height:380px;left:-120px;bottom:-220px;border-radius:50%;background:radial-gradient(circle,var(--acc3) 0%,transparent 70%);opacity:.18}
.hero .wrap{position:relative;z-index:2}
.badge{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.20);padding:5px 13px 5px 6px;border-radius:99px;font-size:12.5px}
.badge i{width:20px;height:20px;border-radius:50%;background:linear-gradient(135deg,var(--acc2),var(--acc3));display:grid;place-items:center;font-size:11px;font-style:normal;font-weight:700;color:#0b0c12}
h1{font-size:30px;font-weight:750;letter-spacing:-.6px;margin:16px 0 8px;line-height:1.3}
.hero .meta{font-size:13px;color:#c3cddd;max-width:900px}
.hero .meta b{color:#eef2f8;font-weight:600}
.verdict{margin-top:22px;display:flex;gap:18px;flex-wrap:wrap;align-items:stretch}
.score{background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.16);border-radius:14px;padding:14px 22px;text-align:center;min-width:142px}
.score .n{font-size:38px;font-weight:750;line-height:1.05;letter-spacing:-1px}
.score .l{font-size:11.5px;color:#c3cddd;margin-top:3px;letter-spacing:1px}
.score .lv{font-size:12px;margin-top:6px;padding:2px 10px;border-radius:99px;display:inline-block;background:rgba(255,255,255,.16);font-weight:600}
.vtext{flex:1;min-width:300px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:14px 18px}
.vtext .hl{font-size:15px;font-weight:650;color:#fff;margin-bottom:7px}
.vtext ul{margin:0;padding-left:17px;font-size:13px;color:#d3dcea}
.vtext li{margin:3px 0}
.vtext b{color:#fff}
.container{max-width:1140px;margin:-64px auto 0;padding:0 20px;position:relative;z-index:3}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:12px}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 16px;box-shadow:var(--sh)}
.kpi .k{font-size:12px;color:var(--muted);letter-spacing:.3px}
.kpi .v{font-size:25px;font-weight:730;letter-spacing:-.5px;margin-top:5px;line-height:1.16}
.kpi .v small{font-size:13px;font-weight:600;color:var(--muted);margin-left:3px}
.kpi .sub{font-size:11.5px;color:var(--muted);margin-top:5px}
.kpi.warn{background:linear-gradient(180deg,#fffaf5,#fff)}
.kpi.bad{background:linear-gradient(180deg,#fff5f5,#fff)}
.kpi.good{background:linear-gradient(180deg,#f6fdf9,#fff)}
.nav{position:sticky;top:0;z-index:30;background:rgba(255,255,255,.94);backdrop-filter:blur(10px);border-bottom:1px solid var(--line);margin-top:26px}
.nav .wrap{display:flex;gap:6px;overflow-x:auto;padding:9px 20px;max-width:1140px;margin:0 auto}
.nav a{white-space:nowrap;font-size:12.5px;color:var(--ink2);text-decoration:none;padding:6px 11px;border-radius:99px;border:1px solid transparent}
.nav a:hover{background:var(--bluebg);color:var(--blue);border-color:#dfe5ff}
section{margin-top:34px;scroll-margin-top:64px}
.sec-h{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:6px}
.sec-n{font-size:12px;font-weight:700;color:var(--acc2);letter-spacing:2px}
h2{font-size:22px;font-weight:730;letter-spacing:-.3px}
.sec-d{font-size:13.5px;color:var(--ink2);margin-bottom:16px;max-width:900px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:18px 20px}
.card + .card{margin-top:14px}
h3{font-size:15.5px;font-weight:700;margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
h4{font-size:14px;font-weight:680;margin:14px 0 6px;color:var(--ink)}
p{color:var(--ink2);font-size:13.8px}
p+p{margin-top:7px}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}
.tablewrap{overflow-x:auto}
th{background:#f8fafc;color:var(--ink2);font-weight:650;text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap;font-size:12.5px}
td{padding:8px 10px;border-bottom:1px solid var(--line2);color:var(--ink2);vertical-align:top}
tr:last-child td{border-bottom:0}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;letter-spacing:.4px;white-space:nowrap}
.p0{background:var(--p0bg);color:var(--p0);border:1px solid #fdd}
.p1{background:var(--p1bg);color:var(--p1);border:1px solid #fde9c4}
.p2{background:var(--p2bg);color:var(--p2);border:1px solid #cdf0dc}
.tag{display:inline-block;font-size:11.5px;padding:2px 9px;border-radius:99px;background:var(--bluebg);color:var(--blue);font-weight:600}
.finding{border-left:3px solid var(--line);padding-left:16px;margin-top:16px}
.finding.p0b{border-color:var(--p0)}
.finding.p1b{border-color:var(--p1)}
.finding.p2b{border-color:var(--p2)}
.finding h3{margin-bottom:4px}
.ev{background:#f8fafc;border:1px solid var(--line2);border-radius:10px;padding:11px 13px;margin-top:9px;font-size:13px;color:var(--ink2)}
.ev b{color:var(--ink)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.kv{font-size:12.8px;color:var(--muted);margin-top:9px}
.kv b{color:var(--ink2)}
ul.tight{margin:8px 0 0;padding-left:18px;font-size:13.5px;color:var(--ink2)}
ul.tight li{margin:4px 0}
ol.tight{margin:8px 0 0;padding-left:20px;font-size:13.5px;color:var(--ink2)}
ol.tight li{margin:5px 0}
.red{background:var(--p0bg);border:1px solid #fdd;border-radius:10px;padding:10px 13px;margin-top:9px;font-size:13px;color:#8f1d14}
.red b{color:var(--p0)}
.warnbox{background:var(--p1bg);border:1px solid #fde9c4;border-radius:10px;padding:10px 13px;margin-top:9px;font-size:13px;color:#7a4a00}
.gap{background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px;padding:11px 13px;margin-top:9px;font-size:13px}
.notice{background:var(--bluebg);border:1px solid #dfe5ff;border-radius:10px;padding:11px 14px;font-size:13px;color:#26327a}
.bar{height:8px;background:var(--line2);border-radius:99px;overflow:hidden;margin-top:6px}
.bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--acc2),#ff7a9c)}
.bar.ok i{background:linear-gradient(90deg,#12b76a,#32d583)}
.bar.mid i{background:linear-gradient(90deg,#f79009,#fdb022)}
.bar.low i{background:linear-gradient(90deg,#d92d20,#f97066)}
footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}
.small{font-size:12px;color:var(--muted)}
@media print{.nav{position:static}.hero{padding-bottom:40px}.container{margin-top:20px}}
`;

function kpiCard(k, v, unit, sub, cls) {
  return `<div class="kpi ${cls || ''}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}${unit ? `<small>${esc(unit)}</small>` : ''}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`;
}
function bar(score) {
  const cls = score == null ? '' : score >= 85 ? 'ok' : score >= 70 ? 'mid' : 'low';
  return `<div class="bar ${cls}"><i style="width:${score == null ? 0 : score}%"></i></div>`;
}
const lvPill = (lv) => `<span class="pill ${lv === 'P0' ? 'p0' : lv === 'P1' ? 'p1' : 'p2'}">${lv}</span>`;

export function buildHtml(D) {
  const M = D.metrics || {};
  const T = D.meta.thresholds || {};
  const A = D.meta.assumptions || {};
  const sc = D.scorecard || [];
  const avail = sc.filter((x) => x.available !== false && x.score != null);
  const health = avail.length ? Math.round(sum(avail, (x) => x.score) / avail.length) : null;
  const level = health == null ? '数据不足' : health >= 85 ? '健康' : health >= 70 ? '需关注' : health >= 50 ? '预警' : '风险';
  const p0 = D.findings.filter((f) => f.level === 'P0');
  const p1 = D.findings.filter((f) => f.level === 'P1');
  const p2 = D.findings.filter((f) => f.level === 'P2');

  // ---------------- KPI 卡片 ----------------
  const K = [];
  if (M.scale) {
    K.push(kpiCard('支付 GMV', wan(M.scale.gmv), '万元', `${M.scale.days} 天 · 日均 ${wan(M.scale.gmvPerDay)} 万`, ''));
    K.push(kpiCard('商品访客', num(M.scale.visitors), '人', M.scale.impressions ? `曝光 ${num(M.scale.impressions)} · UV 价值 ${money(M.scale.uvValue)} 元` : '', ''));
    K.push(kpiCard('支付转化率', pct(M.scale.conv, 2), '', `支付买家 ${num(M.scale.buyers)} ÷ 访客 ${num(M.scale.visitors)}`, M.scale.conv != null && M.scale.conv < T.conv_min ? 'bad' : 'good'));
    K.push(kpiCard('客单价', money(M.scale.aov), '元', `件单价 ${money(M.scale.unitPrice)} 元 · 连带 ${s(M.scale.itemsPerOrder)} 件/单`, ''));
  }
  if (M.promotion) {
    K.push(kpiCard('千川 ROI', s(M.promotion.roi), '', `保本 ${s(T.breakeven_roi)}${M.promotion.roiMargin != null ? ` · 距保本 ${pct(Math.abs(M.promotion.roiMargin), 1)}` : ''}`, M.promotion.roi == null ? '' : M.promotion.roi < T.breakeven_roi ? 'bad' : 'good'));
    K.push(kpiCard('推广费占比', pct(M.promotion.costShare, 2), '', `${money(M.promotion.cost)} 元 / GMV ${wan(M.scale?.gmv)} 万`, M.promotion.costShare != null && M.promotion.costShare > 0.35 ? 'bad' : ''));
  }
  if (M.experience?.score100 != null) {
    K.push(kpiCard('商家体验分', M.experience.score100.toFixed(0), '', `${M.experience.scale} · 红线 ${T.exp_score_floor} / 达标 ${T.exp_score_target}`, M.experience.score100 < T.exp_score_floor ? 'bad' : M.experience.score100 < T.exp_score_target ? 'warn' : 'good'));
  }
  if (M.product) {
    const ip = M.product.inPoolReportedAvg ?? M.product.inPoolRate;
    if (ip != null) K.push(kpiCard('商品卡入池率', pct(ip, 1), '', `治理线 ${pct(T.in_pool_rate_min, 0)} · 零曝光 ${num(M.product.dead)} 款`, ip < T.in_pool_rate_min ? 'bad' : 'good'));
    K.push(kpiCard('商品卡点击率', pct(M.product.ctr, 2), '', `红线 ${pct(T.ctr_min, 1)} · 动销率 ${pct(M.product.sellThrough, 1)}`, M.product.ctr != null && M.product.ctr < T.ctr_min ? 'bad' : 'good'));
  }
  if (M.orders?.refundRate != null) {
    K.push(kpiCard('退款率（金额口径）', pct(M.orders.refundRate, 2), '', `退款 ${money(M.orders.refundAmount)} 元`, M.orders.refundRate > (A.refund_rate_assumed || 0.08) ? 'bad' : 'good'));
  }
  if (M.fulfillment?.ship24h != null) {
    K.push(kpiCard('24h 发货率', pct(M.fulfillment.ship24h, 1), '', `门槛 ${pct(T.ship24h_min, 0)}${M.fulfillment.lateOrders ? ` · 延迟 ${num(M.fulfillment.lateOrders)} 单` : ''}`, M.fulfillment.ship24h < T.ship24h_min ? 'bad' : 'good'));
  }
  if (M.service?.reply3min != null) {
    K.push(kpiCard('3 分钟回复率', pct(M.service.reply3min, 1), '', `门槛 ${pct(T.reply3min_min, 0)}`, M.service.reply3min < T.reply3min_min ? 'bad' : 'good'));
  }
  if (M.live) K.push(kpiCard('直播 GPM', money(M.live.gpm), '元', `${M.live.sessions} 场 · 进入率 ${pct(M.live.enterRate, 1)}`, ''));
  if (M.talent) K.push(kpiCard('达人带货', wan(M.talent.gmv), '万元', `${M.talent.count} 位达人 · 佣金 ${pct(M.talent.commissionRateAvg, 1)}`, ''));

  const nav = [
    ['s1', '一 数据整理'], ['s2', '二 口径与质量'], ['s3', '三 问题诊断'],
    ['s4', '四 解决方案'], ['s5', '五 落地工作表'], ['s6', '六 商品四象限'],
    ['s7', '七 渠道与结构'], ['s8', '八 评分卡'], ['s9', '九 数据缺口'], ['s10', '十 关键结论'],
  ];

  const h = [];
  h.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">');
  h.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
  h.push(`<title>${esc(D.meta.store)} · 抖音小店经营诊断与改善方案</title>`);
  h.push(`<style>${CSS}</style></head><body>`);

  // HERO
  h.push('<div class="hero"><div class="wrap">');
  h.push(`<span class="badge"><i>抖</i>抖音小店 · ${esc(D.meta.period || '数据周期未标注')} 经营诊断</span>`);
  h.push(`<h1>${esc(D.meta.store)} · 经营诊断与改善方案</h1>`);
  h.push(`<div class="meta">数据周期 <b>${esc(D.meta.period || '未标注')}</b> ｜ 已识别 <b>${D.accepted.length}</b> 张表${D.foreign.length ? ` ｜ 非抖音平台已拒收 <b>${D.foreign.length}</b> 张` : ''}${D.rejected.length ? ` ｜ 未识别 <b>${D.rejected.length}</b> 张` : ''}</div>`);
  h.push('<div class="verdict">');
  h.push(`<div class="score"><div class="n">${health == null ? '—' : health}</div><div class="l">综合健康度</div><div class="lv">${esc(level)}</div></div>`);
  h.push('<div class="vtext"><div class="hl">一句话结论</div><ul>');
  for (const c of D.conclusions.slice(0, 4)) h.push(`<li>${esc(c)}</li>`);
  h.push('</ul></div></div></div></div>');   // 关 vtext / verdict / hero-wrap / hero

  // KPI（container 用负 margin 上浮压住 hero，因此必须放在 hero 之外）
  h.push('<div class="container"><div class="kpis">');
  h.push(K.length ? K.join('') : kpiCard('可用指标', '0', '项', '未识别到可用报表，请先按《数据导出清单》补导', 'bad'));
  h.push('</div></div>');

  // NAV
  h.push('<div class="nav"><div class="wrap">');
  for (const [id, t] of nav) h.push(`<a href="#${id}">${esc(t)}</a>`);
  h.push('</div></div>');

  h.push('<div class="wrap">');

  // ---- 一 数据整理 ----
  h.push('<section id="s1"><div class="sec-h"><span class="sec-n">一</span><h2>数据整理 · 现状全景</h2></div>');
  h.push('<div class="sec-d">按抖音的三场结构看：货架场（商品卡/搜索/商城）承接转化、内容场（短视频/直播）负责获客、联盟场（达人）做放大，付费只用来加速已被验证的部分。</div>');

  h.push('<div class="card"><h3>① 已识别的数据文件</h3>');
  if (D.accepted.length) {
    h.push('<div class="tablewrap"><table><thead><tr><th>文件</th><th>识别为</th><th class="n">行数</th><th class="n">字段</th><th>备注</th></tr></thead><tbody>');
    for (const x of D.accepted) {
      const note = [x.platform?.notes?.[0], (x.unmapped || []).length ? `未映射列 ${x.unmapped.length} 个` : null, x.skipped?.summary?.length ? `跳过合计行 ${x.skipped.summary.length} 行` : null, x.skipped?.repeatHeader?.length ? `跳过重复表头 ${x.skipped.repeatHeader.length} 行` : null].filter(Boolean).join('；') || '—';
      h.push(`<tr><td>${esc(x.file)}${x.sheet && x.sheet !== 'CSV' ? ' <span class="small">#' + esc(x.sheet) + '</span>' : ''}</td><td>${esc(x.typeName)}</td><td class="n">${num(x.rows)}</td><td class="n">${x.fields.length}</td><td class="small">${esc(note)}</td></tr>`);
    }
    h.push('</tbody></table></div>');
  } else h.push('<p>没有识别到任何抖音经营报表。</p>');
  if (D.foreign.length) {
    h.push('<div class="red"><b>非抖音平台数据已拒收（不参与计算）：</b>');
    for (const x of D.foreign) h.push(`<div>${esc(x.file)}${x.sheet ? ' #' + esc(x.sheet) : ''} → 判定为 ${esc(x.platforms.join('/'))}：${esc(x.reason)}</div>`);
    h.push('<div class="small" style="margin-top:6px">本引擎只做抖音单平台诊断；多平台复盘请分平台各自出报告，不要合并成一个整体数字。</div></div>');
  }
  if (D.rejected.length) {
    h.push('<div class="warnbox"><b>未识别（未参与计算）：</b>');
    for (const x of D.rejected) h.push(`<div>${esc(x.file)}${x.sheet ? ' #' + esc(x.sheet) : ''} → ${esc(x.reason)}</div>`);
    h.push('</div>');
  }
  h.push('</div>');

  if (M.scale) {
    h.push('<div class="card"><h3>② 规模与节奏</h3>');
    h.push(`<p>${esc(M.scale.period)} 共 ${M.scale.days} 天：曝光 <b>${num(M.scale.impressions)}</b>、商品访客 <b>${num(M.scale.visitors)}</b>、支付买家 <b>${num(M.scale.buyers)}</b>、支付订单 <b>${num(M.scale.orders)}</b>、支付件数 <b>${num(M.scale.items)}</b>，支付 GMV <b>${wan(M.scale.gmv)} 万元</b>（日均 ${wan(M.scale.gmvPerDay)} 万元），全店转化率 <b>${pct(M.scale.conv, 2)}</b>，客单价 <b>${money(M.scale.aov)}</b> 元，UV 价值 ${money(M.scale.uvValue)} 元。</p>`);
    if (M.scale.target) h.push(`<p>月度目标 ${wan(M.scale.target)} 万元，达成率 <b>${pct(M.scale.achieveRate, 1)}</b>。</p>`);
    h.push(`<div class="kv">口径：${esc(M.scale.method)}${M.scale.window ? `｜已按 ${esc(M.scale.window.from)} 至 ${esc(M.scale.window.to)} 截取窗口，剔除窗口外 ${num(M.scale.window.dropped)} 行` : ''}</div>`);
    if (M.rhythm?.byDow?.length) {
      h.push('<h4>星期节奏（按星期几取均值）</h4><div class="tablewrap"><table><thead><tr><th>星期</th><th class="n">天数</th><th class="n">日均 GMV(元)</th><th class="n">日均访客</th><th class="n">日均曝光</th></tr></thead><tbody>');
      for (const d of M.rhythm.byDow) h.push(`<tr><td>${esc(d.label)}</td><td class="n">${d.n}</td><td class="n">${money(d.gmvAvg)}</td><td class="n">${num(d.visitorsAvg)}</td><td class="n">${num(d.impressionsAvg)}</td></tr>`);
      h.push('</tbody></table></div>');
      const peak = [...M.rhythm.byDow].filter((x) => x.gmvAvg != null).sort((a, b) => b.gmvAvg - a.gmvAvg);
      if (peak.length >= 2) h.push(`<p class="small" style="margin-top:8px">峰值 <b>${esc(peak[0].label)}</b>（日均 ${money(peak[0].gmvAvg)} 元），谷值 <b>${esc(peak[peak.length - 1].label)}</b>（日均 ${money(peak[peak.length - 1].gmvAvg)} 元）。排班、开播时段与投放节奏按这个曲线走，不要按工作日惯性排。</p>`);
    }
    h.push('</div>');
  }

  if (M.product) {
    h.push('<div class="card"><h3>③ 货架场 · 商品卡</h3>');
    h.push(`<p>在架 <b>${M.product.skuCount}</b> 款，有访客 <b>${M.product.skuWithVisitors}</b> 款，有成交 <b>${M.product.skuActive}</b> 款，动销率 <b>${pct(M.product.sellThrough, 1)}</b>，零曝光 <b>${M.product.dead}</b> 款。`);
    if (M.product.inPoolReportedAvg != null) h.push(`入池率（报表口径均值）<b>${pct(M.product.inPoolReportedAvg, 1)}</b>；`);
    else if (M.product.inPoolRate != null) h.push(`有曝光的链接占比 <b>${pct(M.product.inPoolRate, 1)}</b>；`);
    h.push(`整体点击率 <b>${pct(M.product.ctr, 2)}</b>、转化率 <b>${pct(M.product.conv, 2)}</b>、加购率 ${pct(M.product.cartRate, 2)}${M.product.qualityScoreAvg != null ? `、商品信息质量分均值 ${s(M.product.qualityScoreAvg, 1)}` : ''}。`);
    if (M.product.concentration) h.push(`集中度：TOP5 占 GMV ${pct(M.product.concentration.top5, 1)}、TOP20 占 ${pct(M.product.concentration.top20, 1)}。`);
    h.push('</p>');
    h.push('<div class="tablewrap"><table><thead><tr><th>TOP12 商品</th><th class="n">GMV(元)</th><th class="n">访客</th><th class="n">点击率</th><th class="n">转化率</th><th class="n">加购率</th><th>象限</th></tr></thead><tbody>');
    for (const t of M.product.top) h.push(`<tr><td>${esc(t.title)}</td><td class="n">${money(t.gmv)}</td><td class="n">${num(t.visitors)}</td><td class="n">${pct(t.ctr, 2)}</td><td class="n">${pct(t.conv, 2)}</td><td class="n">${pct(t.cartRate, 2)}</td><td>${t.quadrant ? `<span class="tag">${esc(t.quadrant)}</span>` : '<span class="small">数据不足</span>'}</td></tr>`);
    h.push('</tbody></table></div>');
    h.push(`<div class="kv">口径：${esc(M.product.method)}｜点击率口径：${esc(M.product.ctrBasis)}</div>`);
    h.push('</div>');
  }

  if (M.promotion) {
    h.push('<div class="card"><h3>④ 付费 · 千川投放</h3>');
    h.push(`<p>消耗 <b>${money(M.promotion.cost)}</b> 元${M.promotion.costShare != null ? `（占全店 GMV <b>${pct(M.promotion.costShare, 2)}</b>）` : ''}，展现 ${num(M.promotion.impressions)}、点击 ${num(M.promotion.clicks)}，CTR <b>${pct(M.promotion.ctr, 2)}</b>、CVR <b>${pct(M.promotion.cvr, 2)}</b>、CPC <b>${money(M.promotion.cpc)}</b> 元；广告成交 <b>${money(M.promotion.adGmv)}</b> 元，ROI <b>${s(M.promotion.roi)}</b>（保本 ${s(M.promotion.breakeven)}、含退货 ${s(M.promotion.breakevenWithReturns)}），转化成本 ${money(M.promotion.convCost)} 元。</p>`);
    if (M.promotion.plans?.length) {
      h.push('<h4>按计划（消耗降序，前 20）</h4><div class="tablewrap"><table><thead><tr><th>计划 / 素材</th><th class="n">消耗(元)</th><th class="n">成交(元)</th><th class="n">ROI</th><th class="n">CTR</th><th class="n">CVR</th><th class="n">CPC</th><th>判定</th></tr></thead><tbody>');
      for (const p of M.promotion.plans) {
        const bad = p.roi != null && p.roi < T.breakeven_roi;
        h.push(`<tr><td>${esc(p.name)}</td><td class="n">${money(p.cost)}</td><td class="n">${money(p.gmv)}</td><td class="n">${s(p.roi)}</td><td class="n">${pct(p.ctr, 2)}</td><td class="n">${pct(p.cvr, 2)}</td><td class="n">${money(p.cpc)}</td><td>${bad ? '<span class="pill p0">低于保本</span>' : p.roi != null && p.roi >= T.breakeven_roi * 1.2 ? '<span class="pill p2">可放量</span>' : '<span class="small">持平</span>'}</td></tr>`);
      }
      h.push('</tbody></table></div>');
    }
    if (M.promotion.losers?.length) h.push(`<div class="red"><b>止损清单（消耗 ≥100 元且 ROI 低于保本线）共 ${M.promotion.losers.length} 个计划，合计消耗 ${money(M.promotion.loserCost)} 元：</b>${M.promotion.losers.map((p) => esc(p.name) + '（' + s(p.roi) + '）').join('、')}</div>`);
    h.push(`<div class="kv">口径：${esc(M.promotion.method)}。${esc(M.promotion.roiCaliberNote)}</div></div>`);
  }

  if (M.content || M.live || M.talent) {
    h.push('<div class="card"><h3>⑤ 内容场与联盟场</h3>');
    if (M.live) {
      h.push(`<p><b>直播</b>：${M.live.sessions} 场，观看 ${num(M.live.watchCount)} 人次，成交 <b>${money(M.live.gmv)}</b> 元，GPM <b>${money(M.live.gpm)}</b> 元，曝光进入率 ${pct(M.live.enterRate, 1)}，人均观看 ${s(M.live.avgWatchMin)} 分钟${M.live.concentration != null ? `，前 25% 场次贡献 ${pct(M.live.concentration, 0)} 的成交` : ''}。</p>`);
      if (M.live.top?.length) {
        h.push('<div class="tablewrap"><table><thead><tr><th>场次</th><th class="n">观看人次</th><th class="n">进入率</th><th class="n">GPM(元)</th><th class="n">成交(元)</th></tr></thead><tbody>');
        for (const t of M.live.top) h.push(`<tr><td>${esc(t.name)}</td><td class="n">${num(t.watch)}</td><td class="n">${pct(t.enterRate, 1)}</td><td class="n">${money(t.gpm)}</td><td class="n">${money(t.gmv)}</td></tr>`);
        h.push('</tbody></table></div>');
      }
    }
    if (M.content) {
      h.push(`<p><b>短视频</b>：${M.content.count} 条作品，播放 ${num(M.content.playCount)}，完播率均值 <b>${pct(M.content.finishRate, 1)}</b>，5s 完播 ${pct(M.content.play5sRate, 1)}，互动率 ${pct(M.content.interactRate, 2)}；高完播（≥35%）${M.content.highFinish} 条、低于基线 ${M.content.lowFinish} 条。</p>`);
    }
    if (M.talent) {
      h.push(`<p><b>精选联盟</b>：${M.talent.count} 位达人，带货 <b>${money(M.talent.gmv)}</b> 元，佣金 ${money(M.talent.commission)} 元（均率 ${pct(M.talent.commissionRateAvg, 1)}），达人退款率均值 ${pct(M.talent.refundRateAvg, 1)}${M.talent.concentration != null ? `，TOP3 达人占 ${pct(M.talent.concentration, 0)}` : ''}。</p>`);
      if (M.talent.top?.length) {
        h.push('<div class="tablewrap"><table><thead><tr><th>达人</th><th class="n">成交(元)</th><th class="n">订单</th><th class="n">佣金(元)</th><th class="n">退款率</th><th>判定</th></tr></thead><tbody>');
        for (const t of M.talent.top) h.push(`<tr><td>${esc(t.name)}</td><td class="n">${money(t.gmv)}</td><td class="n">${num(t.orders)}</td><td class="n">${money(t.commission)}</td><td class="n">${pct(t.refundRate, 1)}</td><td>${t.refundRate != null && t.refundRate > 0.15 ? '<span class="pill p0">高退款，暂停复投</span>' : t.gmv > 0 ? '<span class="pill p2">可复投</span>' : '<span class="small">观察</span>'}</td></tr>`);
        h.push('</tbody></table></div>');
      }
    }
    h.push(`<div class="kv">口径：${esc(M.live?.method || M.content?.method || M.talent?.method || '—')}</div></div>`);
  }
  h.push('</section>');

  // ---- 二 口径与数据质量 ----
  h.push('<section id="s2"><div class="sec-h"><span class="sec-n">二</span><h2>口径与数据质量声明</h2></div>');
  h.push('<div class="sec-d">结论能不能用，取决于口径说没说清。下面这些差异会让你算出来的数和后台看到的数不一样，属于正常现象。</div>');
  h.push('<div class="card"><h3>① 平台口径 vs 本地口径</h3><ul class="tight">');
  h.push('<li><b>GMV</b>：平台「支付 GMV」按支付时点计入，含之后退款的订单；本地订单明细口径可扣掉退款，得到净成交。两个数不一样不代表算错。</li>');
  h.push('<li><b>退款率</b>：平台常按「退款订单数 ÷ 成交订单数」，本地按「退款金额 ÷ 有效订单实付金额」。本报告若出现两个退款率，均已标注是哪一种。</li>');
  h.push('<li><b>ROI</b>：报告中的 ROI 是支付 ROI（含未退款口径）；净成交 ROI 必须用退款明细扣减，否则会被退款吞掉真实产出。</li>');
  h.push('<li><b>体验分</b>：抖店商家体验分已改为百分制；若源数据仍是 5 分制，本报告已 ×20 换算，并在 KPI 卡片标注量纲。判断准入资格一律以后台展示为准。</li>');
  h.push('<li><b>点击率</b>：汇总点击率会被渠道结构掩盖，判断主图好坏要看「猜你喜欢」等自然渠道的分渠道点击率。</li>');
  h.push('</ul></div>');
  h.push(`<div class="card"><h3>② 本次计算用到的校准参数</h3><div class="tablewrap"><table><thead><tr><th>参数</th><th class="n">取值</th><th>说明</th></tr></thead><tbody>`);
  const paramRows = [
    ['毛利率 gross_margin', pct(A.gross_margin, 0), '决定保本 ROI = 1 ÷ 毛利率'],
    ['平台扣点 platform_rate', pct(A.platform_rate, 1), '抖音小店技术服务费按类目'],
    ['推广费占比目标 ad_ratio_target', pct(A.ad_ratio_target, 0), '衡量付费依赖度'],
    ['售后损耗率 aftersale_rate', pct(A.aftersale_rate, 1), '计入成本卡'],
    ['签收率 sign_rate', pct(A.sign_rate, 1), '保本 ROI 含退货口径用'],
    ['退款率假设 refund_rate_assumed', pct(A.refund_rate_assumed, 1), '未知退款率时的保守口径'],
    ['单均物流成本 logistics_cost', money(A.logistics_cost) + ' 元', '成本卡固定项'],
  ];
  for (const [k, v, d] of paramRows) h.push(`<tr><td>${esc(k)}</td><td class="n">${esc(v)}</td><td class="small">${esc(d)}</td></tr>`);
  h.push('</tbody></table></div><div class="warnbox"><b>这七项如果没换成你自己店铺的真实值，涉及钱的结论（保本 ROI、增量测算、退款损失）只能当方向参考。</b>校准方法见包内 <code>kb/calibration.md</code>。</div></div>');

  h.push('<div class="card"><h3>③ 数据质量检查</h3><ul class="tight">');
  h.push(`<li>识别并采用 <b>${D.accepted.length}</b> 张表；未识别 <b>${D.rejected.length}</b> 张；非抖音平台拒收 <b>${D.foreign.length}</b> 张。</li>`);
  const sumSkipped = sum(D.accepted, (x) => (x.skipped?.summary?.length || 0));
  if (sumSkipped) h.push(`<li>已自动跳过「合计/总计」行 <b>${sumSkipped}</b> 行——这些行若被当数据求和，结果会直接翻倍。</li>`);
  const sumDup = sum(D.accepted, (x) => (x.skipped?.repeatHeader?.length || 0));
  if (sumDup) h.push(`<li>已自动跳过重复表头行 <b>${sumDup}</b> 行（分页导出或多 sheet 拼接常见）。</li>`);
  if (M.orders?.duplicateKeys) h.push(`<li>订单明细检测到重复主订单号 <b>${M.orders.duplicateKeys}</b> 条，已按主订单号去重后计算。</li>`);
  const unmappedTotal = sum(D.accepted, (x) => (x.unmapped?.length || 0));
  if (unmappedTotal) h.push(`<li>共有 <b>${unmappedTotal}</b> 个列未被识别映射，这些列的数据没有参与计算；若其中有你关心的指标，请对照《数据文件字典》确认列名。</li>`);
  for (const n of D.notes || []) h.push(`<li>${esc(n)}</li>`);
  h.push('</ul></div>');
  h.push('</section>');

  // ---- 三 问题诊断 ----
  h.push('<section id="s3"><div class="sec-h"><span class="sec-n">三</span><h2>问题诊断（按严重度排序）</h2></div>');
  h.push(`<div class="sec-d">P0 必须立刻处理（闸门类：限流、赔付、停投风险）；P1 本周期内整改；P2 结构性优化。每条都按「数据证据 → 量化影响 → 根因链 → 依据 → 动作」五段写，可以逐条对着改。</div>`);
  h.push(`<div class="notice">P0 <b>${p0.length}</b> 项 ｜ P1 <b>${p1.length}</b> 项 ｜ P2 <b>${p2.length}</b> 项</div>`);
  for (const f of D.findings) {
    h.push(`<div class="finding ${f.level.toLowerCase()}b"><h3>${lvPill(f.level)} ${esc(f.title)} <span class="tag">${esc(f.dim || '')}</span></h3>`);
    h.push(`<div class="ev"><b>数据证据：</b>${esc(f.evidence)}</div>`);
    h.push(`<div class="ev"><b>量化影响：</b>${esc(f.impact)}</div>`);
    h.push(`<div class="ev"><b>根因链：</b>${esc(f.rootCause)}</div>`);
    if (f.kb?.length) h.push(`<div class="kv">依据：${f.kb.map((k) => esc(k)).join('；')}</div>`);
    if (f.solution?.length) {
      h.push('<h4>可照做的动作</h4><ol class="tight">');
      for (const st of f.solution) h.push(`<li>${esc(st)}</li>`);
      h.push('</ol>');
    }
    h.push('</div>');
  }
  h.push('</section>');

  // ---- 四 解决方案汇总 ----
  h.push('<section id="s4"><div class="sec-h"><span class="sec-n">四</span><h2>解决方案汇总</h2></div>');
  h.push('<div class="sec-d">同一件事在多个问题里出现时，只做一次，但要把交付物定清楚。顺序上先做闸门类（体验分/履约），再做承接类（商品卡内功），最后才放大（投放）。</div>');
  for (const so of D.solutions) {
    h.push(`<div class="card"><h3>${lvPill(so.level)} ${esc(so.title)}</h3><ol class="tight">`);
    for (const st of so.steps) h.push(`<li>${esc(st)}</li>`);
    h.push('</ol></div>');
  }
  h.push('</section>');

  // ---- 五 落地工作表 ----
  h.push('<section id="s5"><div class="sec-h"><span class="sec-n">五</span><h2>落地工作表</h2></div>');
  h.push('<div class="sec-d">把动作变成可派工的任务：谁做、什么时间做完、拿什么验收。前两周建议只盯 P0 与 P1。</div>');
  h.push('<div class="card"><div class="tablewrap"><table><thead><tr><th>优先级</th><th>对应问题</th><th>动作</th><th>负责人</th><th>时间窗</th><th>验收 KPI</th></tr></thead><tbody>');
  for (const l of D.landing) h.push(`<tr><td>${lvPill(l.priority)}</td><td>${esc(l.finding)}</td><td>${esc(l.action)}</td><td>${esc(l.owner)}</td><td>${esc(l.window)}</td><td>${esc(l.kpi)}</td></tr>`);
  h.push('</tbody></table></div></div>');
  if (D.benefits?.items?.length) {
    h.push('<div class="card"><h3>已量化机会（方向性测算）</h3><div class="tablewrap"><table><thead><tr><th>机会</th><th class="n">金额/期</th><th>测算口径</th></tr></thead><tbody>');
    for (const b of D.benefits.items) h.push(`<tr><td>${esc(b.label)}</td><td class="n">${b.gmvPerPeriod == null ? '—' : wan(b.gmvPerPeriod) + ' 万元'}</td><td class="small">${esc(b.basis)}</td></tr>`);
    h.push('</tbody></table></div>');
    if (D.benefits.totalGmvPerPeriod != null) h.push(`<p>合计约 <b>${wan(D.benefits.totalGmvPerPeriod)} 万元/期</b>。</p>`);
    h.push(`<div class="kv">${esc(D.benefits.note)}</div></div>`);
  }
  h.push('</section>');

  // ---- 六 商品四象限 ----
  h.push('<section id="s6"><div class="sec-h"><span class="sec-n">六</span><h2>商品四象限（点击率 × 转化率）</h2></div>');
  h.push('<div class="sec-d">判定前提：有点击数据支撑的商品才有分析意义。四个象限对应四种完全不同的动作，照错了方向比不改更糟。</div>');
  const quadDef = [
    ['高点击高转化', '主推品：立刻做列变（同品裂变多条链接）放大免费流量，这是成本最低的放量方式。', 'p2'],
    ['高点击低转化', '解决转化：查详情、评价、价格锚点、SKU 设置；点击没问题就不要动主图。', 'p1'],
    ['低点击高转化', '利润品：精准小众人群，切勿盲目投流扩量（人群一泛转化就崩）；保利润、做品质与复购。', 'p1'],
    ['低点击低转化', '直接淘汰：大概率不符合店铺定位或无受众，不必花时间优化。', 'p0'],
  ];
  h.push('<div class="grid2">');
  for (const [k, act, cls] of quadDef) {
    const g = M.product?.quadrant?.[k] || { count: 0, gmv: null, items: [] };
    h.push(`<div class="card"><h3><span class="pill ${cls}">${esc(k)}</span> ${g.count} 款</h3>`);
    h.push(`<p>${esc(act)}</p>`);
    if (g.gmv != null) h.push(`<div class="kv">该象限合计 GMV ${money(g.gmv)} 元</div>`);
    if (g.items?.length) {
      h.push('<div class="tablewrap"><table><thead><tr><th>商品</th><th class="n">点击率</th><th class="n">转化率</th><th class="n">GMV(元)</th></tr></thead><tbody>');
      for (const t of g.items.slice(0, 6)) h.push(`<tr><td>${esc(t.title)}</td><td class="n">${pct(t.ctr, 2)}</td><td class="n">${pct(t.conv, 2)}</td><td class="n">${money(t.gmv)}</td></tr>`);
      h.push('</tbody></table></div>');
    }
    h.push('</div>');
  }
  if (!M.product) h.push('<div class="gap">未识别到商品卡/商品效果明细，无法出四象限。请按《数据导出清单》补导后重跑。</div>');
  h.push('</div>');
  if (M.product?.quadrant) h.push(`<div class="kv">四象限分界线取本店可比商品的中位点击率与中位转化率（可比 = 点击 ≥30 次或曝光 ≥300 次）；也可用红线 ${pct(T.ctr_min, 1)} / 基线 ${pct(T.conv_min, 1)} 强制分档。</div>`);
  h.push('</section>');

  // ---- 七 渠道与结构 ----
  h.push('<section id="s7"><div class="sec-h"><span class="sec-n">七</span><h2>渠道与流量结构</h2></div>');
  h.push('<div class="sec-d">抖音是三场结构：内容场获客、货架场承接、联盟场放大。结构失衡（比如付费超过一半）比单指标不达标更危险，因为停投就归零。</div>');
  if (M.channel) {
    h.push('<div class="card"><h3>① 分渠道表现</h3><div class="tablewrap"><table><thead><tr><th>渠道</th><th class="n">访客</th><th class="n">GMV(元)</th><th class="n">GMV 占比</th><th class="n">转化率</th></tr></thead><tbody>');
    for (const c of M.channel.channels) h.push(`<tr><td>${esc(c.name)}</td><td class="n">${num(c.visitors)}</td><td class="n">${money(c.gmv)}</td><td class="n">${pct(c.gmvShare, 1)}</td><td class="n">${pct(c.conv, 2)}</td></tr>`);
    h.push('</tbody></table></div>');
    h.push(`<p style="margin-top:10px">三条主线占比（GMV 口径）：付费 <b>${pct(M.channel.paidShare, 1)}</b>、内容场 <b>${pct(M.channel.contentShare, 1)}</b>、货架场 <b>${pct(M.channel.shelfShare, 1)}</b>。</p>`);
    h.push(`<div class="kv">口径：${esc(M.channel.method)}</div></div>`);
  } else {
    h.push('<div class="gap">未识别到分渠道流量报表。没有这张表就无法判断「付费依赖度」与「自然流量占比」这两个最重要的结构指标。请导出：抖店后台 → 电商罗盘 → 流量 → 流量来源 → 导出。</div>');
  }
  if (M.promotion) {
    const share = M.promotion.costShare;
    h.push(`<div class="card"><h3>② 付费依赖度</h3><p>推广费占全店 GMV <b>${pct(share, 2)}</b>${share != null ? `（目标 ${pct(A.ad_ratio_target, 0)}）` : ''}。`);
    if (share != null) h.push(share > 0.35 ? '占比偏高：停投风险大，优先把已验证爆款做成商品卡与内容场的免费承接。' : share > 0.2 ? '占比处于微付费区间：继续保持，同时盯自然流量占比是否上升。' : '占比健康：付费只在放大已被验证的模型，结构良好。');
    h.push('</p>');
    if (M.promotion.roiMargin != null) h.push(`<div class="kv">ROI 相对保本线：${M.promotion.roiMargin >= 0 ? '高于保本 ' : '低于保本 '}${pct(Math.abs(M.promotion.roiMargin), 1)}</div>`);
    h.push('</div>');
  }
  h.push('</section>');

  // ---- 八 评分卡 ----
  h.push('<section id="s8"><div class="sec-h"><span class="sec-n">八</span><h2>八维健康度评分卡</h2></div>');
  h.push('<div class="sec-d">每一维都用「本店实际值 ÷ 应达线」折算成 0–100 分，只为了看清短板在哪，不是平台评分。缺数据的维度不给分。</div>');
  h.push('<div class="card"><div class="tablewrap"><table><thead><tr><th>维度</th><th class="n">得分</th><th>进度</th><th>依据</th></tr></thead><tbody>');
  for (const x of sc) {
    h.push(`<tr><td><b>${esc(x.name)}</b></td><td class="n">${x.score == null ? '—' : x.score}</td><td style="min-width:120px">${bar(x.score)}</td><td class="small">${esc(x.detail)}${x.evidence ? '｜' + esc(x.evidence) : ''}</td></tr>`);
  }
  h.push('</tbody></table></div>');
  h.push(`<p style="margin-top:10px">综合健康度 <b>${health == null ? '—' : health}/100</b>（${esc(level)}），为有数据维度得分的算术平均。</p></div>`);
  h.push('</section>');

  // ---- 九 数据缺口 ----
  h.push('<section id="s9"><div class="sec-h"><span class="sec-n">九</span><h2>数据缺口清单</h2></div>');
  h.push('<div class="sec-d">下面这些数据缺失会直接限制结论的可信度。按优先级补导后重跑，结论会明显变准——不要用假设值硬编结论。</div>');
  if (D.dataGaps.length) {
    h.push('<div class="card"><div class="tablewrap"><table><thead><tr><th>优先级</th><th>需要的数据</th><th>补上后能解锁什么</th><th>取数路径</th></tr></thead><tbody>');
    for (const g of D.dataGaps) h.push(`<tr><td>${lvPill(g.priority)}</td><td>${esc(g.need)}</td><td>${esc(g.unlock)}</td><td class="small">${esc(g.backend)}</td></tr>`);
    h.push('</tbody></table></div></div>');
  } else {
    h.push('<div class="notice">本次提交的数据已覆盖全部核心判断维度，没有阻断性缺口。</div>');
  }
  h.push('</section>');

  // ---- 十 关键结论 ----
  h.push('<section id="s10"><div class="sec-h"><span class="sec-n">十</span><h2>关键结论与动作顺序</h2></div>');
  h.push('<div class="card"><ol class="tight">');
  for (const c of D.conclusions) h.push(`<li>${esc(c)}</li>`);
  h.push('</ol>');
  h.push('<div class="notice" style="margin-top:12px"><b>动作顺序：</b>闸门类（体验分、发货履约）→ 承接类（商品卡入池、点击率、评价）→ 放大类（千川结构、达人复投）。顺序反了，投得越多越被动。</div>');
  h.push('</div>');
  h.push('</section>');
  h.push(`<footer><div>数据依据：${D.meta.dataBasis.length ? esc(D.meta.dataBasis.join(' ｜ ')) : '未提供可识别文件'}｜生成时间 ${esc(new Date(D.meta.generatedAt).toLocaleString('zh-CN'))}</div><div style="margin-top:6px">${esc(D.meta.disclaimer)}</div></footer>`);
  // 收尾：本段只关自己的 <div class="notice">，再复用第 199 行 <div class="wrap"> 的那一层收口
  h.push('</div>');
  h.push('</body></html>');
  return h.join('\n');
}

export function writeHtml(D, outPath) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, buildHtml(D), 'utf8');
  return outPath;
}
