/**
 * 学习引擎：从「AI 原稿 → 用户修订稿」的一对文本里提炼风格规则。
 *
 * 三类信号（参考 Misra et al., NeurIPS 2025 对 user-edits 的统一框架）：
 *   - 偏好信号：用户删掉的表达（banned_phrase）与整段删除（structural）；
 *   - 监督信号：用户改写出来的表达（rewrite / preferred_phrase / opening / closing / term）；
 *   - 奖励信号：文档级指标往哪边移动（metrics 区间更新）。
 *
 * 规则合并交给 profile.js 的 Beta 置信度；这里只负责「对齐 → 信号 → 候选」。
 */

import { AI_PATTERNS, AI_STRONG_PHRASES, GENRES } from './constants.js';
import { COMPARABLE_METRICS, computeMetrics, metricDeltas, normalizeText, similarity } from './features.js';
import { diffDocuments } from './diff.js';
import { capRules, mergeProposal, normalizePhrase, updateMetricTargets } from './profile.js';

/** 没有信息量的短语，不进入规则库。 */
const STOP_PHRASES = new Set([
  '的是', '了的', '一个', '我们', '你们', '他们', '这个', '那个', '这些', '那些',
  '可以', '需要', '应该', '已经', '还是', '就是', '因为', '所以', '但是', '如果',
  '然后', '以及', '还有', '没有', '不是', '这种', '那种', '一下', '一些', '一点',
  '什么', '怎么', '这里', '那里', '方面', '问题', '情况', '时候', '过程', '结果'
]);

const CHAT_STOP = new Set([
  '你好', '您好', '谢谢', '多谢', '可以', '好的', '收到', '明白', '了解', '知道', '没问题',
  '是的', '对的', '不错', '辛苦了', '继续', '开始', '执行', '直接做', '别问了', '不用了',
  '好的好的', '那就这样', '先这样', '我看看', '看看再说'
]);

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return value.slice(0, Math.max(1, max - 1)) + '…';
}

/** 是否是有意义的规则文本。 */
function isMeaningful(text) {
  const t = normalizePhrase(text);
  if (t.length < 2) return false;
  if (/^[\d\s.%()（）\-—–+:：;；,，。！？、]+$/.test(t)) return false;
  if (STOP_PHRASES.has(t)) return false;
  if (/^(的|了|着|过|吗|呢|吧|啊)+$/.test(t)) return false;
  return true;
}

/** 按中文标点拆成短句/短语。 */
export function splitClauses(text) {
  return String(text || '')
    .split(/[。！？；，、,;!?\n\r]+/)
    .map((item) => normalizePhrase(item))
    .filter((item) => item.length > 0);
}

/** 判断文本里是否命中 AI 标记（用于整段删除的解释性判断）。 */
function aiMarkerHits(text) {
  let hits = 0;
  for (const entry of AI_STRONG_PHRASES) {
    if (text.includes(entry.p)) hits += 1;
  }
  for (const pattern of AI_PATTERNS) {
    try { if (pattern.re.test(text)) hits += 1; } catch { /* ignore */ }
    try { pattern.re.lastIndex = 0; } catch { /* ignore */ }
  }
  return hits;
}

/** 含数字/英文字母的短语更可能是内容细节而不是语言习惯，默认不进风格规则。 */
function hasContentNoise(text) {
  return /[0-9A-Za-z]/.test(String(text || ''));
}

