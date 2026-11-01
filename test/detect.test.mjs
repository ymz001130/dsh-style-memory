import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeText, bandOf } from '../lib/detect.js';
import { AI_SAMPLE, HUMAN_SAMPLE } from '../test-support/fixtures.mjs';

test('典型 AI 文本得分明显高于人味文本', () => {
  const ai = analyzeText(AI_SAMPLE, {});
  const human = analyzeText(HUMAN_SAMPLE, {});
  assert.ok(ai.score >= 60, 'AI 样本应达到明显 AI 腔：' + ai.score);
  assert.ok(human.score < ai.score - 20, '人味样本应显著更低：' + human.score + ' vs ' + ai.score);
  assert.equal(ai.band, 'ai_heavy');
});

test('命中项带类别、原因、改法与例句定位', () => {
  const result = analyzeText(AI_SAMPLE, {});
  assert.ok(result.issues.length >= 4);
  const issue = result.issues[0];
  assert.ok(typeof issue.label === 'string' && issue.label.length > 0);
  assert.ok(typeof issue.why === 'string' && issue.why.length > 0);
  assert.ok(typeof issue.fix === 'string' && issue.fix.length > 0);
  assert.ok(['high', 'medium', 'low'].includes(issue.severity));
});

test('人味特征被识别', () => {
  const result = analyzeText(HUMAN_SAMPLE, {});
  const labels = result.humanFeatures.map((item) => item.label);
  assert.ok(labels.length > 0);
  assert.ok(labels.some((label) => label.indexOf('短句') >= 0 || label.indexOf('口语') >= 0 || label.indexOf('数字') >= 0));
});

test('证据分档边界', () => {
  assert.equal(bandOf(85).band, 'ai_heavy');
  assert.equal(bandOf(65).band, 'ai_clear');
  assert.equal(bandOf(45).band, 'mixed');
  assert.equal(bandOf(10).band, 'human');
});

test('学习档案里的禁用规则会被命中', () => {
  const profile = {
    version: 3,
    genres: {
      global: {
        metrics: {},
        rules: [
          { id: 'r1', type: 'banned_phrase', text: '值得注意的是', to: '', confidence: 0.9, pos: 2, neg: 0, status: 'active' },
          { id: 'r2', type: 'rewrite', text: '这带出', to: '这里有', confidence: 0.8, pos: 2, neg: 0, status: 'active' }
        ]
      }
    }
  };
  const result = analyzeText('这带出三个问题。值得注意的是，影像很重要。', { profile: profile });
  assert.equal(result.ruleHits.length, 2);
  assert.ok(result.ruleHits.some((hit) => hit.text === '值得注意的是'));
});

test('rewrite 规则在已使用新写法时不误报', () => {
  const profile = {
    version: 1,
    genres: {
      global: {
        metrics: {},
        rules: [{ id: 'r1', type: 'rewrite', text: '这带出', to: '这里有', confidence: 0.9, pos: 2, neg: 0, status: 'active' }]
      }
    }
  };
  const result = analyzeText('这里有三个问题。这带出另一件事。', { profile: profile });
  assert.equal(result.ruleHits.length, 0, '附近已有“这里有”时不应再把“这带出”算命中');
});

test('医学术语顿号列举不会被当成三项排比', () => {
  const medical = '颈椎病分几型：颈型、神经根型、脊髓型、椎动脉型、交感型。查体看椎间孔挤压试验、臂丛牵拉试验、霍夫曼征。';
  const result = analyzeText(medical, {});
  assert.ok(result.metrics.parallelTriplets < 2, 'parallelTriplets=' + result.metrics.parallelTriplets);
  assert.ok(!result.issues.some((issue) => issue.id === 'parallel-triplet'), '不应命中三项排比');
});

test('内容型改写规则不参与检测命中', () => {
  const profile = {
    version: 1,
    genres: { global: { metrics: {}, rules: [
      { id: 'r1', type: 'rewrite', text: '梨状肌形态改变', to: '腰椎间盘突出', confidence: 0.9, pos: 2, neg: 0, status: 'active' }
    ] } }
  };
  const result = analyzeText('梨状肌形态改变和臀部疼痛有关系。', { profile });
  assert.equal(result.ruleHits.length, 0);
});

test('模板化段落与短句会被识别', () => {
  const paragraph = '颈椎病分型要讲清楚。先说颈型，酸胀僵硬最常见。再说神经根型，疼痛沿手臂放射。最后说脊髓型，走路发飘要警惕。';
  const text = [paragraph, paragraph, paragraph, paragraph, paragraph, paragraph].join('\n');
  const result = analyzeText(text, {});
  const ids = result.issues.map((issue) => issue.id);
  assert.ok(ids.indexOf('paragraphs-too-even') >= 0 || ids.indexOf('uniform-sentence-count') >= 0, '应识别段落/句数过于均匀：' + ids.join(','));
  assert.ok(result.score >= 50, '模板化文本应有明显 AI 特征分：' + result.score);
});

test('「不是…而是」对立句与判断式收束会被识别', () => {
  const text = '问题不在检查做没做，而是有没有把症状和片子对上。分型不是为了贴标签，而是为了治疗有方向。';
  const result = analyzeText(text, {});
  assert.ok(result.issues.some((issue) => issue.id === 'pattern:not-x-but-y' || issue.id === 'not-x-but-y' || issue.label.indexOf('不是') >= 0), '应命中对立句：' + result.issues.map((i) => i.id).join(','));
});

test('多段以短判断句收尾会命中段末金句化', () => {
  const text = [
    '门诊先问清疼痛从哪来，再查体定位。这一步不能省。',
    '影像只是证据之一，不能替你做诊断。记住这一点。',
    '治疗先分级，该保守的别急着开刀。这才是关键。'
  ].join('\n\n');
  const result = analyzeText(text, {});
  assert.ok(result.issues.some((issue) => issue.id === 'aphorism-endings'), '应命中段末金句化：' + result.issues.map((i) => i.id).join(','));
});

test('反问收束与议程预告会被识别', () => {
  const text = '神奇的是，术后臀痛反而更明显了。我们注意到，这类患者都有一个共同点。我会从三个问题说起，接下来介绍两篇文献。';
  const result = analyzeText(text, {});
  const ids = result.issues.map((issue) => issue.id).join(',');
  assert.ok(ids.indexOf('rhetorical-close') >= 0 || ids.indexOf('agenda-preview') >= 0, '应命中反问/议程模式：' + ids);
});

test('文本过短不抛错', () => {
  const result = analyzeText('好。', {});
  assert.equal(typeof result.score, 'number');
  assert.ok(result.score >= 0 && result.score <= 100);
});
