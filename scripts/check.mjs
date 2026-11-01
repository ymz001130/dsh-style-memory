/**
 * 命令行自检：不经过 Agent，直接给一份稿子打分。
 *
 * 用法：
 *   node scripts/check.mjs <文件或目录> [--genre lecture] [--home <数据目录>] [--threshold 60]
 *   node scripts/check.mjs --text "要检查的一段话"
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const out = { extras: [], genre: '', home: '', threshold: 60, text: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--genre') out.genre = next();
    else if (arg === '--home') out.home = next();
    else if (arg === '--threshold') out.threshold = Number(next());
    else if (arg === '--text') out.text = next();
    else if (arg === '--help' || arg === '-h') out.help = true;
    else out.extras.push(arg);
  }
  return out;
}

function usage() {
  console.log('用法：node scripts/check.mjs <文件或目录> [--genre lecture] [--home <数据目录>] [--threshold 60]');
  console.log('      node scripts/check.mjs --text "要检查的一段话"');
}

function collectFiles(target) {
  const files = [];
  const walk = (file, depth) => {
    if (depth > 5) return;
    let info;
    try { info = statSync(file); } catch { return; }
    if (info.isFile()) { if (/\.(docx|pptx|md|markdown|txt)$/i.test(file)) files.push(file); return; }
    if (!info.isDirectory()) return;
    for (const name of readdirSync(file)) walk(join(file, name), depth + 1);
  };
  walk(target, 0);
  return files;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }
if (args.home) process.env.DSH_STYLE_MEMORY_HOME = resolve(args.home);

const { extractTextFromFile } = await import(pathToFileURL(join(ROOT, 'lib', 'textio.js')).href);
const { analyzeText } = await import(pathToFileURL(join(ROOT, 'lib', 'detect.js')).href);
const { loadConfig, stateDir } = await import(pathToFileURL(join(ROOT, 'lib', 'store.js')).href);
const { loadProfile } = await import(pathToFileURL(join(ROOT, 'lib', 'profile.js')).href);
const { buildCard } = await import(pathToFileURL(join(ROOT, 'lib', 'card.js')).href);
const { pickDefaultGenre } = await import(pathToFileURL(join(ROOT, 'lib', 'service.js')).href);

const profile = loadProfile(stateDir());
const config = loadConfig(stateDir());
const threshold = Number.isFinite(args.threshold) && args.threshold > 0 ? args.threshold : ((config.gate && config.gate.threshold) || 60);

function printResult(label, text, genre) {
  const result = analyzeText(text, { profile, genre: genre || pickDefaultGenre(profile), config });
  console.log('');
  console.log('== ' + label + ' ==');
  console.log('AI 特征分：' + result.score + '/100（' + result.band + '，门禁线 ' + threshold + '）');
  if (result.ruleHits.length > 0) {
    console.log('命中个人规则：');
    for (const hit of result.ruleHits) console.log('- ' + hit.text + ' ×' + hit.count + '（置信 ' + Math.round((hit.confidence || 0) * 100) + '%）');
  }
  if (result.issues.length > 0) {
    console.log('主要问题：');
    for (const issue of result.issues.slice(0, 8)) console.log('- [' + issue.severity + '] ' + issue.why);
  }
  if (result.suggestions.length > 0) {
    console.log('改法：');
    result.suggestions.slice(0, 6).forEach((item, index) => console.log((index + 1) + '. ' + item));
  }
  const human = result.humanFeatures.map((item) => item.label + '×' + item.count).join('、');
  if (human) console.log('人味特征：' + human);
}

if (args.text) {
  printResult('文本', args.text, args.genre);
} else {
  if (args.extras.length === 0) { usage(); process.exit(2); }
  const files = [];
  for (const target of args.extras) {
    const resolved = resolve(target);
    if (!existsSync(resolved)) { console.error('路径不存在：' + resolved); continue; }
    if (statSync(resolved).isDirectory()) files.push.apply(files, collectFiles(resolved));
    else files.push(resolved);
  }
  if (files.length === 0) { console.error('没有可检查的文件'); process.exit(2); }
  for (const file of files.slice(0, 20)) {
    const extracted = extractTextFromFile(file);
    if (!extracted.ok) { console.log('\n跳过 ' + file + '：' + extracted.error); continue; }
    printResult(file, extracted.text, args.genre);
  }
}

const card = buildCard(profile, pickDefaultGenre(profile), (config.inject && config.inject.maxChars) || 400);
if (card.length > 0) {
  console.log('');
  console.log('== 当前风格卡（会注入新会话）==');
  console.log(card);
}
