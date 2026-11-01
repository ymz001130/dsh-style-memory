/**
 * dsh-style-memory 插件入口。
 *
 * 接线：
 *   - systemPrompt.section('style-memory:profile')：每个新会话注入 ≤400 字画像卡（主代理完整、子代理精简）；
 *   - 工具：style_analyze / style_learn / style_profile；
 *   - 命令：/style [status|on|off|card|profile|undo|consolidate|reset confirm]；
 *   - agent/pre-step：用户消息带回改过的文档 → 自动配对学习，并把结果作为近距提醒注入；
 *   - agent/turn-stopping：把会话消息里的口语特征并入 chat 画像；
 *   - tools/pre-execute：present 前的 AI 特征软门禁；
 *   - tools/post-execute：交付成功后存纯文本快照，并按保留策略清理（清理前先整合）。
 *
 * 插件是依赖自由的：只用 Node 内置模块与宿主服务（tools / systemPrompt / commands / agents / llm），
 * 不 import @deepseek-ai 包，保证 profile 无需安装运行时依赖。
 */

import { GENRES, PLUGIN_LABEL, SECTION_FOOTER, SECTION_HEADER, SECTION_NAME, SECTION_ORDER, TOOL_HINTS, VERSION } from './lib/constants.js';
import { buildCard, buildCompactCard } from './lib/card.js';
import { agentState, dropAgentState, pluginMessage, rememberMessage, resetTurnState } from './lib/state.js';
import { loadConfig, saveConfig, stateDir } from './lib/store.js';
import { audit } from './lib/store.js';
import { absolutePath, presentFilePaths } from './lib/gate.js';
import {
  analyzeInput, captureDeliveredFiles, consolidateNow, evaluatePresentForAgent,
  flushChatLearning, getProfile, invalidateProfile, learnFromInputs, maybeCleanup,
  panelRulesAndHistory, pickDefaultGenre, profileAction, resolveCwd, statusText, tryAutoLearnFromMessage
} from './lib/service.js';

export const name = 'style-memory';
export const inject = ['tools', 'systemPrompt'];

function log() {
  try {
    const args = Array.prototype.slice.call(arguments);
    console.log.apply(console, ['[dsh-style-memory]'].concat(args));
  } catch { /* never break a turn */ }
}

function errorText(error) {
  return String((error && error.message) || error);
}

/** 工具返回值必须是 lossless JSON：去掉 undefined、函数、循环引用等。 */
function jsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return { ok: false, error: '工具返回值序列化失败：' + errorText(error) };
  }
}

function isRootAgent(ctx, agent) {
  try {
    const registry = ctx.get('agents');
    if (registry !== undefined && typeof registry.roots === 'function') {
      const roots = registry.roots();
      if (Array.isArray(roots)) return roots.indexOf(agent) !== -1;
    }
  } catch { /* unknown ownership: treat as root so rules still apply */ }
  return true;
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || block === undefined) continue;
    if (typeof block === 'string') { parts.push(block); continue; }
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function isUserAuthoredMessage(message) {
  if (!message || message.role !== 'user') return false;
  const kind = message.source && message.source.kind;
  if (kind === undefined) return true;
  return kind === 'user' || kind === 'user-input';
}

/* ------------------------------------------------------------------ */
/* 工具定义                                                            */
/* ------------------------------------------------------------------ */

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean' } },
  required: ['ok']
};

