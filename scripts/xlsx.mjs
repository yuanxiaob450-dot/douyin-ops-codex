/**
 * xlsx.mjs —— 零依赖 XLSX / CSV 读取库（纯 Node 内置模块）
 * ---------------------------------------------------------------------------
 * 只使用 node:fs / node:zlib / node:url / node:path / node:buffer，禁止任何 npm 依赖。
 * 面向淘宝/天猫商家后台导出的真实 xlsx（xl/workbook.xml + sharedStrings + 工作表流式解析）。
 *
 * 能力清单
 *  1. ZIP 读取：EOCD 向前搜索（最多回退 66KB）、ZIP64 EOCD、ZIP64 扩展信息、data descriptor。
 *  2. 文件名编码：优先 UTF-8 flag(bit 11)，否则用 TextDecoder('gbk') 兜底。
 *  3. sharedStrings：<si> 内多个 <r><t> 拼接、<t xml:space="preserve">。
 *  4. 单元格类型：t="s"（共享字符串）、t="inlineStr"（<is>）、t="str"（公式字符串结果）、
 *     无 t（数字）、t="b"（布尔）、t="e"（错误）。
 *  5. 日期：内置 numFmtId 与自定义 numFmt 嗅探，把明显是日期的数字列转成
 *     YYYY-MM-DD / YYYY-MM-DD HH:mm:ss，其它数字原样保留（不会把普通数字当日期）。
 *  6. 大文件：工作表 XML 整体 inflateRaw 后按行正则分块解析，不把整张表做成对象数组；
 *     每 CHUNK_ROWS 行让出一次事件循环，支持 onProgress 进度回调。
 *  7. CSV：自动分隔符（, / \t / ;）、BOM、双引号转义（""）、字段内换行、CRLF。
 *  8. detectAndRead：按扩展名分派，统一返回结构。
 *  9. CLI：node xlsx.mjs <文件> [--sheet 名称] [--limit N] [--json]
 *
 * 统一返回结构：{ sheets: [{ name, rows: string[][] }] }  —— rows 保留空字符串占位，不丢列。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** CRC32 查表（用于校验 deflate 流完整性；也供写 xlsx 复用） */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** 计算 Buffer 的 CRC32 值（返回无符号整数） */
export function crc32(buf) {
  const h = makeCrc32();
  h.update(buf);
  return h.digest();
}

/** CRC32 增量器：用于流式校验大文件时不重复扫描 */
export function makeCrc32() {
  let c = 0xffffffff;
  return {
    update(chunk) {
      for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
      return this;
    },
    digest() { return (c ^ 0xffffffff) >>> 0; },
  };
}

/* ===========================================================================
 * 0. 通用工具
 * ======================================================================== */

const te = (label, fallback = 'utf-8') => {
  try { return new TextDecoder(label); } catch { return new TextDecoder(fallback); }
};

const UTF8_DECODER = new TextDecoder('utf-8');
// Node 内置 ICU 支持 gbk（full-icu 编译时）；不支持则退化为 latin1 而不抛异常。
const GBK_DECODER = te('gbk', 'latin1');

/** XML 实体与数字字符引用解码 */
export function decodeXmlEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    switch (body) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return m;
    }
  });
}

/** Excel 列号（A、B、...AA）→ 0 基列索引 */
export function colToIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}

