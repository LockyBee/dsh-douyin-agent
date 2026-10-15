import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageIdentityTracker } from '../message-tracker.mjs';
import { messageFingerprint } from '../chat-message.mjs';

const absolute = (order, text, extra = {}) => ({ nativeId: null, sender: 'incoming', direction: 'incoming', kind: 'text', text, timestamp: '5分钟前', order, ...extra });
const relative = (order, text, extra = {}) => absolute(order, text, { orderMode: 'relative', latestEndVerified: true, ...extra });
const ids = rows => rows.map(row => row.id);
const noneEligible = rows => assert.equal(rows.some(row => row.eligibleForReply), false);

test('相对窗口：初始消息只建基线，展示时间改变不产生新ID', () => {
  const tracker = new MessageIdentityTracker();
  const before = tracker.identify('合成会话', [relative(0, '旧甲'), relative(1, '旧乙')]);
  assert.equal(before.every(row => row.arrivalClassification === 'baseline'), true);
  const after = tracker.identify('合成会话', [relative(0, '旧甲', { timestamp: '6分钟前' }), relative(1, '旧乙', { timestamp: '6分钟前' })]);
  assert.deepEqual(ids(after), ids(before)); noneEligible(after); assert.equal(after[1].timestamp, '6分钟前');
});

test('真实逆序DOM经调用方变成旧到新：新增行把原domIndex整体右移仍识别末尾新增', () => {
  const tracker = new MessageIdentityTracker();
  const before = tracker.identify('真实拓扑合成', [relative(0, '较旧消息', { domIndex: 6 }), relative(1, '原最新消息', { domIndex: 3 })]);
  const after = tracker.identify('真实拓扑合成', [relative(0, '较旧消息', { domIndex: 7 }), relative(1, '原最新消息', { domIndex: 4 }), relative(2, '新私信', { domIndex: 0 })]);
  assert.deepEqual(ids(after.slice(0, 2)), ids(before)); assert.equal(after[2].arrivalClassification, 'new-tail'); assert.equal(after[2].eligibleForReply, true);
});

test('相对窗口：固定长度滑窗回用重叠消息ID，给新增尾部新ID', () => {
  const tracker = new MessageIdentityTracker();
  const before = tracker.identify('滑动会话', [relative(0, '甲'), relative(1, '乙'), relative(2, '丙')]);
  const after = tracker.identify('滑动会话', [relative(0, '乙'), relative(1, '丙'), relative(2, '丁')]);
  assert.deepEqual(ids(after.slice(0, 2)), ids(before.slice(1))); assert.equal(after[2].arrivalClassification, 'new-tail'); assert.equal(ids(before).includes(after[2].id), false);
});

test('相对窗口：有唯一连续锚点时，新增相同短句不复用旧位置ID', () => {
  const tracker = new MessageIdentityTracker();
  const before = tracker.identify('重复短句', [relative(0, '锚点'), relative(1, '你好')]);
  const after = tracker.identify('重复短句', [relative(0, '锚点'), relative(1, '你好'), relative(2, '你好')]);
  assert.deepEqual(ids(after.slice(0, 2)), ids(before)); assert.notEqual(after[2].id, before[1].id); assert.equal(after[2].eligibleForReply, true);
  const shifted = tracker.identify('重复短句', [relative(0, '你好'), relative(1, '你好'), relative(2, '新锚点')]);
  assert.deepEqual(ids(shifted.slice(0, 2)), ids(after.slice(1))); assert.equal(shifted[2].eligibleForReply, true);
});

test('相对窗口：固定长度重复短句新增不会被archive旧序号吞掉', () => {
  const tracker = new MessageIdentityTracker();
  const before = tracker.identify('固定长度', [relative(0, '甲'), relative(1, '锚点'), relative(2, '你好')]);
  const after = tracker.identify('固定长度', [relative(0, '锚点'), relative(1, '你好'), relative(2, '你好')]);
  assert.equal(after[0].id, before[1].id); assert.equal(after[1].id, before[2].id); assert.notEqual(after[2].id, before[2].id); assert.equal(after[2].arrivalClassification, 'new-tail');
  const repeated = tracker.identify('固定长度', [relative(0, '锚点'), relative(1, '你好'), relative(2, '你好')]);
  assert.deepEqual(ids(repeated), ids(after)); noneEligible(repeated);
});

test('相对窗口：多个同样可行的重复序列锚点保持不确定，不自动回复', () => {
  const tracker = new MessageIdentityTracker();
  tracker.identify('歧义重复', [relative(0, '你好'), relative(1, '你好')]);
  const after = tracker.identify('歧义重复', [relative(0, '你好'), relative(1, '你好'), relative(2, '你好')]);
  noneEligible(after); assert.equal(after.every(row => row.arrivalClassification === 'ambiguous-new'), true); assert.equal(new Set(ids(after)).size, 3);
});

