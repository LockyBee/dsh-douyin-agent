import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseEnv } from 'node:util';
import { saveSharedMediaKey } from '../src/media-key-store.mjs';
import { MediaAdapter } from '../../media/index.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-media-key-synthetic-'));
  t.after(async () => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('douyin-media-key-synthetic-')) throw new Error('音频密钥测试清理目录不符。');
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, envFile: path.join(root, 'media', '.env') };
}

test('保存合成 MiMo/MiniMax Key 共用原媒体文件，保留其他配置且不回显密钥', async t => {
  const f = await fixture(t); await fs.mkdir(path.dirname(f.envFile));
  const header = '# 合成配置\r\nDOUYIN_MEDIA_FFMPEG=synthetic-ffmpeg\r\n';
  await fs.writeFile(f.envFile, header + 'export XIAOMI_API_KEY=old-one\r\nXIAOMI_API_KEY=old-duplicate\r\n');
  const receipts = await Promise.all([
    saveSharedMediaKey({ backend: 'mimo', apiKey: 'synthetic-mimo-key' }, { ...f, explicit: true }),
    saveSharedMediaKey({ backend: 'minimax', apiKey: 'synthetic-minimax-key' }, { ...f, explicit: true }),
  ]);
  const contents = await fs.readFile(f.envFile, 'utf8'), values = parseEnv(contents);
  assert.ok(contents.startsWith(header)); assert.equal(values.DOUYIN_MEDIA_FFMPEG, 'synthetic-ffmpeg');
  assert.equal(values.XIAOMI_API_KEY, 'synthetic-mimo-key'); assert.equal(values.MINIMAX_API_KEY, 'synthetic-minimax-key');
  assert.equal(contents.match(/^XIAOMI_API_KEY=/gm).length, 1);
  assert.doesNotMatch(JSON.stringify(receipts), /synthetic|apiKey|XIAOMI/);
  assert.deepEqual(await fs.readdir(path.dirname(f.envFile)), ['.env']);
});

test('音频 Key 保存拒绝非明确操作、未知字段和换行注入，不修改原文件', async t => {
  const f = await fixture(t); await fs.mkdir(path.dirname(f.envFile)); await fs.writeFile(f.envFile, '# 合成原文件\n');
  for (const input of [
    { backend: 'local-whisper', apiKey: 'synthetic-key' },
    { backend: 'mimo', apiKey: 'synthetic-key\nMINIMAX_API_KEY=injected' },
    { backend: 'mimo', apiKey: 'synthetic-key', enabled: true },
    { backend: 'mimo', apiKey: '' },
  ]) await assert.rejects(saveSharedMediaKey(input, { ...f, explicit: true }));
  await assert.rejects(saveSharedMediaKey({ backend: 'mimo', apiKey: 'synthetic-key' }, f), /明确/);
  assert.equal(await fs.readFile(f.envFile, 'utf8'), '# 合成原文件\n');
});

test('已有音频实例即时读取保存的新 Key；保存不打开音频、不改变选中的后端', async t => {
  const f = await fixture(t), settingsFile = path.join(f.root, 'settings.json');
  const adapter = new MediaAdapter({ env: {}, envFile: f.envFile, settingsFile, fetchImpl: () => { throw new Error('合成测试禁止模型请求'); } });
  assert.equal((await adapter.runtime()).config.XIAOMI_API_KEY, '');
  const before = await adapter.settings(); assert.equal(before.enabled, false);
  await saveSharedMediaKey({ backend: 'mimo', apiKey: 'synthetic-hot-reload-key' }, { ...f, explicit: true });
  assert.equal((await adapter.runtime()).config.XIAOMI_API_KEY, 'synthetic-hot-reload-key');
  assert.deepEqual(await adapter.settings(), before);
  const explicitConfig = new MediaAdapter({ config: { XIAOMI_API_KEY: 'synthetic-injected-config' }, env: {}, envFile: f.envFile, settingsFile });
  assert.equal((await explicitConfig.runtime()).config.XIAOMI_API_KEY, 'synthetic-injected-config');
});
