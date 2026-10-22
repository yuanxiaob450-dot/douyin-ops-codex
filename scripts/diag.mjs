#!/usr/bin/env node
// 抖音小店经营诊断引擎 CLI
//
// 用法：
//   node scripts/diag.mjs --in <文件或目录> [--in <文件或目录> ...] \
//        [--store "店铺名"] [--assumptions assumptions.json] \
//        [--out-json diag.json] [--out-html 报告.html] [--out-md 摘要.md]
//
// 不带任何 --in 时，默认读取同包内的「示例数据」目录（仅用于自检）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFile, collectInputFiles } from './lib/parse.mjs';
import { analyze, DEFAULT_ASSUMPTIONS, ASSUMPTION_SOURCES } from './lib/analyze.mjs';
import { writeHtml } from './lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

function parseArgs(argv) {
  const a = { in: [], store: null, assumptions: null, outJson: null, outHtml: null, outMd: null, quiet: false, assumptionsRaw: null, from: null, to: null, asOf: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--in' || k === '-i') { a.in.push(v); i++; }
    else if (k === '--store' || k === '-s') { a.store = v; i++; }
    else if (k === '--assumptions' || k === '-a') { a.assumptions = v; i++; }
    else if (k === '--assumptions-json') { a.assumptionsRaw = v; i++; }
    else if (k === '--from') { a.from = v; i++; }
    else if (k === '--to') { a.to = v; i++; }
    else if (k === '--as-of') { a.asOf = v; i++; }
    else if (k === '--out-json') { a.outJson = v; i++; }
    else if (k === '--out-html') { a.outHtml = v; i++; }
    else if (k === '--out-md') { a.outMd = v; i++; }
    else if (k === '--quiet' || k === '-q') a.quiet = true;
    else if (k === '--help' || k === '-h') { printHelp(); process.exit(0); }
  }
  return a;
}
function printHelp() {
  console.log(`抖音小店经营诊断引擎 v1.0.2

用法:
  node scripts/diag.mjs --in <文件或目录> [--in ...] [选项]

选项:
  --in, -i <path>            输入 xlsx/csv 文件或含它们的目录（可重复）
  --store, -s <name>         店铺名称（默认「抖音小店」）
  --assumptions, -a <json>   参数文件（毛利率/扣点/退款率/签收率等）
  --assumptions-json <json>  直接传 JSON 字符串（优先级高于 -a，便于脚本调用）
  --from / --to <YYYY-MM-DD> 强制分析窗口（默认取数据里的自然月）
  --as-of <YYYY-MM-DD>       以某天为终点回看 31 天
  --out-json <path>          诊断结果 JSON
  --out-html <path>          十段式 HTML 报告
  --out-md <path>            摘要 Markdown
  --quiet, -q                只输出结果路径

可校准参数（完整清单见 kb/calibration.md）:
  gross_margin 毛利率｜platform_rate 平台扣点｜ad_ratio_target 推广费占比目标
  aftersale_rate 售后损耗率｜sign_rate 签收率｜logistics_cost 单均物流成本
  refund_rate_assumed 退款率｜ctr_min 点击率红线｜cart_rate_min 加购率基线
  conv_min 转化率基线｜sell_through_min 动销率基线｜in_pool_rate_min 入池率治理线
  finish_rate_min 完播率基线｜reply3min_min 回复率门槛｜ship24h_min 发货率门槛
  exp_score_floor / exp_score_target 体验分红线与达标线（百分制）
  gmv_target_month 月度 GMV 目标（填了才做达成率结论）

示例:
  node scripts/diag.mjs --in ./示例数据/csv --store "岸上优品食品旗舰店" \\
       --assumptions ./示例数据/assumptions.json \\
       --out-html ./out/诊断报告.html --out-json ./out/diag.json --out-md ./out/摘要.md

  node scripts/diag.mjs --in ./我的导出数据 --assumptions-json '{"gross_margin":0.3}' --out-html ./out/r.html
`);
}