/** 0 基列索引 → Excel 列号 */
export function indexToCol(idx) {
  let s = '';
  let n = idx + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 把行列数组补齐到 maxLen（保留空字符串占位） */
function padRows(rows, maxLen) {
  for (const r of rows) {
    if (r.length < maxLen) while (r.length < maxLen) r.push('');
    else if (r.length > maxLen) r.length = maxLen;
  }
  return rows;
}

/** 让出事件循环，避免超大文件解析期间饿死 IO */
function yieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/* ===========================================================================
 * 1. ZIP 读取（含 ZIP64 / data descriptor / EOCD 向前搜索）
 * ======================================================================== */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const MAX_EOCD_BACKSCAN = 66 * 1024; // 最多回退 66KB（ZIP 注释最大 65535 字节）

/**
 * 读取并解析中央目录（只读中央目录所在的那一段，不整文件加载）。
 * @param {string} filePath
 * @returns {Promise<{entries:Array, zip64:boolean, fileSize:number, commentLength:number}>}
 */
export async function readCentralDirectory(filePath) {
  const fd = await fsp.open(filePath, 'r');
  try {
    const st = await fd.stat();
    const fileSize = st.size;
    const scanLen = Math.min(fileSize, MAX_EOCD_BACKSCAN + 22);
    const scanStart = fileSize - scanLen;
    const head = Buffer.alloc(scanLen);
    await fd.read(head, 0, scanLen, scanStart);

    // 从尾部向前搜索 EOCD（最多回退 66KB；找不到时全文件再搜一次作兜底）
    let eocdRel = -1;
    for (let i = head.length - 22; i >= 0; i--) {
      if (head.readUInt32LE(i) === SIG_EOCD) { eocdRel = i; break; }
    }
    if (eocdRel === -1) {
      throw new Error('不是有效的 ZIP/XLSX：未找到 EOCD(0x06054b50)');
    }
    const eocdAbs = scanStart + eocdRel;

    let entryCount = head.readUInt16LE(eocdRel + 10);
    let cenSize = head.readUInt32LE(eocdRel + 12);
    let cenOffset = head.readUInt32LE(eocdRel + 16);
    let zip64 = false;

    const needsZip64 = entryCount === 0xffff || cenOffset === 0xffffffff || cenSize === 0xffffffff;

    // ZIP64 EOCD locator 紧邻 EOCD 之前 20 字节
    let locator = null;
    if (eocdRel >= 20 && head.readUInt32LE(eocdRel - 20) === SIG_EOCD64_LOC) {
      const b = Buffer.alloc(56);
      const locAbs = scanStart + eocdRel - 20;
      const z64Off = Number(head.readBigUInt64LE(eocdRel - 20 + 8));
      await fd.read(b, 0, 56, z64Off);
      if (b.readUInt32LE(0) === SIG_EOCD64) {
        zip64 = true;
        locator = z64Off;
        entryCount = Number(b.readBigUInt64LE(32));
        cenSize = Number(b.readBigUInt64LE(40));
        cenOffset = Number(b.readBigUInt64LE(48));
      }
      void locAbs;
    }
    if (!locator && needsZip64) {
      throw new Error('ZIP64 标记存在但缺少 ZIP64 EOCD 定位器，文件可能损坏');
    }

    if (cenOffset + 16 > fileSize) throw new Error('中央目录偏移越界，文件可能被截断');

    const cen = Buffer.alloc(cenSize);
    await fd.read(cen, 0, cenSize, cenOffset);

    const entries = [];
    let p = 0;
    for (let i = 0; i < entryCount && p + 46 <= cen.length; i++) {
      if (cen.readUInt32LE(p) !== SIG_CEN) break;
      const flags = cen.readUInt16LE(p + 8);
      const method = cen.readUInt16LE(p + 10);
      const crc = cen.readUInt32LE(p + 16);
      let compSize = cen.readUInt32LE(p + 20);
      let uncompSize = cen.readUInt32LE(p + 24);
      const nameLen = cen.readUInt16LE(p + 28);
      const extraLen = cen.readUInt16LE(p + 30);
      const commentLen = cen.readUInt16LE(p + 32);
      let localOffset = cen.readUInt32LE(p + 42);
      const rawName = cen.subarray(p + 46, p + 46 + nameLen);

      // ZIP64 扩展字段（header id 0x0001）：仅当对应字段为 0xFFFFFFFF 时才存在
      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
        const extra = cen.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
        let q = 0;
        while (q + 4 <= extra.length) {
          const hid = extra.readUInt16LE(q);
          const hsz = extra.readUInt16LE(q + 2);
          if (hid === 0x0001) {
            let r = q + 4;
            if (uncompSize === 0xffffffff) { uncompSize = Number(extra.readBigUInt64LE(r)); r += 8; }
            if (compSize === 0xffffffff) { compSize = Number(extra.readBigUInt64LE(r)); r += 8; }
            if (localOffset === 0xffffffff) { localOffset = Number(extra.readBigUInt64LE(r)); r += 8; }
            break;
          }
          q += 4 + hsz;
        }
      }

      // 文件名编码：优先 UTF-8 flag（bit 11），否则按 GBK 解释（中文 Windows 常见）
      const utf8Flag = (flags & 0x800) !== 0;
      let name;
      if (utf8Flag) {
        name = UTF8_DECODER.decode(rawName);
      } else {
        const guess = GBK_DECODER.decode(rawName);
        name = guess.includes('\uFFFD') ? UTF8_DECODER.decode(rawName) : guess;
      }

      entries.push({
        name: name.replace(/\\/g, '/'),
        utf8Flag,
        flags,
        method,
        crc32: crc,
        compSize,
        uncompSize,
        localOffset,
        // data descriptor 标志（bit 3）：真正的尺寸只在 descriptor/中央目录里
        usesDataDescriptor: (flags & 0x8) !== 0,
        isDirectory: name.endsWith('/'),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }

    return { entries, zip64, fileSize, commentLength: head.readUInt16LE(eocdRel + 20) };
  } finally {
    await fd.close();
  }
}

/** 从本地文件头拿到数据真正起点（本地头的 name/extra 长度可与中央目录不同） */
async function localDataOffset(fd, entry) {
  const b = Buffer.alloc(30);
  const { bytesRead } = await fd.read(b, 0, 30, entry.localOffset);
  if (bytesRead < 30 || b.readUInt32LE(0) !== SIG_LOCAL) return -1;
  const nameLen = b.readUInt16LE(26);
  const extraLen = b.readUInt16LE(28);
  return entry.localOffset + 30 + nameLen + extraLen;
}

/** 流式 inflate 一个条目为 Buffer（分块 inflate，避免一次性大块输出） */
export async function inflateEntryStream(fd, entry) {
  if (entry.uncompSize === 0) return Buffer.alloc(0);
  const start = await localDataOffset(fd, entry);
  if (start < 0) throw new Error(`本地文件头损坏：${entry.name}`);
  if (entry.method === 0) {
    const out = Buffer.alloc(entry.compSize);
    await fd.read(out, 0, entry.compSize, start);
    return out;
  }
  if (entry.method !== 8) {
    throw new Error(`不支持的压缩方式 ${entry.method}（仅支持 0=stored / 8=deflate）：${entry.name}`);
  }

  const inflater = zlib.createInflateRaw({ chunkSize: 1 << 20 });
  const parts = [];
  let produced = 0;
  const readChunk = Buffer.alloc(1 << 20); // 每次最多读 1MB 压缩数据
  let pos = start;
  let remaining = entry.compSize;
  let readErr = null;
  let ended = false;

  const onData = (chunk) => { parts.push(chunk); produced += chunk.length; };
  inflater.on('data', onData);

  const done = new Promise((resolve) => {
    inflater.on('end', () => { ended = true; resolve(); });
    inflater.on('error', (e) => { readErr = e; resolve(); });
    inflater.on('close', () => { if (!ended) resolve(); });
  });

  while (remaining > 0) {
    const n = Math.min(remaining, readChunk.length);
    const { bytesRead } = await fd.read(readChunk, 0, n, pos);
    if (bytesRead === 0) break;
    pos += bytesRead;
    remaining -= bytesRead;
    // 背压：写满就让出让循环把已 inflate 的数据排空
    if (!inflater.write(Buffer.from(readChunk.subarray(0, bytesRead)))) {
      await new Promise((r) => inflater.once('drain', r));
    }
  }
  inflater.end();
  await done;
  if (readErr) throw new Error(`解压失败（${entry.name}）：${readErr.message}`);

  const out = Buffer.concat(parts, produced);
  if (entry.uncompSize && out.length !== entry.uncompSize) {
    // 不致命：部分写入器记录的 uncompSize 不可信，继续用真实长度
    if (out.length === 0) throw new Error(`解压结果为空：${entry.name}`);
  }
  if (entry.crc32) {
    const actual = crc32(out);
    if (actual !== entry.crc32) {
      throw new Error(
        `CRC32 校验失败：${entry.name}（期望 ${entry.crc32.toString(16)}，实际 ${actual.toString(16)}）`,
      );
    }
  }
  return out;
}

/**
 * 从内存 Buffer 打开 zip（xlsx 本质就是 zip）。
 * 用途：API 服务收到 base64 上传的文件时直接解析，**不必落盘**——
 * 服务端如果为了解析而写临时文件，就得自己承担清理与路径穿越风险，不划算。
 * 返回形状与 openZip(filePath) 完全一致（buffer/text 改成了同步方法）。
 */
export function openZipBuffer(buf) {
  const fileSize = buf.length;
  const scanLen = Math.min(fileSize, MAX_EOCD_BACKSCAN + 22);
  const scanStart = fileSize - scanLen;
  const head = buf.subarray(scanStart);

  let eocdRel = -1;
  for (let i = head.length - 22; i >= 0; i--) {
    if (head.readUInt32LE(i) === SIG_EOCD) { eocdRel = i; break; }
  }
  if (eocdRel === -1) throw new Error('不是有效的 ZIP/XLSX：未找到 EOCD(0x06054b50)');

  let entryCount = head.readUInt16LE(eocdRel + 10);
  let cenSize = head.readUInt32LE(eocdRel + 12);
  let cenOffset = head.readUInt32LE(eocdRel + 16);
  let zip64 = false;
  const needsZip64 = entryCount === 0xffff || cenOffset === 0xffffffff || cenSize === 0xffffffff;

  if (eocdRel >= 20 && head.readUInt32LE(eocdRel - 20) === SIG_EOCD64_LOC) {
    const z64Off = Number(head.readBigUInt64LE(eocdRel - 20 + 8));
    if (z64Off + 56 <= fileSize && buf.readUInt32LE(z64Off) === SIG_EOCD64) {
      zip64 = true;
      entryCount = Number(buf.readBigUInt64LE(z64Off + 32));
      cenSize = Number(buf.readBigUInt64LE(z64Off + 40));
      cenOffset = Number(buf.readBigUInt64LE(z64Off + 48));
    }
  }
  if (!zip64 && needsZip64) throw new Error('ZIP64 标记存在但缺少 ZIP64 EOCD 定位器，文件可能损坏');
  if (cenOffset + 16 > fileSize) throw new Error('中央目录偏移越界，文件可能被截断');

  const cen = buf.subarray(cenOffset, cenOffset + cenSize);
  const entries = [];
  let p = 0;
  for (let i = 0; i < entryCount && p + 46 <= cen.length; i++) {
    if (cen.readUInt32LE(p) !== SIG_CEN) break;
    const method = cen.readUInt16LE(p + 10);
    const crc = cen.readUInt32LE(p + 16);
    let compSize = cen.readUInt32LE(p + 20);
    let uncompSize = cen.readUInt32LE(p + 24);
    const nameLen = cen.readUInt16LE(p + 28);
    const extraLen = cen.readUInt16LE(p + 30);
    const commentLen = cen.readUInt16LE(p + 32);
    let localOffset = cen.readUInt32LE(p + 42);
    const flags = cen.readUInt16LE(p + 8);
    const nameBytes = cen.subarray(p + 46, p + 46 + nameLen);
    let name;
    if (flags & 0x800) name = nameBytes.toString('utf8');
    else { try { name = new TextDecoder('utf-8').decode(nameBytes); } catch { name = nameBytes.toString('utf8'); } }

    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      const extra = cen.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      let q = 0;
      while (q + 4 <= extra.length) {
        const id = extra.readUInt16LE(q);
        const sz = extra.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (uncompSize === 0xffffffff) { uncompSize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (compSize === 0xffffffff) { compSize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(extra.readBigUInt64LE(r)); r += 8; }
          break;
        }
        q += 4 + sz;
      }
    }
    entries.push({ name, method, compSize, uncompSize, localOffset, crc32: crc });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const byName = new Map();
  for (const e of entries) byName.set(e.name, e);

  const readEntry = (e) => {
    if (!e) return null;
    if (e.uncompSize === 0 && e.compSize === 0) return Buffer.alloc(0);
    // 本地文件头可能带与中央目录不同的 extra 长度，必须按本地头重新定位
    if (e.localOffset + 30 > fileSize || buf.readUInt32LE(e.localOffset) !== SIG_LOCAL) {
      throw new Error(`本地文件头损坏：${e.name}`);
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return Buffer.from(raw);
    if (e.method !== 8) throw new Error(`不支持的压缩方式 ${e.method}（仅支持 0=stored / 8=deflate）：${e.name}`);
    return zlib.inflateRawSync(raw);
  };

  return {
    size: fileSize,
    zip64,
    entries,
    has(name) { return byName.has(name); },
    entry(name) { return byName.get(name) || null; },
    list() { return entries.map((e) => e.name); },
    match(re) { return entries.filter((e) => re.test(e.name)).map((e) => e.name); },
    buffer(name) { return readEntry(byName.get(name)); },
    text(name) { const b = readEntry(byName.get(name)); return b === null ? null : UTF8_DECODER.decode(b); },
    async close() { /* Buffer 版本无需释放句柄 */ },
  };
}

/**
 * 打开 zip（xlsx 本质就是 zip）。只在需要时解压，避免整包字符串化。
 * 返回的对象持有打开的 fd，用完请调用 close()。
 */
export async function openZip(filePath) {
  const { entries, zip64, fileSize } = await readCentralDirectory(filePath);
  const fd = await fsp.open(filePath, 'r');
  const byName = new Map();
  for (const e of entries) byName.set(e.name, e);
  return {
    size: fileSize,
    zip64,
    entries,
    has(name) { return byName.has(name); },
    entry(name) { return byName.get(name) || null; },
    list() { return entries.map((e) => e.name); },
    match(re) { return entries.filter((e) => re.test(e.name)).map((e) => e.name); },
    async buffer(name) {
      const e = byName.get(name);
      if (!e) return null;
      return inflateEntryStream(fd, e);
    },
    async text(name) {
      const b = await this.buffer(name);
      return b === null ? null : UTF8_DECODER.decode(b);
    },
    async close() { await fd.close(); },
  };
}

/* ===========================================================================
 * 2. 数字格式 → 是否日期
 * ======================================================================== */

const BUILTIN_DATE_FMT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, // 日期与时间
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36, // 东亚日期格式
  45, 46, 47, // mm:ss、h:mm、mm:ss.0
  50, 51, 52, 53, 54, 55, 56, 57, 58, // 东亚日期格式
]);

/**
 * 判断自定义 number format code 是否表示日期/时间。
 * 关键：先剥掉 [..] 颜色/条件、$、"..." 字面量之类，再看 y/m/d/h/s 组合。
 */
export function isDateFormatCode(code) {
  if (!code) return false;
  let s = String(code);
  // 去掉引号字面量与方括号段（[红色]、[$-409]、[h] 除外，[h] 也是时间）
  const brackets = [];
  s = s.replace(/\[([^\]]*)\]/g, (m, inner) => {
    if (/^[hHmMsS]+$/.test(inner)) brackets.push(inner);
    return ' ';
  });
  if (brackets.length) return true;
  s = s.replace(/"[^"]*"/g, ' ');
  s = s.replace(/\\./g, ' ');       // 转义字符
  s = s.replace(/_.|@/g, ' ');      // 占位符
  // 去掉分数格式（# ?/?）里的斜杠干扰：先看是否含 y/m/d/h/s
  if (!/[yYmMdDhHsS]/.test(s)) return false;
  // 纯数字格式（如 0.00、#,##0）一定没有 ymdhs，前面已排除
  return /[yY]|[dD]|[hH]|[sS]/.test(s) || /[mM]/.test(s);
}

