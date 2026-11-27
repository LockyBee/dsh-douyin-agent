import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { createNativeSettingsRoute } from '../native-settings.mjs';
import { VideoReactions } from '../video-reactions.mjs';
import { PersonaMemory } from '../persona-memory.mjs';
import { VideoLimits } from '../video-limits.mjs';

test('插件通过本机原生 HTTP 路由保存点赞收藏，不依赖独立软件且不调用模型或浏览器', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-native-reactions-')), stateDir = path.join(root, 'state');
  const videoLimits = new VideoLimits({ stateDir });
  const personaMemory = new PersonaMemory({ memoryDir: path.join(root, 'memory'), legacyRoleCardFile: path.join(root, 'none') }); personaMemory.initialize({ importLegacy: false });
  const reactions = new VideoReactions({ personaMemory, videoLimits, stateDir, source: 'dsh', react: async () => assert.fail('保存不能产生平台互动') });
  const route = createNativeSettingsRoute({ getController: async () => ({ limits: () => videoLimits, getPersonaMemory: () => personaMemory, getReactions: async () => reactions }),
    getComments: async () => ({ state: () => ({ enabled: false }) }), getWatch: async () => ({ state: () => ({ running: false }) }), getReport: async () => ({ state: () => ({}) }), getMode: async () => ({ state: () => ({ silent: false }) }), modelSettings: { state: () => ({ configured: false }) } });
  const server = http.createServer(route.handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await reactions.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, prefix = origin + route.path;
  const state = await (await fetch(prefix + '/state')).json();
  assert.equal(state.reactions.protocol, 'video-reactions-v1'); assert.deepEqual(state.reactions.policy, { like: false, favorite: false });
  const request = (body, token = state.token) => fetch(prefix + '/reactions/configure', { method: 'POST', headers: { 'content-type': 'application/json', 'x-douyin-settings-token': token }, body: JSON.stringify(body) });
  assert.equal((await request({ like: true, favorite: true }, 'wrong')).status, 403);
  assert.equal((await request({ like: true })).status, 400);
  const saved = await request({ like: false, favorite: true }); assert.equal(saved.status, 200); assert.deepEqual((await saved.json()).policy, { like: false, favorite: true });
  assert.deepEqual((await (await fetch(prefix + '/state')).json()).reactions.policy, { like: false, favorite: true });
});