function mdSummary(D) {
  const M = D.metrics || {}, T = D.meta.thresholds || {};
  const L = [];
  L.push(`# ${D.meta.store} · 抖音小店经营诊断摘要`);
  L.push('');
  L.push(`- 数据周期：${D.meta.period || '未标注'}`);
  L.push(`- 数据依据：${D.meta.dataBasis.join('；') || '无'}`);
  L.push(`- 生成时间：${new Date(D.meta.generatedAt).toLocaleString('zh-CN')}`);
  if (D.foreign.length) L.push(`- 已拒收非抖音平台文件 ${D.foreign.length} 张：${D.foreign.map((x) => x.file + '（' + x.platforms.join('/') + '）').join('、')}`);
  if (D.rejected.length) L.push(`- 未识别文件 ${D.rejected.length} 张`);
  L.push('');
  L.push('## 一、数据整理');
  if (M.scale) L.push(`- 规模：曝光 ${M.scale.impressions ?? '—'}、商品访客 ${M.scale.visitors ?? '—'}、支付买家 ${M.scale.buyers ?? '—'}、GMV ${M.scale.gmv ?? '—'} 元、转化率 ${M.scale.conv == null ? '—' : (M.scale.conv * 100).toFixed(2) + '%'}、客单价 ${M.scale.aov == null ? '—' : M.scale.aov.toFixed(2)} 元`);
  if (M.product) L.push(`- 商品卡：${M.product.skuCount} 款、动销率 ${M.product.sellThrough == null ? '—' : (M.product.sellThrough * 100).toFixed(1) + '%'}、入池率 ${M.product.inPoolReportedAvg == null ? '—' : (M.product.inPoolReportedAvg * 100).toFixed(1) + '%'}、点击率 ${M.product.ctr == null ? '—' : (M.product.ctr * 100).toFixed(2) + '%'}、零曝光 ${M.product.dead} 款`);
  if (M.promotion) L.push(`- 千川：消耗 ${M.promotion.cost ?? '—'} 元、成交 ${M.promotion.adGmv ?? '—'} 元、ROI ${M.promotion.roi == null ? '—' : M.promotion.roi.toFixed(2)}（保本 ${T.breakeven_roi == null ? '—' : T.breakeven_roi.toFixed(2)}）、推广费占比 ${M.promotion.costShare == null ? '—' : (M.promotion.costShare * 100).toFixed(1) + '%'}`);
  if (M.experience?.score100 != null) L.push(`- 体验分：${M.experience.score100.toFixed(0)}（${M.experience.scale}）${M.experience.shortest ? '，短板 ' + M.experience.shortest[0] : ''}`);
  if (M.orders?.refundRate != null) L.push(`- 退款：金额口径退款率 ${(M.orders.refundRate * 100).toFixed(2)}%，退款 ${M.orders.refundAmount} 元`);
  if (M.fulfillment?.ship24h != null) L.push(`- 履约：24h 发货率 ${(M.fulfillment.ship24h * 100).toFixed(1)}%、揽收及时率 ${M.fulfillment.pickupRate == null ? '—' : (M.fulfillment.pickupRate * 100).toFixed(1) + '%'}`);
  if (M.service?.reply3min != null) L.push(`- 客服：3 分钟人工回复率 ${(M.service.reply3min * 100).toFixed(1)}%`);
  L.push('');
  L.push('## 三、问题诊断（按严重度）');
  for (const f of D.findings) L.push(`- **[${f.level}] ${f.title}**（${f.dim}）\n  - 证据：${f.evidence}\n  - 影响：${f.impact}\n  - 根因：${f.rootCause}\n  - 依据：${(f.kb || []).join('、')}`);
  L.push('');
  L.push('## 五、落地工作表');
  L.push('| 优先级 | 对应问题 | 动作 | 负责人 | 时间窗 | KPI |');
  L.push('|---|---|---|---|---|---|');
  for (const l of D.landing) L.push(`| ${l.priority} | ${l.finding} | ${l.action} | ${l.owner} | ${l.window} | ${l.kpi} |`);
  if (D.benefits?.items?.length) {
    L.push('');
    L.push('## 已量化机会（方向性测算）');
    for (const b of D.benefits.items) L.push(`- ${b.label}：${b.gmvPerPeriod == null ? '—' : '约 ' + (b.gmvPerPeriod / 10000).toFixed(2) + ' 万元/期'}（${b.basis}）`);
    if (D.benefits.totalGmvPerPeriod != null) L.push(`- 合计：约 ${(D.benefits.totalGmvPerPeriod / 10000).toFixed(2)} 万元/期`);
  }
  if (D.dataGaps.length) {
    L.push('');
    L.push('## 九、数据缺口');
    for (const g of D.dataGaps) L.push(`- [${g.priority}] ${g.need} → 解锁：${g.unlock}（${g.backend}）`);
  }
  L.push('');
  L.push('## 十、关键结论');
  for (const c of D.conclusions) L.push(`- ${c}`);
  L.push('');
  L.push(`> ${D.meta.disclaimer}`);
  return L.join('\n');
}

// 默认输入：包内示例数据。示例数据把 CSV 放在 示例数据/csv/、XLSX 放在 示例数据/xlsx/，
// 因此默认要指向 csv 子目录（只给 示例数据/ 会导致顶层没有 xlsx/csv 而报「没有找到文件」）。
function defaultInputs() {
  const base = path.join(PKG, '示例数据');
  const csv = path.join(base, 'csv');
  if (fs.existsSync(csv)) return [csv];
  return [base];
}

