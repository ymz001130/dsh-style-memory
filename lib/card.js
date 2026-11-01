/**
 * 画像卡：把风格档案压缩成 ≤400 字的注入文本。
 *
 * 0.2 起改为「抽象规则优先」：不再罗列用户改过的原句，避免模型把卡片当模板
 * 逐字照搬（盲测评审已证实这是可被识破的破绽）。只有极短的锚点与原句才保留。
 */

import { GENRE_LABELS } from './constants.js';
import { rulesFor, ruleScore } from './profile.js';

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return value.slice(0, Math.max(1, max - 1)) + '…';
}

/** 指标区间转成人话。 */
function metricLines(profile, genre) {
  const lines = [];
  const targets = Object.assign({}, (profile.genres.global && profile.genres.global.metrics) || {}, (profile.genres[genre] && profile.genres[genre].metrics) || {});
  const meanLen = targets.meanLen;
  if (meanLen) lines.push('句长多在 ' + Math.round(meanLen.lo) + '-' + Math.round(meanLen.hi) + ' 字');
  const shortRatio = targets.shortRatio;
  if (shortRatio && shortRatio.hi >= 0.08) lines.push('常插短句');
  const colon = targets.colonDensity;
  if (colon && colon.hi < 8) lines.push('少用冒号引出列表');
  const connective = targets.connectiveDensity;
  if (connective && connective.hi < 6) lines.push('少用此外/然而/因此这类连接词');
  const paraMean = targets.paragraphMean;
  if (paraMean && paraMean.lo > 60) lines.push('段落偏长，一段讲一件事');
  return lines;
}

const CATEGORY_DO_NOT = {
  meta: '不要写交代式元叙述（“值得注意的是”“需要说明的是”这类）',
  summary: '不要替读者总结（“综上所述”“总而言之”这类）',
  parallel: '少用递进排比和机械枚举（“不仅…而且”“首先其次最后”）',
  cliche: '删掉内容空洞的评价句（“具有重要意义”“提供参考”这类）',
  padding: '删掉解释性补白和过细的对照细节',
  rewrite: '把书面腔改成短句直说，不要照搬卡片里的示例'
};

const CATEGORY_ORDER = ['meta', 'summary', 'parallel', 'cliche', 'padding', 'rewrite'];

/** 给一条规则归类（用于抽象成更高层的写作要求）。 */
function categorizeRule(rule) {
  const text = String(rule.text || '');
  if (rule.type === 'banned_phrase') {
    if (/(值得注意的是|需要指出|需要说明|不可否认|毋庸置疑|众所周知|由此可见|不难发现|具体而言|具体来说|换言之|本章将|本节将|接下来)/.test(text)) return 'meta';
    if (/(综上所述|总而言之|总的来说|归根结底|一言以蔽之|简而言之|综上)/.test(text)) return 'summary';
    if (/(不仅|不只是|而且|更是|首先|其次|再次|最后|一方面|另一方面)/.test(text)) return 'parallel';
    if (/(具有.{0,6}(重要|关键|核心)|提供.{0,8}(参考|借鉴)|奠定|发挥.{0,6}作用|起到.{0,6}作用|至关重要|不可或缺)/.test(text)) return 'cliche';
    return text.length >= 10 ? 'padding' : 'short';
  }
  if (rule.type === 'rewrite') return 'rewrite';
  return rule.type;
}

/**
 * 生成完整画像卡（主代理用）。
 * @returns {string} 空档案返回空字符串
 */