function renderAnalyze(args, value) {
  if (!value || value.ok !== true) {
    return [{ type: 'text', text: '分析失败：' + String((value && value.error) || '未知错误') }];
  }
  const lines = [];
  lines.push('AI 特征分：' + value.score + '/100（' + (value.verdict || '') + '）');
  lines.push('文本：' + value.chars + ' 字' + (value.genre ? ' · 文种 ' + value.genre : '') + (value.path ? ' · ' + value.path : ''));
  const issues = value.top_issues || [];
  if (issues.length > 0) {
    lines.push('');
    lines.push('主要问题：');
    for (const issue of issues.slice(0, 8)) {
      const samples = issue.samples && issue.samples.length > 0
        ? '（如：' + String(issue.samples[0].text || issue.samples[0].sentence || '').slice(0, 40) + '）'
        : '';
      lines.push('- [' + issue.severity + '][' + issue.category + '] ' + issue.why + samples);
    }
  }
  const rules = value.rule_hits || [];
  if (rules.length > 0) {
    lines.push('');
    lines.push('命中你的个人风格档案：');
    for (const rule of rules.slice(0, 8)) lines.push('- “' + rule.text + '”（' + rule.count + ' 次，置信 ' + Math.round((rule.confidence || 0) * 100) + '%）');
  }
  const human = value.human_features || [];
  if (human.length > 0) lines.push('', '人类书写特征：' + human.map((item) => item.label + '×' + item.count).join('、'));
  const suggestions = value.suggestions || [];
  if (suggestions.length > 0) {
    lines.push('', '改法：');
    suggestions.slice(0, 6).forEach((item, index) => lines.push((index + 1) + '. ' + item));
  }
  if (value.profile && value.profile.rules > 0) lines.push('', '使用了 v' + value.profile.version + ' 档案里的 ' + value.profile.rules + ' 条规则。');
  return [{ type: 'text', text: lines.join('\n') }];
}

