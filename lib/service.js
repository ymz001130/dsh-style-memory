/**
 * 插件的高层业务：检测输入、学习修订对、快照捕获、自动配对、口语学习、
 * 快照清理（清理前先整合）、present 门禁状态封装、状态与档案操作。
 *
 * index.js 只做 DSH 接线（工具/命令/提示段/hook），把操作都委托到这里，
 * 便于单元测试直接调用而不依赖 Cordis。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { GENRES } from './constants.js';
import { analyzeText, summarizeAnalysis } from './detect.js';
import { analyzeRevisionPair, applyLearning, buildLearnReport, aggregateChatMessages, mergeChatLearning } from './learn.js';
import { buildCard, buildCompactCard, renderRuleList } from './card.js';
import {
  commitProfile, exportProfileData, importProfileData, loadProfile, profileStats,
  resetProfileData, ruleScore, rulesFor, undoProfile
} from './profile.js';
import { consolidateLocal, consolidateWithModelDetailed } from './llm-consolidate.js';
import { evaluatePresent } from './gate.js';
import { extractTextFromFile, isSupportedDoc } from './textio.js';
import {
  audit, bestMatchingSnapshot, deleteSnapshots, dueForCleanup, guessGenre, hashText,
  listHistory, listSnapshots, loadConfig, readHistory, readSnapshotText, recordHistory,
  saveSnapshot, snapshotsForPath, stateDir
} from './store.js';
import { agentState } from './state.js';

/* ------------------------------------------------------------------ */
/* 路径与档案缓存                                                       */
/* ------------------------------------------------------------------ */

export function resolveCwd(agent) {
  try {
    const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd;
    if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  } catch { /* ignore */ }
  try {
    const cwd = agent && agent.session && agent.session.cwd;
    if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  } catch { /* ignore */ }
  return process.cwd();
}

export function resolveUserPath(raw, cwd) {
  const text = String(raw || '').trim();
  if (text.length === 0) return '';
  return isAbsolute(text) ? text : resolve(cwd || process.cwd(), text);
}

let profileCache = { dir: '', profile: null, stamp: '' };

function profileFileStamp(dir) {
  const file = resolve(dir, 'profile.json');
  try {
    const info = statSync(file);
    return String(info.mtimeMs) + ':' + String(info.size);
  } catch {
    return 'missing';
  }
}

/** 读取档案（带 mtime 缓存）。 */
export function getProfile(dir) {
  const target = dir || stateDir();
  const stamp = profileFileStamp(target);
  if (profileCache.dir === target && profileCache.stamp === stamp && profileCache.profile !== null) return profileCache.profile;
  const profile = loadProfile(target);
  profileCache = { dir: target, profile: profile, stamp: stamp };
  return profile;
}

/** 档案变化后使缓存失效。 */
export function invalidateProfile() {
  profileCache = { dir: '', profile: null, stamp: '' };
}

/* ------------------------------------------------------------------ */
/* 分析                                                                */
/* ------------------------------------------------------------------ */

/**
 * 分析文本或文件。
 * @returns {{ ok: boolean, result?: object, summary?: object, error?: string, path?: string }}
 */
export function analyzeInput(input) {
  const config = input.config || loadConfig(input.dir);
  const cwd = input.cwd || process.cwd();
  let text = typeof input.text === 'string' ? input.text : '';
  let path = '';
  if ((!text || text.trim().length === 0) && input.path) {
    path = resolveUserPath(input.path, cwd);
    const extracted = extractTextFromFile(path);
    if (!extracted.ok) return { ok: false, path: path, error: extracted.error };
    text = extracted.text;
  }
  if (!text || text.trim().length === 0) return { ok: false, error: '缺少 text 或 path 参数' };
  if (text.length > 400000) return { ok: false, error: '文本过长（超过 40 万字符），请分段分析' };
  const genre = GENRES.indexOf(input.genre) >= 0 ? input.genre : (path ? guessGenre(path) : 'global');
  const profile = getProfile(input.dir);
  const result = analyzeText(text, { profile: profile, genre: genre, config: config });
  const summary = summarizeAnalysis(result, input.detail === 'full' ? 'full' : 'summary');
  summary.genre = genre;
  summary.path = path || undefined;
  return { ok: true, result: result, summary: summary, path: path, genre: genre };
}

