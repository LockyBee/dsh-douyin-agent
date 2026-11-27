import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCommentNovelty } from '../comment-novelty.mjs';

const now = Date.parse('2026-11-14T04:00:00Z');
const row = (text, status = 'confirmed', age = 1000) => ({ text, status, completedAt: new Date(now - age).toISOString() });
test('同文、标点与全角变体不在不同作品下重复发布', () => {
  assert.equal(compareCommentNovelty('这段光影真漂亮！！', [row('这段光影真漂亮。')], { now }).code, 'COMMENT_REPEATED');
  assert.equal(compareCommentNovelty('ＡＢＣ 好看！', [row('abc好看')], { now }).accepted, false);
  assert.equal(compareCommentNovelty('👍！', [row('👍')], { now }).accepted, false);
  assert.equal(compareCommentNovelty('！！！', [], { now }).code, 'COMMENT_NO_CONTENT');
});
test('高度相似的固定句式跳过，新的具体内容仍可表达', () => {
  assert.equal(compareCommentNovelty('镜头切换时金色光线落在蓝色玻璃上，真好看。', [row('镜头切换时金色光线落在蓝色玻璃上，真漂亮。')], { now }).accepted, false);
  assert.equal(compareCommentNovelty('这个慢动作把水珠散开的过程拍清楚了。', [row('镜头切换时金色光线落在蓝色玻璃上，真漂亮。')], { now }).accepted, true);
});
test('未发送、过期和异常时间不增加假阳性；不明发送参与防重复', () => {
  for (const entry of [row('真好看', 'not-sent'), row('真好看', 'confirmed', 86_400_001), row('真好看', 'confirmed', -1000)]) assert.equal(compareCommentNovelty('真好看', [entry], { now }).accepted, true);
  assert.equal(compareCommentNovelty('真好看', [row('真好看', 'uncertain')], { now }).accepted, false);
});
