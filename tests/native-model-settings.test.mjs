import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeModelSettings } from '../native-model-settings.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-native-model-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^douyin-native-model-/); fs.rmSync(root, { recursive: true, force: true }); });
  let time = 1000, providers = [{ id: 'synthetic', name: '合成提供商', apiKey: '不得出现在状态中' }];
  let models = [{ provider: 'synthetic', id: 'synthetic-vision', name: '合成视觉模型', inputModalities: ['text', 'image'], privateField: '不得出现在状态中' }];
  const calls = { catalog: 0, resolve: 0 }; let holdCatalog, holdMetadata;
  const llm = {
    listProviders: () => providers,
    async listModels(provider) { calls.catalog++; await holdCatalog?.(provider); return models.filter(item => item.provider === provider); },
    async resolveModelInfo(provider, id) { calls.resolve++; await holdMetadata?.(); return { provider, id, name: '合成元数据' }; },
    stream() { assert.fail('模型选择不得生成内容'); },
  };
  const settings = new NativeModelSettings({ stateDir: path.join(root, 'state'), llm, now: () => time, ...options });
  return { root, llm, calls, settings, advance: milliseconds => { time += milliseconds; }, providers: value => { providers = value; }, models: value => { models = value; }, holdCatalog: callback => { holdCatalog = callback; }, holdMetadata: callback => { holdMetadata = callback; } };
}

test('原生模型目录只返回可选择元数据，并发查询与轮询共用有限缓存', async t => {
  const f = fixture(t), started = Promise.withResolvers(), release = Promise.withResolvers();
  f.holdCatalog(async () => { started.resolve(); await release.promise; });
  const first = f.settings.catalog(); await started.promise;
  const second = f.settings.catalog(); release.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(f.calls.catalog, 1); assert.deepEqual(a, b);
  assert.deepEqual(a.providers, [{ id: 'synthetic', name: '合成提供商' }]);
  assert.deepEqual(a.models, [{ provider: 'synthetic', id: 'synthetic-vision', name: '合成视觉模型', inputModalities: ['text', 'image'] }]);
  assert.equal(JSON.stringify(a).includes('不得出现在状态中'), false);
  await f.settings.catalog(); f.advance(59_999); await f.settings.catalog(); assert.equal(f.calls.catalog, 1);
  f.advance(1); await f.settings.catalog(); assert.equal(f.calls.catalog, 2);
  a.models[0].inputModalities.push('外部修改'); assert.deepEqual(f.settings.state().models[0].inputModalities, ['text', 'image']);
  assert.equal(f.calls.resolve, 0); assert.equal(fs.existsSync(f.settings.file), false);
});

test('从可用目录选择模型后核对元数据，只保存提供商与模型标识', async t => {
  const f = fixture(t); let stoppedChecks = 0;
  const saved = await f.settings.configure({ provider: 'synthetic', model: ' synthetic-vision ' }, { explicit: true, beforeCommit: () => { stoppedChecks++; } });
  assert.equal(saved.configured, true); assert.equal(saved.model, 'synthetic-vision');
  assert.equal(f.calls.resolve, 1); assert.equal(stoppedChecks, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settings.file, 'utf8')), { provider: 'synthetic', model: 'synthetic-vision' });
});

test('未列出的模型、未知提供商和附带密钥均在元数据查询与写入前拒绝', async t => {
  const f = fixture(t);
  await assert.rejects(f.settings.configure({ provider: 'synthetic', model: '任意手填模型' }, { explicit: true }), /不在 DSH 可用目录/);
  await assert.rejects(f.settings.configure({ provider: 'missing', model: 'synthetic-vision' }, { explicit: true }), /尚未在 DSH 配置/);
  await assert.rejects(f.settings.configure({ provider: 'synthetic', model: 'synthetic-vision', apiKey: '不能经此入口保存' }, { explicit: true }), /选择模型/);
  await assert.rejects(f.settings.configure({ provider: 'synthetic', model: 'synthetic-vision' }), /选择模型/);
  assert.equal(f.calls.resolve, 0); assert.equal(fs.existsSync(f.settings.file), false);
});

