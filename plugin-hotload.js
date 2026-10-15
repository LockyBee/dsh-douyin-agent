// 此文件是 cordis_define 的 code.host 函数体，不能直接作为普通插件导入。
// 使用已声明的 Loader 服务加载本地原生插件，不读令牌、不改其他插件。
return {
  name: 'douyin-browser-local-mount',
  inject: ['loader', 'tools'],
  async apply(ctx) {
    const expected = ['douyin_open', 'douyin_search', 'douyin_open_video', 'douyin_next', 'douyin_previous', 'douyin_status', 'douyin_observe', 'douyin_screenshot', 'douyin_pause', 'douyin_play', 'douyin_remember', 'douyin_recall','douyin_chat_contacts','douyin_chat_status','douyin_chat_start','douyin_chat_stop','douyin_chat_read','douyin_chat_observe','douyin_video_limits_status','douyin_media_status','douyin_listen','douyin_forward_video','douyin_persona_status','douyin_interest_record','douyin_watch_status','douyin_watch_start','douyin_watch_stop'];
    const base = 'file:///D:/codex%E5%88%86%E5%B1%80/dsh%E9%85%8D%E7%BD%AE/douyin-browser/dsh-plugin.mjs';
    const target = base + '?v=8';
    const ownEntries = () => {
      const entries = [];
      for (const entry of ctx.loader.entries()) if (typeof entry.options.name === 'string' && entry.options.name.split('?')[0] === base) entries.push(entry);
      return entries;
    };
    const complete = () => {
      const names = new Set(ctx.tools.schemas().map((tool) => tool.name));
      return expected.every((name) => names.has(name));
    };
    // Cordis 的运行态为 2；等待注入依赖的条目虽有 UID，仍未运行。
    const active = (entry) => !entry.disabled && entry.fiber?.state === 2;
    const existing = new Set(ctx.tools.schemas().map((tool) => tool.name));
    const owned = ownEntries();
    if (owned.length > 1) throw new Error('本项目插件条目不唯一，已停止升级。');
    if (owned.length === 1) {
      const id = owned[0].id, previousName = owned[0].options.name;
      if (!active(owned[0])) throw new Error('本项目插件条目已停用或尚未处于活动状态，未更改其启用设置。');
      if (previousName === target && complete()) {
        console.log(JSON.stringify({ nativePluginAlreadyLoaded: true, loaderEntryId: id, moduleVersion: 8, registeredToolNames: expected }));
        return;
      }
      try {
        // include 管理的条目使用公开 update 原位重启，保留 ID、配置和归属。
        await ctx.loader.update(id, { name: target });
        await ctx.loader.await();
        const current = ownEntries();
        if (current.length !== 1 || current[0].id !== id || current[0].options.name !== target || !active(current[0]) || !complete()) throw new Error('原位升级后模块版本、活动状态或完整工具目录未通过核对。');
      } catch (error) {
        try {
          await ctx.loader.update(id, { name: previousName });
          await ctx.loader.await();
        } catch (rollbackError) {
          throw new Error('插件升级失败，原条目回滚也未完成，需要人工核对。', { cause: rollbackError });
        }
        throw error;
      }
      // 此条目由原配置或其他既有加载者管理，不随本次辅助包停止而移除。
      console.log(JSON.stringify({ nativePluginLoaded: true, upgradedPreviousEntryId: id, loaderEntryId: id, managedEntryPreserved: true, moduleVersion: 8, registeredToolNames: expected }));
      return;
    }
    if (expected.some((name) => existing.has(name))) {
      throw new Error('抖音工具已存在，但无法确认属于本项目条目，已停止重复加载。');
    }
    const id = await ctx.loader.create({ name: target });
    const created = ownEntries().find((entry) => entry.id === id);
    ctx.effect(() => async () => {
      const current = ownEntries().find((entry) => entry.id === id);
      // ID 被其他插件重用、条目改名或已卸载时，不移除后来接管的条目。
      if (created && current === created) await ctx.loader.remove(id);
    }, '卸载本次加载的原生抖音插件');
    await ctx.loader.await();
    const current = ownEntries().find((entry) => entry.id === id);
    if (!created || current !== created || current.options.name !== target || !active(current) || !complete()) throw new Error('原生抖音插件条目或完整工具目录未通过核对。');
    console.log(JSON.stringify({ nativePluginLoaded: true, loaderEntryId: id, moduleVersion: 8, registeredToolNames: expected }));
  },
};