/** 解析 styles.xml，得到 numFmtId → 是否日期 的映射 */
export function parseStyles(stylesXml) {
  const dateFmtIds = new Set();
  const customFmt = new Map();
  if (!stylesXml) return { dateFmtIds: BUILTIN_DATE_FMT_IDS, customFmt };

  const numFmtsBlock = stylesXml.match(/<numFmts[\s\S]*?<\/numFmts>/);
  if (numFmtsBlock) {
    const re = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/?>/g;
    let m;
    while ((m = re.exec(numFmtsBlock[0]))) {
      const id = Number(m[1]);
      const code = decodeXmlEntities(m[2]);
      customFmt.set(id, code);
      if (isDateFormatCode(code)) dateFmtIds.add(id);
    }
  }

  // cellXfs：每个 xf 的 numFmtId，cell 的 s 属性索引到这里
  const cellXfsBlock = stylesXml.match(/<cellXfs[\s\S]*?<\/cellXfs>/);
  const xfFmtIds = [];
  if (cellXfsBlock) {
    const re = /<xf\b[^>]*>/g;
    let m;
    while ((m = re.exec(cellXfsBlock[0]))) {
      const idm = /numFmtId="(\d+)"/.exec(m[0]);
      xfFmtIds.push(idm ? Number(idm[1]) : 0);
    }
  }
  for (const id of xfFmtIds) {
    if (BUILTIN_DATE_FMT_IDS.has(id)) dateFmtIds.add(id);
    else if (customFmt.has(id) && isDateFormatCode(customFmt.get(id))) dateFmtIds.add(id);
  }

  return { dateFmtIds, customFmt, xfFmtIds };
}

