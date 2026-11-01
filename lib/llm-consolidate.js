/**
 * 档案整合（LLM 判断 + 本地兜底）。
 *
 * 触发场景：手动 /style consolidate、工具 style_profile(consolidate)、
 * 以及自动清理快照之前（用户要求：清理前先由 LLM 判断整理，防止丢重要经验）。
 *
 * LLM 只做「合并同义规则 / 归档过时规则」，不允许改事实；
 * 解析失败一律回退本地确定性整理，不影响档案可用性。
 */

import { randomUUID } from 'node:crypto';

import { GENRES } from './constants.js';
import { confidenceOf, mergeProposal, normalizePhrase, ruleScore } from './profile.js';
import { similarity } from './features.js';

const LLM_TIMEOUT_MS = 45000;
const FENCE = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);

/** 本地确定性整合：同义合并、弱证据归档。 */
export function consolidateLocal(profile, genre, config) {
  const genres = genre && genre !== 'global' ? [genre, 'global'] : ['global'];
  const summary = { merged: 0, archived: 0, kept: 0, mode: 'local' };
  for (const g of genres) {
    const slot = profile.genres[g];
    if (!slot || !Array.isArray(slot.rules)) continue;
    const rules = slot.rules;
    const removed = new Set();
    for (let i = 0; i < rules.length; i += 1) {
      if (removed.has(i)) continue;
      for (let j = i + 1; j < rules.length; j += 1) {
        if (removed.has(j)) continue;
        const a = rules[i];
        const b = rules[j];
        if (a.type !== b.type) continue;
        if (a.status === 'archived' || b.status === 'archived') continue;
        const sameTarget = normalizePhrase(a.to || '') === normalizePhrase(b.to || '');
        const sim = similarity(a.text, b.text);
        if (!(sim >= 0.85 || (sameTarget && sim >= 0.6))) continue;
        const keep = ruleScore(a) >= ruleScore(b) ? a : b;
        const drop = keep === a ? b : a;
        keep.pos += drop.pos;
        keep.neg += drop.neg;
        keep.boost = Math.max(Number(keep.boost) || 0, Number(drop.boost) || 0);
        keep.confidence = confidenceOf(keep.pos, keep.neg, keep.boost);
        drop.status = 'archived';
        drop.why = (drop.why || '') + '（已合并到同类规则）';
        summary.merged += 1;
        removed.add(keep === a ? j : i);
      }
    }
    for (const rule of rules) {
      if (rule.status === 'archived') { summary.archived += 1; continue; }
      if (rule.pos === 0 && rule.neg >= 2) {
        rule.status = 'archived';
        summary.archived += 1;
        continue;
      }
      summary.kept += 1;
    }
  }
  return summary;
}

/** 从模型输出里提取 JSON 对象（容忍代码块与前后噪声）。 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(new RegExp(FENCE + '(?:json)?\\s*([\\s\\S]*?)' + FENCE));
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

/** 构造整合提示词。 */
export function buildConsolidationPrompt(profile, genre) {
  const genres = genre && genre !== 'global' ? [genre, 'global'] : ['global'];
  const rules = [];
  for (const g of genres) {
    const slot = profile.genres[g];
    if (!slot || !Array.isArray(slot.rules)) continue;
    for (const rule of slot.rules.filter((item) => item.status !== 'archived').slice(0, 120)) {
      rules.push({
        id: rule.id,
        genre: g,
        type: rule.type,
        text: rule.text,
        to: rule.to || '',
        pos: rule.pos,
        neg: rule.neg,
        confidence: rule.confidence,
        why: (rule.why || '').slice(0, 80)
      });
    }
  }
  const metrics = {};
  for (const g of genres) {
    const slot = profile.genres[g];
    if (!slot) continue;
    for (const key of Object.keys(slot.metrics || {})) metrics[key] = slot.metrics[key];
  }
  const payload = { version: profile.version, genre: genre || 'global', rules: rules, metrics: metrics };
  const instruction = [
    '你是「风格档案」的整理器。输入是用户从 AI 原稿修订中学习到的规则（含证据计数与置信度）和指标区间。',
    '任务：',
    '1. 合并同义/近义规则：保留证据更强的一条，把其它 id 放进 drop；',
    '2. 归档明显过时或矛盾的规则（例如后续修订已不再这样写）；',
    '3. 最多补充 3 条高层规则（从多条证据里归纳，例如“少用解释性补白”），但不能编造原始文本里没有的表达。',
    '',
    '只输出严格 JSON，不要解释；格式：',
    '{"merge":[{"keep":"<规则id>","drop":["<规则id>","..."],"reason":"一句话"}],"add":[{"type":"banned_phrase|preferred_phrase|rewrite|structural","text":"...","to":"...","why":"...","fix":"...","genre":"<genre>"}]}',
    '没有要改的就输出 {"merge":[],"add":[]}。'
  ].join('\n');
  return instruction + '\n\n输入 JSON：\n' + JSON.stringify(payload);
}

