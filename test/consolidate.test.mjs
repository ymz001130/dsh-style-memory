import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProfile } from '../lib/profile.js';
import {
  consolidationDiagnostics,
  consolidateWithModelDetailed,
  extractJson
} from '../lib/llm-consolidate.js';
import { consolidateNow } from '../lib/service.js';

const agent = { options: { provider: 'test-provider', model: 'test-model' } };

function fakeLlm(payload) {
  return { stream: () => (async function* () { yield { type: 'text-delta', text: payload }; })() };
}

test('模型整合：条件齐全时走 llm 并应用 JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'style-consolidate-'));
  const profile = loadProfile(dir);
  const detailed = await consolidateWithModelDetailed({
    profile: profile,
    genre: 'global',
    config: {},
    agent: agent,
    llm: fakeLlm('{"merge":[],"add":[]}')
  });
  assert.equal(detailed.reason, 'llm');
  assert.ok(detailed.summary, '应有 summary');
  assert.equal(detailed.summary.mode, 'llm');
});

test('模型整合：缺 llm 服务时返回可读原因', async () => {
  const diag = consolidationDiagnostics({ agent: agent, llm: null });
  assert.equal(diag.ready, false);
  assert.equal(diag.reason, 'llm-service-unavailable');
  const detailed = await consolidateWithModelDetailed({ profile: loadProfile(mkdtempSync(join(tmpdir(), 'style-consolidate-'))), genre: 'global', config: {}, agent: agent, llm: null });
  assert.equal(detailed.summary, null);
  assert.equal(detailed.reason, 'llm-service-unavailable');
});

test('模型输出不是 JSON 时会重试一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'style-consolidate-'));
  const calls = [];
  const llm = {
    stream: () => {
      calls.push(calls.length + 1);
      const payload = calls.length === 1 ? '好的，我来整理一下这些规则，结论是都合理。' : '{"merge":[],"add":[]}';
      return (async function* () { yield { type: 'text-delta', text: payload }; })();
    }
  };
  const detailed = await consolidateWithModelDetailed({
    profile: loadProfile(dir),
    genre: 'global',
    config: {},
    agent: agent,
    llm: llm
  });
  assert.equal(calls.length, 2, '应重试一次');
  assert.equal(detailed.reason, 'llm');
  assert.ok(detailed.summary, '重试后应得到 summary');
});

test('模型输出不是 JSON 时回退原因正确', async () => {
  const detailed = await consolidateWithModelDetailed({
    profile: loadProfile(mkdtempSync(join(tmpdir(), 'style-consolidate-'))),
    genre: 'global',
    config: {},
    agent: agent,
    llm: fakeLlm('好的，我整理完了，规则都合理。')
  });
  assert.equal(detailed.summary, null);
  assert.ok(String(detailed.reason).indexOf('model-output-not-json') === 0, '原因应说明非 JSON：' + detailed.reason);
});

test('consolidateNow：模型不可用时走本地兜底并在审计里带原因', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'style-consolidate-'));
  const result = await consolidateNow({ dir: dir, config: {}, genre: 'global', agent: agent, llm: null, source: 'test' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'local');
  assert.ok(String(result.reason).indexOf('local-fallback') === 0, '原因应注明兜底：' + result.reason);
  assert.ok(result.version >= 1);
});

test('失败时返回预览与 chunk 统计，且不把预览写进 audit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'style-consolidate-'));
  let calls = 0;
  const proseLlm = {
    stream: () => {
      calls += 1;
      return (async function* () {
        yield { type: 'text-delta', text: '好的，这些规则整体合理，我建议保留。' };
      })();
    }
  };
  const detailed = await consolidateWithModelDetailed({
    profile: loadProfile(dir),
    genre: 'global',
    config: {},
    agent: agent,
    llm: proseLlm
  });
  assert.ok(String(detailed.reason).indexOf('model-output-not-json') === 0, '原因：' + detailed.reason);
  assert.ok(detailed.preview && detailed.preview.indexOf('好的') >= 0, '应返回预览：' + JSON.stringify(detailed.preview));
  assert.ok(detailed.preview.length <= 201, '预览应截断到 200 字');
  assert.ok(detailed.chunkTypes && detailed.chunkTypes['text-delta'] >= 2, 'chunk 统计应累计两次调用：' + JSON.stringify(detailed.chunkTypes));
  const result = await consolidateNow({ dir: dir, config: {}, genre: 'global', agent: agent, llm: proseLlm, source: 'test' });
  assert.ok(result.preview, 'consolidateNow 应透传预览');
  const auditText = (await import('node:fs')).readFileSync(join(dir, 'audit.ndjson'), 'utf8');
  assert.ok(auditText.indexOf('好的') < 0, 'audit 不应包含模型原文预览');
});

test('模型只输出 reasoning-delta 时从推理文本兜底解析', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'style-consolidate-'));
  const llm = {
    stream: () => (async function* () {
      yield { type: 'block-start' };
      yield { type: 'reasoning-delta', text: '我需要整理规则。最终结果：' };
      yield { type: 'reasoning-delta', text: '{"merge":[],"add":[]}' };
      yield { type: 'block-end' };
      yield { type: 'usage' };
      yield { type: 'finish' };
    })()
  };
  const detailed = await consolidateWithModelDetailed({
    profile: loadProfile(dir),
    genre: 'global',
    config: {},
    agent: agent,
    llm: llm
  });
  assert.equal(detailed.reason, 'llm');
  assert.ok(detailed.summary, '应从 reasoning 文本解析出 JSON');
});

test('只思考不输出 JSON 时，第二阶段强制 JSON 能成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'style-consolidate-'));
  let calls = 0;
  const llm = {
    stream: () => {
      calls += 1;
      return (async function* () {
        if (calls === 1) {
          yield { type: 'reasoning-delta', text: 'We need decide merges. Rules look fine. ' };
        } else {
          yield { type: 'text-delta', text: '{"merge":[],"add":[]}' };
        }
      })();
    }
  };
  const detailed = await consolidateWithModelDetailed({
    profile: loadProfile(dir),
    genre: 'global',
    config: {},
    agent: agent,
    llm: llm
  });
  assert.equal(calls, 2, '应发起第二阶段请求');
  assert.equal(detailed.reason, 'llm');
  assert.ok(detailed.summary, '第二阶段应解析出 JSON');
});

test('extractJson 容忍前后噪声与代码块', () => {
  assert.deepEqual(extractJson('前言 {"merge":[],"add":[]} 后记'), { merge: [], add: [] });
  assert.deepEqual(extractJson('\u0060\u0060\u0060json\n{"merge":[],"add":[]}\n\u0060\u0060\u0060'), { merge: [], add: [] });
  assert.equal(extractJson('没有 JSON'), null);
});
