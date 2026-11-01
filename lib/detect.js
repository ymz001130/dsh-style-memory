/**
 * 可解释的 AI 特征检测器（纯本地、无模型调用）。
 *
 * 三层特征 + 一层个人化：
 *   词汇层：AI 套话/元叙述/职场黑话/泛化引用 —— 强信号词条直接扣分；
 *   句法层：递进排比、机械枚举、视角套话、冒号列表、破折号链；
 *   语篇层：句长均匀度、段落均匀度、连接词密度、列表密度、排比密度；
 *   个人层：与用户学习档案的指标区间偏差 + 用户删过的表达再次出现。
 *
 * 打分采用集成方式（参考 texthumanize 的加权和/强信号/多数投票三路）：
 *   0.5 * 加权和 + 0.3 * 强信号 + 0.2 * 类别投票，再减去人味正向信号，
 *   加上个人基线偏差惩罚，最后截断到 0-100。
 */

import {
  AI_PATTERNS,
  AI_STRONG_PHRASES,
  AI_WEAK_PHRASES,
  HUMAN_FEATURES,
  METRIC_LABELS,
  SCORE_BANDS
} from './constants.js';
import { collectRegexHits, computeMetrics, perKilo, sentenceIndexAt, splitParagraphs, splitSentences } from './features.js';

/** 模板化词条（含“...”）转正则。 */
function phraseToRegExp(phrase) {
  if (phrase.indexOf('...') === -1) {
    return new RegExp(phrase.replace(/[.*+?^$()|[\]\\]/g, '\\$&'), 'g');
  }
  const parts = phrase.split('...').map((p) => p.replace(/[.*+?^$()|[\]\\]/g, '\\$&'));
  return new RegExp(parts.join('[^。！？；\\n]{0,30}'), 'g');
}

function sampleFor(hit, text, sentences) {
  const idx = sentenceIndexAt(sentences, hit.start);
  const sentence = idx >= 0 ? sentences[idx].text : '';
  return {
    text: hit.text,
    sentenceIndex: idx,
    sentence: sentence.length > 80 ? sentence.slice(0, 80) + '…' : sentence
  };
}

function pushIssue(issues, issue) {
  issues.push(issue);
}

function severityWeight(severity) {
  if (severity === 'high') return 1.6;
  if (severity === 'medium') return 1.1;
  return 0.7;
}

/** 对学习档案里的规则做命中检测。 */
function checkPersonalRules(text, sentences, profile, genre) {
  const hits = [];
  if (!profile) return hits;
  const genres = ['global', genre];
  const seen = new Set();
  for (const g of genres) {
    if (!g || seen.has(g)) continue;
    seen.add(g);
    const slot = profile.genres && profile.genres[g];
    if (!slot || !Array.isArray(slot.rules)) continue;
    for (const rule of slot.rules) {
      if (!rule || rule.status !== 'active') continue;
      if (rule.type !== 'banned_phrase' && rule.type !== 'rewrite' && rule.type !== 'banned_pattern') continue;
      const conf = Number(rule.confidence) || 0.5;
      if (conf < 0.5) continue;
      const ruleText = String(rule.text || '');
      if (ruleText.length < 2 || ruleText.length > 30) continue;
      if (ruleText.includes('…')) continue;
      if (/[0-9A-Za-z]/.test(ruleText) && rule.type !== 'reward') continue;
      if (rule.type === 'rewrite') {
        const toText = String(rule.to || '');
        if (!/[这那其也就都还又很太更最把被给让对从向吗呢吧啊有没]/.test(ruleText + toText)) continue;
      }
      let re;
      try { re = phraseToRegExp(ruleText); } catch { continue; }
      let matched = collectRegexHits(text, re);
      if (rule.type === 'rewrite' && rule.to) {
        matched = matched.filter((hit) => {
          const from = Math.max(0, hit.start - 40);
          const to = Math.min(text.length, hit.end + 40);
          return text.slice(from, to).indexOf(rule.to) === -1;
        });
      }
      if (matched.length === 0) continue;
      hits.push({
        ruleId: rule.id,
        type: rule.type,
        text: rule.text,
        genre: g,
        confidence: conf,
        count: matched.length,
        samples: matched.slice(0, 3).map((hit) => sampleFor(hit, text, sentences)),
        why: rule.why || ('你的档案里记录过：你改稿时删掉/改写了“' + rule.text + '”这类表达'),
        fix: rule.fix || ('换成你自己的说法，不要再用“' + rule.text + '”')
      });
    }
  }
  return hits;
}