test('相对窗口：上一末尾内容也出现在更早位置时，单行重叠不能证明仍在最新处', () => {
  const tracker = new MessageIdentityTracker();
  tracker.identify('重复末尾', [relative(0, '重复'), relative(1, '分界'), relative(2, '重复')]);
  const after = tracker.identify('重复末尾', [relative(0, '重复'), relative(1, '可能旧消息')]);
  noneEligible(after); assert.equal(after[1].arrivalClassification, 'ambiguous-new');
});

test('相对窗口：前插旧历史保留重复消息完整序列ID，不把末尾旧短句误判为新增', () => {
  const tracker = new MessageIdentityTracker();
  const before = tracker.identify('前插历史', [relative(0, '你好'), relative(1, '你好')]);
  const after = tracker.identify('前插历史', [relative(0, '更早消息'), relative(1, '你好'), relative(2, '你好')]);
  assert.deepEqual(ids(after.slice(1)), ids(before)); assert.equal(after[0].arrivalClassification, 'old-history'); noneEligible(after);
});

test('相对窗口：同时补载旧历史和尾部新私信，仅最后新增获得资格', () => {
  const tracker = new MessageIdentityTracker();
  const before = tracker.identify('两侧变化', [relative(0, '甲'), relative(1, '乙')]);
  const after = tracker.identify('两侧变化', [relative(0, '旧记录'), relative(1, '甲'), relative(2, '乙'), relative(3, '新私信')]);
  assert.equal(after[0].arrivalClassification, 'old-history'); assert.deepEqual(ids(after.slice(1, 3)), ids(before)); assert.equal(after[3].eligibleForReply, true);
});

test('相对窗口：无重叠陌生窗口始终不确定，较高相对序号也不扩大授权', () => {
  const tracker = new MessageIdentityTracker(); tracker.identify('无重叠', [relative(0, '甲'), relative(1, '乙')]);
  const after = tracker.identify('无重叠', [relative(20, '陌生甲'), relative(21, '陌生乙')]);
  assert.equal(after.every(row => row.arrivalClassification === 'ambiguous-new'), true); noneEligible(after);
});

test('相对窗口：无重叠回到已知完整旧窗口可回用ID，但不能重新回复', () => {
  const tracker = new MessageIdentityTracker();
  const old = tracker.identify('已知窗口', [relative(0, '旧甲'), relative(1, '旧乙')]);
  tracker.identify('已知窗口', [relative(0, '另一甲'), relative(1, '另一乙')]);
  const returned = tracker.identify('已知窗口', [relative(0, '旧甲'), relative(1, '旧乙')]);
  assert.deepEqual(ids(returned), ids(old)); noneEligible(returned); assert.equal(returned.every(row => row.arrivalClassification === 'known-old-window'), true);
});

test('相对窗口：上一末尾不在新窗口时，不用早期重叠推断新尾部', () => {
  const tracker = new MessageIdentityTracker(); tracker.identify('末尾缺失', [relative(0, '旧甲'), relative(1, '最新锚点')]);
  const after = tracker.identify('末尾缺失', [relative(0, '旧甲'), relative(1, '未核实消息')]);
  noneEligible(after); assert.equal(after[1].arrivalClassification, 'ambiguous-new');
});

test('媒体签名：不同空text表情资源及分享作品保持独立身份', () => {
  const tracker = new MessageIdentityTracker(), emoji = resourceRef => ({ kind: 'emoji', media: { type: 'emoji', label: '[表情]', resources: [{ resourceRef, label: null }] } });
  const before = tracker.identify('媒体会话', [relative(0, '', emoji('media:甲')), relative(1, '', emoji('media:乙'))]);
  const after = tracker.identify('媒体会话', [relative(0, '', emoji('media:乙')), relative(1, '', emoji('media:丙'))]);
  assert.equal(after[0].id, before[1].id); assert.equal(after[1].eligibleForReply, true); assert.equal(ids(before).includes(after[1].id), false);
  const cards = new MessageIdentityTracker();
  const first = cards.identify('卡片会话', [relative(0, '', { kind: 'video', media: { type: 'shared-work', title: '猫', videoId: '123' } })]);
  const second = cards.identify('卡片会话', [relative(0, '', { kind: 'video', media: { type: 'shared-work', title: '猫', videoId: '123' } }), relative(1, '', { kind: 'video', media: { type: 'shared-work', title: '狗', videoId: '456' } })]);
  assert.equal(second[0].id, first[0].id); assert.notEqual(second[1].id, first[0].id); assert.equal(second[1].eligibleForReply, true);
});

