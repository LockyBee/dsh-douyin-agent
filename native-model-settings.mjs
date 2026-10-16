import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';

export class NativeModelSettings {
  constructor({ stateDir = resolveRuntimePaths().stateDir, llm, getLlm } = {}) { this.file = path.join(stateDir, 'native-model.json'); this.initialLlm = llm; this.getLlm = getLlm; }
  get llm() { return this.getLlm ? this.getLlm() : this.initialLlm; }
  state() {
    let saved = { provider: '', model: '' };
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('原生模型设置损坏，请核对文件。'); }
    if (!saved || typeof saved.provider !== 'string' || typeof saved.model !== 'string' || saved.provider.length > 200 || saved.model.length > 300) throw new Error('原生模型设置格式无效。');
    const providers = typeof this.llm?.listProviders === 'function' ? this.llm.listProviders().map(({ id, name, displayName }) => ({ id, name: name || displayName || id })) : [];
    return { ...saved, providers, configured: Boolean(saved.provider && saved.model && providers.some(item => item.id === saved.provider)) };
  }
  async configure(input, { explicit = false, beforeCommit } = {}) {
    if (!explicit || !input || Object.keys(input).some(key => !['provider', 'model'].includes(key)) || typeof input.provider !== 'string' || typeof input.model !== 'string' || !input.provider.trim() || !input.model.trim() || input.provider.length > 200 || input.model.length > 300) throw Object.assign(new Error('请从 DSH 已配置提供商中选择并填写模型。'), { status: 400 });
    if (!this.state().providers.some(item => item.id === input.provider)) throw Object.assign(new Error('此模型提供商尚未在 DSH 配置。'), { status: 400 });
    if (typeof this.llm?.resolveModelInfo !== 'function') throw new Error('DSH 模型服务尚未就绪。');
    const model = input.model.trim();
    await this.llm.resolveModelInfo(input.provider, model, AbortSignal.timeout(15_000));
    if (beforeCommit) await beforeCommit();
    fs.mkdirSync(path.dirname(this.file), { recursive: true }); const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify({ provider: input.provider, model }), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, this.file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return this.state();
  }
}