/* ===========================================================================
 * 3. 日期序列号 → 字符串
 * ======================================================================== */

/**
 * Excel 1900 日期系统序列号 → Date（UTC 表示，规避本地时区漂移）。
 * 1900 系统含历史闰年 bug：序列号 60 被 Excel 当作 1900-02-29（不存在的日期）。
 */
export function serialToDate(serial) {
  if (!Number.isFinite(serial)) return null;
  // Excel 1900 系统把 1899-12-30 当作序列号 0 的基准（该基准已吸收「1900 假闰日」的历史 bug：
  // 序列 1=1900-01-01，序列 59=1900-02-28，序列 60=Excel 的假 1900-02-29，序列 61=1900-03-01）。
  const base = Date.UTC(1899, 11, 30);
  return new Date(base + serial * 86400000);
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

/**
 * 把 Excel 日期序列号格式化成字符串。
 * @param {number} serial
 * @param {string} fmtCode 自定义格式（可空）
 * @param {number} numFmtId
 */
export function formatExcelDate(serial, fmtCode, numFmtId) {
  // 序列号换算成毫秒后再四舍五入到「秒」，规避浮点误差导致的 1 秒漂移
  const epoch = Date.UTC(1899, 11, 30);
  const ms = Math.round((epoch + serial * 86400000) / 1000) * 1000;
  const d = new Date(ms);
  if (!d || Number.isNaN(d.getTime())) return String(serial);
  const Y = d.getUTCFullYear(), M = d.getUTCMonth() + 1, D = d.getUTCDate();
  const h = d.getUTCHours(), mi = d.getUTCMinutes(), s = d.getUTCSeconds();

  const code = fmtCode || '';
  const wantsSeconds = /s/i.test(code);
  const datePart = `${Y}-${pad2(M)}-${pad2(D)}`;

  // 纯日期格式（无 h/s）
  const hasTime = /[hHsS]/.test(code);
  if (!hasTime) return datePart;
  // 只有时间（如 mm:ss / h:mm）
  const timeOnly = !/[yYdD]/.test(code) && !/年月日/.test(code);
  const time = wantsSeconds ? `${pad2(h)}:${pad2(mi)}:${pad2(s)}` : `${pad2(h)}:${pad2(mi)}`;
  if (timeOnly) return time;
  // 时间是 0:00 且格式里没有显式秒 → 只给日期，避免把日期列写成 "2026-08-01 00:00"
  if (h === 0 && mi === 0 && s === 0 && !wantsSeconds) return datePart;
  return `${datePart} ${time}`;
}

/** 数字 → 展示字符串（去掉浮点噪声，保留科学计数法可读性） */
function numToString(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  const s = String(n);
  if (/e/i.test(s)) return s;
  // 去掉 0.30000000000000004 之类噪声
  return String(Number(n.toPrecision(15)));
}

/* ===========================================================================
 * 4. sharedStrings.xml
 * ======================================================================== */

/** 解析 sharedStrings.xml：<si> 内多个 <r><t> 拼接，保留 xml:space="preserve" */
export function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const inner = m[1];
    if (inner === undefined) { out.push(''); continue; }
    // 收集所有 <t ...>...</t>（含 <r><t>），以及 <rPh>（注音）要跳过
    let text = '';
    const withoutPhonetic = inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    const tRe = /<t\b([^>]*)>([\s\S]*?)<\/t>|<t\b([^>]*)\/>/g;
    let tm;
    while ((tm = tRe.exec(withoutPhonetic))) {
      if (tm[2] !== undefined) text += decodeXmlEntities(tm[2]);
    }
    out.push(text);
  }
  return out;
}

