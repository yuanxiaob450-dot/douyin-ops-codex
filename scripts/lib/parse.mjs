// 读取 + 文件识别 + 列映射（抖音/抖店口径）。
// 引擎不依赖本仓外的任何库：优先用同目录的 xlsx.mjs，不可用时退回内置 minimal_read.mjs。
import fs from 'node:fs';
import path from 'node:path';
import {
  COL, NUMERIC_FIELDS, RATIO_FIELDS, FILE_TYPES, normalizeHeader,
  PLATFORM_MARKERS, DOUYIN_ONLY_MARKERS, DOUYIN_FLAVORED_MARKERS, DOUYIN_MARKERS_GENERIC,
} from './schema.mjs';

// 读取器解析：**按候选路径逐个试**，不写死相对层级。
// 原因：同一套 lib/ 文件会被放到两种布局里复用 ——
//   ① 主专家包：scripts/lib/parse.mjs 与 scripts/xlsx.mjs（同级目录）
//   ② 扣子插件：lib/engine/parse.mjs 与 lib/engine/xlsx.mjs（同一目录）
// 写死 '../xlsx.mjs' 时插件里会解析失败并静默退回 minimal_read（曾经真实踩过：
// 插件里报「读取器不支持 Buffer 模式」，根因就是这里加载到了兜底读取器）。
let reader = null;
const READER_CANDIDATES = ['./xlsx.mjs', '../xlsx.mjs', '../../scripts/xlsx.mjs'];

async function getReader() {
  if (reader) return reader;
  let lastErr = null;
  for (const spec of READER_CANDIDATES) {
    try {
      const mod = await import(spec);
      if (typeof mod.readXlsx === 'function' && typeof mod.readCsv === 'function') {
        reader = mod;
        return reader;
      }
      lastErr = new Error(spec + ' 缺少 readXlsx/readCsv 导出');
    } catch (e) {
      lastErr = e;
    }
  }
  // 兜底：内置最小读取器（只支持路径模式，不支持 Buffer 与 xlsx 写）
  reader = await import('./minimal_read.mjs');
  if (!reader.__fallbackWarned) {
    console.warn('[engine] 未找到主 XLSX 读取器，已退回内置最小读取器；Buffer 模式不可用。' + (lastErr ? ' 原因：' + lastErr.message : ''));
    reader.__fallbackWarned = true;
  }
  return reader;
}

// ---------- 数字解析 ----------
export function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s || /^(--|-|—|\/|n\/a|null|nan|无)$/i.test(s)) return null;
  let pct = false;
  if (s.endsWith('%')) { pct = true; s = s.slice(0, -1); }
  s = s.replace(/[,\s￥¥$]/g, '');
  const m = s.match(/^(-?[\d.]+)\s*(万|亿|千|w|k)?$/i);
  if (!m) return null;
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === '万' || unit === 'w') n *= 1e4;
  else if (unit === '亿') n *= 1e8;
  else if (unit === '千' || unit === 'k') n *= 1e3;
  if (pct) n /= 100;
  return n;
}

// 比例归一：平台导出可能是 0.032 / 3.2 / "3.2%" 三种形态
export function toRatio(v) {
  const raw = String(v ?? '');
  const n = toNumber(v);
  if (n == null) return null;
  if (raw.includes('%')) return n;
  if (n > 1 && n <= 100) return n / 100;
  if (n > 100) return null;
  if (n < 0) return null;
  return n;
}

// ---------- 表头定位 ----------
function findHeaderRow(rows, maxScan = 25) {
  let best = { idx: -1, score: -1 };
  const allAliases = Object.values(COL).flat().map(normalizeHeader);
  for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
    const r = rows[i] || [];
    let score = 0;
    for (const cell of r) {
      const h = normalizeHeader(cell);
      if (!h) continue;
      if (allAliases.some((a) => a && (h === a || h.includes(a)))) score++;
    }
    if (score > best.score && score >= 2) best = { idx: i, score };
  }
  return best.idx;
}

