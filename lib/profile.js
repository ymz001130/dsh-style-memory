/**
 * 风格档案：结构、读写、规则合并（Beta 置信度）、指标区间学习、版本与回滚。
 *
 * 档案是唯一真源；画像卡（card.js）与检测（detect.js）都从档案派生。
 * 合并策略借鉴「从用户修改中学习」的三类信号（偏好/监督/奖励）：
 *   - banned_phrase / banned_pattern / rewrite_from：偏好信号（用户删掉/改写）
 *   - preferred_phrase / rewrite_to：监督信号（用户写出来的）
 *   - metrics：奖励信号（指标往哪边移动）
 * 每条规则的置信度用 Beta 后验 (pos+1)/(pos+neg+2)，两次独立证据即可升为 active。
 */

import { randomUUID } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, unlinkSync, writeFileSync
} from 'node:fs';
import { join } from 'node:path';

import { GENRES } from './constants.js';

export const PROFILE_SCHEMA = 1;
const HISTORY_LIMIT = 120;
const VERSIONS_LIMIT = 30;

/** 空白档案。 */
export function defaultProfile() {
  const genres = {};
  for (const genre of GENRES) {
    genres[genre] = { rules: [], metrics: {}, card: '', stats: { learns: 0, lastLearnAt: null } };
  }
  return {
    schema: PROFILE_SCHEMA,
    version: 0,
    createdAt: null,
    updatedAt: null,
    genres: genres,
    evidence: { pairs: 0, edits: 0, learns: 0, lastLearnAt: null },
    history: []
  };
}

/** 规则唯一键：类型 + 归一化文本 + 目标文本。 */
export function ruleKey(type, text, to) {
  return type + '|' + normalizePhrase(text) + '|' + normalizePhrase(to || '');
}

/** 归一化短语：去首尾标点空白、压缩空格、全角空格转半角。 */
export function normalizePhrase(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/^[\s。！？；：，、,.;:!?]+/, '')
    .replace(/[\s。！？；：，、,.;:!?]+$/, '')
    .trim();
}

function isValidProfile(value) {
  return value !== null && typeof value === 'object' && value.schema === PROFILE_SCHEMA && value.genres !== null && typeof value.genres === 'object';
}

/** 读取档案；文件缺失/损坏返回空白档案。 */
export function loadProfile(stateDir) {
  const file = join(stateDir, 'profile.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!isValidProfile(parsed)) return defaultProfile();
    const filled = defaultProfile();
    for (const genre of GENRES) {
      if (parsed.genres && parsed.genres[genre]) {
        filled.genres[genre] = Object.assign(filled.genres[genre], parsed.genres[genre]);
      }
    }
    filled.version = Number(parsed.version) || 0;
    filled.createdAt = parsed.createdAt || null;
    filled.updatedAt = parsed.updatedAt || null;
    filled.evidence = Object.assign(filled.evidence, parsed.evidence || {});
    filled.history = Array.isArray(parsed.history) ? parsed.history.slice(-HISTORY_LIMIT) : [];
    return filled;
  } catch {
    return defaultProfile();
  }
}

