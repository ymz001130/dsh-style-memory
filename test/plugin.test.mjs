import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AI_SAMPLE, HUMAN_SAMPLE, PAIR_AI, PAIR_USER } from '../test-support/fixtures.mjs';
import { SECTION_NAME, SECTION_ORDER } from '../lib/constants.js';

const home = mkdtempSync(join(tmpdir(), 'style-memory-plugin-'));
process.env.DSH_STYLE_MEMORY_HOME = home;
// 测试里用 .md 当交付文档，需把门禁扩展名加上去（生产默认只拦 .docx/.pptx）
writeFileSync(join(home, 'config.json'), JSON.stringify({
  enabled: true,
  gate: { enabled: true, threshold: 60, maxAttempts: 3, extensions: ['.md', '.docx', '.pptx'] }
}, null, 2), 'utf8');

const rootAgent = { id: 'root-agent', session: { header: { cwd: home }, id: 'session-1' } };

function createHarness(options) {
  const opts = options || {};
  const handlers = new Map();
  const sections = [];
  const tools = new Map();
  const commands = new Map();
  const roots = [rootAgent];
  const ctx = {
    effect(fn) { return fn(); },
    inject(names, callback) { callback(ctx); },
    on(event, fn) {
      const list = handlers.get(event) || [];
      list.push(fn);
      handlers.set(event, list);
      return () => {
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      };
    },
    get(name) {
      if (name === 'agents') return { roots: () => roots };
      if (name === 'webServer' && opts.webServer) return opts.webServer;
      return undefined;
    },
    systemPrompt: { section(section) { sections.push(section); return () => {}; } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
    commands: { register(definition) { commands.set(definition.name, definition); return () => {}; } },
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  };
  return { ctx, handlers, sections, tools, commands, roots };
}

function handler(harness, event) {
  const list = harness.handlers.get(event) || [];
  assert.ok(list.length > 0, 'expected handler for ' + event);
  return list[0];
}

function userMessage(text, id) {
  return { id: id || 'msg-' + Math.random().toString(36).slice(2), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: text }] };
}

async function preStep(harness, messages) {
  const listener = handler(harness, 'agent/pre-step');
  const payload = { agent: rootAgent, messages: messages, turn: 1, step: 1, signal: new AbortController().signal };
  return listener(payload, async () => ({ kind: 'enter', messages: messages }));
}

async function preExecute(harness, exec) {
  const listener = handler(harness, 'tools/pre-execute');
  return listener(exec, async () => ({ kind: 'allow' }));
}

async function postExecute(harness, exec, result) {
  const listener = handler(harness, 'tools/post-execute');
  return listener(exec, result, async () => ({ kind: 'accept' }));
}

async function loadPlugin(options) {
  const module = await import('../index.js');
  const harness = createHarness(options);
  module.apply(harness.ctx);
  return harness;
}

test('插件注册系统提示段、三个工具、/style 命令与生命周期钩子', async () => {
  const harness = await loadPlugin();
  assert.equal(harness.sections.length, 1);
  assert.equal(harness.sections[0].name, SECTION_NAME);
  assert.equal(harness.sections[0].order, SECTION_ORDER);
  for (const tool of ['style_analyze', 'style_learn', 'style_profile']) {
    assert.ok(harness.tools.has(tool), 'missing tool ' + tool);
    const definition = harness.tools.get(tool);
    assert.equal(typeof definition.execute, 'function');
    assert.ok(definition.output && typeof definition.output.render === 'function', tool + ' needs output projector');
  }
  assert.ok(harness.commands.has('style'));
  for (const event of ['agent/pre-step', 'agent/turn-stopping', 'agent/disposed', 'tools/pre-execute', 'tools/post-execute']) {
    assert.ok((harness.handlers.get(event) || []).length > 0, 'missing hook ' + event);
  }
});