test('nativeId相同但内容或媒体改变时保持ID，发送内容指纹能检测改动', () => {
  const tracker = new MessageIdentityTracker();
  const before = tracker.identify('原生ID', [relative(0, '原内容', { nativeId: 'native-1' })]);
  const after = tracker.identify('原生ID', [relative(0, '修改内容', { nativeId: 'native-1', timestamp: '6分钟前' })]);
  assert.equal(after[0].id, before[0].id); assert.notEqual(messageFingerprint(after[0]), messageFingerprint(before[0])); noneEligible(after);
});

test('nativeId能够消除同内容锚点歧义，新原生消息不复用旧ID', () => {
  const tracker = new MessageIdentityTracker();
  const before = tracker.identify('原生重复', [relative(0, '你好', { nativeId: 'native-1' }), relative(1, '你好', { nativeId: 'native-2' })]);
  const after = tracker.identify('原生重复', [relative(0, '你好', { nativeId: 'native-2' }), relative(1, '你好', { nativeId: 'native-3' })]);
  assert.equal(after[0].id, before[1].id); assert.equal(after[1].eligibleForReply, true); assert.equal(ids(before).includes(after[1].id), false);
});

test('出现新的nativeId不凭同一句内容冒用原无ID消息的身份', () => {
  const tracker = new MessageIdentityTracker(); const before = tracker.identify('原生ID出现', [relative(0, '相同内容')]);
  const first = tracker.identify('原生ID出现', [relative(0, '相同内容', { nativeId: 'native-1' })]);
  assert.notEqual(first[0].id, before[0].id); noneEligible(first);
  const second = tracker.identify('原生ID出现', [relative(0, '相同内容', { nativeId: 'native-2' })]);
  assert.notEqual(second[0].id, first[0].id); noneEligible(second);
  const both = tracker.identify('原生ID出现', [relative(0, '相同内容', { nativeId: 'native-1' }), relative(1, '相同内容', { nativeId: 'native-2' })]);
  assert.equal(new Set(ids(both)).size, 2); noneEligible(both);
});

test('稳定空基线后的首条有可靠定位可新增；首次非空读仍只作基线', () => {
  for (const extra of [{ order: 0 }, { order: null, nativeId: 'native-first' }]) {
    const tracker = new MessageIdentityTracker(); tracker.identify('空基线', []); tracker.identify('空基线', []);
    const first = tracker.identify('空基线', [relative(0, '首次新增', extra)]); assert.equal(first[0].eligibleForReply, true);
  }
  const uncertain = new MessageIdentityTracker(); uncertain.identify('不可靠空基线', []);
  noneEligible(uncertain.identify('不可靠空基线', [relative(null, '无法定位')]));
  const initial = new MessageIdentityTracker(); noneEligible(initial.identify('首次非空', [relative(0, '既有消息')]));
});

test('已见非空会话后来出现空窗口，不被升级为新的空基线', () => {
  const tracker = new MessageIdentityTracker(); const before = tracker.identify('临时空窗口', [relative(0, '既有消息')]);
  tracker.identify('临时空窗口', []);
  const stranger = tracker.identify('临时空窗口', [relative(0, '陌生窗口')]); noneEligible(stranger); assert.equal(stranger[0].arrivalClassification, 'ambiguous-new');
  tracker.identify('临时空窗口', []); const returned = tracker.identify('临时空窗口', [relative(0, '既有消息')]); assert.equal(returned[0].id, before[0].id); noneEligible(returned);
});

test('最新端未核实或明确false时不自动回复，稳定空基线首条也须明确true', () => {
  for (const flag of [false, undefined]) {
    const tracker = new MessageIdentityTracker(); tracker.identify('最新端未知', [relative(0, '旧锚点')]);
    const after = tracker.identify('最新端未知', [relative(0, '旧锚点', { latestEndVerified: flag }), relative(1, '无法确认位置', { latestEndVerified: flag })]);
    noneEligible(after); assert.equal(after[1].arrivalClassification, 'ambiguous-new');
    const empty = new MessageIdentityTracker(); empty.identify('未知空基线', []);
    noneEligible(empty.identify('未知空基线', [relative(0, '首条但最新端未知', { latestEndVerified: flag })]));
  }
});