/** 计算与个人指标基线的偏差惩罚（0-22 分）。 */
function personalDeviation(metrics, profile, genre) {
  const result = { penalty: 0, details: [] };
  if (!profile) return result;
  const genreMetrics = profile.genres && profile.genres[genre] ? profile.genres[genre].metrics : null;
  const globalMetrics = profile.genres && profile.genres.global ? profile.genres.global.metrics : null;
  const targets = (genreMetrics && Object.keys(genreMetrics).length > 0)
    ? genreMetrics
    : (globalMetrics && Object.keys(globalMetrics).length > 0 ? globalMetrics : null);
  if (targets === null) return result;
  let total = 0;
  for (const key of Object.keys(targets)) {
    const target = targets[key];
    if (!target || !Number.isFinite(target.lo) || !Number.isFinite(target.hi)) continue;
    const value = metrics[key];
    if (!Number.isFinite(value)) continue;
    let excess = 0;
    const width = Math.max(0.5, target.hi - target.lo);
    if (value < target.lo) excess = (target.lo - value) / width;
    else if (value > target.hi) excess = (value - target.hi) / width;
    if (excess <= 0) continue;
    const weight = Number(target.weight) || 1.0;
    const penalty = Math.min(1, excess) * 6 * weight;
    total += penalty;
    result.details.push({
      metric: key,
      label: METRIC_LABELS[key] || key,
      value: value,
      target: [target.lo, target.hi],
      penalty: Math.round(penalty * 10) / 10
    });
  }
  result.penalty = Math.min(22, Math.round(total * 10) / 10);
  result.details.sort((a, b) => b.penalty - a.penalty);
  return result;
}

/**
 * 严格版三项排比：三个短项、长度接近、以句号/分号收尾，且不是普通并列名词。
 * 命中一次按中等严重度计，避免把正常枚举误判为 AI 排比。
 */
function strictParallelIssues(text) {
  const issues = [];
  const re = /([^。！？；\n“”]{2,10})[，、]([^。！？；\n“”]{2,10})[，、]([^。！？；\n“”]{2,10})(。|；|！|？)/g;
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const items = [m[1], m[2], m[3]];
    if (items.some((item) => item.length < 2)) continue;
    const lens = items.map((item) => item.length);
    const spread = Math.max(...lens) - Math.min(...lens);
    if (spread > 4) continue;
    const verbish = items.filter((item) => /[的了是在和与及]/.test(item)).length;
    if (verbish < 2) continue;
    hits.push({ text: m[0], start: m.index, count: 1 });
    if (hits.length >= 400) break;
  }
  if (hits.length > 0) {
    issues.push({
      id: 'parallel-triplet',
      cat: 'parallel',
      label: '三项排比（工整三连）',
      severity: hits.length >= 3 ? 'high' : 'medium',
      count: hits.length,
      weight: 1.4 * Math.min(hits.length, 3),
      why: '出现 ' + hits.length + ' 处字数接近的三连排比，是 AI 模板句的典型节奏',
      fix: '每处只留最有分量的一项，其余改成短句或直接删掉',
      samples: hits.slice(0, 3).map((hit) => ({ text: hit.text.slice(0, 60) }))
    });
  }
  return issues;
}