function renderLearn(args, value) {
  if (!value || value.ok !== true) {
    return [{ type: 'text', text: '学习失败：' + String((value && value.error) || '未知错误') }];
  }
  const lines = [];
  lines.push('已学习：' + (value.genre || 'global') + ' 修订对，档案升到 v' + value.version + '。');
  lines.push('对齐后改动 ' + ((value.stats && value.stats.edits) || 0) + ' 处：新增 ' + value.added + ' 条、更新 ' + value.updated + ' 条、升为生效 ' + value.promoted + ' 条、归档 ' + value.removed + ' 条、指标区间更新 ' + value.metrics_updated + ' 项。');
  const top = value.top_proposals || [];
  if (top.length > 0) {
    lines.push('');
    lines.push('这次学到的主要偏好：');
    for (const item of top.slice(0, 10)) {
      const body = item.type === 'rewrite'
        ? '把“' + item.text + '”改成“' + (item.to || '') + '”'
        : (item.to ? '“' + item.text + '”→“' + item.to + '”' : item.text);
      lines.push('- [' + item.type + '] ' + body + (item.evidence === -1 ? '（负面证据，先观察）' : ''));
    }
  }
  if (value.card_preview) {
    lines.push('');
    lines.push('更新后的画像卡：');
    lines.push(value.card_preview);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

function renderProfile(args, value) {
  if (!value || value.ok !== true) {
    return [{ type: 'text', text: '操作失败：' + String((value && value.error) || '未知错误') }];
  }
  return [{ type: 'text', text: String(value.text || ('风格档案 v' + (value.version || '?'))) }];
}

function registerTools(ctx, dir) {
  ctx.effect(() => ctx.tools.register({
    name: 'style_analyze',
    description: '分析文本或文档的 AI 生成特征与人类书写特征：返回 0-100 评分、命中的问题片段、原因与改法、命中的个人风格规则、人类书写特征与指标。用于交付前自检，或判断一段文字像不像你写的。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要分析的文本（与 path 二选一）' },
        path: { type: 'string', description: '要分析的文档路径（.docx/.pptx/.md/.txt，与 text 二选一）' },
        genre: { type: 'string', description: '文种画像：global/lecture/thesis/ppt/chat（可选，默认按路径自动判断）' },
        detail: { type: 'string', description: 'summary 或 full（默认 summary）' }
      },
      additionalProperties: false
    },
    output: { schema: TOOL_OUTPUT_SCHEMA, render: renderAnalyze },
    async execute(args, exec) {
      try {
        const config = loadConfig(dir);
        const cwd = resolveCwd(exec && exec.agent);
        const result = analyzeInput({
          text: args && args.text,
          path: args && args.path,
          genre: args && args.genre,
          detail: args && args.detail,
          config: config,
          dir: dir,
          cwd: cwd
        });
        if (!result.ok) return { ok: false, error: result.error };
        return jsonSafe(Object.assign({ ok: true }, result.summary));
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    }
  }), 'style-memory: style_analyze tool');

  ctx.effect(() => ctx.tools.register({
    name: 'style_learn',
    description: '从「AI 原稿 → 你的修订稿」一对文本中学习你的说话与写作方式：提取禁用表达、改写偏好、结构习惯与指标区间，更新风格档案。原稿可以是文本/文件路径；只给修订稿时会尝试用交付快照自动配对。',
    parameters: {
      type: 'object',
      properties: {
        original_text: { type: 'string', description: 'AI 原稿文本（与 original_path 二选一）' },
        original_path: { type: 'string', description: 'AI 原稿文件路径（.docx/.pptx/.md/.txt）' },
        revised_text: { type: 'string', description: '你修改后的文本（与 revised_path 二选一）' },
        revised_path: { type: 'string', description: '你修改后的文件路径（.docx/.pptx/.md/.txt）' },
        genre: { type: 'string', description: '文种画像：global/lecture/thesis/ppt/chat（可选，默认按路径判断）' },
        note: { type: 'string', description: '可选：一句话说明这次修改的重点' }
      },
      additionalProperties: false
    },
    output: { schema: TOOL_OUTPUT_SCHEMA, render: renderLearn },
    async execute(args, exec) {
      try {
        const config = loadConfig(dir);
        const cwd = resolveCwd(exec && exec.agent);
        const result = learnFromInputs({
          original_text: args && args.original_text,
          original_path: args && args.original_path,
          revised_text: args && args.revised_text,
          revised_path: args && args.revised_path,
          genre: args && args.genre,
          note: args && args.note,
          config: config,
          dir: dir,
          cwd: cwd
        });
        if (!result.ok) return { ok: false, error: result.error };
        const everyLearns = (config.consolidation && config.consolidation.everyLearns) || 0;
        if (config.consolidation && config.consolidation.enabled !== false && everyLearns > 0 && result.total_learns > 0 && result.total_learns % everyLearns === 0) {
          try {
            const consolidation = await consolidateNow({
              dir: dir,
              config: config,
              agent: exec && exec.agent,
              llm: ctx.get('llm'),
              source: 'every-' + everyLearns + '-learns',
              genre: result.genre
            });
            result.consolidation = consolidation;
          } catch (error) {
            log('periodic consolidation failed:', errorText(error));
          }
        }
        return jsonSafe(Object.assign({ ok: true }, result));
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    }
  }), 'style-memory: style_learn tool');

  ctx.effect(() => ctx.tools.register({
    name: 'style_profile',
    description: '查看和管理风格档案：view/stats 看统计与画像卡，card 看注入卡，rules 看学到的规则，history 看学习记录，undo 回滚上一条学习，reset 重置档案，export/import 导入导出，consolidate 让模型整合规则。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'view|stats|card|rules|history|undo|reset|export|import|consolidate' },
        genre: { type: 'string', description: '文种画像（可选）' },
        limit: { type: 'number', description: 'rules 最多显示多少条（默认 40）' },
        path: { type: 'string', description: 'export/import 的文件路径' },
        confirm: { type: 'boolean', description: 'reset 时需要 true' }
      },
      additionalProperties: false
    },
    output: { schema: TOOL_OUTPUT_SCHEMA, render: renderProfile },
    async execute(args, exec) {
      try {
        const config = loadConfig(dir);
        const cwd = resolveCwd(exec && exec.agent);
        const action = String((args && args.action) || 'view');
        if (action === 'consolidate') {
          const result = await consolidateNow({
            dir: dir,
            config: config,
            genre: args && args.genre,
            agent: exec && exec.agent,
            llm: ctx.get('llm'),
            source: 'tool'
          });
          return jsonSafe(Object.assign({ ok: true }, result, {
            text: '整合完成（' + result.mode + '）：合并 ' + result.merged + ' 条、归档 ' + result.archived + ' 条、新增 ' + result.added + ' 条；档案 v' + result.version + '。' + (result.reason ? ' 原因：' + result.reason : '') + (result.preview ? ' 采样：' + result.preview : '') + (result.chunkTypes ? ' chunk：' + JSON.stringify(result.chunkTypes) : '')
          }));
        }
        const result = profileAction({
          action: action,
          genre: args && args.genre,
          limit: args && args.limit,
          path: args && args.path,
          confirm: args && args.confirm,
          config: config,
          dir: dir,
          cwd: cwd
        });
        return jsonSafe(result);
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    }
  }), 'style-memory: style_profile tool');
}

