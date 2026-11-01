/**
 * 本地存储：配置、快照、学习历史、审计。数据只落在 $DSH_HOME/style-memory/ 下，
 * 不写用户项目目录、不联网。
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';

import { DEFAULT_CONFIG } from './constants.js';
import { similarity } from './features.js';

/** DSH 数据根目录。 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 插件数据目录（可用 DSH_STYLE_MEMORY_HOME 覆盖，测试用）。 */
export function stateDir() {
  return process.env.DSH_STYLE_MEMORY_HOME || join(dshHome(), 'style-memory');
}

/** 所有子路径。 */
export function paths(dir) {
  const root = dir || stateDir();
  return {
    root: root,
    config: join(root, 'config.json'),
    profile: join(root, 'profile.json'),
    snapshots: join(root, 'snapshots'),
    snapshotsIndex: join(root, 'snapshots', 'index.json'),
    history: join(root, 'history'),
    versions: join(root, 'versions'),
    audit: join(root, 'audit.ndjson')
  };
}

/** 建目录。 */
export function ensureDirs(dir) {
  const p = paths(dir);
  for (const key of ['root', 'snapshots', 'history', 'versions']) mkdirSync(p[key], { recursive: true });
  return p;
}

let configCache = null;
let configCacheKey = '';

function deepMerge(baseValue, patchValue) {
  if (patchValue === null || patchValue === undefined) return baseValue;
  if (Array.isArray(baseValue)) return Array.isArray(patchValue) ? patchValue.slice() : baseValue;
  if (typeof baseValue === 'object' && typeof patchValue === 'object') {
    const out = Object.assign({}, baseValue);
    for (const key of Object.keys(patchValue)) {
      out[key] = deepMerge(baseValue[key] === undefined ? patchValue[key] : baseValue[key], patchValue[key]);
    }
    return out;
  }
  return patchValue;
}

/** 读取配置（默认值 + 文件覆盖），带 1 秒缓存。 */
export function loadConfig(dir) {
  const p = paths(dir);
  let stamp = '0';
  try {
    const info = statSync(p.config);
    stamp = String(info.mtimeMs) + ':' + String(info.size);
  } catch { stamp = 'missing'; }
  if (configCache !== null && configCacheKey === p.config + '|' + stamp) return configCache;
  let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  try {
    const parsed = JSON.parse(readFileSync(p.config, 'utf8'));
    config = deepMerge(config, parsed);
  } catch { /* 默认配置 */ }
  configCache = config;
  configCacheKey = p.config + '|' + stamp;
  return config;
}

/** 保存配置（只写插件数据目录）。 */
export function saveConfig(dir, config) {
  const p = ensureDirs(dir);
  const temp = p.config + '.tmp';
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  renameSync(temp, p.config);
  configCache = config;
  configCacheKey = '';
  return { ok: true };
}

