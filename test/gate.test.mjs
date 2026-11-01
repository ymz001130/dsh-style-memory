import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluatePresent } from '../lib/gate.js';
import { gateStateFor } from '../lib/service.js';
import { agentState } from '../lib/state.js';
import { AI_SAMPLE, HUMAN_SAMPLE } from '../test-support/fixtures.mjs';

function tempFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'style-memory-gate-'));
  const file = join(dir, '讲稿.md');
  writeFileSync(file, content, 'utf8');
  return { dir: dir, file: file };
}

function config() {
  return { enabled: true, gate: { enabled: true, threshold: 60, maxAttempts: 3, extensions: ['.md'] } };
}

test('首次交付 AI 腔文本会被拦截，并给出诊断', () => {
  const fixture = tempFile(AI_SAMPLE);
  const state = agentState('agent-gate-1');
  const result = evaluatePresent({
    args: { files: [{ path: fixture.file }] },
    agentState: gateStateFor(state),
    cwd: fixture.dir,
    config: config(),
    profile: null
  });
  assert.equal(result.decision, 'deny');
  assert.ok(result.reason.indexOf('AI 特征分') >= 0);
  assert.ok(result.reason.indexOf('改法') >= 0);
});

test('改写后分数下降则放行', () => {
  const fixture = tempFile(AI_SAMPLE);
  const state = agentState('agent-gate-2');
  const stateView = gateStateFor(state);
  const first = evaluatePresent({ args: { files: [{ path: fixture.file }] }, agentState: stateView, cwd: fixture.dir, config: config(), profile: null });
  assert.equal(first.decision, 'deny');
  writeFileSync(fixture.file, HUMAN_SAMPLE, 'utf8');
  const second = evaluatePresent({ args: { files: [{ path: fixture.file }] }, agentState: stateView, cwd: fixture.dir, config: config(), profile: null });
  assert.equal(second.decision, 'allow');
});

test('连续 maxAttempts 次未过则留审计放行（fail-open）', () => {
  const fixture = tempFile(AI_SAMPLE);
  const state = gateStateFor(agentState('agent-gate-3'));
  let allowed = 0;
  for (let i = 0; i < 4; i += 1) {
    const result = evaluatePresent({ args: { files: [{ path: fixture.file }] }, agentState: state, cwd: fixture.dir, config: config(), profile: null });
    if (result.decision === 'allow') allowed += 1;
  }
  assert.ok(allowed >= 1, '第 3 次之后应 fail-open');
});

test('停用时直接放行', () => {
  const fixture = tempFile(AI_SAMPLE);
  const state = gateStateFor(agentState('agent-gate-4'));
  const result = evaluatePresent({
    args: { files: [{ path: fixture.file }] },
    agentState: state,
    cwd: fixture.dir,
    config: { enabled: false, gate: { enabled: true, threshold: 60, maxAttempts: 3, extensions: ['.md'] } },
    profile: null
  });
  assert.equal(result.decision, 'allow');
});

test('不在门禁扩展名范围内的文件跳过', () => {
  const fixture = tempFile(AI_SAMPLE);
  const state = gateStateFor(agentState('agent-gate-5'));
  const result = evaluatePresent({
    args: { files: [{ path: fixture.file }] },
    agentState: state,
    cwd: fixture.dir,
    config: { enabled: true, gate: { enabled: true, threshold: 60, maxAttempts: 3, extensions: ['.docx'] } },
    profile: null
  });
  assert.equal(result.decision, 'allow');
});