// 列映射：分三轮贪心，**精确相等优先于模糊包含**。
//
// 这个顺序不是洁癖，是踩出来的：表头「成交订单数」在 orders 里是精确别名，
// 在 liveOrders 里只是「直播间成交订单数」的子串。原来一轮按 score 排序做贪心，
// 长别名 liveOrders 先把列抢走，orders 就拿不到了（店铺订单数凭空消失）。
// 现在改成三轮：① 非衍生精确 ② 非衍生模糊 ③ 衍生（无论精确/模糊）。
const DERIVED_ALIASES = new Set([
  normalizeHeader('点击率'), normalizeHeader('转化率'), normalizeHeader('成交转化率'),
  normalizeHeader('点击次数'), normalizeHeader('展现量'), normalizeHeader('曝光量'),
]);
function mapColumns(header) {
  const norm = header.map(normalizeHeader);
  const candidates = {};
  const entries = [];
  for (const [field, aliases] of Object.entries(COL)) {
    for (const a of aliases) {
      const na = normalizeHeader(a);
      entries.push({ field, alias: na, len: na.length, derived: DERIVED_ALIASES.has(na) });
    }
  }
  entries.sort((x, y) => y.len - x.len);
  for (const { field, alias, derived } of entries) {
    if (!alias) continue;
    for (let i = 0; i < norm.length; i++) {
      const h = norm[i];
      if (!h) continue;
      const exact = h === alias;
      const partial = h.includes(alias) || alias.includes(h);
      if (!exact && !partial) continue;
      // 短别名（uv/pv/ctr/roi）只在精确相等时生效，否则「gmv」会命中一切含 gmv 的表头
      if (!exact && partial && alias.length < 3) continue;
      let score = (exact ? 1000 : 0) + alias.length * 4 - Math.abs(h.length - alias.length);
      if (derived) score -= 500;
      const matched = COL[field].find((x) => normalizeHeader(x) === alias) || alias;
      if (!candidates[field] || candidates[field].score < score) {
        candidates[field] = { col: i, score, header: header[i], alias: matched, derived, exact };
      }
    }
  }
  const mapping = {};
  const used = new Set();
  const passes = [
    Object.entries(candidates).filter(([, c]) => !c.derived && c.exact),
    Object.entries(candidates).filter(([, c]) => !c.derived && !c.exact),
    Object.entries(candidates).filter(([, c]) => c.derived),
  ];
  for (const pass of passes) {
    for (const [field, c] of pass.sort((a, b) => b[1].score - a[1].score)) {
      if (mapping[field] || used.has(c.col)) continue;
      used.add(c.col);
      mapping[field] = { col: c.col, header: c.header, alias: c.alias, exact: !!c.exact, derived: !!c.derived };
    }
  }
  return mapping;
}

