// 最小可用的 XLSX / CSV 读取器（纯 Node 内置模块，无任何 npm 依赖）。
// 用途：当同目录上级的 xlsx.mjs 不可用时的兜底实现。接口与 xlsx.mjs 兼容：
//   readXlsx(path, opts) -> { sheets: [{ name, rows: string[][] }] }
//   readCsv(path, opts)  -> { name, rows }
import fs from 'node:fs';
import zlib from 'node:zlib';

// ---------------- ZIP ----------------
function findEocd(b) {
  const min = Math.max(0, b.length - 66000);
  for (let i = b.length - 22; i >= min; i--) if (b.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}
function zipEntries(file) {
  const b = fs.readFileSync(file);
  const eocd = findEocd(b);
  if (eocd < 0) throw new Error('不是有效的 zip/xlsx：未找到 EOCD');
  let n = b.readUInt16LE(eocd + 10);
  let cdOff = b.readUInt32LE(eocd + 16);
  // ZIP64
  if (cdOff === 0xffffffff || n === 0xffff) {
    const loc = eocd - 20;
    if (loc > 0 && b.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(b.readBigUInt64LE(loc + 8));
      if (b.readUInt32LE(z64) === 0x06064b50) {
        n = Number(b.readBigUInt64LE(z64 + 32));
        cdOff = Number(b.readBigUInt64LE(z64 + 48));
      }
    }
  }
  const out = new Map();
  let o = cdOff;
  for (let k = 0; k < n; k++) {
    if (b.readUInt32LE(o) !== 0x02014b50) break;
    const flags = b.readUInt16LE(o + 8);
    const method = b.readUInt16LE(o + 10);
    const csize = b.readUInt32LE(o + 20);
    const nameLen = b.readUInt16LE(o + 28);
    const extraLen = b.readUInt16LE(o + 30);
    const cmtLen = b.readUInt16LE(o + 32);
    const lho = b.readUInt32LE(o + 42);
    const rawName = b.subarray(o + 46, o + 46 + nameLen);
    let name;
    if (flags & 0x800) name = rawName.toString('utf8');
    else {
      try { name = new TextDecoder('gbk').decode(rawName); }
      catch { name = rawName.toString('utf8'); }
    }
    const lnl = b.readUInt16LE(lho + 26);
    const lel = b.readUInt16LE(lho + 28);
    const start = lho + 30 + lnl + lel;
    const comp = method === 8 ? b.subarray(start, start + csize) : b.subarray(start, start + csize);
    out.set(name, { method, comp, usize: b.readUInt32LE(o + 24) });
    o += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}
function entryBuf(e, name) {
  const x = e.get(name);
  if (!x) return null;
  if (x.method === 0) return x.comp;
  try { return zlib.inflateRawSync(x.comp); } catch { return null; }
}
function entryText(e, name) {
  const b = entryBuf(e, name);
  return b ? b.toString('utf8') : null;
}

const dec = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&');

// ---------------- 共享字符串 ----------------
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const si of xml.match(/<si>[\s\S]*?<\/si>|<si\/>/g) || []) {
    let s = '';
    for (const t of si.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) || []) s += dec(t.replace(/<[^>]+>/g, ''));
    out.push(s);
  }
  return out;
}