/* ===========================================================================
 * 5. 工作表流式解析
 * ======================================================================== */

const CHUNK_ROWS = 4000; // 每解析多少行让出一次事件循环 / 报告进度

/**
 * 解析工作表 XML（已 inflate 的字符串）。
 * 分块策略：按 <row ...> ... </row> 顺序扫描，逐行抽取单元格，绝不构建整表 DOM。
 */
async function parseSheetXml(xml, ctx, opts, onProgress) {
  const { sharedStrings, styles } = ctx;
  const rows = [];
  const maxRows = opts.maxRows || Infinity;
  let maxCols = 0;
  let rowCount = 0;

  const rowRe = /<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g;
  const cellRe = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
  const attrRe = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;

  const readAttrs = (s) => {
    const o = {};
    attrRe.lastIndex = 0;
    let m;
    while ((m = attrRe.exec(s))) o[m[1]] = m[2];
    return o;
  };

  let rm;
  let lastYield = 0;
  while ((rm = rowRe.exec(xml))) {
    if (rowCount >= maxRows) break;
    const selfClosing = rm[2] === '/>';
    const inner = rm[3] || '';
    const rAttrs = readAttrs(rm[1]);
    const rowNum = rAttrs.r ? Number(rAttrs.r) : rowCount + 1;

    const row = [];
    if (!selfClosing && inner) {
      cellRe.lastIndex = 0;
      let cm;
      while ((cm = cellRe.exec(inner))) {
        const cAttrs = readAttrs(cm[1]);
        const cInner = cm[3] || '';
        // 列索引：优先用 r 属性（处理空列跳格），否则顺序追加
        let ci = cAttrs.r ? colToIndex(cAttrs.r) : row.length;
        if (ci < 0 || !Number.isFinite(ci)) ci = row.length;

        const t = cAttrs.t || '';
        let value = '';

        if (t === 'inlineStr') {
          let is = cInner;
          const ism = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(cInner);
          if (ism) is = ism[1];
          const tRe = /<t\b([^>]*)>([\s\S]*?)<\/t>/g;
          let tm2;
          while ((tm2 = tRe.exec(is))) value += decodeXmlEntities(tm2[2]);
        } else {
          const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cInner);
          const rawV = vm ? vm[1] : '';
          if (t === 's') {
            const idx = Number(rawV);
            value = Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length
              ? sharedStrings[idx]
              : '';
          } else if (t === 'str') {
            value = decodeXmlEntities(rawV);
          } else if (t === 'b') {
            value = rawV === '1' ? 'TRUE' : 'FALSE';
          } else if (t === 'e') {
            value = decodeXmlEntities(rawV);
          } else {
            // 无 t：数字（也可能是日期序列号）
            const v = rawV === '' ? '' : decodeXmlEntities(rawV);
            if (v === '') value = '';
            else {
              const num = Number(v);
              if (Number.isFinite(num)) {
                const sIdx = cAttrs.s !== undefined ? Number(cAttrs.s) : -1;
                const fmtId = (sIdx >= 0 && styles.xfFmtIds && styles.xfFmtIds[sIdx] !== undefined)
                  ? styles.xfFmtIds[sIdx] : -1;
                const isDate = fmtId >= 0 && styles.dateFmtIds.has(fmtId);
                // 只对「格式明确是日期」且数值落在合理日期区间（1900-01-01 ~ 2100-12-31）的才转日期
                if (isDate && num >= 1 && num < 73415) {
                  value = formatExcelDate(num, fmtId >= 0 ? styles.customFmt.get(fmtId) : '', fmtId);
                } else {
                  value = numToString(num);
                }
              } else {
                value = v; // 非数字（极少数写入器会写文本）原样保留
              }
            }
          }
        }

        while (row.length < ci) row.push('');
        row[ci] = value;
      }
    }

    rows.push(row);
    if (row.length > maxCols) maxCols = row.length;
    rowCount++;

    if (onProgress && rowCount - lastYield >= CHUNK_ROWS) {
      lastYield = rowCount;
      onProgress({ rows: rowCount, lastRow: rowNum });
      await yieldToLoop();
    }
  }

  // 统一列宽（保留空字符串占位，不丢列）
  padRows(rows, maxCols);
  if (onProgress) onProgress({ rows: rowCount, lastRow: rowCount, done: true });
  return { rows, maxCols };
}

