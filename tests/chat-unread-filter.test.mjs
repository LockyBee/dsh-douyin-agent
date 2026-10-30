import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatService } from '../chat-service.mjs';

const contact = (suffix, binding, name) => ({
  id: `conv:${suffix.repeat(64)}`,
  name,
  followed: true,
  isGroup: false,
  identityVerified: true,
  identityBinding: `binding:${binding.repeat(64)}`,
  identityVersion: 2,
  identityKind: 'rendered-user',
  identityHash: suffix.repeat(64),
});
const first = contact('1', '2', '合成好友甲');
const second = contact('3', '4', '合成好友乙');

function fixture(t, unreadCounts) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-chat-unread-'));
  const reads = [];
  const browser = {
    listContacts: async () => ({ contacts: [first, second] }),
    readConversation: async (id, args) => {
      assert.equal(args.allowed, true);
      reads.push(id);
      return { conversation: { id }, contact: { ...(id === first.id ? first : second) }, messages: [] };
    },
    sendMessage: async () => { throw new Error('本测试禁止发送'); },
    unreadCounts,
  };
  const service = new ChatService({ browser, config: { apiKey: 'synthetic-unread-filter' }, agent: { reply: async () => { throw new Error('本测试禁止模型'); } }, stateDir: directory });
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { service, reads };
}

async function prepare(f) {
  await f.service.configure({ recipientIds: [first.id, second.id] });
  await f.service.start({ schedule: false });
  f.reads.length = 0;
  f.service.lastFullScanAt = Date.now();
}

test('没有未读时不打开任何许可会话', async t => {
  const f = fixture(t, async () => ({ available: true, rows: 2, counts: {} }));
  await prepare(f);
  await f.service.poll();
  assert.deepEqual(f.reads, []);
});

test('只读取未读数大于零的许可会话', async t => {
  const f = fixture(t, async () => ({ available: true, rows: 2, counts: { [second.id]: 2 } }));
  await prepare(f);
  await f.service.poll();
  assert.deepEqual(f.reads, [second.id]);
});

test('未读检查不可用或失败时回退全量', async t => {
  for (const unread of [async () => ({ available: false, rows: 0, counts: {} }), async () => { throw new Error('合成未读读取失败'); }]) {
    const f = fixture(t, unread);
    await prepare(f);
    await f.service.poll();
    assert.deepEqual([...f.reads].sort(), [first.id, second.id].sort());
  }
});

test('全量兜底到期后重新读取所有许可会话', async t => {
  const f = fixture(t, async () => ({ available: true, rows: 2, counts: {} }));
  await prepare(f);
  f.service.lastFullScanAt = Date.now() - 61_000;
  await f.service.poll();
  assert.deepEqual([...f.reads].sort(), [first.id, second.id].sort());
});

test('未读检查持续不可用时不每轮全量，等待兜底', async t => {
  const f = fixture(t, async () => ({ available: false, rows: 0, counts: {} }));
  await prepare(f);
  await f.service.poll();
  assert.equal(f.reads.length, 2);
  f.reads.length = 0;
  await f.service.poll();
  assert.deepEqual(f.reads, []);
  f.service.lastFullScanAt = Date.now() - 61_000;
  await f.service.poll();
  assert.deepEqual([...f.reads].sort(), [first.id, second.id].sort());
});