/* ------------------------------------------------------------------ */
/* 学习                                                                */
/* ------------------------------------------------------------------ */

function pickString(input, names) {
  for (const name of names) {
    if (typeof input[name] === 'string' && input[name].trim().length > 0) return input[name];
  }
  return '';
}

function extractInputText(input, role) {
  const textValue = pickString(input, [role + '_text', role + 'Text']);
  const pathValue = pickString(input, [role + '_path', role + 'Path']);
  if (textValue.length > 0) return { ok: true, text: textValue, path: '' };
  if (pathValue.length > 0) {
    const path = resolveUserPath(pathValue, input.cwd);
    const extracted = extractTextFromFile(path);
    if (!extracted.ok) return { ok: false, error: '读取 ' + role + ' 失败：' + extracted.error, path: path };
    return { ok: true, text: extracted.text, path: path };
  }
  return { ok: false, error: '缺少 ' + role + 'Text/' + role + '_text 或 ' + role + 'Path/' + role + '_path' };
}

/**
 * 从一对文本（或文件）学习。
 * 若没给 original 但有 revisedPath，会尝试用快照自动找 AI 原稿。
 */
export function learnFromInputs(input) {
  const config = input.config || loadConfig(input.dir);
  const cwd = input.cwd || process.cwd();
  if (config.enabled === false) return { ok: false, error: '风格记忆已停用（/style on 恢复）' };
  const revised = extractInputText(input, 'revised');
  if (!revised.ok) return { ok: false, error: revised.error };
  let original = extractInputText(input, 'original');
  let originalSource = 'explicit';
  if (!original.ok) {
    if (revised.path) {
      const matched = locateOriginalForFile(input.dir, revised.path, revised.text, config);
      if (matched !== null) {
        original = { ok: true, text: matched.text, path: matched.path };
        originalSource = matched.source;
      }
    }
    if (!original.ok) {
      return {
        ok: false,
        error: '找不到 AI 原稿：请提供 original_path/original_text；或者先让 DSH 交付过这份文档（插件会在 present 时自动存快照），再把你改过的版本交回来。'
      };
    }
  }
  const maxChars = (config.learn && config.learn.maxTextChars) || 200000;
  if (original.text.length > maxChars || revised.text.length > maxChars) {
    return { ok: false, error: '文本超过学习上限（' + maxChars + ' 字符），请分段学习' };
  }
  if (original.text === revised.text) return { ok: false, error: '原稿与修订稿完全相同，没有可学习的改动' };
  const genre = GENRES.indexOf(input.genre) >= 0
    ? input.genre
    : (revised.path ? guessGenre(revised.path) : (original.path ? guessGenre(original.path) : 'global'));
  const profile = getProfile(input.dir);
  const analysis = analyzeRevisionPair({ originalText: original.text, revisedText: revised.text, config: config });
  if (analysis.stats.edits === 0) return { ok: false, error: '两份文本没有可分析的差异（对齐后没有编辑操作）' };
  const applied = applyLearning({ profile: profile, genre: genre, analysis: analysis, config: config });
  const committed = commitProfile(input.dir, profile, {
    action: 'learn',
    source: originalSource + ':' + (revised.path || 'text'),
    summary: 'learn pair => ' + genre + ', +' + applied.added.length + ' rules'
  });
  invalidateProfile();
  const report = buildLearnReport(analysis, applied, genre);
  const card = buildCard(profile, genre, (config.inject && config.inject.maxChars) || 400);
  const compact = buildCompactCard(profile, genre, (config.inject && config.inject.subagentMaxChars) || 200);
  const record = {
    kind: 'learn',
    at: new Date().toISOString(),
    genre: genre,
    source: originalSource,
    note: input.note || '',
    originalPath: original.path || '',
    revisedPath: revised.path || '',
    stats: analysis.stats,
    report: report,
    card: card
  };
  recordHistory(input.dir, record);
  audit(input.dir, {
    kind: 'learn',
    genre: genre,
    added: applied.added.length,
    promoted: applied.promoted.length,
    edits: analysis.stats.edits,
    version: committed.version
  });
  return {
    ok: true,
    genre: genre,
    version: committed.version,
    total_learns: profile.evidence.learns,
    added: report.added,
    updated: report.updated,
    promoted: report.promoted,
    removed: report.removed,
    metrics_updated: report.metrics_updated,
    stats: report.stats,
    deltas: report.deltas,
    top_proposals: report.top_proposals,
    card_preview: card,
    card_compact: compact,
    note: input.note || ''
  };
}

