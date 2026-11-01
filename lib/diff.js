/**
 * AI 原稿 vs 用户修订稿的结构化差异。
 *
 * 三级对齐，先粗后细：
 *   1) 段落级：二元组相似度 + LCS，容忍段落改写与顺序变化；
 *   2) 句级：在匹配到的段落内部按句切分，句子相似度做锚点；
 *   3) 字符级：Myers diff，拿到精确的删除/插入/替换区间。
 *
 * 输出统一的 edit span，供 learn.js 提炼三类信号（偏好/监督/奖励）。
 */

import { normalizeText, similarity, splitParagraphs, splitSentences } from './features.js';

const DEFAULT_MIN_PARAGRAPH_SIM = 0.5;
const MAX_CHAR_DIFF_CHARS = 30000;
const MAX_MYERS_D = 4000;

/** 段落级对齐（允许改写，按相似度 > 阈值视为同一段）。 */
export function alignParagraphs(aiParas, userParas, options) {
  const minSim = (options && options.minSim) || DEFAULT_MIN_PARAGRAPH_SIM;
  const n = aiParas.length;
  const m = userParas.length;
  const eq = [];
  for (let i = 0; i < n; i += 1) {
    eq.push([]);
    for (let j = 0; j < m; j += 1) {
      eq[i].push(aiParas[i] === userParas[j] ? 1 : (similarity(aiParas[i], userParas[j]) >= minSim ? 1 : 0));
    }
  }
  const dp = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      dp[i][j] = eq[i - 1][j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const pairs = [];
  const aiOnly = [];
  const userOnly = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (eq[i - 1][j - 1] && dp[i][j] === dp[i - 1][j - 1] + 1) {
      const sim = aiParas[i - 1] === userParas[j - 1] ? 1 : similarity(aiParas[i - 1], userParas[j - 1]);
      pairs.push({ aiIndex: i - 1, userIndex: j - 1, ai: aiParas[i - 1], user: userParas[j - 1], sim: sim });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      aiOnly.push(i - 1);
      i -= 1;
    } else {
      userOnly.push(j - 1);
      j -= 1;
    }
  }
  while (i > 0) { aiOnly.push(i - 1); i -= 1; }
  while (j > 0) { userOnly.push(j - 1); j -= 1; }
  pairs.reverse();
  aiOnly.reverse();
  userOnly.reverse();

  // 第二遍兜底：大改写时句子相似度可能低于锚点阈值，按相似度把剩余段落配对，
  // 避免整段改写被当成「删除 + 新增」而丢掉精确的改法信号。
  const remainingUser = new Set(userOnly);
  const stillAiOnly = [];
  for (const aiIndex of aiOnly) {
    let bestUser = -1;
    let bestSim = 0;
    for (const userIndex of remainingUser) {
      const score = similarity(aiParas[aiIndex], userParas[userIndex]);
      if (score > bestSim) { bestSim = score; bestUser = userIndex; }
    }
    if (bestUser >= 0 && bestSim >= 0.15) {
      pairs.push({ aiIndex: aiIndex, userIndex: bestUser, ai: aiParas[aiIndex], user: userParas[bestUser], sim: bestSim });
      remainingUser.delete(bestUser);
    } else {
      stillAiOnly.push(aiIndex);
    }
  }
  // 第三遍：整段重写时相似度可能很低，但两份文档的剩余段落在位置上仍对应。
  // 按顺序把剩余段落配对（不做硬性相似度门槛），让学习端至少能拿到逐字的改法；
  // 真正的新增/删除段落会在学习端因为过长/越界被过滤。
  const restUser = Array.from(remainingUser).sort((a, b) => a - b);
  const pairedCount = Math.min(stillAiOnly.length, restUser.length);
  for (let x = 0; x < pairedCount; x += 1) {
    const aiIndex = stillAiOnly[x];
    const userIndex = restUser[x];
    pairs.push({ aiIndex: aiIndex, userIndex: userIndex, ai: aiParas[aiIndex], user: userParas[userIndex], sim: similarity(aiParas[aiIndex], userParas[userIndex]) });
  }
  pairs.sort((a, b) => a.aiIndex - b.aiIndex);
  return {
    pairs: pairs,
    aiOnly: stillAiOnly.slice(pairedCount),
    userOnly: restUser.slice(pairedCount)
  };
}