/* ===========================================================================
 * 6. readXlsx
 * ======================================================================== */

/**
 * 读取 xlsx。
 * @param {string} filePath
 * @param {{sheet?:string, maxRows?:number, onProgress?:Function, useGbkFallback?:boolean}} [options]
 * @returns {Promise<{sheets:Array<{name:string,rows:string[][]}>}>}
 */
export async function readXlsx(filePath, options = {}) {
  const zip = await openZip(filePath);
  const onProgress = options.onProgress;
  try {
    return await readXlsxWithZip(zip, options, onProgress);
  } finally {
    await zip.close();
  }
}

async function readXlsxWithZip(zip, options, onProgress) {
  // ---- workbook.xml：sheet 顺序、名称、rId ----
  const workbookXml = await zip.text('xl/workbook.xml');
  if (!workbookXml) throw new Error('不是有效的 xlsx：缺少 xl/workbook.xml');

  const sheetDefs = [];
  const sheetRe = /<sheet\b([^>]*)\/?>/g;
  let sm;
  while ((sm = sheetRe.exec(workbookXml))) {
    const attrs = sm[1];
    const nameM = /name="([^"]*)"/.exec(attrs);
    const ridM = /r:id="([^"]*)"/.exec(attrs) || /rel:id="([^"]*)"/.exec(attrs);
    const stateM = /state="([^"]*)"/.exec(attrs);
    sheetDefs.push({
      name: nameM ? decodeXmlEntities(nameM[1]) : `Sheet${sheetDefs.length + 1}`,
      rId: ridM ? ridM[1] : null,
      hidden: stateM ? stateM[1] !== 'visible' : false,
    });
  }

  // ---- workbook rels：rId → target ----
  const relsXml = (await zip.text('xl/_rels/workbook.xml.rels')) || '';
  const relMap = new Map();
  const relRe = /<Relationship\b([^>]*)\/?>/g;
  let rem;
  while ((rem = relRe.exec(relsXml))) {
    const attrs = rem[1];
    const idM = /Id="([^"]*)"/.exec(attrs);
    const tM = /Target="([^"]*)"/.exec(attrs);
    const modeM = /TargetMode="([^"]*)"/.exec(attrs);
    if (idM && tM && (!modeM || modeM[1] !== 'External')) {
      relMap.set(idM[1], decodeXmlEntities(tM[1]));
    }
  }

  const resolveTarget = (target) => {
    let t = target.replace(/^\/+/, '');
    if (t.startsWith('xl/')) return t;
    // rels 里的相对路径相对 xl/ 目录
    const joined = path.posix.normalize(path.posix.join('xl', t));
    return joined;
  };

  // ---- styles.xml：日期格式判定 ----
  const styles = parseStyles(await zip.text('xl/styles.xml'));

  // ---- sharedStrings.xml ----
  const sharedStrings = parseSharedStrings(await zip.text('xl/sharedStrings.xml'));
  if (onProgress) onProgress({ phase: 'sharedStrings', count: sharedStrings.length });

  const wanted = options.sheet ? String(options.sheet) : null;

  const sheets = [];
  const sheetEntries = zip.entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => {
      const na = Number(/sheet(\d+)\.xml$/.exec(a.name)[1]);
      const nb = Number(/sheet(\d+)\.xml$/.exec(b.name)[1]);
      return na - nb;
    });

  const consumed = new Set();

  for (const def of sheetDefs) {
    if (wanted && def.name !== wanted) continue;
    if (def.hidden) continue; // 隐藏表默认跳过（淘宝导出常见隐藏的说明页）

    let target = def.rId && relMap.has(def.rId) ? resolveTarget(relMap.get(def.rId)) : null;
    if (!target || !zip.has(target)) {
      // 兜底：rels 缺失时按顺序取 sheetN.xml
      const next = sheetEntries.find((e) => !consumed.has(e.name));
      if (!next) continue;
      target = next.name;
    }
    consumed.add(target);

    const xml = await zip.text(target);
    if (xml == null) continue;
    const { rows } = await parseSheetXml(xml, { sharedStrings, styles }, options, onProgress);
    sheets.push({ name: def.name, rows });
  }

  // 兜底：workbook.xml 里没有 sheet 定义（极少见）→ 全部工作表用文件名当表名
  if (sheets.length === 0 && !wanted) {
    for (const e of sheetEntries) {
      const xml = await zip.text(e.name);
      const { rows } = await parseSheetXml(xml, { sharedStrings, styles }, options, onProgress);
      sheets.push({ name: e.name.replace(/^xl\/worksheets\//, '').replace(/\.xml$/, ''), rows });
    }
  }

  if (wanted && sheets.length === 0) {
    throw new Error(`未找到工作表「${wanted}」。可用工作表：${sheetDefs.map((s) => s.name).join(' / ')}`);
  }

  return { sheets };
}

/* ===========================================================================
 * 7. CSV 读取
 * ======================================================================== */

/**
 * 读取 CSV/TSV。
 * 自动分隔符（, / \t / ;）、自动跳过 BOM、支持 "..." 与 "" 转义、字段内换行、CRLF。
 * @returns {Promise<{sheets:Array<{name:string,rows:string[][]}>}>}
 */
export async function readCsv(filePath, options = {}) {
  const buffer = await fsp.readFile(filePath);
  const name = options.sheetName || path.basename(filePath).replace(/\.[^.]+$/, '');
  return readCsvFromText(csvDecodeBuffer(buffer, options), options, name);
}

/**
 * 从内存 Buffer 读 xlsx（API 服务用：收到 base64 上传直接解析，不落盘）。
 * 与 readXlsx(filePath) 返回同构结果。
 */
export async function readXlsxBuffer(buffer, options = {}) {
  const zip = openZipBuffer(buffer);
  return readXlsxWithZip(zip, options, options.onProgress);
}

/**
 * 从内存 Buffer 读 CSV（自动分隔符 / BOM / GBK 回退，与 readCsv 同口径）。
 */
export async function readCsvBuffer(buffer, options = {}) {
  return readCsvFromText(csvDecodeBuffer(buffer, options), options, options.sheetName || 'CSV');
}

// CSV 文本解码：UTF-8 BOM → UTF-8；否则 UTF-8 解出替换字符就回退 GBK
//（中文 Windows 后台导出常见 GBK，没有这层兜底整份文件会被静默丢弃）
function csvDecodeBuffer(buffer, options = {}) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return UTF8_DECODER.decode(buffer.subarray(3));
  }
  const asUtf8 = UTF8_DECODER.decode(buffer);
  if (!asUtf8.includes('\uFFFD')) return asUtf8;
  const asGbk = GBK_DECODER.decode(buffer);
  const before = (asUtf8.match(/\uFFFD/g) || []).length;
  const after = (asGbk.match(/\uFFFD/g) || []).length;
  if (options.onProgress) options.onProgress({ stage: 'encoding', chosen: after < before ? 'gbk' : 'utf-8' });
  return after < before ? asGbk : asUtf8;
}