export function buildCard(profile, genre, maxChars) {
  const limit = Number(maxChars) || 400;
  const activeGenre = genre && profile.genres[genre] ? genre : 'global';
  const rules = rulesFor(profile, activeGenre).filter((rule) => rule.status === 'active');
  if (rules.length === 0 && Object.keys(profile.genres[activeGenre].metrics || {}).length === 0) return '';
  const byScore = rules.slice().sort((a, b) => ruleScore(b) - ruleScore(a));

  const styleMarkers = /[这那其也就都还又很太更最把被给让对从向吗呢吧啊]/;
  const isStyleAnchored = (text) => styleMarkers.test(String(text || ''));
  const categories = new Set();
  const shortBans = [];
  const preferred = [];
  const structural = [];
  const openings = [];
  const closings = [];
  for (const rule of byScore) {
    const category = categorizeRule(rule);
    if (category === 'short') { if (rule.text.length <= 8 && isStyleAnchored(rule.text) && shortBans.length < 4) shortBans.push(rule.text); continue; }
    if (category === 'rewrite') {
      categories.add('rewrite');
      continue;
    }
    if (category === 'preferred_phrase') { if (rule.text.length <= 8 && preferred.length < 3) preferred.push(rule.text); continue; }
    if (category === 'structural') { if (structural.length < 2) structural.push(clip(rule.text, 30)); continue; }
    if (category === 'opening') { if (openings.length < 1) openings.push(clip(rule.text, 24)); continue; }
    if (category === 'closing') { if (closings.length < 1) closings.push(clip(rule.text, 24)); continue; }
    categories.add(category);
  }

  const lines = [];
  lines.push('【你的写作风格 v' + (profile.version || 0) + '·' + (GENRE_LABELS[activeGenre] || '通用') + '】');
  const metrics = metricLines(profile, activeGenre);
  if (metrics.length > 0) lines.push('节奏：' + metrics.join('；') + '。');
  for (const category of CATEGORY_ORDER) {
    if (!categories.has(category)) continue;
    lines.push(CATEGORY_DO_NOT[category] + '。');
  }
  if (shortBans.length > 0) lines.push('别用：' + shortBans.join('、') + '。');
  if (preferred.length > 0) lines.push('你惯用：' + preferred.join('、') + '。');
  const chatStats = profile.genres && profile.genres.chat && profile.genres.chat.stats;
  if (chatStats && Number(chatStats.messages) >= 5) lines.push('对话：句子偏短，直接给结论，少客套。');
  lines.push('多写具体场景、具体动作和具体数字，少写概括评价。');
  lines.push('结尾停在具体事上，不要金句收束。');
  if (structural.length > 0) lines.push('结构：' + structural.join('；') + '。');
  if (openings.length > 0) lines.push('开场：' + openings[0] + '。');
  if (closings.length > 0) lines.push('结尾：' + closings[0] + '。');

  let text = lines.join('\n');
  if (text.length > limit) {
    const kept = [];
    let length = 0;
    for (const line of lines) {
      if (length + line.length + 1 > limit) break;
      kept.push(line);
      length += line.length + 1;
    }
    text = kept.length > 1 ? kept.join('\n') : clip(text, limit);
  }
  return clip(text, limit);
}

/** 精简卡（子代理用）：只保留抽象要求与短禁令，≤200 字。 */
export function buildCompactCard(profile, genre, maxChars) {
  const limit = Number(maxChars) || 200;
  const activeGenre = genre && profile.genres[genre] ? genre : 'global';
  const rules = rulesFor(profile, activeGenre).filter((rule) => rule.status === 'active');
  if (rules.length === 0) return '';
  const styleMarkers = /[这那其也就都还又很太更最把被给让对从向吗呢吧啊]/;
  const isStyleAnchored = (text) => styleMarkers.test(String(text || ''));
  const categories = new Set();
  const shortBans = [];
  for (const rule of rules.slice().sort((a, b) => ruleScore(b) - ruleScore(a))) {
    const category = categorizeRule(rule);
    if (category === 'short') { if (rule.text.length <= 8 && isStyleAnchored(rule.text) && shortBans.length < 5) shortBans.push(rule.text); continue; }
    if (category === 'preferred_phrase' || category === 'structural' || category === 'opening' || category === 'closing') continue;
    categories.add(category);
  }
  const lines = [];
  const metrics = metricLines(profile, activeGenre);
  if (metrics.length > 0) lines.push('节奏：' + metrics.slice(0, 2).join('；'));
  for (const category of CATEGORY_ORDER) {
    if (!categories.has(category)) continue;
    lines.push(CATEGORY_DO_NOT[category]);
    if (lines.length >= 4) break;
  }
  if (shortBans.length > 0) lines.push('别用：' + shortBans.join('、'));
  return clip(lines.join('\n'), limit);
}

/** 列出可读规则（/style profile 或 style_profile rules 用）。 */
export function renderRuleList(profile, genre, options) {
  const opts = options || {};
  const limit = Number(opts.limit) || 40;
  const activeGenre = genre && profile.genres[genre] ? genre : 'global';
  const rules = rulesFor(profile, activeGenre).sort((a, b) => ruleScore(b) - ruleScore(a)).slice(0, limit);
  if (rules.length === 0) return '（还没有学到任何规则：把 AI 原稿和你改过的版本交给 style_learn）';
  const typeLabels = {
    banned_phrase: '禁用表达', rewrite: '改写偏好', preferred_phrase: '偏好表达',
    structural: '结构习惯', opening: '开场习惯', closing: '结尾习惯', term: '术语偏好', chat_phrase: '口头表达', human_feature: '人味特征'
  };
  const lines = [];
  for (const rule of rules) {
    const status = rule.status === 'active' ? '' : '（待验证）';
    const evidence = '证据 ' + rule.pos + ' 次 · 置信 ' + Math.round((rule.confidence || 0) * 100) + '%';
    const label = typeLabels[rule.type] || rule.type;
    const body = rule.type === 'rewrite'
      ? '把「' + rule.text + '」改成「' + (rule.to || '') + '」'
      : (rule.type === 'term' ? '统一「' + rule.text + '」→「' + (rule.to || '') + '」' : rule.text);
    lines.push('- [' + label + '] ' + body + ' ' + status + ' · ' + evidence + (rule.anchor ? ' · 例：' + rule.anchor.slice(0, 40) : ''));
    if (lines.length >= limit) break;
  }
  return lines.join('\n');
}

/** 卡片预览（学习后返回给模型）。 */
export function cardPreview(profile, genre, maxChars) {
  return buildCard(profile, genre, maxChars || 400);
}