/** Myers 字符级 diff（有上限；超出时回退为整段替换）。 */
function myersDiff(a, b) {
  const N = a.length;
  const M = b.length;
  const maxD = Math.min(N + M, MAX_MYERS_D);
  const v = new Map();
  v.set(1, 0);
  const trace = [];
  for (let d = 0; d <= maxD; d += 1) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x;
      const down = v.has(k + 1) ? v.get(k + 1) : -Infinity;
      const right = v.has(k - 1) ? v.get(k - 1) : -Infinity;
      if (k === -d || (k !== d && right < down)) x = down;
      else x = right + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x += 1; y += 1; }
      v.set(k, x);
      if (x >= N && y >= M) return { ok: true, trace: trace };
    }
  }
  return { ok: false, trace: trace };
}

function recoverOps(trace, a, b) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const v = trace[d];
    const k = x - y;
    const down = v.has(k + 1) ? v.get(k + 1) : -Infinity;
    const right = v.has(k - 1) ? v.get(k - 1) : -Infinity;
    let prevK;
    if (k === -d || (k !== d && right < down)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v.has(prevK) ? v.get(prevK) : 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ t: '=', c: a[x - 1] }); x -= 1; y -= 1; }
    if (x === prevX) { ops.push({ t: '+', c: b[y - 1] }); y -= 1; }
    else { ops.push({ t: '-', c: a[x - 1] }); x -= 1; }
  }
  while (x > 0) { ops.push({ t: '-', c: a[x - 1] }); x -= 1; }
  while (y > 0) { ops.push({ t: '+', c: b[y - 1] }); y -= 1; }
  return ops.reverse();
}

/** 把逐字操作压成「连续删除 + 连续插入」的编辑区间，并记录前后文与子句边界。 */
function opsToSpans(ops) {
  const spans = [];
  let current = null;
  let equalTail = '';
  let aiOffset = 0;
  let userOffset = 0;
  let spanAiStart = 0;
  let spanUserStart = 0;
  let lastSpan = null;

  function closeCurrent() {
    if (current === null) return;
    current.aiStart = spanAiStart;
    current.aiEnd = aiOffset;
    current.userStart = spanUserStart;
    current.userEnd = userOffset;
    current.contextBefore = equalTail;
    if (current.contextAfter === undefined) current.contextAfter = '';
    spans.push(current);
    lastSpan = current;
    current = null;
  }

  for (const op of ops) {
    if (op.t === '=') {
      if (current !== null) closeCurrent();
      if (lastSpan !== null && lastSpan.contextAfter.length < 16) lastSpan.contextAfter += op.c;
      equalTail = (equalTail + op.c).slice(-14);
      aiOffset += 1;
      userOffset += 1;
      continue;
    }
    if (current === null) {
      current = { del: '', ins: '', contextBefore: '', contextAfter: '' };
      spanAiStart = aiOffset;
      spanUserStart = userOffset;
    }
    if (op.t === '-') { current.del += op.c; aiOffset += 1; }
    else { current.ins += op.c; userOffset += 1; }
  }
  closeCurrent();
  // 子句边界：前文以标点开头/结尾说明改动落在子句边界上，碎片改动则不是
  for (const span of spans) {
    span.clauseStart = span.contextBefore.length === 0 || /[。！？；，、：:!?;\n\s]$/.test(span.contextBefore);
    span.clauseEnd = span.contextAfter.length === 0 || /^[。！？；，、：:!?;\n\s]/.test(span.contextAfter);
  }
  return spans;
}

/** 段落内字符 diff，返回 span 列表（带上下文）。 */
export function diffParagraph(aiText, userText) {
  const a = normalizeText(aiText);
  const b = normalizeText(userText);
  if (a === b) return { spans: [], ok: true };
  if (a.length + b.length > MAX_CHAR_DIFF_CHARS) {
    return { spans: [{ del: a, ins: b, contextBefore: '', contextAfter: '', aiStart: 0, aiEnd: a.length, userStart: 0, userEnd: b.length }], ok: false };
  }
  const res = myersDiff(a, b);
  if (!res.ok) {
    return { spans: [{ del: a, ins: b, contextBefore: '', contextAfter: '', aiStart: 0, aiEnd: a.length, userStart: 0, userEnd: b.length }], ok: false };
  }
  const ops = recoverOps(res.trace, a, b);
  const spans = opsToSpans(ops);
  for (const span of spans) {
    if (span.aiStart === undefined) span.aiStart = span.aiEnd;
    if (span.userStart === undefined) span.userStart = span.userEnd;
  }
  return { spans: spans, ok: true };
}