/* ------------------------------------------------------------------ */
/* 命令                                                                */
/* ------------------------------------------------------------------ */

function registerDataRoute(ctx, dir) {
  try {
    ctx.inject(['webServer'], (subCtx) => {
      let webServer = null;
      try {
        webServer = (subCtx && subCtx.webServer) || (subCtx && typeof subCtx.get === 'function' ? subCtx.get('webServer') : undefined);
      } catch (error) {
        webServer = undefined;
      }
      if (!webServer || typeof webServer.register !== 'function') {
        log('webServer unavailable; settings data route not mounted');
        try { audit(dir, { kind: 'web-route', ok: false, reason: 'webServer-unavailable' }); } catch (error) { /* ignore */ }
        return;
      }
      const handler = (req, res) => {
        try {
          if (req && req.method && req.method !== 'GET') {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Only GET is supported' }));
            return;
          }
          const url = new URL(String((req && req.url) || '/style-memory/data'), 'http://local');
          const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 60));
          const config = loadConfig(dir);
          const profile = getProfile(dir);
          const view = profileAction({ action: 'view', dir: dir });
          const card = profileAction({ action: 'card', dir: dir });
          const rules = profileAction({ action: 'rules', dir: dir, limit: limit });
          const history = profileAction({ action: 'history', dir: dir });
          const panel = panelRulesAndHistory(dir, limit);
          const payload = {
            ok: true,
            pluginVersion: VERSION,
            profileVersion: profile.version,
            updatedAt: profile.updatedAt || null,
            dataDir: dir,
            enabled: config.enabled !== false,
            gate: config.gate || {},
            inject: config.inject || {},
            stats: view.stats || null,
            genre: panel.genre,
            card: card.card || '',
            cardText: card.text || '',
            rulesText: rules.text || '',
            historyText: history.text || '',
            rules: panel.rules,
            history: panel.history
          };
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(payload));
        } catch (error) {
          try {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: errorText(error) }));
          } catch (inner) { /* ignore */ }
        }
      };
      try {
        const dispose = webServer.register({ kind: 'prefix', path: '/style-memory/data', handler: handler });
        if (typeof dispose === 'function') ctx.effect(() => dispose, 'style-memory: data route');
        audit(dir, { kind: 'web-route', ok: true, path: '/style-memory/data' });
        log('settings data route mounted at /style-memory/data');
      } catch (error) {
        log('data route registration failed:', errorText(error));
        try { audit(dir, { kind: 'web-route', ok: false, reason: errorText(error) }); } catch (inner) { /* ignore */ }
      }
    });
  } catch (error) {
    log('webServer injection failed:', errorText(error));
  }
}