test('陌生历史窗口误标latest也不能覆盖可信最新锚点，回到旧最新后只识别真正新尾部', () => {
  const tracker = new MessageIdentityTracker(); const initial = tracker.identify('历史跨窗口', [relative(0, 'F'), relative(1, 'G')]);
  const history = tracker.identify('历史跨窗口', [relative(0, 'A'), relative(1, 'B')]); noneEligible(history);
  const historyAgain = tracker.identify('历史跨窗口', [relative(0, 'A'), relative(1, 'B')]); noneEligible(historyAgain);
  const returned = tracker.identify('历史跨窗口', ['B', 'C', 'D', 'F', 'G'].map((text, order) => relative(order, text)));
  assert.deepEqual(ids(returned.slice(-2)), ids(initial)); noneEligible(returned); assert.equal(returned.filter(row => ['C', 'D'].includes(row.text)).every(row => row.arrivalClassification === 'old-history'), true);
  const latest = tracker.identify('历史跨窗口', ['C', 'D', 'F', 'G', '真正新私信'].map((text, order) => relative(order, text)));
  assert.equal(latest.at(-1).arrivalClassification, 'new-tail'); assert.equal(latest.at(-1).eligibleForReply, true); assert.deepEqual(ids(latest.slice(2, 4)), ids(initial));
});

test('重复nativeId或相对序号拒绝识别，未向调用方返回歧义身份', () => {
  assert.throws(() => new MessageIdentityTracker().identify('重复原生', [relative(0, '甲', { nativeId: 'same' }), relative(1, '乙', { nativeId: 'same' })]), /身份重复/);
  assert.throws(() => new MessageIdentityTracker().identify('重复序号', [relative(0, '甲'), relative(0, '乙')]), /身份重复/);
});

test('相对与绝对顺序模式改变只建立新基线', () => {
  const tracker = new MessageIdentityTracker(); tracker.identify('模式变化', [absolute(0, '旧甲')]);
  const after = tracker.identify('模式变化', [relative(0, '旧甲'), relative(1, '新增待核对')]); noneEligible(after); assert.equal(after.every(row => row.arrivalClassification === 'baseline'), true);
  assert.throws(() => tracker.identify('混合模式', [relative(0, '甲'), absolute(1, '乙')]), /模式不一致/);
});

test('legacy绝对序号：同日重复短句滑窗保留旧ID并识别新增', () => {
  const tracker = new MessageIdentityTracker(); const before = tracker.identify('兼容重复', [absolute(0, '你好'), absolute(1, '你好')]);
  const after = tracker.identify('兼容重复', [absolute(1, '你好'), absolute(2, '你好')]);
  assert.equal(after[0].id, before[1].id); assert.notEqual(after[1].id, before[1].id); assert.equal(after[1].eligibleForReply, true);
});

test('legacy绝对序号：重复短句前插历史仍回用完整旧序列', () => {
  const tracker = new MessageIdentityTracker(); const before = tracker.identify('兼容历史', [absolute(0, '你好'), absolute(1, '你好')]);
  const after = tracker.identify('兼容历史', [absolute(0, '更早记录'), absolute(1, '你好'), absolute(2, '你好')]);
  assert.deepEqual(ids(after.slice(1)), ids(before)); noneEligible(after); assert.equal(after[0].arrivalClassification, 'old-history');
});

test('legacy绝对序号：旧历史与陌生高位窗口不获得新增资格，已知窗口ID可恢复', () => {
  const tracker = new MessageIdentityTracker(); const before = tracker.identify('兼容水位', [absolute(4, '甲'), absolute(5, '乙')]);
  const older = tracker.identify('兼容水位', [absolute(0, '旧甲'), absolute(1, '旧乙')]); assert.equal(older.every(row => row.arrivalClassification === 'old-history'), true);
  const returned = tracker.identify('兼容水位', [absolute(4, '甲'), absolute(5, '乙')]); assert.deepEqual(ids(returned), ids(before)); noneEligible(returned);
  const stranger = tracker.identify('兼容水位', [absolute(20, '陌生消息')]); assert.equal(stranger[0].arrivalClassification, 'ambiguous-new'); noneEligible(stranger);
});

test('legacy无法核实序号及非文字无媒体的消息不误判，重复身份拒绝', () => {
  const tracker = new MessageIdentityTracker(); const unknown = tracker.identify('兼容无序号', [absolute(null, '短句'), absolute(null, '短句')]); assert.notEqual(unknown[0].id, unknown[1].id); noneEligible(unknown);
  const media = tracker.identify('兼容未知媒体', [absolute(0, '', { kind: 'video' }), absolute(1, '', { kind: 'emoji' })]); assert.equal(media.every(row => row.unsupported), true);
  assert.throws(() => tracker.identify('兼容重复身份', [absolute(0, '你好'), absolute(0, '你好')]), /身份重复/);
});
