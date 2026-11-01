import test from 'node:test';
import assert from 'node:assert/strict';

import { alignParagraphs, diffDocuments, diffParagraph } from '../lib/diff.js';
import { LEARN_AI, LEARN_USER } from '../test-support/fixtures.mjs';

test('完全相同的文本没有编辑区间', () => {
  const result = diffDocuments('第一段。\n第二段。', '第一段。\n第二段。');
  assert.equal(result.spans.length, 0);
  assert.equal(result.identicalParagraphs, 2);
});

test('段落内替换能被定位', () => {
  const result = diffParagraph('这带出三个问题。', '这里有三个问题。');
  assert.ok(result.spans.length >= 1);
  const joined = result.spans.map((span) => span.del + '/' + span.ins).join('|');
  assert.ok(joined.indexOf('这带出') >= 0, joined);
});

test('学习样本：能识别改写与删除的段落', () => {
  const result = diffDocuments(LEARN_AI, LEARN_USER);
  assert.ok(result.stats.totalSpans >= 1, '至少一处编辑：' + result.stats.totalSpans);
  assert.ok(result.stats.deletedParagraphs >= 1, '应识别出删除的段落');
  assert.ok(result.stats.deletedChars > 0);
});

test('删掉的重复段落能被识别为重复删除', () => {
  const ai = [
    '诊断流程小结：三结合是诊断的核心，为临床工作提供参考。',
    '三结合是诊断的核心，为临床工作提供参考。',
    '另一段内容。'
  ].join('\n');
  const user = [
    '诊断流程小结：三结合是诊断的核心，为临床工作提供参考。',
    '另一段内容。'
  ].join('\n');
  const result = diffDocuments(ai, user);
  assert.ok(result.stats.deletedParagraphs >= 1);
  assert.ok(result.duplicatedDeleted.length >= 1, '删除段与保留段高度重复');
});

test('段落级对齐能容忍改写', () => {
  const pairs = alignParagraphs(
    ['颈椎病的诊断需要结合病史、查体和影像学检查。', '第二段内容乙，保持不变。'],
    ['颈椎病的诊断要看三条线：病史、查体、还有片子。', '第二段内容乙，保持不变。'],
    { minSim: 0.3 }
  );
  assert.equal(pairs.pairs.length, 2);
  assert.ok(pairs.pairs[0].sim < 1);
});

test('空文本不抛错', () => {
  const result = diffDocuments('', '');
  assert.equal(result.spans.length, 0);
});
