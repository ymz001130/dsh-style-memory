import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commitProfile, confidenceOf, defaultProfile, exportProfileData, importProfileData,
  loadProfile, mergeProposal, profileStats, resetProfileData, undoProfile, updateMetricTargets
} from '../lib/profile.js';
import { buildCard, buildCompactCard } from '../lib/card.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'style-memory-profile-'));
}

test('单条强证据可升为 active，弱证据保持 candidate', () => {
  const profile = defaultProfile();
  const strong = mergeProposal(profile, 'global', { type: 'banned_phrase', text: '值得注意的是', evidence: 1, trust: 1.0 }, { learn: { minEvidence: 1, minConfidence: 0.6 } });
  const weak = mergeProposal(profile, 'global', { type: 'preferred_phrase', text: '而且它', evidence: 1, trust: 0.2 }, { learn: { minEvidence: 1, minConfidence: 0.6 } });
  assert.equal(strong.rule.status, 'active');
  assert.equal(weak.rule.status, 'candidate');
  assert.ok(strong.rule.confidence > weak.rule.confidence);
});

test('同一条规则重复出现时证据累加、置信度上升', () => {
  const profile = defaultProfile();
  mergeProposal(profile, 'global', { type: 'banned_phrase', text: '综上所述', evidence: 1, trust: 0.6 }, {});
  const first = profile.genres.global.rules[0].confidence;
  mergeProposal(profile, 'global', { type: 'banned_phrase', text: '综上所述', evidence: 1, trust: 0.6 }, {});
  const second = profile.genres.global.rules[0].confidence;
  assert.ok(second > first);
  assert.equal(profile.genres.global.rules.length, 1);
});

test('Beta 置信度公式', () => {
  assert.equal(confidenceOf(1, 0, 0), 0.5);
  assert.equal(confidenceOf(1, 0, 1), 0.667);
  assert.ok(confidenceOf(2, 0, 1) > confidenceOf(1, 0, 1));
});

test('指标区间学习与卡片生成', () => {
  const profile = defaultProfile();
  const metrics = { meanLen: 20, cv: 0.6, shortRatio: 0.2, colonDensity: 5, paragraphMean: 80, connectiveDensity: 3 };
  updateMetricTargets(profile, 'lecture', metrics, { keys: Object.keys(metrics) });
  mergeProposal(profile, 'lecture', { type: 'banned_phrase', text: '值得注意的是', evidence: 1, trust: 1 }, {});
  mergeProposal(profile, 'lecture', { type: 'rewrite', text: '这带出', to: '这里有', evidence: 1, trust: 1 }, {});
  const card = buildCard(profile, 'lecture', 400);
  assert.ok(card.length > 0);
  assert.ok(card.length <= 400, '卡片超长：' + card.length);
  assert.ok(card.indexOf('值得注意的是') >= 0 || card.indexOf('句长') >= 0);
  const compact = buildCompactCard(profile, 'lecture', 200);
  assert.ok(compact.length <= 200);
});

test('提交/读取/回滚/重置/导入导出', () => {
  const dir = tempDir();
  const profile = defaultProfile();
  mergeProposal(profile, 'global', { type: 'banned_phrase', text: '综上所述', evidence: 1, trust: 1 }, {});
  commitProfile(dir, profile, { action: 'learn', summary: 'v1' });
  const loaded = loadProfile(dir);
  assert.equal(loaded.version, 1);
  assert.equal(profileStats(loaded).activeRules, 1);
  mergeProposal(loaded, 'global', { type: 'banned_phrase', text: '一言以蔽之', evidence: 1, trust: 1 }, {});
  commitProfile(dir, loaded, { action: 'learn', summary: 'v2' });
  assert.equal(loadProfile(dir).version, 2);
  const undo = undoProfile(dir);
  assert.equal(undo.ok, true);
  assert.equal(undo.version, 1);
  assert.equal(loadProfile(dir).version, 1);
  const exported = join(tempDir(), 'profile-export.json');
  exportProfileData(dir, exported);
  const importedDir = tempDir();
  const imported = importProfileData(importedDir, exported);
  assert.equal(imported.ok, true);
  assert.ok(loadProfile(importedDir).version >= 1);
  resetProfileData(dir);
  assert.equal(loadProfile(dir).version, 0);
});
