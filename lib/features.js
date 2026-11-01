/**
 * 文本切分与可解释指标计算。纯函数、零依赖，检测与学习共用同一套口径。
 *
 * 所有偏移量都基于 normalizeText 之后的文本；调用方需要展示原文时，
 * 用同一份 normalized 文本即可（只做空白归一，不改变字符顺序）。
 */

import { HUMAN_FEATURES } from './constants.js';

const BOUNDARY = new Set(['。', '！', '？', '；', '…', '!', '?', ';', '\n', '\r']);
const CLOSERS = new Set(['”', '’', '」', '』', '）', ')', '】', '》', '…', '.', '!', '?', '。', '！', '？']);

/** 归一化：统一换行、压缩多余空白与空行，保留中文标点。 */
export function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 按空行/换行切段（段内保留句读）。 */
export function splitParagraphs(text) {
  const normalized = normalizeText(text);
  if (normalized.length === 0) return [];
  return normalized.split(/\n{1,}/).map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * 切句：返回 { text, start, end } 数组，保留原文偏移。
 * 连续标点（如“……”或“？！）合并到同一句边界。
 */
export function splitSentences(text) {
  const t = normalizeText(text);
  const out = [];
  let start = 0;
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (!BOUNDARY.has(ch)) { i += 1; continue; }
    let end = i + 1;
    while (end < t.length && (BOUNDARY.has(t[end]) || CLOSERS.has(t[end]))) {
      if (t[end] === '”' || t[end] === '’' || t[end] === '」' || t[end] === '』' || t[end] === '）' || t[end] === ')' || t[end] === '】' || t[end] === '》') {
        end += 1;
        continue;
      }
      end += 1;
    }
    pushSentence(out, t, start, end);
    start = end;
    i = end;
  }
  if (start < t.length) pushSentence(out, t, start, t.length);
  return out;
}

function pushSentence(out, text, start, end) {
  const raw = text.slice(start, end);
  const trimmed = raw.trim();
  if (trimmed.length === 0) return;
  const leading = raw.length - raw.trimStart().length;
  const offset = start + leading;
  out.push({ text: trimmed, start: offset, end: offset + trimmed.length });
}