// ---------- 平台来源判定（硬红线：只处理抖音导出） ----------
// 判定只看表头。强词 2 分、弱词 1 分、阈值 2 分：
//   ① 命中它平台**专有名词**（千牛/京准通/多多搜索/聚光投放…）→ 直接拒；
//   ② 弱词证据分 ≥2 且含平台名（淘宝/京东/拼多多/小红书）→ 拒；
//   ③ 表头同时命中抖音专有词 → 降级为「接受 + 提示」，不整份拒收。
const BENIGN_WEAK = new Set(['直播间', '场观', '达人带货', '商品曝光人数', '口碑分', '拼团价', '宝贝']);
export function detectPlatform(headers) {
  const headerHay = headers.join(' ').toLowerCase();
  const hits = {};
  for (const [key, def] of Object.entries(PLATFORM_MARKERS)) {
    const strong = (def.strong || []).filter((w) => headerHay.includes(w.toLowerCase()));
    const weak = (def.weak || []).filter((w) => headerHay.includes(w.toLowerCase()));
    const score = strong.length * 2 + weak.length;
    if (strong.length || weak.length) hits[key] = { name: def.name, strong, weak, score, decided: score >= 2 };
  }
  const onlyHits = DOUYIN_ONLY_MARKERS.filter((w) => headerHay.includes(w.toLowerCase()));
  const flavoredHits = DOUYIN_FLAVORED_MARKERS.filter((w) => headerHay.includes(w.toLowerCase()));
  const genericHits = DOUYIN_MARKERS_GENERIC.filter((w) => headerHay.includes(w.toLowerCase()));
  const douyinHits = [...onlyHits, ...flavoredHits, ...genericHits];
  const decided = Object.entries(hits).filter(([k, v]) => k !== 'other' && v.decided);
  const undecided = Object.entries(hits).filter(([k, v]) => k !== 'other' && !v.decided);
  const PLATFORM_NAME_TOKENS = ['淘宝', '天猫', '京东', '拼多多', '小红书', '快手', '唯品会', '得物'];
  const strongForeign = decided.filter(([, v]) => v.strong.length > 0);
  const weakDecided = decided.filter(([, v]) => v.strong.length === 0);

  // 平台名出现在表头里，即使只命中 1 次，也足以判定「这不是抖音导出」。
  // 理由：泛化列名各平台都会用（所以弱词阈值是 2 分），但「淘宝访客数」这种
  // 「平台名 + 列名」的组合只有该平台的工具会生成。真实踩过：
  // 一个表头为「淘宝访客数/淘宝支付金额」的 CSV 被放行，最后产出一份空报告，
  // 用户以为诊断跑成功了 —— 这种「静默接受错数据」比直接拒收危险得多。
  const namedForeign = undecided.filter(([, v]) => v.weak.some((w) => PLATFORM_NAME_TOKENS.includes(w)));
  const weakHasPlatformName = weakDecided.some(([, v]) => v.weak.some((w) => PLATFORM_NAME_TOKENS.includes(w)))
    || namedForeign.length > 0;
  const suspectSerious = undecided.filter(([, v]) => v.weak.some((w) => !BENIGN_WEAK.has(w) && !PLATFORM_NAME_TOKENS.includes(w)));
  const hasOnly = onlyHits.length > 0;
  const isDouyin = strongForeign.length === 0
    && !weakHasPlatformName
    && !(suspectSerious.length > 0 && flavoredHits.length < 2);
  const notes = [];
  if (!isDouyin && decided.length && hasOnly) {
    notes.push(`表头同时命中抖音专有词（${onlyHits.slice(0, 5).join('、')}），但检测到${decided.map(([, v]) => v.name).join('/')}平台**专有名词**（${decided.flatMap(([, v]) => v.strong).slice(0, 4).join('、')}），按非抖音导出处理`);
  } else if (decided.length && hasOnly) {
    notes.push(`表头同时命中抖音专有词（${onlyHits.slice(0, 5).join('、')}），已按抖音报表接受；但检测到${decided.map(([, v]) => v.name).join('/')}平台词（证据分 ${decided.map(([, v]) => v.score).join('/')}），请确认该文件确实来自抖店后台`);
  } else if (undecided.length) {
    notes.push(`检测到疑似它平台词但未达判定阈值（${undecided.map(([, v]) => `${v.name}：${[...v.strong, ...v.weak].join('、')}（${v.score} 分）`).join('；')}），已按抖音口径处理`);
  }
  return {
    isDouyin,
    // decided 未达阈值但表头直接带平台名的，也要报给调用方，否则拒收原因会显示为空数组
    foreign: (isDouyin ? [] : [...decided, ...namedForeign]).map(([k, v]) => ({ key: k, name: v.name, words: [...v.strong, ...v.weak], strong: v.strong, weak: v.weak, score: v.score })),
    suspect: undecided.map(([k, v]) => ({ key: k, name: v.name, words: [...v.strong, ...v.weak], score: v.score })),
    otherHits: hits.other || null,
    douyinHits,
    douyinOnlyHits: onlyHits,
    douyinFlavoredHits: flavoredHits,
    douyinGenericHits: genericHits,
    douyinMarkerCount: douyinHits.length,
    notes,
    evidence: decided.length
      ? decided.map(([, v]) => `${v.name}特征词（证据分 ${v.score}：强 ${v.strong.length} / 弱 ${v.weak.length}）：${[...v.strong, ...v.weak].slice(0, 4).join('、')}`).join('；')
      : (douyinHits.length ? `抖音特征词 ${douyinHits.length} 个（专有 ${onlyHits.length}）：${douyinHits.slice(0, 4).join('、')}` : '无平台特征词（按抖音列名口径处理）'),
  };
}