/** 语篇层的均匀度与节奏问题。 */
function rhythmIssues(metrics) {
  const issues = [];
  if (metrics.sentences >= 8) {
    if (metrics.cv < 0.35) {
      pushIssue(issues, {
        id: 'uniform-sentence-rhythm',
        cat: 'rhythm',
        label: '句长过于均匀',
        severity: 'high',
        count: 1,
        weight: 2.2,
        why: '句长变异系数 ' + metrics.cv + '（<0.35），连续句子长度接近，是中文 AI 文本最强的统计特征',
        fix: '拆出 1-2 个十来个字的短句，并留一两个长句，让句长有起伏',
        samples: []
      });
    }
    if (metrics.shortRatio < 0.05 && metrics.meanLen > 22) {
      pushIssue(issues, {
        id: 'no-short-sentence',
        cat: 'rhythm',
        label: '几乎没有短句',
        severity: 'medium',
        count: 1,
        weight: 1.3,
        why: '全文短句（≤12 字）占比 ' + metrics.shortRatio + '，读起来缺少换气',
        fix: '每 200 字左右放一个短句，比如三五个字的断句',
        samples: []
      });
    }
    if (metrics.longRatio > 0.45 && metrics.meanLen > 32) {
      pushIssue(issues, {
        id: 'long-sentence-cluster',
        cat: 'rhythm',
        label: '长句扎堆',
        severity: 'medium',
        count: 1,
        weight: 1.1,
        why: '长句占比 ' + metrics.longRatio + '，平均句长 ' + metrics.meanLen + '，信息挤在一句里',
        fix: '把 40 字以上的句子拆成两三句，每句只讲一个动作或判断',
        samples: []
      });
    }
  }
  if (metrics.paragraphs >= 5) {
    if (metrics.paragraphCv < 0.3) {
      pushIssue(issues, {
        id: 'uniform-paragraphs',
        cat: 'rhythm',
        label: '段落长度过于均匀',
        severity: 'medium',
        count: 1,
        weight: 1.2,
        why: '段长变异系数 ' + metrics.paragraphCv + '，段落像流水线切出来的',
        fix: '有意写一两个短段，甚至一句话成段，打破均匀感',
        samples: []
      });
    }
  }
  return issues;
}

/**
 * 模板式节奏：每段固定塞一句短口号、段落长度几乎一致。
 * 这类「均匀感」是 AI 改写稿的高频破绽（盲测评审多次点名）。
 */
function templateRhythmIssues(text) {
  const issues = [];
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length < 4) return issues;
  const rows = paragraphs.map((paragraph) => {
    const sentences = splitSentences(paragraph);
    const shortCount = sentences.filter((sentence) => sentence.text.length <= 8).length;
    return { chars: paragraph.replace(/\s+/g, '').length, sentences: sentences.length, shortCount: shortCount };
  });
  const totalShort = rows.reduce((acc, row) => acc + row.shortCount, 0);
  const paragraphsWithSlogan = rows.filter((row) => row.shortCount >= 1 && row.shortCount <= 2).length;
  if (totalShort >= 3 && paragraphsWithSlogan / rows.length >= 0.6) {
    issues.push({
      id: 'template-slogans',
      cat: 'rhythm',
      label: '模板式短句：每段固定塞短口号',
      severity: 'high',
      count: totalShort,
      weight: 1.8,
      why: '共 ' + totalShort + ' 句超短句，且 ' + paragraphsWithSlogan + '/' + rows.length + ' 段都是「每段一两句」，分布过于均匀，像按模板插进去的',
      fix: '短句只放在自然停顿处（换话题、下判断、举例之后）；不要每段都凑一句口号',
      samples: []
    });
  }
  // 每段句数完全一致：比段长均匀更像模板
  const sentenceCounts = rows.map((row) => row.sentences);
  const modeCount = sentenceCounts.slice().sort((a, b) => sentenceCounts.filter((value) => value === b).length - sentenceCounts.filter((value) => value === a).length)[0];
  const sameSentenceCount = sentenceCounts.filter((value) => value === modeCount).length;
  if (rows.length >= 4 && sameSentenceCount / rows.length >= 0.8 && modeCount >= 2) {
    issues.push({
      id: 'uniform-sentence-count',
      cat: 'rhythm',
      label: '每段句数几乎一致',
      severity: 'high',
      count: sameSentenceCount,
      weight: 1.6,
      why: sameSentenceCount + '/' + rows.length + ' 段都是 ' + modeCount + ' 句，段落结构像复制粘贴',
      fix: '允许有的段只写一两句，有的段连续展开；不要每段都凑成同样句数',
      samples: []
    });
  }
  const lengths = rows.map((row) => row.chars);
  const mean = lengths.reduce((acc, value) => acc + value, 0) / lengths.length;
  const variance = lengths.reduce((acc, value) => acc + (value - mean) * (value - mean), 0) / lengths.length;
  const std = Math.sqrt(variance);
  const cv = mean > 0 ? std / mean : 0;
  if (rows.length >= 5 && mean >= 80 && cv < 0.12) {
    issues.push({
      id: 'paragraphs-too-even',
      cat: 'rhythm',
      label: '段落长度几乎一致',
      severity: 'high',
      count: 1,
      weight: 1.6,
      why: '各段字数 ' + lengths.map((value) => Math.round(value)).join('/') + '，变异系数仅 ' + Math.round(cv * 100) + '%，段落像同一个模板切出来的',
      fix: '让段落长短有起伏：有的段两三句就收，有的段展开讲一件事',
      samples: []
    });
  }
  return issues;
}