async function main() {
  const a = parseArgs(process.argv);
  let inputs = a.in;
  if (!inputs.length) inputs = defaultInputs();

  const found = collectInputFiles(inputs);
  const missing = found.filter((f) => f.missing).map((f) => f.path);
  const real = found.filter((f) => !f.missing);
  if (missing.length) console.error('[warn] 路径不存在，已跳过：' + missing.join(', '));
  if (!real.length) { console.error('没有找到任何 xlsx/csv 文件。用 --in 指定文件或目录。'); process.exit(2); }

  const loaded = [];
  for (const f of real) {
    try {
      loaded.push(await loadFile(f.path));
    } catch (e) {
      loaded.push({ file: f.path, base: path.basename(f.path), ext: path.extname(f.path), sheets: [], error: String((e && e.message) || e) });
    }
  }
  const errs = loaded.filter((l) => l.error);
  for (const e of errs) console.error('[error] 读取失败 ' + e.base + '：' + e.error);

  let assumptions = { ...DEFAULT_ASSUMPTIONS };
  if (a.assumptionsRaw) Object.assign(assumptions, JSON.parse(a.assumptionsRaw));
  if (a.assumptions) {
    if (!fs.existsSync(a.assumptions)) { console.error('参数文件不存在：' + a.assumptions); process.exit(2); }
    Object.assign(assumptions, JSON.parse(fs.readFileSync(a.assumptions, 'utf8')));
  }

  const D = analyze(loaded, { store: a.store || '抖音小店', assumptions, from: a.from, to: a.to, asOf: a.asOf });
  D.meta.assumptionSources = ASSUMPTION_SOURCES;
  D.meta.inputFiles = real.map((f) => f.path);
  D.meta.readErrors = errs.map((e) => ({ file: e.base, error: e.error }));

  const outs = {};
  if (a.outJson) { fs.mkdirSync(path.dirname(path.resolve(a.outJson)), { recursive: true }); fs.writeFileSync(a.outJson, JSON.stringify(D, null, 2), 'utf8'); outs.json = a.outJson; }
  if (a.outHtml) { writeHtml(D, a.outHtml); outs.html = a.outHtml; }
  if (a.outMd) { fs.mkdirSync(path.dirname(path.resolve(a.outMd)), { recursive: true }); fs.writeFileSync(a.outMd, mdSummary(D), 'utf8'); outs.md = a.outMd; }

  if (!a.quiet) {
    const M = D.metrics || {};
    console.log('=== 抖音小店经营诊断 ===');
    console.log('店铺：' + D.meta.store + '   周期：' + (D.meta.period || '未标注'));
    console.log('识别文件：' + D.accepted.length + ' 张表 / 提交 ' + real.length + ' 个文件'
      + (D.rejected.length ? '，未识别 ' + D.rejected.length + ' 张' : '')
      + (D.foreign.length ? '，非抖音平台已拒收 ' + D.foreign.length + ' 张' : ''));
    for (const x of D.accepted) console.log('  · ' + x.file + (x.sheet && x.sheet !== 'CSV' ? ' #' + x.sheet : '') + ' → ' + x.typeName + '（' + x.rows + ' 行，字段 ' + x.fields.length + ' 个）');
    for (const x of D.rejected) console.log('  ! ' + x.file + (x.sheet ? ' #' + x.sheet : '') + ' → 未识别：' + x.reason);
    for (const x of D.foreign) console.log('  ⊘ ' + x.file + (x.sheet ? ' #' + x.sheet : '') + ' → 拒收（' + x.platforms.join('/') + '）：' + x.reason);
    if (M.scale) console.log('规模：GMV ' + (M.scale.gmv == null ? '—' : (M.scale.gmv / 10000).toFixed(2) + ' 万') + '，访客 ' + M.scale.visitors + '，转化率 ' + (M.scale.conv == null ? '—' : (M.scale.conv * 100).toFixed(2) + '%') + '，客单价 ' + (M.scale.aov == null ? '—' : M.scale.aov.toFixed(2)) + ' 元');
    if (M.product) console.log('商品卡：' + M.product.skuCount + ' 款，入池率 ' + (M.product.inPoolReportedAvg == null ? '—' : (M.product.inPoolReportedAvg * 100).toFixed(1) + '%') + '，点击率 ' + (M.product.ctr == null ? '—' : (M.product.ctr * 100).toFixed(2) + '%'));
    if (M.promotion) console.log('千川：消耗 ' + M.promotion.cost + ' 元，ROI ' + (M.promotion.roi == null ? '—' : M.promotion.roi.toFixed(2)) + '，保本 ' + D.meta.thresholds.breakeven_roi.toFixed(2));
    if (M.experience?.score100 != null) console.log('体验分：' + M.experience.score100.toFixed(0) + '（' + M.experience.scale + '）');
    console.log('问题：P0 ' + D.findings.filter((f) => f.level === 'P0').length + ' / P1 ' + D.findings.filter((f) => f.level === 'P1').length + ' / P2 ' + D.findings.filter((f) => f.level === 'P2').length);
    for (const f of D.findings) console.log('  [' + f.level + '] ' + f.title);
    if (D.dataGaps.length) console.log('数据缺口：' + D.dataGaps.map((g) => g.need).join('、'));
    const sc = D.scorecard.filter((x) => x.score != null);
    if (sc.length) console.log('健康度：' + Math.round(sc.reduce((s, x) => s + x.score, 0) / sc.length) + '/100');
    if (Object.keys(outs).length) { console.log('\n输出：'); for (const [k, v] of Object.entries(outs)) console.log('  ' + k + ' → ' + path.resolve(v)); }
  } else if (Object.keys(outs).length) {
    for (const [k, v] of Object.entries(outs)) console.log(k + '=' + path.resolve(v));
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