// ---------- 文件类型识别（导出，供 diag/自检复用） ----------
export function makeHas(headers) {
  const norm = headers.map(normalizeHeader);
  return (field) => (COL[field] || []).some((a) => {
    const na = normalizeHeader(a);
    return na && norm.some((h) => h && (h === na || h.includes(na)));
  });
}

export function detectFileType(headers, fileName = '') {
  const norm = headers.map(normalizeHeader);
  const fnorm = normalizeHeader(path.basename(fileName).replace(/\.[^.]+$/, ''));
  const has = makeHas(headers);
  const scored = [];
  for (const t of FILE_TYPES) {
    const reqOk = (t.required || []).every((group) => group.some((f) => has(f)));
    if (!reqOk) continue;
    if (t.requiredAny && !t.requiredAny.every((group) => group.some((f) => has(f)))) continue;
    if (t.veto && t.veto.some((group) => group.every((f) => has(f)))) continue;
    let score = 100 - t.priority * 0.1;
    let hit = 0;
    for (const kw of t.keywords) {
      const nk = normalizeHeader(kw);
      if (nk && fnorm.includes(nk)) { score += 40; hit++; }
      else if (norm.some((h) => h && h.includes(nk))) { score += 8; hit++; }
    }
    if (hit === 0) score -= 25;
    for (const f of t.prefer || []) if (has(f)) score += 3;
    scored.push({ id: t.id, name: t.name, shape: t.shape, score: +score.toFixed(2), keywordHits: hit });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.length
    ? { ...scored[0], alternatives: scored.slice(1, 4) }
    : { id: 'unknown', name: '未识别文件', shape: 'unknown', score: 0, alternatives: [] };
}

// ---------- 读取数值矩阵 ----------
// 同时做两件清洗：① 跳过重复表头行 ② 跳过合计/总计行（否则结果直接翻倍）
const SUMMARY_RE = /^\s*(合计|总计|小计|汇总|总额|共计|total|sum)\s*$/i;
function buildMatrix(rows, headerIdx, mapping) {
  const header = rows[headerIdx] || [];
  const headerKey = header.map(normalizeHeader).join('|');
  const data = [];
  const skipped = { repeatHeader: [], summary: [] };
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.some((c) => c != null && String(c).trim() !== '')) continue;
    if (header.length && r.map(normalizeHeader).join('|') === headerKey) { skipped.repeatHeader.push(i + 1); continue; }
    const cellsTrim = r.slice(0, 4).map((c) => String(c ?? '').trim());
    if (cellsTrim.some((c) => SUMMARY_RE.test(c))) {
      const numericHit = Object.entries(mapping).some(([f, info]) => NUMERIC_FIELDS.has(f) && r[info.col] != null && String(r[info.col]).trim() !== '');
      if (numericHit) { skipped.summary.push(i + 1); continue; }
    }
    const obj = { __row: i + 1 };
    let any = false;
    for (const [field, info] of Object.entries(mapping)) {
      const raw = r[info.col];
      if (raw == null || String(raw).trim() === '') continue;
      if (NUMERIC_FIELDS.has(field)) {
        const n = RATIO_FIELDS.has(field) ? toRatio(raw) : toNumber(raw);
        obj[field] = n;
        if (n != null) any = true;
      } else {
        obj[field] = String(raw).trim();
        any = true;
      }
    }
    if (any) data.push(obj);
  }
  return { header, data, skipped };
}