/**
 * 段末金句化：多段都以短判断句收尾，像每段都憋一句金句。
 * 这是注入风格卡后最容易出现的「过度像」破绽。
 */
function aphorismEndingIssues(text) {
  const issues = [];
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length < 3) return issues;
  const hits = [];
  for (const paragraph of paragraphs) {
    const sentences = splitSentences(paragraph);
    if (sentences.length === 0) continue;
    const last = sentences[sentences.length - 1].text;
    if (last.length < 6 || last.length > 16) continue;
    if (!/[。！？]$/.test(last)) continue;
    if (!/(就是|不是|才是|别|不要|要|才|都|说到底|真正的|更|不能)/.test(last)) continue;
    hits.push(last);
  }
  if (hits.length >= 2 && hits.length / paragraphs.length >= 0.4) {
    issues.push({
      id: 'aphorism-endings',
      cat: 'rhythm',
      label: '段末金句化',
      severity: 'high',
      count: hits.length,
      weight: 1.6,
      why: hits.length + '/' + paragraphs.length + ' 段都以短判断句收尾（如“' + hits.slice(0, 2).map((item) => item.slice(0, 14)).join('”“') + '”），像每段都憋一句金句',
      fix: '删掉段末评价句，停在前一句的事实或动作上',
      samples: hits.slice(0, 3).map((item) => ({ text: item }))
    });
  }
  return issues;
}

/** 过度规整：连接词几乎为零 + 句长控制过匀 + 短句比例机械。 */
function overfitIssues(metrics) {
  const issues = [];
  if (metrics.sentences < 10) return issues;
  if (metrics.connectiveDensity >= 1) return issues;
  if (metrics.cv >= 0.45) return issues;
  if (metrics.shortRatio < 0.1 || metrics.shortRatio > 0.4) return issues;
  issues.push({
    id: 'overfit-regularity',
    cat: 'rhythm',
    label: '过度规整：连接词为零、句长控制过匀',
    severity: 'medium',
    count: 1,
    weight: 1.2,
    why: '全文连接词密度 ' + metrics.connectiveDensity + '/千字，句长变异系数 ' + metrics.cv + '，短句比例 ' + metrics.shortRatio + '，像按规则刻意调过节奏',
    fix: '允许句子忽长忽短，偶尔用口语连接词把话说得松一点',
    samples: []
  });
  return issues;
}