// ---------------- 样式日期格式 ----------------
function parseDateStyles(stylesXml) {
  const dateStyleIds = new Set();
  if (!stylesXml) return dateStyleIds;
  const customDateFmt = new Set();
  for (const m of stylesXml.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    const code = dec(m[2]);
    if (/[ymdhs]/i.test(code) && !/^[\["].*[\]"]$/.test(code)) {
      if (/^(yyyy|yy|m{1,5}|d{1,2}|h{1,2}|s{1,2}|[\/\-.: ]|am\/pm|\[[^\]]*\])+$/i.test(code.replace(/"[^"]*"/g, ''))) {
        customDateFmt.add(+m[1]);
      }
    }
  }
  const cellXfs = stylesXml.match(/<cellXfs[\s\S]*?<\/cellXfs>/);
  if (cellXfs) {
    let idx = 0;
    for (const xf of cellXfs[0].match(/<xf\b[\s\S]*?<\/xf>|<xf\b[^>]*\/>/g) || []) {
      const id = (xf.match(/numFmtId="(\d+)"/) || [, '0'])[1];
      const n = +id;
      const isDate = (n >= 14 && n <= 22) || (n >= 45 && n <= 47) || customDateFmt.has(n);
      if (isDate) dateStyleIds.add(idx);
      idx++;
    }
  }
  return dateStyleIds;
}
const EPOCH = Date.UTC(1899, 11, 30);
function excelDate(n) {
  const ms = EPOCH + Math.round(n * 86400000);
  return new Date(ms);
}
function fmtDate(d, withTime) {
  const p = (x) => String(x).padStart(2, '0');
  const s = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return withTime ? `${s} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : s;
}

// ---------------- sheet 解析 ----------------
function colIndex(ref) {
  const m = String(ref).match(/^([A-Z]+)/);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function parseSheet(xml, sst, dateStyles, opts) {
  const rows = [];
  const rowRe = /<row\b[^>]*\/>|<row\b[\s\S]*?<\/row>/g;
  let m;
  while ((m = rowRe.exec(xml))) {
    const rXml = m[0];
    const cells = [];
    const cellRe = /<c\b[^>]*\/>|<c\b[\s\S]*?<\/c>/g;
    let c;
    while ((c = cellRe.exec(rXml))) {
      const cx = c[0];
      const ref = (cx.match(/r="([A-Z]+\d+)"/) || [, ''])[1];
      const ty = (cx.match(/\st="([^"]+)"/) || [, ''])[1];
      const st = (cx.match(/\ss="(\d+)"/) || [, ''])[1];
      const idx = ref ? colIndex(ref) : cells.length;
      let val = '';
      if (ty === 'inlineStr') {
        for (const t of cx.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) || []) val += dec(t.replace(/<[^>]+>/g, ''));
      } else {
        const v = cx.match(/<v>([\s\S]*?)<\/v>/);
        if (v) {
          const raw = dec(v[1]);
          if (ty === 's') val = sst[+raw] ?? '';
          else if (ty === 'str' || ty === 'b' || ty === 'e') val = raw;
          else {
            const n = Number(raw);
            if (Number.isFinite(n) && st !== '' && dateStyles.has(+st) && n > 1 && n < 60000) {
              val = fmtDate(excelDate(n), n % 1 > 0);
            } else val = raw;
          }
        }
      }
      cells[idx] = (val == null ? '' : String(val)).replace(/\u0000/g, '');
    }
    // 补齐空洞
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = '';
    rows.push(cells);
    if (opts.limit && rows.length >= opts.limit) break;
  }
  return rows;
}

export async function readXlsx(filePath, opts = {}) {
  const e = zipEntries(filePath);
  const wb = entryText(e, 'xl/workbook.xml');
  if (!wb) throw new Error('不是有效的 xlsx：缺少 xl/workbook.xml');
  const rels = entryText(e, 'xl/_rels/workbook.xml.rels') || '';
  const relMap = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = (m[0].match(/Id="([^"]+)"/) || [, ''])[1];
    const tg = (m[0].match(/Target="([^"]+)"/) || [, ''])[1];
    if (id && tg) relMap.set(id, tg);
  }
  const sst = parseSharedStrings(entryText(e, 'xl/sharedStrings.xml'));
  const dateStyles = parseDateStyles(entryText(e, 'xl/styles.xml'));
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\/>|<sheet\b[^>]*>[\s\S]*?<\/sheet>/g)) {
    const tag = m[0];
    const name = dec((tag.match(/name="([^"]*)"/) || [, 'Sheet'])[1]);
    const rid = (tag.match(/r:id="([^"]*)"/) || [, ''])[1];
    let target = relMap.get(rid) || '';
    target = target.replace(/^\/?xl\//, '').replace(/^\//, '');
    if (!target) target = `worksheets/sheet${sheets.length + 1}.xml`;
    const xml = entryText(e, 'xl/' + target);
    if (!xml) { sheets.push({ name, rows: [], missing: true }); continue; }
    sheets.push({ name, rows: parseSheet(xml, sst, dateStyles, opts) });
  }
  return { sheets };
}

// ---------------- CSV ----------------
function sniffDelim(line) {
  const cands = [',', '\t', ';', '|'];
  let best = ',', bestN = -1;
  for (const d of cands) {
    const n = line.split(d).length;
    if (n > bestN) { bestN = n; best = d; }
  }
  return best;
}
function parseCsvText(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') || '';
  const delim = sniffDelim(firstLine);
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch === '\r') { /* skip */ }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
export async function readCsv(filePath, opts = {}) {
  const buf = fs.readFileSync(filePath);
  let text;
  // UTF-8 BOM 或有效 UTF-8 用 utf8；否则尝试 GBK
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) text = buf.subarray(3).toString('utf8');
  else {
    const s = buf.toString('utf8');
    text = s.includes('\uFFFD') ? new TextDecoder('gbk').decode(buf) : s;
  }
  let rows = parseCsvText(text);
  if (opts.limit) rows = rows.slice(0, opts.limit);
  return { name: 'CSV', rows };
}

export async function detectAndRead(filePath, opts = {}) {
  return /\.(csv|tsv|txt)$/i.test(filePath) ? readCsv(filePath, opts) : readXlsx(filePath, opts);
}