/** 应用 LLM 整合结果。 */
export function applyConsolidation(profile, data, genre, config) {
  const summary = { merged: 0, archived: 0, added: 0, mode: 'llm' };
  if (!data || typeof data !== 'object') return summary;
  const dropIds = new Set();
  if (Array.isArray(data.merge)) {
    for (const item of data.merge) {
      if (!item || typeof item !== 'object') continue;
      const drops = Array.isArray(item.drop) ? item.drop : [];
      for (const id of drops) if (typeof id === 'string') dropIds.add(id);
    }
  }
  const genres = genre && genre !== 'global' ? [genre, 'global'] : ['global'];
  for (const g of genres) {
    const slot = profile.genres[g];
    if (!slot || !Array.isArray(slot.rules)) continue;
    for (const rule of slot.rules) {
      if (dropIds.has(rule.id) && rule.status !== 'archived') {
        rule.status = 'archived';
        rule.why = (rule.why || '') + '（LLM 整合：与同类规则合并）';
        summary.archived += 1;
      }
    }
  }
  if (Array.isArray(data.add)) {
    for (const item of data.add.slice(0, 3)) {
      if (!item || typeof item !== 'object') continue;
      const type = String(item.type || '');
      if (['banned_phrase', 'preferred_phrase', 'rewrite', 'structural', 'opening', 'closing', 'term'].indexOf(type) === -1) continue;
      const targetGenre = GENRES.indexOf(item.genre) >= 0 ? item.genre : genre;
      const result = mergeProposal(profile, targetGenre, {
        type: type,
        text: item.text,
        to: item.to || '',
        why: item.why || 'LLM 整合时归纳的高层规则',
        fix: item.fix || '',
        evidence: 1,
        trust: 0.7
      }, config);
      if (result.rule) summary.added += 1;
    }
  }
  summary.merged = dropIds.size;
  return summary;
}

/**
 * 用宿主模型做一次整合。llm 服务不可用或超时则返回 null，由调用方回退本地整理。
 */
/** 判断模型整合的前置条件，返回可读原因，便于在 /style consolidate 里显示。 */
export function consolidationDiagnostics(input) {
  const llm = input && input.llm;
  const agent = input && input.agent;
  if (!llm || typeof llm.stream !== 'function') return { ready: false, reason: 'llm-service-unavailable' };
  if (!agent || !agent.options) return { ready: false, reason: 'agent-unavailable' };
  if (!agent.options.provider || !agent.options.model) return { ready: false, reason: 'agent-model-unknown' };
  return { ready: true, reason: 'ready' };
}

export async function consolidateWithModel(input) {
  const detailed = await consolidateWithModelDetailed(input);
  return detailed.summary;
}

