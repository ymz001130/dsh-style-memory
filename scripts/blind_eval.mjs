/**
 * 盲测验收脚本（离线）：把「AI 写的」和「你本人写的」两段文本随机标成 A/B，
 * 生成一个评审包，让独立评审（人，或另一个模型/子代理）判断哪段是本人写的。
 *
 * 用法一（盲测哪段是人写的）：
 *   node scripts/blind_eval.mjs --ai D:\tmp\ai.md --human D:\tmp\mine.md --card-auto --out D:\tmp\blind
 *   node scripts/blind_eval.mjs --ai ai.md --human mine.md --card style-card.txt --out blind --seed 7
 *
 * 用法二（误报率：拿自己的真稿当负样本）：
 *   node scripts/blind_eval.mjs --fp "D:\我的真稿目录" --home %USERPROFILE%\.dsh\style-memory
 *
 * 用法三（核对评审答案）：
 *   node scripts/blind_eval.mjs --check D:\tmp\blind --answer "A"
 *
 * 判定标准（方法论第 12 节）：
 *   - 平局/接近就说明注入后不可区分，盲测正确率 ≤65% 为达标，50% 最好；
 *   - 误报率（真稿被判 ≥ 门禁线的比例）目标 ≤10%。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const out = { extras: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--ai') out.ai = next();
    else if (arg === '--human') out.human = next();
    else if (arg === '--card') out.card = next();
    else if (arg === '--card-auto') out.cardAuto = true;
    else if (arg === '--out') out.out = next();
    else if (arg === '--seed') out.seed = Number(next());
    else if (arg === '--home') out.home = next();
    else if (arg === '--fp') out.fp = next();
    else if (arg === '--check') out.check = next();
    else if (arg === '--answer') out.answer = next();
    else if (arg === '--threshold') out.threshold = Number(next());
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function usage() {
  console.log('用法：');
  console.log('  node scripts/blind_eval.mjs --ai <AI稿> --human <本人稿> [--card <风格卡文件>|--card-auto] [--out <目录>] [--seed N]');
  console.log('  node scripts/blind_eval.mjs --fp <真稿文件或目录> [--home <数据目录>] [--threshold 60]');
  console.log('  node scripts/blind_eval.mjs --check <盲测包目录> --answer <A|B>');
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

function seededRandom(seed) {
  let state = (Number(seed) || Date.now()) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }

if (args.check) {
  const dir = resolve(args.check);
  const mappingFile = join(dir, 'mapping.json');
  if (!existsSync(mappingFile)) { console.error('找不到 mapping.json：' + mappingFile); process.exit(2); }
  const mapping = JSON.parse(readFileSync(mappingFile, 'utf8'));
  const answer = String(args.answer || '').trim().toUpperCase();
  const expected = mapping.human === 'A' ? 'A' : 'B';
  const correct = answer === expected;
  console.log('评审答案：' + answer + ' · 正确答案：' + expected + ' · ' + (correct ? '判断正确（看穿了）' : '判断错误/接近平局（更像人）'));
  console.log('说明：' + (correct ? '这次盲测判对，说明 AI 稿的人味还不够；继续用修订对学习。' : '这次盲测没判对，是达标结果（正确率越低越好）。'));
  process.exit(correct ? 1 : 0);
}

const home = args.home ? resolve(args.home) : (process.env.DSH_STYLE_MEMORY_HOME || '');
if (home) process.env.DSH_STYLE_MEMORY_HOME = home;

if (args.fp) {
  const target = resolve(args.fp);
  if (!existsSync(target)) { console.error('路径不存在：' + target); process.exit(2); }
  const files = collectFiles(target);
  const { extractTextFromFile } = await import(pathToFileURL(join(ROOT, 'lib', 'textio.js')).href);
  const { analyzeText } = await import(pathToFileURL(join(ROOT, 'lib', 'detect.js')).href);
  const { loadConfig, stateDir } = await import(pathToFileURL(join(ROOT, 'lib', 'store.js')).href);
  const { loadProfile } = await import(pathToFileURL(join(ROOT, 'lib', 'profile.js')).href);
  const config = loadConfig(stateDir());
  const profile = loadProfile(stateDir());
  const threshold = Number.isFinite(args.threshold) ? args.threshold : ((config.gate && config.gate.threshold) || 60);
  let total = 0;
  let flagged = 0;
  const rows = [];
  for (const file of files.slice(0, 60)) {
    const extracted = extractTextFromFile(file);
    if (!extracted.ok || extracted.chars < 120) continue;
    const result = analyzeText(extracted.text, { profile: profile, genre: 'global', config: config });
    total += 1;
    if (result.score >= threshold) flagged += 1;
    rows.push({ file: file, score: result.score });
  }
  const rate = total > 0 ? flagged / total : 0;
  console.log('误报率检查：样本 ' + total + ' 份；被判 ≥' + threshold + ' 的 ' + flagged + ' 份，误报率 ' + (rate * 100).toFixed(1) + '%（目标 ≤10%）');
  rows.sort((a, b) => b.score - a.score);
  for (const row of rows.slice(0, 15)) console.log('- ' + row.score + ' 分：' + row.file);
  process.exit(rate <= 0.1 ? 0 : 1);
}

if (!args.ai || !args.human) { usage(); process.exit(2); }

const cardText = (() => {
  if (args.card) {
    const file = resolve(args.card);
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  }
  return '';
})();

async function autoCard() {
  const { loadConfig, stateDir } = await import(pathToFileURL(join(ROOT, 'lib', 'store.js')).href);
  const { loadProfile } = await import(pathToFileURL(join(ROOT, 'lib', 'profile.js')).href);
  const { buildCard } = await import(pathToFileURL(join(ROOT, 'lib', 'card.js')).href);
  const { pickDefaultGenre } = await import(pathToFileURL(join(ROOT, 'lib', 'service.js')).href);
  const dir = stateDir();
  const config = loadConfig(dir);
  const profile = loadProfile(dir);
  return buildCard(profile, pickDefaultGenre(profile), (config.inject && config.inject.maxChars) || 400);
}

const { extractTextFromFile } = await import(pathToFileURL(join(ROOT, 'lib', 'textio.js')).href);
function loadBlindText(file, label) {
  const extracted = extractTextFromFile(resolve(file));
  if (!extracted.ok) {
    console.error(label + ' 读取失败：' + extracted.error);
    process.exit(2);
  }
  const value = extracted.text.replace(/^\uFEFF/, '').trim();
  if (value.length === 0) {
    console.error(label + ' 没有可读文本');
    process.exit(2);
  }
  if (value.indexOf('\uFFFD') >= 0 || value.indexOf('\u0000') >= 0) {
    console.error(label + ' 提取结果含替换字符/空字节，判定为二进制误读，已中止。');
    process.exit(2);
  }
  return value;
}
const finalCard = cardText.length > 0 ? cardText : (args.cardAuto ? await autoCard() : '（本次未提供风格卡，评审只依据文本本身判断）');
const aiText = loadBlindText(args.ai, 'AI 稿');
const humanText = loadBlindText(args.human, '本人稿');

const targetLength = Math.min(1200, aiText.length, humanText.length);
const trim = (text) => {
  const clean = text.replace(/\r\n?/g, '\n').trim();
  return clean.length <= targetLength ? clean : clean.slice(0, targetLength) + '…';
};
const aiTrimmed = trim(aiText);
const humanTrimmed = trim(humanText);

const random = seededRandom(args.seed);
const humanIsA = random() < 0.5;
const textA = humanIsA ? humanTrimmed : aiTrimmed;
const textB = humanIsA ? aiTrimmed : humanTrimmed;
const mapping = {
  human: humanIsA ? 'A' : 'B',
  ai: humanIsA ? 'B' : 'A',
  aiFile: resolve(args.ai),
  humanFile: resolve(args.human),
  targetLength: targetLength,
  createdAt: new Date().toISOString()
};

const outDir = resolve(args.out || join(process.cwd(), 'blind-test-' + Date.now()));
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'text-a.txt'), textA + '\n', 'utf8');
writeFileSync(join(outDir, 'text-b.txt'), textB + '\n', 'utf8');
writeFileSync(join(outDir, 'mapping.json'), JSON.stringify(mapping, null, 2), 'utf8');

const judgePrompt = [
  '你是一名独立评审。下面给出一张「用户写作风格卡」和两段无标注文本（A、B），其中一段是这位用户本人写的，另一段是 AI 写的（可能经过风格卡注入）。',
  '',
  '请只依据文本判断：哪一段更像这位用户本人写的。不要猜测生成工具，不要因为文本里的事实内容给分。',
  '',
  '【用户写作风格卡】',
  finalCard,
  '',
  '【文本 A】',
  textA,
  '',
  '【文本 B】',
  textB,
  '',
  '【输出要求】只输出严格 JSON，不要解释：',
  '{"human":"A 或 B","confidence":0到1之间的小数,"reasons":["理由1","理由2"],"scores":{"A":{"style_fit":1到5的整数,"ai_feel":1到5的整数},"B":{"style_fit":1到5的整数,"ai_feel":1到5的整数}}}',
  '',
  '评分说明：style_fit 越高表示越像这位用户的写法；ai_feel 越高表示越像 AI 腔。'
].join('\n');
writeFileSync(join(outDir, 'judge-prompt.md'), judgePrompt + '\n', 'utf8');
writeFileSync(join(outDir, 'README.txt'), [
  '盲测包已生成：' + outDir,
  '',
  '1. 把 judge-prompt.md 的全文交给独立评审（另一个模型/子代理，或人）。不要告诉它哪段是 AI。',
  '2. 评审返回 JSON 里的 human 字段就是它的判断。',
  '3. 用下面的命令核对：',
  '   node scripts/blind_eval.mjs --check "' + outDir + '" --answer <评审给的 A/B>',
  '4. mapping.json 里有真实答案，别提前给评审看。',
  '',
  '判定：评审判对（看穿）说明注入后还不够像；判错/接近平局是达标结果。建议 ≥20 组再下结论。'
].join('\n') + '\n', 'utf8');

console.log('盲测包：' + outDir);
console.log('文本 A：' + textA.length + ' 字；文本 B：' + textB.length + ' 字');
console.log('真实答案已写入 mapping.json（A=人写 或 B=人写），评审看 judge-prompt.md。');
console.log('核对：node scripts/blind_eval.mjs --check "' + outDir + '" --answer <A|B>');
console.log('');
console.log('提示：评审请用另一个模型/子代理，别用写稿的同一个上下文，否则自评偏差会系统性偏乐观。');
