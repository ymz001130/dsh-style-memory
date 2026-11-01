/**
 * 真实数据校准脚本：用一对「AI 原稿 → 你的修订稿」检验检测与学习效果。
 *
 * 用法：
 *   node scripts/calibrate.mjs --original D:\path\ai.docx --revised D:\path\mine.docx --genre lecture
 *   node scripts/calibrate.mjs --original ai.md --revised mine.md --extras "D:\真稿目录" --out report.json
 *
 * 输出：
 *   1. 学习前：两份文本的 AI 特征分；
 *   2. 学习后：同一对文本的分数、命中的个人规则数；
 *   3. 学到的规则清单与画像卡；
 *   4. 若给了 --extras（文件或目录），把你自己的真稿当负样本跑一遍误报率。
 *
 * 退出码：0 表示分离成立（原稿分明显高于修订稿，或原稿命中规则更多）；--strict 时
 * 还要求修订稿分数低于门禁线、误报率不高于 10%。
 */

import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const out = { genre: '', home: '', out: '', extras: [], strict: false, keep: false, threshold: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--original') out.original = next();
    else if (arg === '--revised') out.revised = next();
    else if (arg === '--genre') out.genre = next();
    else if (arg === '--home') out.home = next();
    else if (arg === '--out') out.out = next();
    else if (arg === '--extras') out.extras.push(next());
    else if (arg === '--threshold') out.threshold = Number(next());
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function usage() {
  console.log('用法：node scripts/calibrate.mjs --original <AI原稿> --revised <你的修订稿> [--genre lecture] [--extras <文件或目录>] [--out report.json] [--strict]');
}

function collectFiles(target) {
  const files = [];
  const walk = (file, depth) => {
    if (depth > 5) return;
    let info;
    try { info = statSync(file); } catch { return; }
    if (info.isFile()) {
      if (/\.(docx|pptx|md|markdown|txt)$/i.test(file)) files.push(file);
      return;
    }
    if (!info.isDirectory()) return;
    let entries = [];
    try { entries = readdirSync(file); } catch { return; }
    for (const name of entries) walk(join(file, name), depth + 1);
  };
  walk(target, 0);
  return files;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }
if (!args.original || !args.revised) { usage(); process.exit(2); }

const home = args.home ? resolve(args.home) : mkdtempSync(join(tmpdir(), 'style-memory-calibrate-'));
if (!existsSync(home)) mkdirSync(home, { recursive: true });
process.env.DSH_STYLE_MEMORY_HOME = home;

const { extractTextFromFile } = await import(pathToFileURL(join(ROOT, 'lib', 'textio.js')).href);
const { analyzeText } = await import(pathToFileURL(join(ROOT, 'lib', 'detect.js')).href);
const { loadConfig } = await import(pathToFileURL(join(ROOT, 'lib', 'store.js')).href);
const { loadProfile } = await import(pathToFileURL(join(ROOT, 'lib', 'profile.js')).href);
const { learnFromInputs, invalidateProfile } = await import(pathToFileURL(join(ROOT, 'lib', 'service.js')).href);
const { buildCard } = await import(pathToFileURL(join(ROOT, 'lib', 'card.js')).href);

const config = loadConfig(home);
const threshold = Number.isFinite(args.threshold) ? args.threshold : ((config.gate && config.gate.threshold) || 60);

function loadText(path, label) {
  const resolved = resolve(path);
  const extracted = extractTextFromFile(resolved);
  if (!extracted.ok) {
    console.error(label + ' 读取失败：' + extracted.error + '（' + resolved + '）');
    process.exit(2);
  }
  return { path: resolved, text: extracted.text, chars: extracted.chars };
}

const original = loadText(args.original, 'AI 原稿');
const revised = loadText(args.revised, '修订稿');
const genre = args.genre || 'global';

console.log('风格记忆 · 真实数据校准');
console.log('数据目录：' + home);
console.log('AI 原稿：' + original.path + '（' + original.chars + ' 字）');
console.log('修订稿：' + revised.path + '（' + revised.chars + ' 字）');
console.log('文种：' + genre + ' · 门禁线：' + threshold);
console.log('');

const beforeAi = analyzeText(original.text, { config: config });
const beforeUser = analyzeText(revised.text, { config: config });
console.log('== 学习前（无个人档案）==');
console.log('AI 原稿：' + beforeAi.score + '/100（' + beforeAi.band + '），命中问题 ' + beforeAi.issues.length + ' 项');
console.log('修订稿：' + beforeUser.score + '/100（' + beforeUser.band + '），命中问题 ' + beforeUser.issues.length + ' 项');
console.log('');

const learn = learnFromInputs({
  original_text: original.text,
  revised_text: revised.text,
  genre: genre,
  note: 'calibrate.mjs 校准',
  config: config,
  dir: home,
  cwd: home
});
if (!learn.ok) {
  console.error('学习失败：' + learn.error);
  process.exit(1);
}
invalidateProfile();
console.log('== 学习结果 ==');
console.log('改动 ' + learn.stats.edits + ' 处；新增 ' + learn.added + ' 条、更新 ' + learn.updated + ' 条、生效 ' + learn.promoted + ' 条、归档 ' + learn.removed + ' 条；指标区间更新 ' + learn.metrics_updated + ' 项；档案 v' + learn.version);
console.log('');
console.log('== 学到的规则（top 12）==');
for (const item of (learn.top_proposals || []).slice(0, 12)) {
  const body = item.type === 'rewrite' ? '「' + item.text + '」->「' + (item.to || '') + '」' : item.text;
  console.log('- [' + item.type + '] ' + body + '（证据 ' + (item.hits || 1) + ' 次' + (item.evidence === -1 ? '，负面' : '') + '）');
}
console.log('');

const profile = loadProfile(home);
const afterAi = analyzeText(original.text, { profile: profile, genre: genre, config: config });
const afterUser = analyzeText(revised.text, { profile: profile, genre: genre, config: config });
console.log('== 学习后（带个人档案）==');
console.log('AI 原稿：' + afterAi.score + '/100（' + afterAi.band + '），命中个人规则 ' + afterAi.ruleHits.length + ' 条 / ' + afterAi.ruleHits.reduce((acc, hit) => acc + hit.count, 0) + ' 处，个人基线偏离 ' + afterAi.personalDeviation.penalty + ' 分');
console.log('修订稿：' + afterUser.score + '/100（' + afterUser.band + '），命中个人规则 ' + afterUser.ruleHits.length + ' 条 / ' + afterUser.ruleHits.reduce((acc, hit) => acc + hit.count, 0) + ' 处，个人基线偏离 ' + afterUser.personalDeviation.penalty + ' 分');
console.log('');

const card = buildCard(profile, genre, (config.inject && config.inject.maxChars) || 400);
console.log('== 画像卡（会注入到新会话）==');
console.log(card || '（空：没有规则或指标）');
console.log('');

let extrasReport = null;
if (args.extras.length > 0) {
  const files = [];
  for (const target of args.extras) {
    const resolved = resolve(target);
    if (!existsSync(resolved)) continue;
    if (statSync(resolved).isDirectory()) files.push.apply(files, collectFiles(resolved));
    else files.push(resolved);
  }
  const unique = Array.from(new Set(files));
  const rows = [];
  let flagged = 0;
  for (const file of unique.slice(0, 40)) {
    const extracted = extractTextFromFile(file);
    if (!extracted.ok) continue;
    const result = analyzeText(extracted.text, { profile: profile, genre: genre, config: config });
    if (result.score >= threshold) flagged += 1;
    rows.push({ file: file, score: result.score, chars: extracted.chars });
  }
  const rate = rows.length > 0 ? flagged / rows.length : 0;
  extrasReport = { total: rows.length, flagged: flagged, rate: rate, rows: rows };
  console.log('== 误报检查（你的真稿当负样本）==');
  console.log('样本 ' + rows.length + ' 份；被判 ≥' + threshold + ' 的 ' + flagged + ' 份，误报率 ' + (rate * 100).toFixed(1) + '%（目标 ≤10%）');
  for (const row of rows.slice(0, 10)) console.log('- ' + row.score + ' 分：' + row.file);
  console.log('');
}

const separation = (afterAi.score - afterUser.score >= 10) || (afterAi.ruleHits.length > afterUser.ruleHits.length);
const falsePositiveOk = extrasReport === null || extrasReport.rate <= 0.1;
const strictOk = afterUser.score < threshold && falsePositiveOk;
const passed = args.strict ? (separation && strictOk) : separation;
console.log('== 结论 ==');
console.log('分离度：' + (separation ? '成立' : '不成立') + '（AI 稿 ' + afterAi.score + ' vs 修订稿 ' + afterUser.score + '，规则命中 ' + afterAi.ruleHits.length + ' vs ' + afterUser.ruleHits.length + '）');
if (extrasReport !== null) console.log('误报率：' + (extrasReport.rate * 100).toFixed(1) + '% ' + (falsePositiveOk ? '（达标）' : '（超标）'));
console.log('结果：' + (passed ? 'PASS' : 'FAIL') + (args.strict ? '（strict）' : ''));

const report = {
  at: new Date().toISOString(),
  home: home,
  genre: genre,
  threshold: threshold,
  before: { ai: beforeAi.score, revised: beforeUser.score },
  after: {
    ai: { score: afterAi.score, band: afterAi.band, ruleHits: afterAi.ruleHits.length, deviation: afterAi.personalDeviation.penalty },
    revised: { score: afterUser.score, band: afterUser.band, ruleHits: afterUser.ruleHits.length, deviation: afterUser.personalDeviation.penalty }
  },
  learn: { version: learn.version, added: learn.added, updated: learn.updated, promoted: learn.promoted, removed: learn.removed, edits: learn.stats.edits },
  card: card,
  extras: extrasReport,
  separation: separation,
  passed: passed
};
if (args.out) {
  writeFileSync(resolve(args.out), JSON.stringify(report, null, 2), 'utf8');
  console.log('报告已写入：' + resolve(args.out));
}
if (!args.home && !args.keep) {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(passed ? 0 : 1);