/** 密度类问题（低于人工判断阈值时不报）。 */
function densityIssues(metrics) {
  const issues = [];
  const checks = [
    { id: 'colon-density', label: '冒号偏多', metric: 'colonDensity', threshold: 11, weight: 1.0, why: '冒号密度 ' + metrics.colonDensity + '/千字，AI 爱用冒号引出列表或解释', fix: '把冒号改成句号或逗号，剩下的改成自然叙述' },
    { id: 'connective-density', label: '显性连接词偏多', metric: 'connectiveDensity', threshold: 7, weight: 0.9, why: '连接词密度 ' + metrics.connectiveDensity + '/千字，句间靠连接词硬接', fix: '删掉“此外/然而/因此”，让下一句承接上一句的语义' },
    { id: 'list-density', label: '列表化明显', metric: 'listMarkerDensity', threshold: 5, weight: 1.0, why: '列表标记密度 ' + metrics.listMarkerDensity + '/千字，正文被拆成条目', fix: '把不必要并列的条目写回正常段落' },
    { id: 'parallel-density', label: '三项排比偏多', metric: 'parallelTriplets', threshold: 2.0, weight: 1.2, why: '三项排比密度 ' + metrics.parallelTriplets + '/千字，工整三连是 AI 模板', fix: '留一项最有力的，其余删掉或改成短句' },
    { id: 'dash-density', label: '破折号偏多', metric: 'dashDensity', threshold: 4, weight: 0.7, why: '破折号密度 ' + metrics.dashDensity + '/千字，连续破折号是 AI 标点签名', fix: '改成逗号断句' }
  ];
  for (const check of checks) {
    const value = metrics[check.metric];
    if (!Number.isFinite(value) || value <= check.threshold) continue;
    const over = value / check.threshold;
    pushIssue(issues, {
      id: check.id,
      cat: 'density',
      label: check.label,
      severity: over >= 1.8 ? 'high' : 'medium',
      count: 1,
      weight: check.weight * Math.min(2.2, over),
      why: check.why,
      fix: check.fix,
      samples: []
    });
  }
  return issues;
}

/** 人味正向信号汇总。 */
function humanFeatureList(metrics) {
  const list = [];
  for (const feature of HUMAN_FEATURES) {
    if (feature.re === null) continue;
    const count = metrics.humanSignals[feature.id] || 0;
    if (count > 0) list.push({ id: feature.id, label: feature.label, count: count });
  }
  if (metrics.humanSignals.shortSentences > 0) {
    list.push({ id: 'short-sentence', label: '短句穿插', count: metrics.humanSignals.shortSentences });
  }
  return list;
}

/** 分数 → 档位。 */
export function bandOf(score) {
  for (const item of SCORE_BANDS) {
    if (score >= item.min) return { band: item.band, label: item.label };
  }
  return { band: 'human', label: '像人写的' };
}

/**
 * 分析文本。
 * @param {string} rawText
 * @param {object} options { profile, genre, config }
 * @returns {object}
 */