/**
 * 给一份修订稿找 AI 原稿：先同路径快照，再全库相似度匹配。
 * @returns {{text:string, path:string, source:string, item:object}|null}
 */
export function locateOriginalForFile(dir, revisedPath, revisedText, config) {
  const samePath = snapshotsForPath(dir, revisedPath);
  for (const item of samePath) {
    const text = readSnapshotTextSafe(dir, item);
    if (text.length > 0 && text !== revisedText) return { text: text, path: item.path, source: 'snapshot-same-path', item: item };
  }
  const best = bestMatchingSnapshot(dir, revisedText, {
    minSimilarity: (config.learn && config.learn.autoPairMinSimilarity) || 0.35,
    excludePath: revisedPath
  });
  if (best !== null) return { text: best.text, path: best.item.path, source: 'snapshot-similarity', item: best.item };
  return null;
}

function readSnapshotTextSafe(dir, item) {
  try { return readSnapshotText(dir, item); } catch { return ''; }
}

/**
 * 选择注入用的默认文种：优先 global；若 global 还空，选内容最多的文种，
 * 避免「只学过讲稿」时新会话什么都注入不了。
 */
export function pickDefaultGenre(profile) {
  const slotContent = (genre) => {
    const slot = profile.genres[genre];
    if (!slot) return 0;
    const rules = Array.isArray(slot.rules) ? slot.rules.filter((rule) => rule.status !== 'archived').length : 0;
    const metrics = slot.metrics ? Object.keys(slot.metrics).length : 0;
    return rules * 2 + metrics;
  };
  if (slotContent('global') > 0) return 'global';
  let best = 'global';
  let bestScore = 0;
  for (const genre of GENRES) {
    if (genre === 'global') continue;
    const score = slotContent(genre);
    if (score > bestScore) { bestScore = score; best = genre; }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* 快照捕获与自动学习                                                   */
/* ------------------------------------------------------------------ */

/** 交付成功后的快照捕获（present 的 post-execute 调用）。 */
export function captureDeliveredFiles(input) {
  const config = input.config || loadConfig(input.dir);
  const results = [];
  for (const file of input.files) {
    if (!isSupportedDoc(file.path)) continue;
    if (!existsSync(file.path)) continue;
    const extracted = extractTextFromFile(file.path);
    if (!extracted.ok) continue;
    const item = saveSnapshot(input.dir, {
      path: file.path,
      text: extracted.text,
      hash: hashText(extracted.text),
      genre: input.genre || guessGenre(file.path),
      agentId: input.agentId || '',
      sessionId: input.sessionId || '',
      deliveredBy: input.deliveredBy || 'present'
    });
    audit(input.dir, { kind: 'snapshot', path: file.path, chars: extracted.chars, id: item.id });
    results.push(item);
  }
  return results;
}

/** 从用户消息里提取可能回传的文档路径。 */
export function extractFilePathsFromText(text, cwd) {
  const found = [];
  const source = String(text || '');
  const winAbs = /(?:[A-Za-z]:[\\/][^<>:"|?*\r\n\t]{1,220}?\.(?:docx|pptx|doc|md|markdown|txt))/gi;
  let m;
  while ((m = winAbs.exec(source)) !== null) found.push(m[0]);
  const quoted = /["'“”「」]([^"'“”「」\r\n]{1,220}\.(?:docx|pptx|doc|md|markdown|txt))["'“”「」]/gi;
  while ((m = quoted.exec(source)) !== null) found.push(resolveUserPath(m[1], cwd));
  const seen = new Set();
  return found.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 用户消息里带了改过的文档路径 → 自动配对并学习。
 * @returns {{ learned: boolean, message?: string, report?: object }}
 */
export function tryAutoLearnFromMessage(input) {
  const config = input.config || loadConfig(input.dir);
  if (config.enabled === false) return { learned: false };
  if (!config.learn || config.learn.autoPair === false) return { learned: false };
  const cwd = input.cwd || process.cwd();
  const paths = extractFilePathsFromText(input.text, cwd);
  if (paths.length === 0) return { learned: false };
  const state = input.agent && input.agent.id ? agentState(input.agent.id) : null;
  for (const raw of paths.slice(0, 3)) {
    const path = resolveUserPath(raw, cwd);
    if (!existsSync(path) || !isSupportedDoc(path)) continue;
    const extracted = extractTextFromFile(path);
    if (!extracted.ok || extracted.chars < ((config.learn && config.learn.minChars) || 60)) continue;
    const original = locateOriginalForFile(input.dir, path, extracted.text, config);
    if (original === null) continue;
    const pairKey = original.item.id + '|' + hashText(extracted.text);
    if (state !== null && state.learnedPairs.has(pairKey)) continue;
    const report = learnFromInputs({
      originalText: original.text,
      revisedText: extracted.text,
      genre: guessGenre(path),
      note: '自动配对（用户消息带回修订稿）',
      config: config,
      dir: input.dir,
      cwd: cwd
    });
    if (!report.ok) continue;
    if (state !== null) state.learnedPairs.add(pairKey);
    return {
      learned: true,
      path: path,
      originalPath: original.path,
      source: original.source,
      report: report,
      message: buildLearnNotice(report, path, original.path)
    };
  }
  return { learned: false };
}

/** 自动学习后的提示消息。 */
export function buildLearnNotice(report, revisedPath, originalPath) {
  const lines = [];
  lines.push('[风格记忆] 已从你修改的文档里自动学习：');
  lines.push('- 修订稿：' + revisedPath);
  if (originalPath) lines.push('- AI 原稿：' + originalPath);
  lines.push('- 对齐后改动 ' + report.stats.edits + ' 处，新增/更新 ' + (report.added + report.updated) + ' 条规则，档案升到 v' + report.version + '。');
  if (report.top_proposals && report.top_proposals.length > 0) {
    lines.push('- 这次学到的主要偏好：');
    for (const item of report.top_proposals.slice(0, 5)) {
      lines.push('  · ' + (item.type === 'rewrite' ? '「' + item.text + '」改成「' + (item.to || '') + '」' : item.text));
    }
  }
  lines.push('后续会话会自动按更新后的风格卡写；用 /style card 查看。');
  return lines.join('\n');
}

/** 口语学习：把缓冲区里的用户消息聚合并并入 chat 画像。 */
export function flushChatLearning(input) {
  const config = input.config || loadConfig(input.dir);
  if (config.enabled === false) return { ok: false, reason: 'disabled' };
  if (!config.chat || config.chat.enabled === false) return { ok: false, reason: 'chat-disabled' };
  const state = input.agent && input.agent.id ? agentState(input.agent.id) : null;
  if (state === null) return { ok: false, reason: 'no-agent' };
  if (!Array.isArray(state.chatBuffer)) state.chatBuffer = [];
  if (state.chatBuffer.length === 0) return { ok: false, reason: 'empty' };
  const buffer = state.chatBuffer.splice(0, state.chatBuffer.length);
  const aggregate = aggregateChatMessages(buffer, config.chat);
  if (aggregate === null) return { ok: false, reason: 'empty' };
  const profile = getProfile(input.dir);
  const merged = mergeChatLearning(profile, aggregate, config);
  const committed = commitProfile(input.dir, profile, {
    action: 'chat-learn',
    source: 'session-messages',
    summary: 'chat messages ' + aggregate.messages + ', +' + merged.added + ' phrases'
  });
  invalidateProfile();
  audit(input.dir, { kind: 'chat-learn', messages: aggregate.messages, added: merged.added, version: committed.version });
  return { ok: true, messages: aggregate.messages, added: merged.added, version: committed.version };
}

/** 清理快照；按用户要求先做一次整合（LLM 可用时用 LLM，否则本地兜底）。 */
export async function maybeCleanup(input) {
  const config = input.config || loadConfig(input.dir);
  const due = dueForCleanup(input.dir, config);
  if (due.due.length === 0) return { ok: true, deleted: 0, due: 0 };
  let consolidation = null;
  if (config.retention && config.retention.consolidateBeforeCleanup !== false) {
    const profile = getProfile(input.dir);
    consolidation = await consolidateWithModel({
      profile: profile,
      genre: 'global',
      config: config,
      agent: input.agent,
      llm: input.llm
    });
    if (consolidation === null) {
      consolidation = consolidateLocal(profile, 'global', config);
      consolidation.mode = 'local-fallback';
    }
    const committed = commitProfile(input.dir, profile, {
      action: 'consolidate',
      source: 'before-cleanup',
      summary: 'consolidate before cleanup: merged=' + consolidation.merged + ' archived=' + consolidation.archived
    });
    invalidateProfile();
    audit(input.dir, { kind: 'consolidate', mode: consolidation.mode, beforeCleanup: true, version: committed.version });
  }
  const deleted = deleteSnapshots(input.dir, due.due);
  audit(input.dir, { kind: 'snapshot-cleanup', deleted: deleted, reason: due.reason });
  recordHistory(input.dir, { kind: 'cleanup', at: new Date().toISOString(), deleted: deleted, reason: due.reason, consolidation: consolidation });
  return { ok: true, deleted: deleted, due: due.due.length, consolidation: consolidation };
}

/* ------------------------------------------------------------------ */
/* present 门禁与快照                                                  */
/* ------------------------------------------------------------------ */

/** 把会话状态封装成 gate.js 需要的接口。 */
export function gateStateFor(state) {
  return {
    recordFor: (absolute) => {
      const record = state.present.get(absolute);
      return record === undefined ? { attempts: 0, lastHash: '', lastScore: 0 } : record;
    },
    hashOf: (text) => hashText(text),
    markPassed: (absolute, hash, score) => {
      const record = state.present.get(absolute) || { attempts: 0 };
      record.lastHash = hash;
      record.lastScore = score;
      record.passedHash = hash;
      state.present.set(absolute, record);
    },
    markDenied: (absolute, hash, score) => {
      const record = state.present.get(absolute) || { attempts: 0 };
      record.attempts = (Number(record.attempts) || 0) + 1;
      record.lastHash = hash;
      record.lastScore = score;
      record.lastAt = Date.now();
      state.present.set(absolute, record);
      return record;
    }
  };
}

/** present 前的门禁评估。 */
export function evaluatePresentForAgent(input) {
  const config = input.config || loadConfig(input.dir);
  if (config.enabled === false) return { decision: 'allow', checked: [] };
  const state = input.agent && input.agent.id ? agentState(input.agent.id) : null;
  const genre = input.genre || guessGenre((input.args && input.args.files && input.args.files[0] && (input.args.files[0].path || input.args.files[0])) || '');
  return evaluatePresent({
    args: input.args,
    agentState: state === null ? null : gateStateFor(state),
    cwd: input.cwd || resolveCwd(input.agent),
    config: config,
    profile: getProfile(input.dir),
    genre: genre
  });
}

/* ------------------------------------------------------------------ */
/* 状态与档案操作                                                       */
/* ------------------------------------------------------------------ */

export function statusText(input) {
  const config = input.config || loadConfig(input.dir);
  const profile = getProfile(input.dir);
  const stats = profileStats(profile);
  const snapshots = listSnapshots(input.dir);
  const history = listHistory(input.dir, 5);
  const lines = [];
  lines.push('风格记忆：' + (config.enabled === false ? '已停用（/style on 恢复）' : '已启用'));
  lines.push('档案：v' + stats.version + ' · 规则 ' + stats.activeRules + ' 条生效 / ' + stats.candidateRules + ' 条候选 · 学习 ' + ((stats.evidence && stats.evidence.learns) || 0) + ' 对');
  lines.push('快照：' + snapshots.length + ' 份（保留 ' + ((config.retention && config.retention.days) || 90) + ' 天 / 最多 ' + ((config.retention && config.retention.maxSnapshots) || 200) + ' 份）');
  lines.push('门禁：AI 特征分 ≥ ' + ((config.gate && config.gate.threshold) || 60) + ' 时拦截（最多 ' + ((config.gate && config.gate.maxAttempts) || 3) + ' 次后放行）');
  lines.push('数据目录：' + stateDir());
  if (history.length > 0) lines.push('最近学习记录：' + history.length + ' 条（/style profile 查看）');
  const card = buildCard(profile, pickDefaultGenre(profile), (config.inject && config.inject.maxChars) || 400);
  if (card.length > 0) {
    lines.push('');
    lines.push(card);
  } else {
    lines.push('');
    lines.push('还没有风格卡：把 AI 原稿和你的修改稿交给 style_learn，或让 DSH 交付一次文档、你再把改过的版本带回会话。');
  }
  lines.push('');
  lines.push('用法：/style [status|on|off|card|profile|undo|consolidate]');
  return lines.join('\n');
}


const RULE_TYPE_LABELS = {
  banned_phrase: '禁用表达',
  rewrite: '改写偏好',
  preferred_phrase: '偏好表达',
  structural: '结构习惯',
  opening: '开场习惯',
  closing: '结尾习惯',
  term: '术语偏好',
  chat_phrase: '口头表达',
  human_feature: '人味特征'
};

/**
 * Structured panel payload: rules split by status and recent learn history.
 * Text fields above are kept for old clients; this is for the redesigned panel.
 */
export function panelRulesAndHistory(dir, limit) {
  const profile = getProfile(dir);
  const genre = pickDefaultGenre(profile);
  const max = Math.max(1, Math.min(120, Number(limit) || 60));
  const rules = rulesFor(profile, genre)
    .slice()
    .sort((a, b) => ruleScore(b) - ruleScore(a))
    .slice(0, max)
    .map((rule) => ({
      id: rule.id,
      genre: rule.genre,
      type: rule.type,
      typeLabel: RULE_TYPE_LABELS[rule.type] || rule.type,
      text: rule.text,
      to: rule.to || '',
      status: rule.status,
      confidence: Math.round((rule.confidence || 0) * 100),
      evidence: Number(rule.pos) || 0,
      anchor: typeof rule.anchor === 'string' ? rule.anchor.slice(0, 600) : '',
      why: rule.why || '',
      fix: rule.fix || ''
    }));
  const history = [];
  for (const name of listHistory(dir, 12)) {
    const record = readHistory(dir, name);
    if (record === null) continue;
    history.push({
      name: name,
      kind: record.kind || '',
      genre: record.genre || '',
      at: record.at || '',
      edits: (record.stats && record.stats.edits) || 0,
      added: (record.report && record.report.added) || 0,
      note: record.note || ''
    });
  }
  return { genre: genre, rules: rules, history: history };
}

export function profileAction(input) {
  const action = String(input.action || 'view');
  const config = input.config || loadConfig(input.dir);
  const profile = getProfile(input.dir);
  const genre = GENRES.indexOf(input.genre) >= 0 ? input.genre : pickDefaultGenre(profile);
  if (action === 'view' || action === 'stats') {
    const stats = profileStats(profile);
    const snapshots = listSnapshots(input.dir);
    const lines = [];
    lines.push(JSON.stringify(stats, null, 2));
    lines.push('快照数：' + snapshots.length);
    lines.push('数据目录：' + stateDir());
    const card = buildCard(profile, genre, (config.inject && config.inject.maxChars) || 400);
    if (card) { lines.push(''); lines.push('画像卡：'); lines.push(card); }
    return { ok: true, action: action, text: lines.join('\n'), stats: stats, snapshots: snapshots.length };
  }
  if (action === 'card') {
    const card = buildCard(profile, genre, (config.inject && config.inject.maxChars) || 400);
    const compact = buildCompactCard(profile, genre, (config.inject && config.inject.subagentMaxChars) || 200);
    return {
      ok: true,
      action: action,
      genre: genre,
      text: (card || '（还没有风格卡）') + (compact && compact !== card ? '\n\n子代理精简版：\n' + compact : ''),
      card: card,
      compact: compact
    };
  }
  if (action === 'rules') {
    const text = renderRuleList(profile, genre, { limit: Number(input.limit) || 40 });
    return { ok: true, action: action, genre: genre, text: text };
  }
  if (action === 'history') {
    const names = listHistory(input.dir, 10);
    const lines = [];
    for (const name of names) {
      const record = readHistory(input.dir, name);
      if (record === null) continue;
      lines.push('- ' + name);
      if (record.kind === 'learn') {
        lines.push('  学习：' + (record.genre || '') + ' · 改动 ' + ((record.stats && record.stats.edits) || 0) + ' 处 · 新增 ' + (record.report && record.report.added) + ' 条' + (record.note ? ' · ' + record.note : ''));
      } else if (record.kind === 'cleanup') {
        lines.push('  清理快照：' + record.deleted + ' 份');
      } else {
        lines.push('  ' + record.kind);
      }
    }
    return { ok: true, action: action, text: lines.length > 0 ? lines.join('\n') : '（还没有学习记录）' };
  }
  if (action === 'undo') {
    const result = undoProfile(input.dir);
    invalidateProfile();
    if (!result.ok) return { ok: false, action: action, error: result.error };
    audit(input.dir, { kind: 'undo', version: result.version });
    return { ok: true, action: action, version: result.version, text: '已回滚到档案 v' + result.version + '（' + result.restoredFrom + '）。' };
  }
  if (action === 'reset') {
    if (input.confirm !== true && input.confirm !== 'confirm') {
      return { ok: false, action: action, error: '重置会清空所有学到的规则（保留快照）。确认请传 confirm: true 或命令 /style reset confirm。' };
    }
    resetProfileData(input.dir);
    invalidateProfile();
    audit(input.dir, { kind: 'reset' });
    return { ok: true, action: action, text: '档案已重置（旧档案已存档到 versions/）。' };
  }
  if (action === 'export') {
    if (!input.path) return { ok: false, action: action, error: '缺少导出路径 path' };
    const out = resolveUserPath(input.path, input.cwd || process.cwd());
    const result = exportProfileData(input.dir, out);
    return { ok: true, action: action, path: out, text: '已导出到 ' + out + '（档案 v' + result.version + '）。' };
  }
  if (action === 'import') {
    if (!input.path) return { ok: false, action: action, error: '缺少导入路径 path' };
    const source = resolveUserPath(input.path, input.cwd || process.cwd());
    if (!existsSync(source)) return { ok: false, action: action, error: '文件不存在：' + source };
    const result = importProfileData(input.dir, source);
    invalidateProfile();
    if (!result.ok) return { ok: false, action: action, error: result.error };
    return { ok: true, action: action, version: result.version, text: '已导入档案（新版本 v' + result.version + '）。' };
  }
  if (action === 'consolidate') {
    return { ok: false, action: action, error: 'consolidate 需要 agent 上下文，请用工具调用 style_profile(action="consolidate")，或直接运行 /style consolidate。' };
  }
  return { ok: false, error: '未知 action：' + action + '（可用 view|card|rules|history|undo|reset|export|import|stats|consolidate）' };
}

/** 执行一次整合并提交（工具与命令共用）。 */
export async function consolidateNow(input) {
  const config = input.config || loadConfig(input.dir);
  const profile = getProfile(input.dir);
  const detailed = await consolidateWithModelDetailed({ profile: profile, genre: input.genre || 'global', config: config, agent: input.agent, llm: input.llm });
  let summary = detailed.summary;
  let reason = detailed.reason;
  if (summary === null) {
    summary = consolidateLocal(profile, input.genre || 'global', config);
    reason = 'local-fallback:' + reason;
  }
  const committed = commitProfile(input.dir, profile, {
    action: 'consolidate',
    source: input.source || 'manual',
    summary: 'consolidate: merged=' + summary.merged + ' archived=' + summary.archived + ' added=' + (summary.added || 0)
  });
  invalidateProfile();
  audit(input.dir, { kind: 'consolidate', mode: summary.mode, reason: reason, version: committed.version });
  const result = { ok: true, version: committed.version, mode: summary.mode, reason: reason, merged: summary.merged, archived: summary.archived, added: summary.added || 0 };
  if (detailed.preview) result.preview = detailed.preview;
  if (detailed.chunkTypes) result.chunkTypes = detailed.chunkTypes;
  return result;
}
