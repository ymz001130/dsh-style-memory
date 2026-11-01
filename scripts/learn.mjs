/**
 * 命令行学习：不经过 Agent，直接把一对「AI 原稿 → 你的修订稿」喂给档案。
 *
 * 用法：
 *   node scripts/learn.mjs --original <AI原稿> --revised <你的修订稿> [--genre lecture] [--home <数据目录>] [--note "..."]
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const out = { genre: '', home: '', note: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--original') out.original = next();
    else if (arg === '--revised') out.revised = next();
    else if (arg === '--genre') out.genre = next();
    else if (arg === '--home') out.home = next();
    else if (arg === '--note') out.note = next();
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function usage() {
  console.log('用法：node scripts/learn.mjs --original <AI原稿> --revised <你的修订稿> [--genre lecture] [--home <数据目录>] [--note "..."]');
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }
if (!args.original || !args.revised) { usage(); process.exit(2); }
if (args.home) process.env.DSH_STYLE_MEMORY_HOME = resolve(args.home);

const { extractTextFromFile } = await import(pathToFileURL(resolve(ROOT, 'lib', 'textio.js')).href);
const { learnFromInputs, getProfile, invalidateProfile } = await import(pathToFileURL(resolve(ROOT, 'lib', 'service.js')).href);
const { buildCard } = await import(pathToFileURL(resolve(ROOT, 'lib', 'card.js')).href);
const { loadConfig, stateDir } = await import(pathToFileURL(resolve(ROOT, 'lib', 'store.js')).href);
const { pickDefaultGenre } = await import(pathToFileURL(resolve(ROOT, 'lib', 'service.js')).href);

const original = extractTextFromFile(resolve(args.original));
const revised = extractTextFromFile(resolve(args.revised));
if (!original.ok) { console.error('AI 原稿读取失败：' + original.error); process.exit(2); }
if (!revised.ok) { console.error('修订稿读取失败：' + revised.error); process.exit(2); }

const dir = stateDir();
const config = loadConfig(dir);
const result = learnFromInputs({
  original_text: original.text,
  revised_text: revised.text,
  genre: args.genre || guessGenre(args.revised),
  note: args.note || 'learn.mjs CLI',
  config: config,
  dir: dir,
  cwd: process.cwd()
});
if (!result.ok) { console.error('学习失败：' + result.error); process.exit(1); }
invalidateProfile();
console.log('已学习：' + (result.genre || 'global') + ' 修订对，档案 v' + result.version + '（' + dir + '）');
console.log('改动 ' + result.stats.edits + ' 处：新增 ' + result.added + ' 条、更新 ' + result.updated + ' 条、生效 ' + result.promoted + ' 条、归档 ' + result.removed + ' 条；指标区间更新 ' + result.metrics_updated + ' 项。');
const profile = getProfile(dir);
const card = buildCard(profile, pickDefaultGenre(profile), (config.inject && config.inject.maxChars) || 400);
if (card) { console.log(''); console.log('当前风格卡：'); console.log(card); }

function guessGenre(file) {
  const value = String(file || '').toLowerCase();
  if (/(讲稿|lecture|讲课)/.test(value)) return 'lecture';
  if (/(论文|thesis|综述|paper)/.test(value)) return 'thesis';
  if (/(ppt|slides|大纲)/.test(value)) return 'ppt';
  return 'global';
}