// CSV 文本 → rows（分隔符探测 + 引号/转义/字段内换行/CRLF）
function readCsvFromText(text, options, csvSheetName) {
  const { delimiter, onProgress, maxRows } = options;

  // 分隔符探测：看第一个「逻辑行」中各候选出现次数（忽略引号内内容）
  let delim = delimiter;
  if (!delim) {
    const headSample = text.slice(0, 65536);
    const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
    let inQ = false;
    for (let i = 0; i < headSample.length; i++) {
      const ch = headSample[i];
      if (ch === '"') inQ = !inQ;
      else if (!inQ && ch === '\n') break;
      else if (!inQ && counts[ch] !== undefined) counts[ch]++;
    }
    delim = Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a), ',');
    if (counts[delim] === 0) delim = ',';
  }

  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let started = false;
  let maxCols = 0;

  const pushField = () => {
    row.push(field);
    field = '';
    if (row.length > maxCols) maxCols = row.length;
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; started = true; continue; }
    if (ch === delim) { pushField(); started = true; continue; }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      pushRow();
      continue;
    }
    if (ch === '\n') { pushRow(); continue; }
    field += ch;
    started = true;
  }
  if (field !== '' || row.length > 0 || started) pushRow();

  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();

  let out = rows;
  if (maxRows && out.length > maxRows) out = out.slice(0, maxRows);
  padRows(out, maxCols);

  if (onProgress) onProgress({ rows: out.length, done: true });

  return { sheets: [{ name: csvSheetName, rows: out }] };
}