/** 与 consolidateWithModel 相同，但返回 {summary, reason}，reason 用于审计与界面提示。 */
function previewOf(text, limit) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  return value.slice(0, limit) + '…';
}

export async function consolidateWithModelDetailed(input) {
  const diagnostics = consolidationDiagnostics(input);
  if (!diagnostics.ready) return { summary: null, reason: diagnostics.reason };
  const llm = input.llm;
  const agent = input.agent;
  const provider = agent.options.provider;
  const model = agent.options.model;
  const prompt = buildConsolidationPrompt(input.profile, input.genre);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const stream = llm.stream({
      provider: provider,
      model: model,
      messages: [{ id: 'style-memory-consolidate-' + randomUUID(), role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }],
      system: '你是一个严谨的档案整理器，只输出 JSON。',
      maxTokens: 2000,
      temperature: 0.1,
      signal: controller.signal
    });
    const chunkTypes = {};
    let text = '';
    let reasoningText = '';
    let blockContent = '';
    for await (const chunk of stream) {
      const chunkType = chunk && chunk.type ? chunk.type : 'unknown';
      chunkTypes[chunkType] = (chunkTypes[chunkType] || 0) + 1;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoningText += chunk.text;
      if (chunk.type === 'block-end') {
        const content = chunk.content || (chunk.block && chunk.block.content) || (chunk.message && chunk.message.content);
        if (Array.isArray(content)) {
          for (const part of content) if (part && typeof part.text === 'string') blockContent += part.text;
        } else if (typeof content === 'string') {
          blockContent += content;
        }
      }
      if (text.length > 200000) break;
    }
    if (text.length === 0 && blockContent.length > 0) text = blockContent;
    if (text.length === 0 && reasoningText.length > 0) text = reasoningText;
    let data = extractJson(text);
    let lastText = text;
    let lastTextLength = text.length;
    if (data === null) {
      const reasoningExcerpt = reasoningText ? reasoningText.slice(-1600) : '';
      const retryPrompt = prompt + '\n\n你上面的思考已经完成，摘录如下：\n' + reasoningExcerpt + '\n\n现在只输出最终 JSON，不要任何思考过程、解释、markdown 或代码块。没有要改的就输出 {"merge":[],"add":[]}。';
      const retryController = new AbortController();
      const retryTimer = setTimeout(() => retryController.abort(), LLM_TIMEOUT_MS);
      try {
        const retryStream = llm.stream({
          provider: provider,
          model: model,
          messages: [{ id: 'style-memory-consolidate-retry-' + randomUUID(), role: 'user', content: [{ type: 'text', text: retryPrompt }], source: { kind: 'user' } }],
          system: '你已经完成思考。现在只输出严格 JSON 对象，不要任何解释或思考过程。',
          maxTokens: 1200,
          temperature: 0.1,
          signal: retryController.signal
        });
        let retryText = '';
        let retryReasoning = '';
        for await (const chunk of retryStream) {
          const chunkType = chunk && chunk.type ? chunk.type : 'unknown';
          chunkTypes[chunkType] = (chunkTypes[chunkType] || 0) + 1;
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') retryText += chunk.text;
          if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') retryReasoning += chunk.text;
          if (retryText.length > 200000) break;
        }
        if (retryText.length === 0 && retryReasoning.length > 0) retryText = retryReasoning;
        data = extractJson(retryText);
        lastText = retryText;
        lastTextLength = retryText.length;
      } finally {
        clearTimeout(retryTimer);
      }
    }
    if (data === null) {
      return {
        summary: null,
        reason: 'model-output-not-json:textLen=' + lastTextLength,
        preview: previewOf(lastText, 200),
        chunkTypes: chunkTypes
      };
    }
    return { summary: applyConsolidation(input.profile, data, input.genre, input.config), reason: 'llm' };
  } catch {
    return { summary: null, reason: 'model-call-failed' };
  } finally {
    clearTimeout(timer);
  }
}
