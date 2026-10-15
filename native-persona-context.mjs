import path from 'node:path';

const canonical = value => typeof value === 'string' ? path.resolve(value).toLowerCase().replaceAll('\\','/').replace(/\/+$/,'') : '';

// 只给大肥鱼工作区与本插件工作区附加人格，其他 DSH 工作区保持自己的角色。
export function bindNativePersonaContext(ctx, { getPersonaMemory, workspacePaths }) {
  const workspaces = new Set(workspacePaths.map(canonical));
  const attached = new Map(), listeners = [];
  const attach = agent => {
    if (attached.has(agent) || !workspaces.has(canonical(agent?.session?.header?.cwd))) return false;
    const prompt = agent.ctx?.systemPrompt;
    if (!prompt?.variable || !prompt?.context) return false;
    const disposers = [];
    try {
      disposers.push(prompt.variable('douyin_shared_persona', () => getPersonaMemory().context()));
      disposers.push(prompt.context({name:'workspace:douyin-shared-persona',order:140,text:()=> '{{douyin_shared_persona}}'}));
      attached.set(agent,disposers);
      return true;
    } catch (error) { for (const dispose of disposers.reverse()) dispose?.(); throw error; }
  };
  const detach = agent => { for (const dispose of (attached.get(agent) || []).reverse()) dispose?.(); attached.delete(agent); };
  try {
    if (typeof ctx.on === 'function') {
      listeners.push(ctx.on('agent/created',({agent})=>attach(agent)));
      listeners.push(ctx.on('agent/disposed',({agent})=>detach(agent)));
    }
    let agents; try { agents=ctx.get?.('agents'); } catch {}
    for (const agent of agents?.list?.() || []) attach(agent);
  } catch (error) { for (const off of listeners.reverse()) off?.(); for (const agent of [...attached.keys()]) detach(agent); throw error; }
  return {attach,close(){for(const off of listeners.reverse())off?.();for(const agent of [...attached.keys()])detach(agent);}};
}