/* ===========================================================================
 * 8. detectAndRead
 * ======================================================================== */

/**
 * 按扩展名分派：.xlsx/.xlsm → readXlsx，.csv/.tsv/.txt → readCsv。
 * @returns {Promise<{sheets:Array<{name:string,rows:string[][]}>}>}
 */
export async function detectAndRead(filePath, options = {}) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.xltx') {
    return readXlsx(filePath, options);
  }
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt' || ext === '') {
    return readCsv(filePath, options);
  }
  // 未知扩展名：先按 zip 探一下 magic，再决定
  try {
    const fd = await fsp.open(filePath, 'r');
    const head = Buffer.alloc(4);
    await fd.read(head, 0, 4, 0);
    await fd.close();
    if (head[0] === 0x50 && head[1] === 0x4b) return readXlsx(filePath, options);
  } catch { /* ignore */ }
  return readCsv(filePath, options);
}

/* ===========================================================================
 * 9. CLI
 * ======================================================================== */

function cliUsage() {
  return [
    '用法: node xlsx.mjs <文件> [选项]',
    '',
    '选项:',
    '  --sheet <名称>   只读取指定工作表',
    '  --limit <N>      只打印前 N 行（默认 10）',
    '  --json           以 JSON 输出解析结果（含全部行，配合 --limit 使用）',
    '  --list           只列出工作表名与行数/列数',
    '  --raw            不做截断，打印全部行（慎用，大文件会很长）',
    '  --progress       解析过程中打印进度',
    '',
    '示例:',
    '  node xlsx.mjs "交易概况.xlsx" --limit 5',
    '  node xlsx.mjs "订单明细.xlsx" --sheet Sheet1 --list',
  ].join('\n');
}

function cellWidth(s) {
  // 中文按 2 列宽估算
  let w = 0;
  for (const ch of String(s)) w += /[\u2E80-\u9FFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? 2 : 1;
  return w;
}

function padCell(s, w) {
  const d = w - cellWidth(s);
  return s + (d > 0 ? ' '.repeat(d) : '');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    console.log(cliUsage());
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const file = argv[0];
  const opt = { sheet: null, limit: 10, json: false, list: false, raw: false, progress: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sheet') opt.sheet = argv[++i];
    else if (a === '--limit') opt.limit = Number(argv[++i]);
    else if (a === '--json') opt.json = true;
    else if (a === '--list') opt.list = true;
    else if (a === '--raw') opt.raw = true;
    else if (a === '--progress') opt.progress = true;
  }

  if (!fs.existsSync(file)) {
    console.error(`文件不存在: ${file}`);
    process.exit(2);
  }

  const t0 = Date.now();
  const useProgress = opt.progress;
  const onProgress = useProgress
    ? (p) => {
        if (p.done) process.stderr.write(`\r  解析完成: ${p.rows} 行            \n`);
        else if (p.phase === 'sharedStrings') process.stderr.write(`  共享字符串: ${p.count} 条\n`);
        else process.stderr.write(`\r  已解析 ${p.rows} 行...`);
      }
    : undefined;

  const result = await detectAndRead(file, { sheet: opt.sheet, onProgress });
  const ms = Date.now() - t0;

  if (opt.json) {
    const payload = {
      file: path.resolve(file),
      elapsedMs: ms,
      sheets: result.sheets.map((s) => ({
        name: s.name,
        rowCount: s.rows.length,
        colCount: s.rows.reduce((m, r) => Math.max(m, r.length), 0),
        rows: opt.raw ? s.rows : s.rows.slice(0, opt.raw ? s.rows.length : opt.limit),
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`文件: ${path.resolve(file)}`);
  console.log(`解析耗时: ${ms} ms   工作表数: ${result.sheets.length}`);

  if (opt.list) {
    for (const s of result.sheets) {
      const cols = s.rows.reduce((m, r) => Math.max(m, r.length), 0);
      console.log(`  - ${s.name}  行: ${s.rows.length}  列: ${cols}`);
      if (s.rows[0]) console.log(`      表头: ${s.rows[0].filter(Boolean).join(' | ')}`);
    }
    return;
  }

  for (const s of result.sheets) {
    const cols = s.rows.reduce((m, r) => Math.max(m, r.length), 0);
    console.log('');
    console.log(`=== 工作表「${s.name}」 行数 ${s.rows.length} 列数 ${cols} ===`);
    const n = opt.raw ? s.rows.length : Math.min(opt.limit, s.rows.length);
    const show = s.rows.slice(0, n);
    // 列宽
    const widths = new Array(cols).fill(0);
    for (const r of show) {
      for (let c = 0; c < cols; c++) {
        const w = cellWidth(r[c] === undefined ? '' : r[c]);
        if (w > widths[c]) widths[c] = w;
      }
    }
    const fmtRow = (r) => {
      const cells = [];
      for (let c = 0; c < cols; c++) cells.push(padCell(r[c] === undefined ? '' : r[c], widths[c]));
      return cells.join(' | ').replace(/\s+$/, '');
    };
    for (const r of show) console.log(fmtRow(r));
    if (!opt.raw && s.rows.length > n) console.log(`... 省略 ${s.rows.length - n} 行（用 --limit/--raw 调整）`);
  }
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error('解析失败:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

export default { readXlsx, readCsv, detectAndRead, openZip };