test('目录移除已保存模型后标为未就绪，不能继续提交已移除模型', async t => {
  const f = fixture(t); await f.settings.configure({ provider: 'synthetic', model: 'synthetic-vision' }, { explicit: true });
  f.models([]); f.advance(60_000);
  const state = await f.settings.catalog();
  assert.equal(state.configured, false); assert.equal(state.model, 'synthetic-vision'); assert.deepEqual(state.models, []);
  assert.match(state.catalogErrors[0].message, /模型目录为空/);
  await assert.rejects(f.settings.configure({ provider: 'synthetic', model: 'synthetic-vision' }, { explicit: true }), /模型目录为空/);
  assert.equal(f.calls.resolve, 1);
});

test('元数据查询期间提供商或模型退出目录时，保存失败并保留原文件', async t => {
  const f = fixture(t); await f.settings.configure({ provider: 'synthetic', model: 'synthetic-vision' }, { explicit: true });
  const original = fs.readFileSync(f.settings.file, 'utf8');
  f.holdMetadata(() => { f.models([]); });
  await assert.rejects(f.settings.configure({ provider: 'synthetic', model: 'synthetic-vision' }, { explicit: true }), /模型目录为空/);
  assert.equal(fs.readFileSync(f.settings.file, 'utf8'), original);
  f.models([{ provider: 'synthetic', id: 'synthetic-vision', name: '合成视觉模型' }]); await f.settings.catalog({ force: true });
  f.holdMetadata(() => { f.providers([]); });
  await assert.rejects(f.settings.configure({ provider: 'synthetic', model: 'synthetic-vision' }, { explicit: true }), /尚未在 DSH 配置/);
  assert.equal(fs.readFileSync(f.settings.file, 'utf8'), original);
});

test('保存前停止守卫或模型服务更换阻止写入，不遗留临时文件', async t => {
  const f = fixture(t);
  await assert.rejects(f.settings.configure({ provider: 'synthetic', model: 'synthetic-vision' }, { explicit: true, beforeCommit: () => { throw Object.assign(new Error('合成服务已启动'), { status: 409 }); } }), /服务已启动/);
  assert.equal(fs.existsSync(f.settings.file), false);
  let available = f.llm;
  const settings = new NativeModelSettings({ stateDir: path.join(f.root, 'swapped'), getLlm: () => available });
  await assert.rejects(settings.configure({ provider: 'synthetic', model: 'synthetic-vision' }, { explicit: true, beforeCommit: () => { available = undefined; } }), /提供商已变化/);
  assert.equal(fs.existsSync(settings.file), false);
});

test('单个提供商目录失败或超时不阻断其他模型，也不回传原始异常秘密', async t => {
  const f = fixture(t, { catalogTimeoutMs: 25 });
  f.providers([{ id: 'synthetic', name: '可用提供商' }, { id: 'broken', name: '失败提供商' }, { id: 'hung', name: '超时提供商' }]);
  f.holdCatalog(provider => { if (provider === 'broken') throw new Error('Bearer 禁止回传的合成凭据'); if (provider === 'hung') return new Promise(() => {}); });
  const state = await f.settings.catalog();
  assert.equal(state.models.length, 1); assert.deepEqual(state.catalogErrors.map(item => item.provider).sort(), ['broken', 'hung']);
  assert.equal(JSON.stringify(state).includes('禁止回传'), false);
  assert.equal(state.catalogLoaded, true); assert.equal(f.calls.resolve, 0);
});

test('晚挂载服务与提供商列表变化会重新读取目录，不延用旧服务缓存', async t => {
  const f = fixture(t); let available;
  const settings = new NativeModelSettings({ stateDir: path.join(f.root, 'late'), getLlm: () => available });
  assert.deepEqual((await settings.catalog()).models, []); available = f.llm;
  assert.equal((await settings.catalog()).models.length, 1); assert.equal(f.calls.catalog, 1);
  f.providers([{ id: 'synthetic', name: '原提供商' }, { id: 'added', name: '新提供商' }]);
  await settings.catalog(); assert.equal(f.calls.catalog, 3);
  available = { ...f.llm, listModels: async () => [] };
  assert.equal(settings.state().catalogLoaded, false); assert.deepEqual((await settings.catalog()).models, []);
});