test('工具 style_learn → 画像卡注入 → style_analyze 命中个人规则', async () => {
  const harness = await loadPlugin();
  const learnTool = harness.tools.get('style_learn');
  const learnResult = await learnTool.execute({
    original_text: PAIR_AI,
    revised_text: PAIR_USER,
    genre: 'lecture',
    note: 'test'
  }, { agent: rootAgent, arguments: {}, signal: new AbortController().signal });
  assert.equal(learnResult.ok, true, JSON.stringify(learnResult));
  assert.ok(learnResult.version >= 1);

  const sectionText = harness.sections[0].text({ agent: rootAgent });
  assert.ok(sectionText.indexOf('风格') >= 0, '提示段应包含风格标签：' + sectionText.slice(0, 120));

  const analyzeTool = harness.tools.get('style_analyze');
  const analyzed = await analyzeTool.execute({ text: '值得注意的是，这带出三个问题。', genre: 'lecture' }, { agent: rootAgent, arguments: {} });
  assert.equal(analyzed.ok, true);
  assert.ok(analyzed.score >= 60);
});

test('设置面板的只读数据路由返回档案数据', async () => {
  const routes = [];
  const webServer = { register(definition) { routes.push(definition); return () => {}; } };
  const harness = await loadPlugin({ webServer: webServer });
  assert.equal(routes.length, 1, '应注册一条数据路由');
  assert.ok(String(routes[0].path).indexOf('style-memory/data') >= 0);
  const learnTool = harness.tools.get('style_learn');
  await learnTool.execute({ original_text: PAIR_AI, revised_text: PAIR_USER, genre: 'lecture' }, { agent: rootAgent, arguments: {} });
  const body = await new Promise((resolve, reject) => {
    const res = {
      writeHead() {},
      end(value) { resolve(value); }
    };
    try { routes[0].handler({ url: '/style-memory/data?limit=5' }, res); } catch (error) { reject(error); }
  });
  const data = JSON.parse(body);
  assert.equal(data.ok, true);
  assert.ok(data.profileVersion >= 1);
  assert.ok(data.cardText && data.cardText.length > 0, '应返回画像卡');
  assert.ok(data.rulesText && data.rulesText.length > 0, '应返回规则文本');
  assert.ok(data.stats && data.stats.version >= 1);
  assert.ok(Array.isArray(data.rules) && data.rules.length > 0, '应返回结构化规则数组');
  assert.ok(Array.isArray(data.history) && data.history.length > 0, '应返回结构化学习记录');
  const firstRule = data.rules[0];
  assert.equal(typeof firstRule.typeLabel, 'string');
  assert.equal(typeof firstRule.confidence, 'number');
  assert.ok(firstRule.status === 'active' || firstRule.status === 'candidate');
});

test('工具返回值是 lossless JSON（PTC 传输要求）', async () => {
  const harness = await loadPlugin();
  const analyzeTool = harness.tools.get('style_analyze');
  const analyzed = await analyzeTool.execute({ text: AI_SAMPLE, genre: 'lecture' }, { agent: rootAgent, arguments: {} });
  assert.equal(analyzed.ok, true);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(analyzed)));
  const learnTool = harness.tools.get('style_learn');
  const learned = await learnTool.execute({ original_text: PAIR_AI, revised_text: PAIR_USER, genre: 'lecture' }, { agent: rootAgent, arguments: {} });
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(learned)));
  const profileTool = harness.tools.get('style_profile');
  const profiled = await profileTool.execute({ action: 'view' }, { agent: rootAgent, arguments: {} });
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(profiled)));
});

test('style_profile card/rules 默认取有内容的文种', async () => {
  const harness = await loadPlugin();
  const learnTool = harness.tools.get('style_learn');
  const learned = await learnTool.execute({ original_text: PAIR_AI, revised_text: PAIR_USER, genre: 'lecture' }, { agent: rootAgent, arguments: {} });
  assert.equal(learned.ok, true);
  const profileTool = harness.tools.get('style_profile');
  const card = await profileTool.execute({ action: 'card' }, { agent: rootAgent, arguments: {} });
  assert.equal(card.ok, true);
  assert.notEqual(card.text, '（还没有风格卡）', '默认文种不应落到空 global：' + card.text);
  assert.ok(card.text.indexOf('节奏') >= 0 || card.text.indexOf('风格') >= 0, '卡片应包含内容：' + card.text.slice(0, 100));
  const rules = await profileTool.execute({ action: 'rules', limit: 5 }, { agent: rootAgent, arguments: {} });
  assert.equal(rules.ok, true);
  assert.ok(rules.text.indexOf('还没有学到任何规则') < 0, '默认文种不应为空规则列表：' + rules.text.slice(0, 100));
});