/** 原子写 JSON。 */
export function saveJsonAtomic(file, value) {
  const text = JSON.stringify(value, null, 2) + '\n';
  const temp = file + '.tmp';
  writeFileSync(temp, text, 'utf8');
  renameSync(temp, file);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function versionsDir(stateDir) {
  const dir = join(stateDir, 'versions');
  ensureDir(dir);
  return dir;
}

/**
 * 提交新档案：先把旧版本快照进 versions/，再写 profile.json。
 * @returns {{ prevVersion: number, version: number }}
 */
export function commitProfile(stateDir, profile, options) {
  const opts = options || {};
  ensureDir(stateDir);
  const prevVersion = Number(profile.version) || 0;
  if (prevVersion > 0) {
    try {
      const dir = versionsDir(stateDir);
      const file = join(dir, 'v' + String(prevVersion).padStart(5, '0') + '.json');
      writeFileSync(file, JSON.stringify(profile, null, 2) + '\n', 'utf8');
      pruneVersions(dir);
    } catch { /* 快照失败不阻塞学习 */ }
  }
  const nextVersion = prevVersion + 1;
  profile.version = nextVersion;
  profile.updatedAt = new Date().toISOString();
  if (!profile.createdAt) profile.createdAt = profile.updatedAt;
  if (!Array.isArray(profile.history)) profile.history = [];
  profile.history.push({
    version: nextVersion,
    at: profile.updatedAt,
    action: opts.action || 'learn',
    source: opts.source || '',
    summary: opts.summary || ''
  });
  if (profile.history.length > HISTORY_LIMIT) profile.history = profile.history.slice(-HISTORY_LIMIT);
  saveJsonAtomic(join(stateDir, 'profile.json'), profile);
  return { prevVersion: prevVersion, version: nextVersion };
}

function pruneVersions(dir) {
  try {
    const files = readdirSync(dir).filter((name) => /^v\d+\.json$/.test(name)).sort();
    const extra = files.length - VERSIONS_LIMIT;
    if (extra <= 0) return;
    for (const name of files.slice(0, extra)) unlinkSync(join(dir, name));
  } catch { /* ignore */ }
}

/** 规则展示分：置信度 × 证据量 × 类型权重。 */
export function ruleScore(rule) {
  const typeWeight = {
    banned_phrase: 1.2, banned_pattern: 1.15, rewrite: 1.1, preferred_phrase: 0.9,
    structural: 1.25, opening: 1.0, closing: 1.0, term: 1.1, human_feature: 0.8, chat_phrase: 0.8
  };
  const weight = typeWeight[rule.type] === undefined ? 1.0 : typeWeight[rule.type];
  const evidence = Math.min(4, (Number(rule.pos) || 0) + 0.5);
  return (Number(rule.confidence) || 0.5) * weight * (0.6 + evidence * 0.35);
}

/**
 * 置信度：Beta 后验 + 证据强度 boost。
 * boost 表示这条证据本身的可信度（0-1）：长句/结构性删除给 1.0，
 * 短词/语义弱的给 0.2-0.6；这样单对样本里的弱证据不会直接升级为 active。
 */
export function confidenceOf(pos, neg, boost) {
  const p = Math.max(0, Number(pos) || 0);
  const n = Math.max(0, Number(neg) || 0);
  const b = Math.max(0, Math.min(1, Number(boost) || 0));
  return Math.round(((p + b) / (p + n + 1 + b)) * 1000) / 1000;
}

/**
 * 合并一条规则候选。
 * @param {object} profile
 * @param {string} genre
 * @param {object} proposal {type,text,to,why,fix,anchor,evidence(+1/-1),source,trust}
 * @param {object} config
 * @returns {{rule: object, created: boolean, promoted: boolean}}
 */
export function mergeProposal(profile, genre, proposal, config) {
  const slot = profile.genres[genre] || profile.genres.global;
  const text = normalizePhrase(proposal.text);
  if (text.length === 0) return { rule: null, created: false, promoted: false };
  const to = normalizePhrase(proposal.to || '');
  const key = ruleKey(proposal.type, text, to);
  let rule = slot.rules.find((item) => ruleKey(item.type, item.text, item.to) === key);
  const created = !rule;
  if (created) {
    rule = {
      id: randomUUID(),
      key: key,
      type: proposal.type,
      text: text,
      to: to || undefined,
      genre: genre,
      pos: 0,
      neg: 0,
      confidence: 0.5,
      boost: 0,
      status: 'candidate',
      why: proposal.why || '',
      fix: proposal.fix || '',
      anchor: proposal.anchor || '',
      source: proposal.source || '',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    };
    slot.rules.push(rule);
  }
  if (proposal.evidence === -1) rule.neg += 1;
  else rule.pos += 1;
  const boost = proposal.evidence === -1 ? 0 : Math.max(0, Math.min(1, Number(proposal.trust) || 0.5));
  rule.boost = Math.max(Number(rule.boost) || 0, boost);
  if (proposal.why && !rule.why) rule.why = proposal.why;
  if (proposal.fix && !rule.fix) rule.fix = proposal.fix;
  if (proposal.anchor && !rule.anchor) rule.anchor = proposal.anchor;
  rule.confidence = confidenceOf(rule.pos, rule.neg, rule.boost);
  rule.lastSeen = new Date().toISOString();
  const minEvidence = (config && config.learn && config.learn.minEvidence) || 1;
  const minConfidence = (config && config.learn && config.learn.minConfidence) || 0.6;
  const promoted = rule.pos >= minEvidence && rule.confidence >= minConfidence && rule.status !== 'active';
  if (promoted) rule.status = 'active';
  if (rule.pos < minEvidence && rule.status === 'active' && rule.neg > rule.pos) rule.status = 'archived';
  return { rule: rule, created: created, promoted: promoted };
}

/** 清理超量规则：按展示分保留，低分候选归档。 */
export function capRules(profile, genre, maxRules) {
  const slot = profile.genres[genre];
  if (!slot || slot.rules.length <= maxRules) return 0;
  const sorted = slot.rules.slice().sort((a, b) => ruleScore(b) - ruleScore(a));
  const keep = new Set(sorted.slice(0, maxRules).map((rule) => rule.id));
  let removed = 0;
  for (const rule of slot.rules) {
    if (!keep.has(rule.id) && rule.status !== 'archived') {
      rule.status = 'archived';
      removed += 1;
    }
  }
  return removed;
}

/** 更新指标区间（奖励信号）。 */
export function updateMetricTargets(profile, genre, metrics, options) {
  const slot = profile.genres[genre] || profile.genres.global;
  const keys = options && Array.isArray(options.keys) ? options.keys : Object.keys(metrics);
  const updated = [];
  for (const key of keys) {
    const value = metrics[key];
    if (!Number.isFinite(value)) continue;
    let target = slot.metrics[key];
    if (!target) {
      target = { samples: [], lo: value, hi: value, weight: 1, updatedAt: null };
      slot.metrics[key] = target;
    }
    if (!Array.isArray(target.samples)) target.samples = [];
    target.samples.push(Math.round(value * 1000) / 1000);
    if (target.samples.length > 12) target.samples = target.samples.slice(-12);
    const values = target.samples.slice().sort((a, b) => a - b);
    const n = values.length;
    let lo;
    let hi;
    if (n >= 5) {
      const p20 = values[Math.floor(n * 0.2)];
      const p80 = values[Math.min(n - 1, Math.floor(n * 0.8))];
      lo = Math.min(p20, p80);
      hi = Math.max(p20, p80);
    } else {
      lo = values[0];
      hi = values[n - 1];
    }
    const margin = Math.max(Math.abs(hi - lo) * 0.25, Math.abs(hi) * 0.08, 0.5);
    target.lo = Math.round((lo - margin) * 100) / 100;
    target.hi = Math.round((hi + margin) * 100) / 100;
    target.weight = Math.round((0.6 + Math.min(1.2, n * 0.15)) * 100) / 100;
    target.updatedAt = new Date().toISOString();
    updated.push(key);
  }
  return updated;
}

/** 取某文种下参与画像的规则（global + 指定文种）。 */
export function rulesFor(profile, genre) {
  const out = [];
  const seen = new Set();
  for (const g of ['global', genre]) {
    if (!g || seen.has(g)) continue;
    seen.add(g);
    const slot = profile.genres[g];
    if (!slot || !Array.isArray(slot.rules)) continue;
    for (const rule of slot.rules) {
      if (rule.status === 'archived') continue;
      out.push(rule);
    }
  }
  return out;
}

/** 档案统计。 */
export function profileStats(profile) {
  const genres = {};
  let active = 0;
  let candidate = 0;
  for (const genre of GENRES) {
    const slot = profile.genres[genre];
    const rules = slot && Array.isArray(slot.rules) ? slot.rules : [];
    const a = rules.filter((rule) => rule.status === 'active').length;
    const c = rules.filter((rule) => rule.status !== 'active' && rule.status !== 'archived').length;
    active += a;
    candidate += c;
    genres[genre] = { rules: rules.length, active: a, candidate: c, metrics: Object.keys(slot && slot.metrics ? slot.metrics : {}).length };
  }
  return {
    version: profile.version,
    updatedAt: profile.updatedAt,
    evidence: profile.evidence,
    activeRules: active,
    candidateRules: candidate,
    genres: genres
  };
}

/** 回滚到上一个版本。 */
export function undoProfile(stateDir) {
  const dir = versionsDir(stateDir);
  const files = readdirSync(dir).filter((name) => /^v\d+\.json$/.test(name)).sort();
  if (files.length === 0) return { ok: false, error: '没有可回滚的版本' };
  const latest = files[files.length - 1];
  const snapshot = JSON.parse(readFileSync(join(dir, latest), 'utf8'));
  if (!isValidProfile(snapshot)) return { ok: false, error: '版本快照损坏' };
  unlinkSync(join(dir, latest));
  // 当前档案另存一份，保留 undo 之后仍可追溯
  try {
    const current = loadProfile(stateDir);
    const keep = 'undone-v' + String(current.version || 0).padStart(5, '0') + '-' + Date.now() + '.json';
    writeFileSync(join(dir, keep), JSON.stringify(current, null, 2), 'utf8');
  } catch { /* ignore */ }
  snapshot.history = Array.isArray(snapshot.history) ? snapshot.history : [];
  snapshot.history.push({ version: snapshot.version, at: new Date().toISOString(), action: 'undo', summary: '回滚到 ' + latest });
  saveJsonAtomic(join(stateDir, 'profile.json'), snapshot);
  return { ok: true, version: snapshot.version, restoredFrom: latest };
}

/** 重置档案（保留一份存档）。 */
export function resetProfileData(stateDir) {
  const current = loadProfile(stateDir);
  if (current.version > 0) {
    const dir = versionsDir(stateDir);
    writeFileSync(join(dir, 'reset-before-v' + String(current.version).padStart(5, '0') + '-' + Date.now() + '.json'), JSON.stringify(current, null, 2), 'utf8');
  }
  const fresh = defaultProfile();
  fresh.createdAt = new Date().toISOString();
  fresh.updatedAt = fresh.createdAt;
  saveJsonAtomic(join(stateDir, 'profile.json'), fresh);
  return { ok: true };
}

/** 导出档案。 */
export function exportProfileData(stateDir, outFile) {
  const profile = loadProfile(stateDir);
  saveJsonAtomic(outFile, profile);
  return { ok: true, path: outFile, version: profile.version };
}

/** 导入档案。 */
export function importProfileData(stateDir, inFile) {
  const parsed = JSON.parse(readFileSync(inFile, 'utf8'));
  if (!isValidProfile(parsed)) return { ok: false, error: '不是有效的风格档案文件' };
  const current = loadProfile(stateDir);
  if (current.version > 0) {
    const dir = versionsDir(stateDir);
    writeFileSync(join(dir, 'import-before-v' + String(current.version).padStart(5, '0') + '-' + Date.now() + '.json'), JSON.stringify(current, null, 2), 'utf8');
  }
  parsed.version = (Number(current.version) || 0) + 1;
  parsed.updatedAt = new Date().toISOString();
  parsed.history = Array.isArray(parsed.history) ? parsed.history : [];
  parsed.history.push({ version: parsed.version, at: parsed.updatedAt, action: 'import', source: inFile, summary: '导入档案' });
  saveJsonAtomic(join(stateDir, 'profile.json'), parsed);
  return { ok: true, version: parsed.version };
}