function registerCommand(ctx, dir) {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'style',
      description: '风格记忆：查看状态/画像卡，开关插件，回滚或整合学到的写作风格',
      input: { hint: '[status|on|off|card|profile|undo|consolidate|reset confirm]' },
      handler: async (invocation) => {
        try {
          const config = loadConfig(dir);
          const argument = String((invocation && invocation.rawInput) || '').trim();
          const action = argument.toLowerCase();
          if (action === '' || action === 'status') {
            return { kind: 'success', text: statusText({ dir: dir, config: config }) };
          }
          if (action === 'on' || action === 'off') {
            config.enabled = action === 'on';
            saveConfig(dir, config);
            invalidateProfile();
            audit(dir, { kind: 'switch', enabled: config.enabled });
            return { kind: 'success', text: '风格记忆已' + (action === 'on' ? '开启' : '停用（门禁、自动学习与注入都会暂停，手动工具仍可用）') + '。' };
          }
          if (action === 'card') {
            const result = profileAction({ action: 'card', config: config, dir: dir });
            return result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.error };
          }
          if (action === 'profile') {
            const result = profileAction({ action: 'rules', config: config, dir: dir });
            return result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.error };
          }
          if (action === 'undo') {
            const result = profileAction({ action: 'undo', config: config, dir: dir });
            return result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.error };
          }
          if (action === 'consolidate') {
            const result = await consolidateNow({
              dir: dir,
              config: config,
              agent: invocation && invocation.agent,
              llm: ctx.get('llm'),
              source: 'command'
            });
            return { kind: 'success', text: '整合完成（' + result.mode + '）：合并 ' + result.merged + ' 条，归档 ' + result.archived + ' 条，新增 ' + result.added + ' 条；档案 v' + result.version + '。' + (result.reason ? ' 原因：' + result.reason : '') + (result.preview ? ' 采样：' + result.preview : '') + (result.chunkTypes ? ' chunk：' + JSON.stringify(result.chunkTypes) : '') };
          }
          if (action === 'reset' || action === 'reset confirm') {
            const result = profileAction({ action: 'reset', confirm: action === 'reset confirm', config: config, dir: dir });
            return result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.error };
          }
          return { kind: 'error', text: '用法：/style [status|on|off|card|profile|undo|consolidate|reset confirm]' };
        } catch (error) {
          return { kind: 'error', text: '风格记忆命令失败：' + errorText(error) };
        }
      }
    }), 'style-memory: /style command');
  });
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  const dir = stateDir();
  const config = loadConfig(dir);
  log('loading v' + VERSION + '; data dir:', dir);

  // 1) 系统提示段：每个新会话注入画像卡（主代理完整、子代理精简）
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (assembly) => {
      try {
        const current = loadConfig(dir);
        if (current.enabled === false || !current.inject || current.inject.enabled === false) return '';
        const agent = assembly && assembly.agent;
        const profile = getProfile(dir);
        const root = isRootAgent(ctx, agent);
        const genre = pickDefaultGenre(profile);
        const card = root
          ? buildCard(profile, genre, (current.inject && current.inject.maxChars) || 400)
          : buildCompactCard(profile, genre, (current.inject && current.inject.subagentMaxChars) || 200);
        if (card.length === 0) return '';
        return SECTION_HEADER + '\n' + card + '\n\n' + SECTION_FOOTER + '\n' + TOOL_HINTS;
      } catch (error) {
        log('prompt section failed:', errorText(error));
        return '';
      }
    }
  }), 'style-memory: system prompt card');

  // 2) 工具
  registerTools(ctx, dir);
  // 3) 命令
  registerCommand(ctx, dir);
  // 4) 只读数据路由（设置面板用）
  registerDataRoute(ctx, dir);

  // 4) 回合生命周期：自动学习 + 口语特征缓冲
  ctx.effect(() => {
    const offPreStep = ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      try {
        if (decision.kind !== 'enter') return decision;
        const agent = payload && payload.agent;
        if (!agent || !agent.id) return decision;
        const current = loadConfig(dir);
        if (current.enabled === false) return decision;
        const state = agentState(agent.id);
        if (state.turn !== payload.turn) resetTurnState(state, payload.turn);
        if (!Array.isArray(state.chatBuffer)) state.chatBuffer = [];
        const additions = [];
        const cwd = resolveCwd(agent);
        for (const message of decision.messages) {
          if (!isUserAuthoredMessage(message)) continue;
          const text = extractMessageText(message.content);
          if (!rememberMessage(state, message.id)) continue;
          if (text.length === 0) continue;
          if (current.chat && current.chat.enabled !== false && text.length <= 4000) {
            state.chatBuffer.push(text);
            state.chatMessages = (state.chatMessages || 0) + 1;
          }
          if (current.learn && current.learn.autoPair !== false) {
            const learned = tryAutoLearnFromMessage({
              text: text,
              cwd: cwd,
              agent: agent,
              config: current,
              dir: dir
            });
            if (learned.learned && learned.message) {
              additions.push(pluginMessage(learned.message, '已从修订稿自动学习写作风格'));
            }
          }
        }
        if (additions.length > 0) {
          return Object.assign({}, decision, { messages: decision.messages.concat(additions) });
        }
        return decision;
      } catch (error) {
        log('pre-step failed:', errorText(error));
        return decision;
      }
    });

    const offStopping = ctx.on('agent/turn-stopping', async (payload) => {
      try {
        const agent = payload && payload.agent;
        if (!agent || !agent.id) return;
        const current = loadConfig(dir);
        if (current.enabled === false) return;
        if (!isRootAgent(ctx, agent)) return;
        const state = agentState(agent.id);
        const buffered = Array.isArray(state.chatBuffer) ? state.chatBuffer.length : 0;
        if (buffered < 4) return;
        const now = Date.now();
        if (state.lastChatFlushAt && now - state.lastChatFlushAt < 120000) return;
        state.lastChatFlushAt = now;
        const result = flushChatLearning({ agent: agent, config: current, dir: dir });
        if (result && result.ok) log('chat learning: messages=' + result.messages + ' added=' + result.added);
      } catch (error) {
        log('turn-stopping chat learning failed:', errorText(error));
      }
    });

    const offDisposed = ctx.on('agent/disposed', (payload) => {
      try {
        const agent = payload && payload.agent;
        if (agent && agent.id) dropAgentState(agent.id);
      } catch { /* ignore */ }
    });

    return () => {
      if (typeof offPreStep === 'function') offPreStep();
      if (typeof offStopping === 'function') offStopping();
      if (typeof offDisposed === 'function') offDisposed();
    };
  }, 'style-memory: turn lifecycle');

  // 5) 工具管线：present 门禁 + 交付快照 + 清理
  ctx.effect(() => {
    const offPreExecute = ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (!exec || exec.name !== 'present') return next();
        const current = loadConfig(dir);
        if (current.enabled === false) return next();
        const verdict = evaluatePresentForAgent({
          args: exec.arguments,
          agent: exec.agent,
          config: current,
          dir: dir,
          cwd: resolveCwd(exec.agent)
        });
        if (verdict.decision === 'deny') {
          audit(dir, {
            kind: 'gate-deny',
            agentId: exec.agent && exec.agent.id,
            files: presentFilePaths(exec.arguments),
            checked: verdict.checked
          });
          return { kind: 'deny', reason: verdict.reason };
        }
        return next();
      } catch (error) {
        log('pre-execute gate failed open:', errorText(error));
        return next();
      }
    });

    const offPostExecute = ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      try {
        if (exec && exec.name === 'present' && result && result.isError !== true) {
          const cwd = resolveCwd(exec.agent);
          const files = presentFilePaths(exec.arguments).map((item) => ({ path: absolutePath(item, cwd) }));
          if (files.length > 0) {
            const current = loadConfig(dir);
            const snapshots = captureDeliveredFiles({
              dir: dir,
              config: current,
              files: files,
              agentId: exec.agent && exec.agent.id,
              sessionId: exec.agent && exec.agent.session && exec.agent.session.id,
              deliveredBy: 'present'
            });
            if (snapshots.length > 0) {
              audit(dir, { kind: 'gate-pass', files: files.map((file) => file.path) });
              maybeCleanup({
                dir: dir,
                config: current,
                agent: exec.agent,
                llm: ctx.get('llm')
              }).then((cleanup) => {
                if (cleanup && cleanup.deleted > 0) log('snapshot cleanup:', JSON.stringify(cleanup));
              }).catch((error) => log('snapshot cleanup failed:', errorText(error)));
            }
          }
        }
        return decision;
      } catch (error) {
        log('post-execute capture failed:', errorText(error));
        return decision;
      }
    });

    return () => {
      if (typeof offPreExecute === 'function') offPreExecute();
      if (typeof offPostExecute === 'function') offPostExecute();
    };
  }, 'style-memory: tool pipeline');

  audit(dir, { kind: 'plugin-loaded', version: VERSION, enabled: config.enabled !== false });
  log('loaded; rules injection ' + (config.enabled === false ? 'disabled' : 'enabled'));
}