/** 统计一个字符串在文本中出现的非重叠次数。 */
export function countOccurrences(haystack, needle) {
  if (!needle || haystack.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 收集正则命中（带原文偏移）。零长度命中会被跳过。 */
export function collectRegexHits(text, re) {
  const hits = [];
  if (!re || typeof text !== 'string' || text.length === 0) return hits;
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const scan = new RegExp(re.source, flags);
  let m;
  while ((m = scan.exec(text)) !== null) {
    if (m[0].length === 0) { scan.lastIndex += 1; continue; }
    hits.push({ start: m.index, end: m.index + m[0].length, text: m[0], groups: m.slice(1) });
    if (hits.length > 5000) break;
  }
  return hits;
}

/** 千字密度。 */
export function perKilo(count, chars) {
  if (!Number.isFinite(count) || !Number.isFinite(chars) || chars <= 0) return 0;
  return (count / chars) * 1000;
}

function safeRatio(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  return a / b;
}

function statsOf(values) {
  const n = values.length;
  const sum = values.reduce((acc, v) => acc + v, 0);
  const mean = n > 0 ? sum / n : 0;
  const variance = n > 0 ? values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / n : 0;
  const std = Math.sqrt(variance);
  return {
    count: n,
    mean: round(mean, 2),
    std: round(std, 2),
    cv: round(safeRatio(std, mean), 3),
    min: n > 0 ? Math.min.apply(null, values) : 0,
    max: n > 0 ? Math.max.apply(null, values) : 0,
    ratio: round(safeRatio(n > 0 ? Math.max.apply(null, values) : 0, n > 0 ? Math.max(1, Math.min.apply(null, values)) : 1), 2)
  };
}

function round(v, digits) {
  if (!Number.isFinite(v)) return 0;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

/**
 * 严格的三项排比计数：三项字数接近，且至少两项带虚词/动词性成分。
 * 目的是把「颈型、神经根型、脊髓型」这类医学术语列举排除在外。
 */
function countParallelTriplets(text) {
  const re = /[^。！？；\n]{2,10}[，、][^。！？；\n]{2,10}[，、][^。！？；\n]{2,10}[，。；]/g;
  let count = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const parts = m[0].split(/[，、]/).map((item) => item.replace(/[，。；]$/, '').trim()).filter((item) => item.length > 0);
    if (parts.length < 3) continue;
    const lens = parts.map((item) => item.length);
    if (Math.max.apply(null, lens) - Math.min.apply(null, lens) > 5) continue;
    const functional = parts.filter((item) => /[的了是在和与及为]/.test(item)).length;
    if (functional < 2) continue;
    count += 1;
  }
  return count;
}

/** 引号内文字总长度。 */
function quotedChars(text) {
  let total = 0;
  const re = /“[^”]{0,400}”|「[^」]{0,400}」|『[^』]{0,400}』|"[^"\n]{0,400}"/g;
  let m;
  while ((m = re.exec(text)) !== null) total += m[0].length;
  return total;
}

/**
 * 计算一份文本的可解释指标。
 * @param {string} rawText
 * @returns {object}
 */
export function computeMetrics(rawText) {
  const text = normalizeText(rawText);
  const chars = text.replace(/\s+/g, '').length;
  const sentences = splitSentences(text);
  const lens = sentences.map((s) => s.text.length);
  const stats = statsOf(lens);
  const paragraphs = splitParagraphs(text);
  const paraStats = statsOf(paragraphs.map((p) => p.length));

  const colon = collectRegexHits(text, /[：:]/g).length;
  const dash = collectRegexHits(text, /—{1,}/g).length;
  const semicolon = collectRegexHits(text, /[；;]/g).length;
  const parens = collectRegexHits(text, /[（(]/g).length;
  const quotes = collectRegexHits(text, /[“”"「」『』]/g).length;
  const questions = collectRegexHits(text, /[？?]/g).length;
  const exclaims = collectRegexHits(text, /[！!]/g).length;
  const connectives = collectRegexHits(text, /(此外|然而|因此|与此同时|从而|进而|首先|其次|再次|最后|综上|总之)/g).length;
  const listMarkers = collectRegexHits(text, /(^|\n)\s*(第[一二三四五六七八九十百]+[章节条]?|[一二三四五六七八九十]+、|\d+[.、)）]|[-*•·])\s*/g).length;
  const parallelTriplets = countParallelTriplets(text);
  const uniqueChars = new Set(text.replace(/\s+/g, '').split('')).size;
  const quoted = quotedChars(text);

  const human = {};
  for (const feature of HUMAN_FEATURES) {
    if (feature.re === null) continue;
    human[feature.id] = collectRegexHits(text, feature.re).length;
  }
  human.shortSentences = lens.filter((l) => l > 0 && l <= 12).length;

  return {
    chars,
    paragraphs: paragraphs.length,
    sentences: stats.count,
    meanLen: stats.mean,
    stdLen: stats.std,
    cv: stats.cv,
    minLen: stats.min,
    maxLen: stats.max,
    spread: stats.ratio,
    shortRatio: round(safeRatio(human.shortSentences, stats.count || 1), 3),
    longRatio: round(safeRatio(lens.filter((l) => l >= 35).length, stats.count || 1), 3),
    colonDensity: round(perKilo(colon, chars), 2),
    dashDensity: round(perKilo(dash, chars), 2),
    semicolonDensity: round(perKilo(semicolon, chars), 2),
    parenDensity: round(perKilo(parens, chars), 2),
    quoteDensity: round(perKilo(quotes, chars), 2),
    questionDensity: round(perKilo(questions, chars), 2),
    exclaimDensity: round(perKilo(exclaims, chars), 2),
    connectiveDensity: round(perKilo(connectives, chars), 2),
    listMarkerDensity: round(perKilo(listMarkers, chars), 2),
    parallelTriplets: round(perKilo(parallelTriplets, chars), 2),
    quoteRatio: round(safeRatio(quoted, chars), 3),
    paragraphMean: paraStats.mean,
    paragraphCv: paraStats.cv,
    vocabularyRichness: round(safeRatio(uniqueChars, chars), 3),
    humanSignals: human,
    humanSignalTotal: Object.keys(human).reduce((acc, k) => acc + human[k], 0),
    sentenceLengths: lens
  };
}

/** 字符二元组集合，用于相似度与文本对齐。 */
export function bigramSet(text) {
  const set = new Set();
  const t = normalizeText(text).replace(/\s+/g, '');
  for (let i = 0; i + 1 < t.length; i += 1) set.add(t.slice(i, i + 2));
  return set;
}

/** 二元组 Jaccard 相似度（0-1）。 */
export function similarity(a, b) {
  const ta = normalizeText(a).replace(/\s+/g, '');
  const tb = normalizeText(b).replace(/\s+/g, '');
  if (ta === tb) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;
  const sa = bigramSet(ta);
  const sb = bigramSet(tb);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 找到偏移量所属的句子序号（用于问题定位）。 */
export function sentenceIndexAt(sentences, offset) {
  for (let i = 0; i < sentences.length; i += 1) {
    if (offset >= sentences[i].start && offset < sentences[i].end) return i;
  }
  return sentences.length > 0 ? sentences.length - 1 : -1;
}

/** 段落首尾判断（用于学习开头/结尾习惯）。 */
export function paragraphIndexAt(paragraphs, offset, cursor) {
  let pos = 0;
  for (let i = 0; i < paragraphs.length; i += 1) {
    const start = cursor.indexOf(paragraphs[i], pos);
    if (start === -1) continue;
    if (offset >= start && offset < start + paragraphs[i].length) return i;
    pos = start + paragraphs[i].length;
  }
  return -1;
}

/** 把指标里可比较的数值字段列出来（学习与偏差计算共用）。 */
export const COMPARABLE_METRICS = [
  'meanLen', 'stdLen', 'cv', 'spread', 'shortRatio', 'longRatio',
  'colonDensity', 'dashDensity', 'semicolonDensity', 'parenDensity',
  'quoteDensity', 'questionDensity', 'exclaimDensity',
  'connectiveDensity', 'listMarkerDensity', 'parallelTriplets',
  'paragraphMean', 'paragraphCv', 'vocabularyRichness'
];

/** 计算两个指标对象之间的相对变化（revised - original，方向一致）。 */
export function metricDeltas(originalMetrics, revisedMetrics) {
  const out = {};
  for (const key of COMPARABLE_METRICS) {
    const a = originalMetrics[key];
    const b = revisedMetrics[key];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    out[key] = round(b - a, 3);
  }
  return out;
}