/**
 * 整体差异分析。
 * @param {string} aiText  AI 原稿
 * @param {string} userText 用户修订稿
 * @returns {object}
 */
export function diffDocuments(aiText, userText) {
  const aiNormalized = normalizeText(aiText);
  const userNormalized = normalizeText(userText);
  const aiParas = splitParagraphs(aiNormalized);
  const userParas = splitParagraphs(userNormalized);
  const alignment = alignParagraphs(aiParas, userParas);
  const paragraphEdits = [];
  const changedSpans = [];
  let identical = 0;
  let modified = 0;
  for (const pair of alignment.pairs) {
    const result = diffParagraph(pair.ai, pair.user);
    if (result.spans.length === 0) { identical += 1; continue; }
    modified += 1;
    const entry = {
      aiIndex: pair.aiIndex,
      userIndex: pair.userIndex,
      sim: pair.sim,
      ai: pair.ai,
      user: pair.user,
      spans: result.spans,
      charDiffOk: result.ok
    };
    paragraphEdits.push(entry);
    for (const span of result.spans) {
      changedSpans.push({
        del: span.del,
        ins: span.ins,
        contextBefore: span.contextBefore || '',
        contextAfter: span.contextAfter || '',
        clauseStart: span.clauseStart === true,
        clauseEnd: span.clauseEnd === true,
        aiStart: span.aiStart,
        aiEnd: span.aiEnd,
        userStart: span.userStart,
        userEnd: span.userEnd,
        aiParagraph: pair.aiIndex,
        userParagraph: pair.userIndex,
        aiParagraphText: pair.ai,
        userParagraphText: pair.user
      });
    }
  }
  const deletedParagraphs = alignment.aiOnly.map((idx) => ({ index: idx, text: aiParas[idx] }));
  const insertedParagraphs = alignment.userOnly.map((idx) => ({ index: idx, text: userParas[idx] }));

  // 删除的段落是否与保留段落高度重复（结构去重/删掉重复的大纲表等）
  const duplicatedDeleted = [];
  for (const del of deletedParagraphs) {
    let best = 0;
    let bestUser = '';
    for (const para of userParas) {
      const s = similarity(del.text, para);
      if (s > best) { best = s; bestUser = para; }
    }
    if (best >= 0.6 && del.text.length >= 20) duplicatedDeleted.push({ text: del.text, sim: best, duplicateOf: bestUser });
  }

  return {
    aiChars: aiNormalized.replace(/\s+/g, '').length,
    userChars: userNormalized.replace(/\s+/g, '').length,
    aiParagraphs: aiParas.length,
    userParagraphs: userParas.length,
    matchedPairs: alignment.pairs.length,
    identicalParagraphs: identical,
    modifiedParagraphs: modified,
    deletedParagraphs: deletedParagraphs,
    insertedParagraphs: insertedParagraphs,
    duplicatedDeleted: duplicatedDeleted,
    paragraphEdits: paragraphEdits,
    spans: changedSpans,
    stats: {
      totalSpans: changedSpans.length,
      deletedChars: changedSpans.reduce((acc, s) => acc + s.del.length, 0),
      insertedChars: changedSpans.reduce((acc, s) => acc + s.ins.length, 0),
      deletedParagraphs: deletedParagraphs.length,
      insertedParagraphs: insertedParagraphs.length,
      duplicatedDeletedParagraphs: duplicatedDeleted.length
    }
  };
}

/** 找到 span 在段落里的句子序号（展示用）。 */
export function sentenceIndexOfSpan(paragraphText, offset) {
  const sentences = splitSentences(paragraphText);
  for (let i = 0; i < sentences.length; i += 1) {
    if (offset >= sentences[i].start && offset < sentences[i].end) return i;
  }
  return sentences.length > 0 ? sentences.length - 1 : -1;
}