export function analyzeText(rawText, options) {
  const opts = options || {};
  const text = String(rawText || '');
  const metrics = computeMetrics(text);
  const sentences = splitSentences(text);
  const issues = [];
  const strongHits = [];

  // 1) 强信号词条
  for (const entry of AI_STRONG_PHRASES) {
    let re;
    try { re = phraseToRegExp(entry.p); } catch { continue; }
    const hits = collectRegexHits(text, re);
    if (hits.length === 0) continue;
    strongHits.push({ type: 'phrase', text: entry.p, count: hits.length });
    pushIssue(issues, {
      id: 'phrase:' + entry.p,
      cat: entry.cat,
      label: 'AI 套话“' + entry.p + '”',
      severity: entry.w >= 2 ? 'high' : 'medium',
      count: hits.length,
      weight: entry.w * Math.min(hits.length, 3) * 0.9,
      why: entry.why || '这类表达是 AI 腔的高频标记',
      fix: entry.fix || '删掉，换成具体陈述',
      samples: hits.slice(0, 3).map((hit) => sampleFor(hit, text, sentences))
    });
  }

  // 2) 句法模式
  for (const pattern of AI_PATTERNS) {
    let hits = [];
    try { hits = collectRegexHits(text, pattern.re); } catch { continue; }
    if (hits.length === 0) continue;
    if (pattern.severity === 'high') strongHits.push({ type: 'pattern', text: pattern.id, count: hits.length });
    pushIssue(issues, {
      id: 'pattern:' + pattern.id,
      cat: pattern.cat,
      label: pattern.why.length > 18 ? pattern.why.slice(0, 18) + '…' : pattern.why,
      severity: pattern.severity,
      count: hits.length,
      weight: pattern.w * Math.min(hits.length, 3),
      why: pattern.why,
      fix: pattern.fix,
      samples: hits.slice(0, 3).map((hit) => sampleFor(hit, text, sentences))
    });
  }

  // 3) 弱信号密度
  let weakPoints = 0;
  const weakCounts = [];
  for (const entry of AI_WEAK_PHRASES) {
    const count = collectRegexHits(text, phraseToRegExp(entry.p)).length;
    if (count === 0) continue;
    weakPoints += count * entry.w;
    weakCounts.push({ text: entry.p, count: count });
  }
  const weakDensity = perKilo(weakPoints, metrics.chars);
  if (weakDensity >= 6) {
    pushIssue(issues, {
      id: 'weak-phrase-density',
      cat: 'lexical',
      label: 'AI 高频虚词密度偏高',
      severity: weakDensity >= 12 ? 'high' : 'medium',
      count: weakCounts.length,
      weight: Math.min(3, weakDensity / 6),
      why: '“此外/然而/因此/显著/有助于”这类词密度 ' + round2(weakDensity) + '/千字，整体读感发飘',
      fix: '删掉一半连接词与强化词，只留必要的',
      samples: weakCounts.slice(0, 5).map((item) => ({ text: item.text, count: item.count }))
    });
  }

  // 4) 节奏与密度
  for (const issue of rhythmIssues(metrics)) issues.push(issue);
  for (const issue of densityIssues(metrics)) issues.push(issue);
  for (const issue of strictParallelIssues(text)) issues.push(issue);
  for (const issue of templateRhythmIssues(text)) issues.push(issue);
  for (const issue of aphorismEndingIssues(text)) issues.push(issue);
  for (const issue of overfitIssues(metrics)) issues.push(issue);

  // 5) 个人规则命中
  const ruleHits = checkPersonalRules(text, sentences, opts.profile, opts.genre);
  for (const hit of ruleHits) {
    pushIssue(issues, {
      id: 'rule:' + hit.ruleId,
      cat: 'personal',
      label: '命中你改稿时删过的表达',
      severity: 'high',
      count: hit.count,
      weight: 2.0 * hit.confidence * Math.min(hit.count, 3),
      why: hit.why,
      fix: hit.fix,
      samples: hit.samples
    });
  }
  const deviation = personalDeviation(metrics, opts.profile, opts.genre);
  const rhythmStrongIds = new Set(['uniform-sentence-rhythm', 'paragraphs-too-even', 'template-slogans', 'uniform-sentence-count']);
  const rhythmStrongHits = issues.filter((issue) => rhythmStrongIds.has(issue.id) && issue.severity === 'high').length;
  if (rhythmStrongHits > 0) {
    strongHits.push({ type: 'rhythm', text: 'template_rhythm', count: rhythmStrongHits });
  }
  if (ruleHits.length > 0) {
    const totalHits = ruleHits.reduce((acc, hit) => acc + hit.count, 0);
    strongHits.push({ type: 'personal_rule', text: 'learned_rules', count: totalHits });
  }

  // 6) 汇总打分
  issues.sort((a, b) => (severityWeight(b.severity) * b.weight) - (severityWeight(a.severity) * a.weight));
  const rawPoints = issues.reduce((acc, issue) => acc + Math.min(3, issue.weight * severityWeight(issue.severity)), 0);
  const weightedSum = Math.min(100, rawPoints * 9);
  let strongSignal = 0;
  for (const hit of strongHits) {
    const base = hit.type === 'phrase' ? 52 : (hit.type === 'personal_rule' ? 56 : (hit.type === 'rhythm' ? 50 : 46));
    strongSignal = Math.max(strongSignal, base + Math.min(40, (hit.count - 1) * 7));
  }
  const cats = new Set(issues.map((issue) => issue.cat));
  const vote = Math.min(100, cats.size * 14);
  const rawScore = 0.5 * weightedSum + 0.3 * strongSignal + 0.2 * vote;

  const humanList = humanFeatureList(metrics);
  const humanWeights = { colloquial: 1.4, modality: 1.0, 'first-person': 0.7, 'specific-number': 0.35, 'direct-quote': 0.5, example: 0.5, question: 0.25, dialect: 1.6, 'hedge-real': 0.5, narrative: 1.0, 'short-sentence': 0.35 };
  const humanBonus = Math.min(8, humanList.reduce((acc, item) => {
    const w = humanWeights[item.id] === undefined ? 0.5 : humanWeights[item.id];
    return acc + Math.min(2, item.count) * w;
  }, 0));
  const score = Math.max(0, Math.min(100, Math.round(rawScore - humanBonus + deviation.penalty)));
  const band = bandOf(score);

  const suggestions = [];
  const seenFix = new Set();
  for (const issue of issues) {
    if (seenFix.has(issue.fix)) continue;
    seenFix.add(issue.fix);
    suggestions.push(issue.fix);
    if (suggestions.length >= 6) break;
  }

  return {
    score: score,
    band: band.band,
    verdict: band.label,
    chars: metrics.chars,
    metrics: metrics,
    issues: issues,
    strongHits: strongHits,
    weakDensity: round2(weakDensity),
    humanFeatures: humanList,
    ruleHits: ruleHits,
    personalDeviation: deviation,
    suggestions: suggestions,
    profileUsed: opts.profile ? {
      version: opts.profile.version,
      genre: opts.genre || 'global',
      rules: countRules(opts.profile, opts.genre)
    } : null,
    thresholds: {
      gate: (opts.config && opts.config.gate && opts.config.gate.threshold) || 60
    }
  };
}

