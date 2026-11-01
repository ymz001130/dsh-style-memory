/**
 * present 前的交付门禁：
 *   AI 特征分 ≥ 阈值 → 首次拦截并给诊断；
 *   改写后（内容哈希变化）重新检测，分数下降即放行；
 *   同一文件连续 maxAttempts 次仍未过 → 留审计后放行（fail-open）。
 * 只用本地检测，不调用模型，不拖慢交付。
 */

import { extname, isAbsolute, resolve } from 'node:path';

import { analyzeText } from './detect.js';
import { extractTextFromFile, isSupportedDoc } from './textio.js';

/** 从 present 参数里取出文件路径。 */
export function presentFilePaths(args) {
  const files = args && Array.isArray(args.files) ? args.files : [];
  const out = [];
  for (const file of files) {
    const raw = typeof file === 'string' ? file : (file && file.path);
    if (typeof raw === 'string' && raw.trim().length > 0) out.push(raw.trim());
  }
  return out;
}

/** 解析绝对路径。 */
export function absolutePath(raw, cwd) {
  return isAbsolute(raw) ? raw : resolve(cwd || process.cwd(), raw);
}

/** 把一次检测的诊断写成人能直接改的清单。 */
export function formatDiagnosis(analysis, filePath) {
  const lines = [];
  lines.push('⛔ 风格记忆·交付前检查：这份文档的 AI 特征分是 ' + analysis.score + '/100（阈值 ' + analysis.thresholds.gate + '）。');
  lines.push('文档：' + filePath);
  if (analysis.ruleHits.length > 0) {
    lines.push('');
    lines.push('命中你档案里记录过的表达（你改稿时删过/改过的）：');
    for (const hit of analysis.ruleHits.slice(0, 6)) {
      const sample = hit.samples && hit.samples[0] ? '，例如：' + hit.samples[0].text.slice(0, 40) : '';
      lines.push('- “' + hit.text + '”（' + hit.count + ' 次）' + sample);
    }
  }
  if (analysis.issues.length > 0) {
    lines.push('');
    lines.push('检测到的主要 AI 特征：');
    for (const issue of analysis.issues.slice(0, 6)) {
      const sample = issue.samples && issue.samples[0] && issue.samples[0].sentence
        ? ' —— 例如：' + issue.samples[0].sentence.slice(0, 50)
        : '';
      lines.push('- [' + issue.severity + '] ' + issue.why + sample);
    }
  }
  if (analysis.suggestions.length > 0) {
    lines.push('');
    lines.push('改法（按顺序改最重的几处）：');
    analysis.suggestions.slice(0, 5).forEach((item, index) => lines.push((index + 1) + '. ' + item));
  }
  if (analysis.humanFeatures.length > 0) {
    lines.push('');
    lines.push('保留这些像人写的部分：' + analysis.humanFeatures.slice(0, 6).map((item) => item.label).join('、') + '。');
  }
  lines.push('');
  lines.push('说明：插件按文件内容哈希判断。改写并覆盖保存后再调用 present，分数降到阈值以下就会放行；同一文件连续 ' + analysis.thresholds.gateMaxAttempts + ' 次未过会留审计后放行。不要为了过门禁编造事实或删掉关键内容。');
  return lines.join('\n');
}

/**
 * 评估一次 present。
 * @param {object} input {args, agentState, cwd, config, profile}
 * @returns {{ decision: 'allow'|'deny', reason?: string, checked?: object[] }}
 */
export function evaluatePresent(input) {
  const config = input.config || {};
  const gateConfig = config.gate || {};
  const files = presentFilePaths(input.args);
  if (files.length === 0) return { decision: 'allow', checked: [] };
  if (gateConfig.enabled === false || config.enabled === false) return { decision: 'allow', checked: [] };
  const threshold = Number(gateConfig.threshold) || 60;
  const maxAttempts = Number(gateConfig.maxAttempts) || 3;
  const cwd = input.cwd || process.cwd();
  const allowedExts = Array.isArray(gateConfig.extensions) && gateConfig.extensions.length > 0
    ? gateConfig.extensions.map((item) => String(item).toLowerCase())
    : ['.docx', '.pptx'];
  const checked = [];
  const denials = [];

  for (const raw of files) {
    if (!isSupportedDoc(raw)) continue;
    if (allowedExts.indexOf(extname(raw).toLowerCase()) === -1) continue;
    const absolute = absolutePath(raw, cwd);
    const extracted = extractTextFromFile(absolute);
    if (!extracted.ok) {
      checked.push({ path: absolute, skipped: true, error: extracted.error });
      continue;
    }
    const analysis = analyzeText(extracted.text, { profile: input.profile, genre: input.genre || 'global', config: config });
    analysis.thresholds.gate = threshold;
    analysis.thresholds.gateMaxAttempts = maxAttempts;
    const record = input.agentState ? input.agentState.recordFor(absolute) : { attempts: 0, lastHash: '', lastScore: 0 };
    const contentHash = input.agentState ? input.agentState.hashOf(extracted.text) : '';
    const previousScore = record.lastScore;
    const changedSinceLastTime = record.lastHash !== '' && record.lastHash !== contentHash;
    const improved = previousScore > 0 && analysis.score < previousScore;

    checked.push({ path: absolute, score: analysis.score, hash: contentHash, attempts: record.attempts });

    if (analysis.score < threshold) {
      if (input.agentState) input.agentState.markPassed(absolute, contentHash, analysis.score);
      continue;
    }
    if (record.attempts > 0 && changedSinceLastTime && improved) {
      if (input.agentState) input.agentState.markPassed(absolute, contentHash, analysis.score);
      continue;
    }
    if (record.attempts >= maxAttempts) {
      if (input.agentState) input.agentState.markPassed(absolute, contentHash, analysis.score);
      continue;
    }
    const reason = formatDiagnosis(analysis, absolute);
    const updated = input.agentState ? input.agentState.markDenied(absolute, contentHash, analysis.score) : { attempts: record.attempts + 1 };
    denials.push(reason + '\n（第 ' + updated.attempts + '/' + maxAttempts + ' 次拦截）');
  }

  if (denials.length > 0) return { decision: 'deny', reason: denials.join('\n\n'), checked: checked };
  return { decision: 'allow', checked: checked };
}