/** Markdown 标记/表格符号/句读碎片不算语言习惯。 */
function hasMarkupNoise(text) {
  const value = String(text || '');
  if (/[#*>|\[\]{}]/.test(value)) return true;
  if (value.indexOf(String.fromCharCode(96)) >= 0) return true;
  if (/[。！？；!?]/.test(value)) return true;
  return false;
}

/** 短碎片（<=5 字）必须有虚词/指代词才像语言习惯。 */
function shortPhraseLooksReal(text) {
  const value = String(text || '');
  if (value.length > 5) return true;
  return /[这那其也就都还又很太更最把被给让对从向吗呢吧啊]/.test(value);
}

/** 片段开头：以这些字开头的短词多半是被 diff 切开的半个词，不是语言习惯。 */
const FRAGMENT_START = /^[的地得个]/;
const CONNECTIVE_START = /^[而但同因所然接并]/

/** 是否像一条可复用的风格规则（而不是内容细节或 diff 碎片）。 */
function looksLikeStylePhrase(text, maxLen) {
  const value = String(text || '').trim();
  if (value.length < 2 || value.length > maxLen) return false;
  if (FRAGMENT_START.test(value)) return false;
  if (value.length <= 4 && CONNECTIVE_START.test(value)) {
    const whitelist = ['而且', '但是', '因为', '所以', '然后', '接着', '不过', '并且', '同时'];
    if (whitelist.indexOf(value) === -1) return false;
  }
  return true;
}

/** 从段落里取出包含 [start,end) 的子句（按中文标点切），返回 {text,start,end} 或 null。 */
function clauseAt(paragraphText, start, end) {
  const text = String(paragraphText || '');
  if (text.length === 0) return null;
  const from = Math.max(0, Math.min(text.length, Number(start) || 0));
  const to = Math.max(from, Math.min(text.length, Number(end) || from));
  const boundary = /[。！？；，、,.;!?\n\r]/;
  let left = from;
  while (left > 0 && !boundary.test(text[left - 1])) left -= 1;
  let right = to;
  while (right < text.length && !boundary.test(text[right])) right += 1;
  const value = text.slice(left, right).trim();
  if (value.length === 0) return null;
  return { text: value, start: left, end: right };
}

/** 短语长度 → 证据可信度（单对样本时区分强弱证据）。 */
function styleTrust(length) {
  if (length >= 8) return 1.0;
  if (length >= 5) return 0.8;
  return 0.5;
}

function buildAnchor(span) {
  const before = clip(span.contextBefore || '', 18);
  const del = clip(span.del || '', 24);
  const ins = clip(span.ins || '', 24);
  const after = clip(span.contextAfter || '', 12);
  if (del && ins) return before + '【' + del + '→' + ins + '】' + after;
  if (del) return before + '【' + del + '】' + after;
  return before + '【' + ins + '】' + after;
}

function positionKind(span) {
  const paragraph = String(span.userParagraphText || '');
  const value = normalizePhrase(span.ins || '');
  if (!paragraph || !value) return 'body';
  const index = paragraph.indexOf(value);
  if (index === -1) return 'body';
  const ratio = index / Math.max(1, paragraph.length);
  if (ratio <= 0.12) return 'opening';
  if (ratio >= 0.88) return 'closing';
  return 'body';
}

/** 收集候选规则（一次修订对）。 */
export function analyzeRevisionPair(input) {
  const originalText = normalizeText(input.originalText || '');
  const revisedText = normalizeText(input.revisedText || '');
  const config = input.config || {};
  const minSpan = (config.learn && config.learn.minSpanChars) || 3;
  const maxProposals = 240;

  const diff = diffDocuments(originalText, revisedText);
  const aiMetrics = computeMetrics(originalText);
  const userMetrics = computeMetrics(revisedText);
  const deltas = metricDeltas(aiMetrics, userMetrics);

  const proposals = [];
  const byKey = new Map();
  function propose(proposal) {
    if (proposals.length >= maxProposals) return;
    const key = proposal.type + '|' + normalizePhrase(proposal.text) + '|' + normalizePhrase(proposal.to || '');
    const existing = byKey.get(key);
    if (existing !== undefined) {
      if (existing.hits < 3) existing.hits += 1;
      return;
    }
    const entry = Object.assign({ hits: 1 }, proposal);
    byKey.set(key, entry);
    proposals.push(entry);
  }

  for (const span of diff.spans) {
    const del = normalizePhrase(span.del);
    const ins = normalizePhrase(span.ins);
    const anchor = buildAnchor(span);
    // 碎片改动（两侧都不在子句边界上）不作为语言习惯证据
    const atBoundary = span.clauseStart === true || span.clauseEnd === true;
    if (!atBoundary && (del.length + ins.length) < 10) continue;

    if (del && !ins && del.length <= 2 && span.aiParagraphText && span.userParagraphText) {
      const aiClause = clauseAt(span.aiParagraphText, span.aiStart, span.aiEnd);
      const userClause = clauseAt(span.userParagraphText, span.userStart, span.userEnd);
      if (aiClause && userClause && aiClause.text !== userClause.text
        && !hasMarkupNoise(aiClause.text) && !hasMarkupNoise(userClause.text)
        && looksLikeStylePhrase(aiClause.text, 30) && looksLikeStylePhrase(userClause.text, 30)) {
        propose({
          type: 'rewrite',
          text: aiClause.text,
          to: userClause.text,
          evidence: 1,
          trust: 0.9,
          why: '你把“' + clip(aiClause.text, 14) + '”改成了“' + clip(userClause.text, 14) + '”',
          fix: '按你的改法来',
          anchor: anchor
        });
        continue;
      }
    }
    if (del && !ins) {
      const clauses = splitClauses(del);
      for (const clause of clauses.slice(0, 8)) {
        if (clause.length < 4 || clause.length > 30) continue;
        if (hasContentNoise(clause)) continue;
        if (!looksLikeStylePhrase(clause, 24)) continue;
        if (/[。！？；!?]/.test(clause)) continue;
        if (clause.length <= 5 && !/[这那其也就都还又很太更最把被给让对从向于的了是在和与及]/.test(clause)) continue;
        const keptElsewhere = revisedText.includes(clause);
        const weak = clause.length > 16;
        propose({
          type: 'banned_phrase',
          text: clip(clause, 30),
          evidence: keptElsewhere ? -1 : 1,
          trust: weak ? 0.2 : styleTrust(clause.length),
          why: keptElsewhere
            ? '你删掉了这处“' + clip(clause, 16) + '”，但别处还保留，先记为待观察'
            : '你改稿时删掉了“' + clip(clause, 18) + '”，说明这种表达你不想要',
          fix: '不要再用这种表达，按你改后的写法来',
          anchor: anchor
        });
      }
      if (del.length >= 14 && clauses.length === 1 && aiMarkerHits(del) > 0) {
        propose({
          type: 'structural',
          text: '删掉元叙述/解释性补白（例如“' + clip(del, 20) + '…”这类）',
          evidence: 1,
          trust: 1.0,
          why: '你删掉的整句里带 AI 套话标记，说明这类交代你不需要',
          fix: '不要替读者解释已知事实，直接进入内容',
          anchor: anchor
        });
      }
    } else if (ins && !del) {
      const clauses = splitClauses(ins);
      for (const clause of clauses.slice(0, 8)) {
        if (clause.length < 2 || clause.length > 30) continue;
        if (hasContentNoise(clause)) continue;
        if (!looksLikeStylePhrase(clause, clause.length <= 16 ? 16 : 16)) continue;
        if (originalText.includes(clause)) continue;
        const position = positionKind(span);
        let type = 'preferred_phrase';
        if (position === 'opening') type = 'opening';
        if (position === 'closing') type = 'closing';
        propose({
          type: type,
          text: clip(clause, 30),
          evidence: 1,
          trust: styleTrust(clause.length),
          why: '你在改稿时加了“' + clip(clause, 18) + '”，先当作你偏好的表达',
          fix: '',
          anchor: anchor
        });
      }
    } else if (del && ins) {
      const delClean = isMeaningful(del) && del.length <= 30 && !hasContentNoise(del) && looksLikeStylePhrase(del, del.length <= 16 ? 16 : 30);
      const insClean = isMeaningful(ins) && ins.length <= 30 && !hasContentNoise(ins) && looksLikeStylePhrase(ins, ins.length <= 16 ? 16 : 30);
      if (delClean && insClean) {
        const containment = del.includes(ins) || ins.includes(del);
        const aiMark = aiMarkerHits(del) > 0;
        if (!containment && !hasMarkupNoise(del) && !hasMarkupNoise(ins)) {
          const sim = similarity(del, ins);
          const shortPair = del.length <= 8 && ins.length <= 8;
          if (shortPair && sim < 0.4) {
            propose({
              type: 'rewrite',
              text: clip(del, 24),
              to: clip(ins, 24),
              evidence: 1,
              trust: sim >= 0.15 ? 0.8 : 0.55,
              why: '你把“' + clip(del, 12) + '”改成了“' + clip(ins, 12) + '”',
              fix: '按你的改法来，不要用原来那种写法',
              anchor: anchor
            });
          } else if (del.length <= 12 && ins.length <= 12 && sim >= 0.4) {
            propose({
              type: 'term',
              text: clip(del, 24),
              to: clip(ins, 24),
              evidence: 1,
              trust: 0.8,
              why: '你把术语“' + clip(del, 12) + '”统一成了“' + clip(ins, 12) + '”',
              fix: '统一用“' + clip(ins, 16) + '”',
              anchor: anchor
            });
          } else if (sim >= 0.15 || aiMark) {
            propose({
              type: 'rewrite',
              text: clip(del, 30),
              to: clip(ins, 30),
              evidence: 1,
              trust: sim >= 0.5 ? 0.6 : 1.0,
              why: '你把“' + clip(del, 16) + '”改写成“' + clip(ins, 16) + '”',
              fix: '按你的改法来，不要用原来那种写法',
              anchor: anchor
            });
          }
        }
      } else if (delClean && del.length >= 4 && !hasMarkupNoise(del) && shortPhraseLooksReal(del)) {
        propose({
          type: 'banned_phrase',
          text: clip(del, 30),
          evidence: 1,
          trust: 0.6,
          why: '你删掉了“' + clip(del, 18) + '”并换成更短的说法',
          fix: '删掉这类冗余表达',
          anchor: anchor
        });
      } else if (insClean && ins.length >= 4 && !hasMarkupNoise(ins) && shortPhraseLooksReal(ins)) {
        propose({
          type: 'preferred_phrase',
          text: clip(ins, 30),
          evidence: 1,
          trust: 0.6,
          why: '你把一句空话改成了“' + clip(ins, 18) + '”',
          fix: '',
          anchor: anchor
        });
      }
    }
  }

  // 结构信号：删掉与正文重复的段落（大纲表/目录/重复解释）
  if (diff.duplicatedDeleted.length > 0) {
    const examples = diff.duplicatedDeleted.slice(0, 2).map((item) => clip(item.text, 24)).join('；');
    propose({
      type: 'structural',
      text: '正文不要重复保留大纲/目录类内容',
      evidence: Math.min(3, diff.duplicatedDeleted.length),
      why: '你删掉了 ' + diff.duplicatedDeleted.length + ' 段与正文重复的内容（例如：' + examples + '）',
      fix: '交付时只留正文，不要再附一份重复的大纲',
      anchor: examples
    });
  }

  // 结构信号：整段删除且带 AI 标记 → 删掉铺陈/元叙述
  for (const deleted of diff.deletedParagraphs) {
    if (diff.duplicatedDeleted.some((item) => item.text === deleted.text)) continue;
    if (deleted.text.length < 30) continue;
    const markers = aiMarkerHits(deleted.text);
    if (markers > 0) {
      propose({
        type: 'structural',
        text: '删掉元叙述/铺陈段落（例如“' + clip(deleted.text, 20) + '…”）',
        evidence: 1,
        why: '你删掉的整段里有 ' + markers + ' 处 AI 套话标记，说明这类段落你不需要',
        fix: '直接从具体内容开始写，不要交代“我要讲什么”',
        anchor: clip(deleted.text, 40)
      });
    }
  }

  return {
    diff: diff,
    aiMetrics: aiMetrics,
    userMetrics: userMetrics,
    deltas: deltas,
    proposals: proposals,
    stats: {
      pairs: 1,
      edits: diff.stats.totalSpans,
      deletedChars: diff.stats.deletedChars,
      insertedChars: diff.stats.insertedChars,
      deletedParagraphs: diff.stats.deletedParagraphs,
      insertedParagraphs: diff.stats.insertedParagraphs,
      duplicatedDeletedParagraphs: diff.stats.duplicatedDeletedParagraphs,
      proposals: proposals.length
    }
  };
}

/** 把候选规则合并进档案，并更新指标区间。 */
export function applyLearning(input) {
  const profile = input.profile;
  const genre = GENRES.indexOf(input.genre) >= 0 ? input.genre : 'global';
  const analysis = input.analysis;
  const config = input.config || {};
  const added = [];
  const updated = [];
  const promoted = [];
  const seen = new Set();

  for (const proposal of analysis.proposals) {
    for (let hit = 0; hit < proposal.hits; hit += 1) {
      const result = mergeProposal(profile, genre, proposal, config);
      if (!result.rule) continue;
      const id = result.rule.id;
      if (result.created && !seen.has(id)) { added.push(result.rule); seen.add(id); }
      else if (!seen.has(id)) { updated.push(result.rule); seen.add(id); }
      if (result.promoted && promoted.indexOf(result.rule) === -1) promoted.push(result.rule);
    }
  }
  const metricKeys = COMPARABLE_METRICS.filter((key) => Number.isFinite(analysis.userMetrics[key]));
  const metricsUpdated = updateMetricTargets(profile, genre, analysis.userMetrics, { keys: metricKeys });

  profile.evidence = profile.evidence || { pairs: 0, edits: 0, learns: 0, lastLearnAt: null };
  profile.evidence.pairs = (Number(profile.evidence.pairs) || 0) + 1;
  profile.evidence.edits = (Number(profile.evidence.edits) || 0) + (analysis.stats.edits || 0);
  profile.evidence.learns = (Number(profile.evidence.learns) || 0) + 1;
  profile.evidence.lastLearnAt = new Date().toISOString();

  const maxRules = (config.learn && config.learn.maxRulesPerGenre) || 400;
  const removed = capRules(profile, genre, maxRules);
  return { added: added, updated: updated, promoted: promoted, removed: removed, metricsUpdated: metricsUpdated };
}

/** 学习报告（给工具输出与历史记录）。 */
export function buildLearnReport(analysis, applied, genre) {
  const top = analysis.proposals
    .slice()
    .sort((a, b) => (b.evidence === -1 ? 0 : 1) - (a.evidence === -1 ? 0 : 1) || (b.text.length - a.text.length))
    .slice(0, 12)
    .map((proposal) => ({
      type: proposal.type,
      text: proposal.text,
      to: proposal.to || undefined,
      evidence: proposal.evidence,
      hits: proposal.hits
    }));
  return {
    genre: genre,
    stats: analysis.stats,
    deltas: analysis.deltas,
    added: applied.added.length,
    updated: applied.updated.length,
    promoted: applied.promoted.length,
    removed: applied.removed,
    metrics_updated: applied.metricsUpdated.length,
    top_proposals: top
  };
}

/**
 * 聚合会话消息里的口语特征（只存特征；高频短语按用户要求保留原文）。
 * @param {string[]} messages 用户消息文本
 * @param {object} options {minPhraseFrequency,maxPhraseLen}
 */
export function aggregateChatMessages(messages, options) {
  const opts = options || {};
  const minFreq = Number(opts.minPhraseFrequency) || 3;
  const maxPhraseLen = Number(opts.maxPhraseLen) || 24;
  const texts = (Array.isArray(messages) ? messages : []).map((item) => normalizeText(item)).filter((item) => item.length > 0);
  if (texts.length === 0) return null;
  const joined = texts.join('\n');
  const metrics = computeMetrics(joined);
  const clauseCounts = new Map();
  for (const text of texts) {
    const clauses = splitClauses(text);
    for (const clause of clauses) {
      if (clause.length < 2 || clause.length > maxPhraseLen) continue;
      if (CHAT_STOP.has(clause)) continue;
      if (/^[\d\s.%()（）\-—–+:：;；,，。！？、]+$/.test(clause)) continue;
      clauseCounts.set(clause, (clauseCounts.get(clause) || 0) + 1);
    }
  }
  const phrases = [];
  for (const [text, count] of clauseCounts.entries()) {
    if (count >= minFreq) phrases.push({ text: text, count: count });
  }
  phrases.sort((a, b) => b.count - a.count);
  const pronouns = {
    wo: (joined.match(/我/g) || []).length,
    women: (joined.match(/我们/g) || []).length,
    ni: (joined.match(/你/g) || []).length,
    dajia: (joined.match(/大家/g) || []).length
  };
  return {
    messages: texts.length,
    chars: joined.replace(/\s+/g, '').length,
    metrics: metrics,
    pronouns: pronouns,
    phrases: phrases.slice(0, 30)
  };
}

/** 把口语特征并入 chat 文种档案。 */
export function mergeChatLearning(profile, aggregate, config) {
  if (!aggregate) return { added: 0 };
  const slot = profile.genres.chat;
  slot.stats = Object.assign({}, slot.stats, {
    messages: (Number(slot.stats && slot.stats.messages) || 0) + aggregate.messages,
    chars: (Number(slot.stats && slot.stats.chars) || 0) + aggregate.chars,
    pronouns: aggregate.pronouns,
    updatedAt: new Date().toISOString()
  });
  let added = 0;
  for (const phrase of aggregate.phrases) {
    const result = mergeProposal(profile, 'chat', {
      type: 'chat_phrase',
      text: phrase.text,
      evidence: 1,
      why: '你在会话里反复用“' + phrase.text + '”（' + phrase.count + ' 次）',
      fix: ''
    }, config);
    if (result.created) added += 1;
  }
  return { added: added };
}