function countRules(profile, genre) {
  let n = 0;
  const seen = new Set();
  for (const g of ['global', genre]) {
    if (!g || seen.has(g)) continue;
    seen.add(g);
    const slot = profile.genres && profile.genres[g];
    if (slot && Array.isArray(slot.rules)) n += slot.rules.filter((rule) => rule.status !== 'archived').length;
  }
  return n;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/** 只保留摘要字段，给工具输出用（避免把 metrics 全量塞给模型）。 */
export function summarizeAnalysis(result, detail) {
  const base = {
    score: result.score,
    band: result.band,
    verdict: result.verdict,
    chars: result.chars,
    top_issues: result.issues.slice(0, 8).map((issue) => ({
      category: issue.cat,
      label: issue.label,
      severity: issue.severity,
      count: issue.count,
      why: issue.why,
      fix: issue.fix,
      samples: issue.samples.slice(0, 2)
    })),
    human_features: result.humanFeatures.slice(0, 8),
    rule_hits: result.ruleHits.map((hit) => ({ text: hit.text, count: hit.count, confidence: hit.confidence })),
    suggestions: result.suggestions,
    profile: result.profileUsed
  };
  if (detail === 'full') {
    base.metrics = result.metrics;
    base.all_issues = result.issues.map((issue) => ({
      id: issue.id, category: issue.cat, label: issue.label, severity: issue.severity,
      count: issue.count, why: issue.why, fix: issue.fix, samples: issue.samples
    }));
    base.personal_deviation = result.personalDeviation;
    base.strong_hits = result.strongHits;
  }
  return base;
}
