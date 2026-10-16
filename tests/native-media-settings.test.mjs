import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parseEnv } from 'node:util';
import { MediaAdapter } from '../media/index.mjs';
import { createNativeSettingsRoute } from '../native-settings.mjs';

async function fixture(t, { env = {}, config } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-native-media-settings-'));
  const envFile = path.join(directory, '.env'), settingsFile = path.join(directory, 'settings.json');
  let cloudRequests = 0, token;
  const media = new MediaAdapter({ env, config, envFile, settingsFile, python: 'douyin-synthetic-unavailable-python', fetchImpl: () => { cloudRequests++; throw new Error('合成验收禁止云请求'); } });
  const flags = { watch: {}, spark: {}, chat: {} };
  const route = createNativeSettingsRoute({
    getController: async () => ({ limits: () => ({ state: () => ({}) }), getPersonaMemory: () => ({ snapshot: () => ({}) }) }),
    getComments: async () => ({ state: () => ({}) }), getReport: async () => ({ state: async () => ({}) }), getMode: async () => ({ state: () => ({}) }),
    getSpark: async () => ({ state: () => flags.spark }), getWatch: async () => ({ state: () => flags.watch }), getChat: async () => ({ state: () => flags.chat }), getMedia: async () => media,
    modelSettings: { state: () => ({ configured: false }), catalog: async () => ({ configured: false, providers: [], models: [] }) },
  });
  const server = http.createServer((req, res) => { void route.handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/douyin-browser`;
  const request = async (route, input, headers = {}) => {
    const response = await fetch(base + route, { ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }), headers: { ...(input === undefined ? {} : { 'content-type': 'application/json', 'x-douyin-settings-token': token || '' }), ...headers } });
    return { status: response.status, body: await response.json() };
  };
  const bootstrap = async () => { const result = await request('/state'); assert.equal(result.status, 200); token = result.body.token; return result.body; };
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^douyin-native-media-settings-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, envFile, settingsFile, media, flags, request, bootstrap, cloudRequests: () => cloudRequests };
}

test('原生音频密钥入口沿用同源令牌，拒绝 GET、跨源和未授权写入', async t => {
  const f = await fixture(t), input = { backend: 'mimo', apiKey: 'synthetic-native-mimo' };
  assert.equal((await f.request('/media/credentials', input)).status, 403);
  const initial = await f.bootstrap(); assert.deepEqual(initial.model.models, []);
  assert.equal((await f.request('/media/credentials', input, { origin: 'https://synthetic.invalid' })).status, 403);
  assert.equal((await f.request('/media/credentials', input, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.request('/media/credentials?apiKey=synthetic-must-not-save')).status, 404);
  await assert.rejects(fs.access(f.envFile), { code: 'ENOENT' });
  assert.equal(f.cloudRequests(), 0);
});

test('原生 MiMo/MiniMax 保存共用原子 writer，状态不返 Key 且不打开音频或改变后端', async t => {
  const f = await fixture(t); await fs.writeFile(f.envFile, '# 合成共享配置\nDOUYIN_MEDIA_FFMPEG=synthetic-ffmpeg\n');
  await f.media.saveSettings({ enabled: false, backend: 'local-whisper' }, { explicit: true });
  const originalSettings = await fs.readFile(f.settingsFile, 'utf8'); await f.bootstrap();
  const results = await Promise.all([
    f.request('/media/credentials', { backend: 'mimo', apiKey: 'synthetic-native-mimo' }),
    f.request('/media/credentials', { backend: 'minimax', apiKey: 'synthetic-native-minimax' }),
  ]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  const contents = await fs.readFile(f.envFile, 'utf8'), config = parseEnv(contents);
  assert.equal(config.XIAOMI_API_KEY, 'synthetic-native-mimo'); assert.equal(config.MINIMAX_API_KEY, 'synthetic-native-minimax');
  assert.ok(contents.startsWith('# 合成共享配置\n')); assert.equal(config.DOUYIN_MEDIA_FFMPEG, 'synthetic-ffmpeg');
  assert.equal(await fs.readFile(f.settingsFile, 'utf8'), originalSettings);
  const state = (await f.bootstrap()).media;
  assert.deepEqual(state.backends.mimo.credential, { configured: true, source: 'shared-env', saved: true, environmentOverride: false });
  assert.equal(state.backends.minimax.credential.configured, true);
  assert.equal(state.enabled, false); assert.equal(state.backend, 'local-whisper');
  for (const result of [...results, { body: state }]) assert.doesNotMatch(JSON.stringify(result.body), /synthetic-native|apiKey|XIAOMI_API_KEY|MINIMAX_API_KEY/);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['.env', 'settings.json']); assert.equal(f.cloudRequests(), 0);
});

test('音频 Key 留空保留原文件，未知字段和注入被拒绝且错误不回显输入', async t => {
  const f = await fixture(t); await f.bootstrap();
  const original = '# 合成原文件\nXIAOMI_API_KEY=synthetic-existing\n'; await fs.writeFile(f.envFile, original);
  assert.equal((await f.request('/media/credentials', { backend: 'mimo', apiKey: '  \n' })).status, 200);
  assert.equal(await fs.readFile(f.envFile, 'utf8'), original);
  for (const input of [
    { backend: 'mimo', apiKey: 'synthetic-new', enabled: true },
    { backend: 'mimo', apiKey: 'synthetic-injection\nMINIMAX_API_KEY=synthetic-extra' },
    { backend: 'local-whisper', apiKey: 'synthetic-not-supported' },
    { backend: 'minimax' },
  ]) {
    const result = await f.request('/media/credentials', input);
    assert.equal(result.status, 400); assert.doesNotMatch(JSON.stringify(result.body), /synthetic|apiKey|MINIMAX_API_KEY/);
  }
  assert.equal(await fs.readFile(f.envFile, 'utf8'), original);
  await assert.rejects(f.media.saveCredentials({ backend: 'mimo', apiKey: '' }), /明确保存/);
  assert.equal(f.cloudRequests(), 0);
});

test('已保存与实际生效分开显示，进程环境或显式配置覆盖不会泄露值', async t => {
  const env = { XIAOMI_API_KEY: '', MINIMAX_API_KEY: 'synthetic-environment' }, f = await fixture(t, { env });
  await fs.writeFile(f.envFile, 'XIAOMI_API_KEY=synthetic-file-mimo\nMINIMAX_API_KEY=synthetic-file-minimax\n');
  let state = await f.media.status();
  assert.deepEqual(state.backends.mimo.credential, { configured: false, source: 'environment', saved: true, environmentOverride: true });
  assert.equal(state.backends.mimo.available, false);
  assert.deepEqual(state.backends.minimax.credential, { configured: true, source: 'environment', saved: true, environmentOverride: true });
  await f.bootstrap(); const saved = await f.request('/media/credentials', { backend: 'mimo', apiKey: 'synthetic-new-file' });
  assert.equal(saved.status, 200); assert.equal(saved.body.backends.mimo.credential.configured, false);
  assert.equal(parseEnv(await fs.readFile(f.envFile, 'utf8')).XIAOMI_API_KEY, 'synthetic-new-file');
  delete env.XIAOMI_API_KEY; state = await f.media.status();
  assert.equal(state.backends.mimo.credential.source, 'shared-env'); assert.equal(state.backends.mimo.credential.configured, true);
  f.media.configOverride = { XIAOMI_API_KEY: 'synthetic-override' }; state = await f.media.status();
  assert.deepEqual(state.backends.mimo.credential, { configured: true, source: 'override', saved: true, environmentOverride: false });
  assert.equal(state.backends.minimax.credential.configured, false); assert.equal(state.backends.minimax.credential.source, 'override');
  assert.doesNotMatch(JSON.stringify(state), /synthetic-|apiKey|XIAOMI_API_KEY|MINIMAX_API_KEY/); assert.equal(f.cloudRequests(), 0);
});

test('观看、问候或私信服务运行时，原生设置拒绝替换音频凭据', async t => {
  const f = await fixture(t); await f.bootstrap();
  for (const [kind, value] of [['watch', { running: true }], ['spark', { starting: true }], ['chat', { worker: { alive: true } }]]) {
    f.flags[kind] = value;
    const result = await f.request('/media/credentials', { backend: 'mimo', apiKey: 'synthetic-active-denied' });
    assert.equal(result.status, 409); assert.match(result.body.error, /先停止/); f.flags[kind] = {};
  }
  await assert.rejects(fs.access(f.envFile), { code: 'ENOENT' }); assert.equal(f.cloudRequests(), 0);
});
