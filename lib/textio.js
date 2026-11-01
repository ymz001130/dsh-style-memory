/**
 * 本地文本抽取：.docx / .pptx / .md / .txt → 纯文本。
 * 只用 Node 内置模块（fs/zlib），不联网、不调用外部程序。
 *
 * .docx 与 .pptx 本质是 zip；这里实现一个最小 zip 读取器：
 * 中央目录定位 → 本地文件头 → deflate 解压。
 * 不支持加密、分卷、zip64 超大文件的边缘情况，遇到时返回明确错误。
 */

import { readFileSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { extname } from 'node:path';

const MAX_FILE_BYTES = 80 * 1024 * 1024;

/** 支持的文档扩展名。 */
export const DOC_EXTENSIONS = new Set(['.docx', '.pptx', '.md', '.markdown', '.txt']);

/** 判断路径是否是本插件能抽取文本的文档。 */
export function isSupportedDoc(path) {
  if (typeof path !== 'string') return false;
  return DOC_EXTENSIONS.has(extname(path).toLowerCase());
}

/** 文档大类：docx / pptx / text / unknown。 */
export function docKind(path) {
  const ext = extname(String(path || '')).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.pptx') return 'pptx';
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') return 'text';
  return 'unknown';
}

function readAllBytes(file) {
  const info = statSync(file);
  if (!info.isFile()) throw new Error('不是普通文件：' + file);
  if (info.size > MAX_FILE_BYTES) throw new Error('文件超过 80MB，跳过抽取：' + file);
  return readFileSync(file);
}

function readZipEntry(buf, want) {
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minStart; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/office 文件（找不到中央目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (off + 46 > buf.length) throw new Error('zip 中央目录越界');
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip 中央目录条目损坏');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name === want) {
      if (compSize === 0xffffffff) throw new Error('不支持 zip64 条目：' + want);
      if (localOff + 30 > buf.length) throw new Error('zip 本地头越界');
      if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zip 本地头损坏');
      const lnameLen = buf.readUInt16LE(localOff + 26);
      const lextraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lnameLen + lextraLen;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error('不支持的 zip 压缩方式：' + method);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function listZipNames(buf) {
  const names = [];
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minStart; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return names;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function decodeXmlEntities(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m) => {
    switch (m) {
      case '&lt;': return '<';
      case '&gt;': return '>';
      case '&amp;': return '&';
      case '&quot;': return '"';
      case '&apos;': return "'";
      default: {
        const hex = m.startsWith('&#x');
        const code = parseInt(m.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
    }
  });
}

/** 从 office XML 中按 <w:p>/<a:p> 段落取文本。 */
function paragraphsFromXml(xml, tag) {
  const out = [];
  const open = tag === 'w' ? /<w:p(?:\s[^>]*)?>/g : /<a:p(?:\s[^>]*)?>/g;
  const close = tag === 'w' ? '</w:p>' : '</a:p>';
  let depth = 0;
  let buf = '';
  let m;
  while ((m = open.exec(xml)) !== null) {
    depth += 1;
    if (depth === 1) {
      buf = xml.slice(m.index + m[0].length);
      const end = buf.indexOf(close);
      if (end === -1) continue;
      buf = buf.slice(0, end);
      const texts = [];
      const tre = tag === 'w' ? /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g : /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
      let t;
      while ((t = tre.exec(buf)) !== null) texts.push(decodeXmlEntities(t[1]));
      const value = texts.join('').trim();
      if (value.length > 0) out.push(value);
      depth = 0;
    }
  }
  return out;
}

/** 抽取 .docx 正文（含表格内段落，表格单元格的 w:t 也在 w:p 内）。 */
export function extractDocxText(file) {
  const buf = readAllBytes(file);
  const xml = readZipEntry(buf, 'word/document.xml');
  if (xml === null) throw new Error('docx 缺少 word/document.xml');
  const text = xml.toString('utf8');
  const paragraphs = paragraphsFromXml(text, 'w');
  return paragraphs.join('\n');
}

/** 抽取 .pptx 文本：按幻灯片顺序输出，每页以“【第N页】”起头。 */
export function extractPptxText(file) {
  const buf = readAllBytes(file);
  const names = listZipNames(buf)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/)[1], 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml/)[1], 10);
      return na - nb;
    });
  if (names.length === 0) throw new Error('pptx 里找不到幻灯片');
  const parts = [];
  for (const name of names) {
    const xml = readZipEntry(buf, name);
    if (xml === null) continue;
    const pageNo = parseInt(name.match(/slide(\d+)\.xml/)[1], 10);
    const paragraphs = paragraphsFromXml(xml.toString('utf8'), 'a');
    if (paragraphs.length === 0) continue;
    parts.push('【第' + pageNo + '页】\n' + paragraphs.join('\n'));
  }
  return parts.join('\n\n');
}

/**
 * 从文件抽取纯文本。
 * @param {string} file 绝对路径
 * @returns {{ ok: boolean, kind: string, text: string, chars: number, error?: string }}
 */
export function extractTextFromFile(file) {
  try {
    const kind = docKind(file);
    let text = '';
    if (kind === 'docx') text = extractDocxText(file);
    else if (kind === 'pptx') text = extractPptxText(file);
    else if (kind === 'text') {
      const info = statSync(file);
      if (info.size > MAX_FILE_BYTES) return { ok: false, kind, text: '', chars: 0, error: '文件过大' };
      text = readFileSync(file, 'utf8');
    } else {
      return { ok: false, kind, text: '', chars: 0, error: '不支持的文档类型：' + extname(file) };
    }
    const clean = text.replace(/\uFEFF/g, '').trim();
    if (clean.length === 0) return { ok: false, kind, text: '', chars: 0, error: '文档没有可读文本（可能是扫描件或图片型文档）' };
    return { ok: true, kind, text: clean, chars: clean.length };
  } catch (error) {
    return { ok: false, kind: docKind(file), text: '', chars: 0, error: String((error && error.message) || error) };
  }
}

/** 读取纯文本文件（用于导出/导入数据）。 */
export function readPlainFile(file) {
  return readFileSync(file, 'utf8').replace(/\uFEFF/g, '');
}