test('/style status 返回状态与画像卡', async () => {
  const harness = await loadPlugin();
  const command = harness.commands.get('style');
  const result = await command.handler({ rawInput: 'status', agent: rootAgent, signal: new AbortController().signal });
  assert.equal(result.kind, 'success');
  assert.ok(result.text.indexOf('风格记忆') >= 0);
  assert.ok(result.text.indexOf('/style') >= 0);
});

test('present 门禁：AI 稿被拦截，改写后放行', async () => {
  const harness = await loadPlugin();
  const dir = mkdtempSync(join(tmpdir(), 'style-memory-plugin-gate-'));
  const file = join(dir, '讲稿.md');
  writeFileSync(file, AI_SAMPLE, 'utf8');
  const exec = { name: 'present', agent: rootAgent, arguments: { files: [{ path: file }] }, signal: new AbortController().signal };
  const first = await preExecute(harness, exec);
  assert.equal(first.kind, 'deny');
  writeFileSync(file, HUMAN_SAMPLE, 'utf8');
  const second = await preExecute(harness, exec);
  assert.equal(second.kind, 'allow');
});

test('交付成功后的 post-execute 会存快照', async () => {
  const harness = await loadPlugin();
  const dir = mkdtempSync(join(tmpdir(), 'style-memory-plugin-snap-'));
  const file = join(dir, '讲稿.md');
  writeFileSync(file, PAIR_AI, 'utf8');
  const exec = { name: 'present', agent: rootAgent, arguments: { files: [{ path: file }] }, signal: new AbortController().signal };
  await postExecute(harness, exec, { isError: false, value: {}, content: [] });
  const { listSnapshots } = await import('../lib/store.js');
  const snapshots = listSnapshots(home);
  assert.ok(snapshots.some((item) => item.name === '讲稿.md'));
});

test('用户消息带回改过的文档 → 自动学习并注入提醒', async () => {
  const harness = await loadPlugin();
  const dir = mkdtempSync(join(tmpdir(), 'style-memory-plugin-auto-'));
  const file = join(dir, '汇报.md');
  writeFileSync(file, PAIR_AI, 'utf8');
  // 先像正常交付一样存快照
  await postExecute(harness, { name: 'present', agent: rootAgent, arguments: { files: [{ path: file }] }, signal: new AbortController().signal }, { isError: false, value: {}, content: [] });
  // 用户改完后覆盖文件，再把路径发回来
  writeFileSync(file, PAIR_USER, 'utf8');
  const decision = await preStep(harness, [userMessage('我改好了，文件在 ' + file + '，你看看')]);
  assert.ok(decision.messages.length >= 2, '应注入一条学习提醒');
  const injected = decision.messages[decision.messages.length - 1];
  const text = injected.content.map((block) => block.text || '').join('');
  assert.ok(text.indexOf('已从你修改的文档里自动学习') >= 0, text);
});

test('会话消息累积后并入 chat 画像', async () => {
  const harness = await loadPlugin();
  const messages = [
    userMessage('说白了，这个方案我看行。', 'm1'),
    userMessage('说白了，先这样吧。', 'm2'),
    userMessage('说白了，可以。', 'm3'),
    userMessage('说白了，明天再说。', 'm4')
  ];
  await preStep(harness, messages);
  const stopping = handler(harness, 'agent/turn-stopping');
  await stopping({ agent: rootAgent, turn: 1, signal: new AbortController().signal });
  const { loadProfile } = await import('../lib/profile.js');
  const { stateDir } = await import('../lib/store.js');
  const profile = loadProfile(stateDir());
  assert.ok((profile.genres.chat.stats.messages || 0) >= 4);
});