// 把读取器返回的工作表数组统一成 { file, base, ext, sheets } 结构。
// filePath 只用于「文件名关键词」参与文件类型识别与错误信息，不要求文件真实存在。
function parseSheets(raw, filePath, isCsv) {
  let sheets;
  if (Array.isArray(raw)) sheets = raw;
  else if (raw && Array.isArray(raw.sheets)) sheets = raw.sheets;
  else if (raw && Array.isArray(raw.rows)) sheets = [{ name: raw.name || (isCsv ? 'CSV' : 'Sheet1'), rows: raw.rows }];
  else sheets = [];
  if (!sheets.length) throw new Error('读取器未返回任何工作表');
  const parsed = [];
  for (const sh of sheets) {
    const rows = (sh.rows || []).map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? '' : String(c))) : []));
    if (!rows.length) continue;
    const headerIdx = findHeaderRow(rows);
    if (headerIdx < 0) {
      parsed.push({ sheetName: sh.name, ok: false, reason: '未找到表头行（前 25 行没有任何可识别字段名）', rowCount: rows.length });
      continue;
    }
    const header = rows[headerIdx];
    const mapping = mapColumns(header);
    const detected = detectFileType(header, filePath + (sh.name ? ' #' + sh.name : ''));
    const platform = detectPlatform(header);
    const { data, skipped } = buildMatrix(rows, headerIdx, mapping);
    parsed.push({
      sheetName: sh.name, ok: true, headerIdx: headerIdx + 1, header,
      mapping, fields: Object.keys(mapping), detected, platform, rowCount: data.length, data, skipped,
      unmappedHeaders: header.filter((_, i) => !Object.values(mapping).some((m) => m.col === i)),
    });
  }
  return { file: filePath, base: path.basename(filePath), ext: path.extname(filePath).toLowerCase(), sheets: parsed };
}

export async function loadFile(filePath, opts = {}) {
  const R = await getReader();
  const isCsv = isCsvExt(filePath);
  const raw = isCsv ? await R.readCsv(filePath, opts) : await R.readXlsx(filePath, opts);
  return parseSheets(raw, filePath, isCsv);
}

function isCsvExt(name) {
  const ext = path.extname(String(name)).toLowerCase();
  return ext === '.csv' || ext === '.txt' || ext === '.tsv' || ext === '';
}

/**
 * 从内存 Buffer 解析一个上传文件（API 服务用）。
 * 好处：服务端不必为了解析把用户上传写到磁盘，也就没有临时文件清理与路径穿越风险。
 * @param {Buffer} buffer 文件字节
 * @param {string} filename 原始文件名（用于扩展名分派与文件类型识别中的文件名关键词）
 */
export async function loadBuffer(buffer, filename, opts = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('空文件');
  const R = await getReader();
  const base = path.basename(String(filename || 'upload.csv'));
  const csv = isCsvExt(base);
  const reader = csv ? R.readCsvBuffer : R.readXlsxBuffer;
  if (typeof reader !== 'function') {
    // 这里必须明确报错：静默退回按文本解析会把 xlsx 二进制当 CSV，产出一堆垃圾列
    throw new Error(
      `当前读取器不支持 Buffer 模式（${csv ? 'readCsvBuffer' : 'readXlsxBuffer'} 缺失）——通常说明加载到了兜底读取器 minimal_read.mjs。`
      + '请确认 xlsx.mjs 与 parse.mjs 处于同一目录或上一级目录。'
    );
  }
  const raw = await reader(buffer, opts);
  return parseSheets(raw, base, csv);
}

export function collectInputFiles(inputs) {
  const out = [];
  for (const p of inputs) {
    if (!fs.existsSync(p)) { out.push({ path: p, missing: true }); continue; }
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p)) {
        if (/\.(xlsx|xls|csv|tsv|txt)$/i.test(f) && !f.startsWith('~$') && !f.startsWith('.') && !/^_/.test(f)) {
          out.push({ path: path.join(p, f) });
        }
      }
    } else out.push({ path: p });
  }
  return out;
}