/** 文本 SHA-256。 */
export function hashText(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/** 文件 SHA-256。 */
export function hashFile(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

/** 审计日志（best effort，永不抛错）。 */
export function audit(dir, record) {
  try {
    const p = ensureDirs(dir);
    appendFileSync(p.audit, JSON.stringify(Object.assign({ ts: new Date().toISOString(), plugin: 'dsh-style-memory' }, record)) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/** 学习历史记录。 */
export function recordHistory(dir, record) {
  try {
    const p = ensureDirs(dir);
    const name = new Date().toISOString().replace(/[:.]/g, '-') + '-' + (record.kind || 'learn') + '.json';
    writeFileSync(join(p.history, name), JSON.stringify(record, null, 2), 'utf8');
    return name;
  } catch { return null; }
}

/** 列出学习历史文件名（新的在前）。 */
export function listHistory(dir, limit) {
  try {
    const p = paths(dir);
    return readdirSync(p.history).filter((name) => name.endsWith('.json')).sort().reverse().slice(0, limit || 20);
  } catch { return []; }
}

/** 读取一条学习历史。 */
export function readHistory(dir, name) {
  try { return JSON.parse(readFileSync(join(paths(dir).history, name), 'utf8')); } catch { return null; }
}

/** 读取快照索引。 */
export function listSnapshots(dir) {
  try {
    const raw = JSON.parse(readFileSync(paths(dir).snapshotsIndex, 'utf8'));
    return Array.isArray(raw && raw.items) ? raw.items : [];
  } catch { return []; }
}

function writeSnapshotsIndex(dir, items) {
  const p = ensureDirs(dir);
  const keep = items.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 1000);
  const temp = p.snapshotsIndex + '.tmp';
  writeFileSync(temp, JSON.stringify({ items: keep }, null, 2), 'utf8');
  renameSync(temp, p.snapshotsIndex);
  return keep;
}

/**
 * 记录一个交付文档快照（纯文本）。
 * @returns {object} 快照条目
 */
export function saveSnapshot(dir, input) {
  const p = ensureDirs(dir);
  const items = listSnapshots(dir);
  const absolute = input.path;
  const hash = input.hash || hashText(input.text || '');
  const existing = items.find((item) => item.path === absolute && item.hash === hash);
  if (existing) {
    existing.deliveredAt = new Date().toISOString();
    existing.sessionId = input.sessionId || existing.sessionId;
    writeSnapshotsIndex(dir, items);
    return existing;
  }
  const id = 'snap-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8);
  const textFile = join(p.snapshots, id + '.txt');
  writeFileSync(textFile, String(input.text || ''), 'utf8');
  const item = {
    id: id,
    path: absolute,
    name: basename(absolute),
    ext: extname(absolute).toLowerCase(),
    genre: input.genre || guessGenre(absolute),
    hash: hash,
    chars: String(input.text || '').length,
    textFile: textFile,
    createdAt: new Date().toISOString(),
    deliveredAt: new Date().toISOString(),
    sessionId: input.sessionId || '',
    agentId: input.agentId || '',
    deliveredBy: input.deliveredBy || 'present'
  };
  items.push(item);
  writeSnapshotsIndex(dir, items);
  return item;
}

/** 读取快照文本。 */
export function readSnapshotText(dir, item) {
  try {
    if (item && item.textFile && existsSync(item.textFile)) return readFileSync(item.textFile, 'utf8');
    const alt = join(paths(dir).snapshots, item.id + '.txt');
    if (existsSync(alt)) return readFileSync(alt, 'utf8');
  } catch { /* ignore */ }
  return '';
}

/** 同路径的历史快照（新的在前）。 */
export function snapshotsForPath(dir, absolute) {
  return listSnapshots(dir).filter((item) => item.path === absolute).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** 在所有快照里找与给定修订文本最像的原稿。 */
export function bestMatchingSnapshot(dir, revisedText, options) {
  const opts = options || {};
  const minSimilarity = Number.isFinite(opts.minSimilarity) ? opts.minSimilarity : 0.3;
  const maxCandidates = Number.isFinite(opts.maxCandidates) ? opts.maxCandidates : 400;
  const items = listSnapshots(dir).slice(0, maxCandidates);
  let best = null;
  for (const item of items) {
    if (opts.excludePath && item.path === opts.excludePath) continue;
    if (item.chars < 200) continue;
    const text = readSnapshotText(dir, item);
    const score = similarity(text, revisedText);
    if (best === null || score > best.score) best = { item: item, score: score, text: text };
  }
  if (best === null || best.score < minSimilarity) return null;
  return best;
}

/**
 * 找出需要清理的快照（保留策略：天数 + 数量）。
 * @returns {{ due: object[], kept: object[], reason: string }}
 */
export function dueForCleanup(dir, config) {
  const retention = (config && config.retention) || {};
  const days = Number(retention.days) || 90;
  const maxSnapshots = Number(retention.maxSnapshots) || 200;
  const items = listSnapshots(dir).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const due = [];
  const kept = [];
  items.forEach((item, index) => {
    const created = Date.parse(item.createdAt);
    const expired = Number.isFinite(created) && created < cutoff;
    const overflow = index >= maxSnapshots;
    if ((expired || overflow) && kept.length > 0) due.push(item);
    else kept.push(item);
  });
  return { due: due, kept: kept, reason: due.length > 0 ? '超过保留策略（' + days + ' 天 / ' + maxSnapshots + ' 个）' : '' };
}

/** 删除快照（含文本文件）。 */
export function deleteSnapshots(dir, items) {
  const ids = new Set(items.map((item) => item.id));
  const rest = listSnapshots(dir).filter((item) => !ids.has(item.id));
  writeSnapshotsIndex(dir, rest);
  for (const item of items) {
    try { if (item.textFile && existsSync(item.textFile)) unlinkSync(item.textFile); } catch { /* ignore */ }
    try {
      const alt = join(paths(dir).snapshots, item.id + '.txt');
      if (existsSync(alt)) unlinkSync(alt);
    } catch { /* ignore */ }
  }
  return items.length;
}

/** 由路径猜文种。 */
export function guessGenre(filePath) {
  const text = String(filePath || '').replace(/\\/g, '/');
  if (/(讲课|讲稿|lecture|汇报|组会|分享会)/i.test(text)) return 'lecture';
  if (/(论文|初稿|综述|thesis|paper|开题|投稿)/i.test(text)) return 'thesis';
  if (/(ppt|slides|大纲|课件|deck)/i.test(text)) return 'ppt';
  return 'global';
}
