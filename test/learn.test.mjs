import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeRevisionPair, applyLearning, aggregateChatMessages, mergeChatLearning } from '../lib/learn.js';
import { defaultProfile, loadProfile, commitProfile, profileStats } from '../lib/profile.js';
import { buildCard } from '../lib/card.js';
import { LEARN_AI, LEARN_USER } from '../test-support/fixtures.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'style-memory-learn-'));
}

test('修订对分析：有编辑、有规则候选、有指标变化', () => {
  const analysis = analyzeRevisionPair({ originalText: LEARN_AI, revisedText: LEARN_USER, config: {} });
  assert.ok(analysis.stats.edits >= 1, 'edits=' + analysis.stats.edits);
  assert.ok(analysis.proposals.length >= 1, 'proposals=' + analysis.proposals.length);
  const types = analysis.proposals.map((item) => item.type);
  assert.ok(types.includes('banned_phrase') || types.includes('rewrite'));
  assert.ok(typeof analysis.deltas.meanLen === 'number');
});

test('规则合并进档案：生效规则、指标区间、学习计数', () => {
  const dir = tempDir();
  const profile = loadProfile(dir);
  const analysis = analyzeRevisionPair({ originalText: LEARN_AI, revisedText: LEARN_USER, config: {} });
  const applied = applyLearning({ profile: profile, genre: 'lecture', analysis: analysis, config: {} });
  assert.ok(applied.added.length >= 1);
  assert.ok(applied.promoted.length >= 1);
  assert.ok(applied.metricsUpdated.length >= 1);
  assert.equal(profile.evidence.learns, 1);
  assert.ok(Object.keys(profile.genres.lecture.metrics).length > 0);
  const target = profile.genres.lecture.metrics.meanLen;
  assert.ok(target && target.lo <= target.hi);
  const committed = commitProfile(dir, profile, { action: 'learn', summary: 'test' });
  assert.equal(committed.version, 1);
  assert.equal(loadProfile(dir).version, 1);
  const card = buildCard(profile, 'lecture', 400);
  assert.ok(card.length === 0 || card.length <= 400);
  assert.ok(profileStats(profile).activeRules >= 1);
});

test('重复学习同一对：规则不重复、证据累加', () => {
  const profile = defaultProfile();
  const analysis = analyzeRevisionPair({ originalText: LEARN_AI, revisedText: LEARN_USER, config: {} });
  applyLearning({ profile: profile, genre: 'lecture', analysis: analysis, config: {} });
  const firstCount = profile.genres.lecture.rules.length;
  const firstPos = profile.genres.lecture.rules.reduce((acc, rule) => acc + rule.pos, 0);
  const analysis2 = analyzeRevisionPair({ originalText: LEARN_AI, revisedText: LEARN_USER, config: {} });
  applyLearning({ profile: profile, genre: 'lecture', analysis: analysis2, config: {} });
  assert.equal(profile.genres.lecture.rules.length, firstCount);
  assert.ok(profile.genres.lecture.rules.reduce((acc, rule) => acc + rule.pos, 0) > firstPos);
});

test('Markdown 标题/格式改动不产生风格规则', () => {
  const ai = '## 一、分型\n## 二、诊断\n## 三、治疗';
  const user = '一、分型\n二、诊断\n三、治疗';
  const analysis = analyzeRevisionPair({ originalText: ai, revisedText: user, config: {} });
  for (const proposal of analysis.proposals) {
    assert.ok(!/[#*\`>|]/.test(proposal.text + (proposal.to || '')), '不应出现 Markdown 规则：' + JSON.stringify(proposal));
  }
});

test('口语特征聚合：高频短语保留、低频丢弃', () => {
  const messages = [
    '说白了，这个方案我看行。',
    '说白了，先这样吧。',
    '说白了，我觉得可以。',
    '嗯，可以。'
  ];
  const aggregate = aggregateChatMessages(messages, { minPhraseFrequency: 3, maxPhraseLen: 24 });
  assert.ok(aggregate);
  assert.ok(aggregate.phrases.some((item) => item.text === '说白了'));
  assert.ok(aggregate.pronouns.wo >= 1);
});

test('chat 画像合并：统计与短语规则', () => {
  const profile = defaultProfile();
  const aggregate = aggregateChatMessages([
    '说白了，先这样。', '说白了，我看行。', '说白了，可以。'
  ], { minPhraseFrequency: 3, maxPhraseLen: 24 });
  const merged = mergeChatLearning(profile, aggregate, {});
  assert.ok(merged.added >= 1);
  assert.ok(profile.genres.chat.rules.length >= 1);
  assert.ok(profile.genres.chat.stats.messages >= 3);
});
