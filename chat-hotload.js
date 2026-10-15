// cordis_define 的 code.host；只加载新增私信工具，不改旧视频包。
return {
  name:'douyin-chat-local-mount',inject:['loader','tools'],
  async apply(ctx) {
    const expected=['douyin_chat_contacts','douyin_chat_status','douyin_chat_start','douyin_chat_stop','douyin_chat_read','douyin_chat_observe'];
    const names=new Set(ctx.tools.schemas().map(tool=>tool.name));
    if(expected.every(name=>names.has(name))) { console.log(JSON.stringify({chatAddonAlreadyLoaded:true,registeredToolNames:expected}));return; }
    if(expected.some(name=>names.has(name))) throw new Error('聊天工具已有部分同名注册，已停止重复加载。');
    const id=await ctx.loader.create({name:'file:///D:/codex%E5%88%86%E5%B1%80/dsh%E9%85%8D%E7%BD%AE/douyin-browser/dsh-chat-addon.mjs?v=5'});
    ctx.effect(()=>async()=>{await ctx.loader.remove(id);},'卸载本次新增的私信工具');
    await ctx.loader.await();
    const loaded=new Set(ctx.tools.schemas().map(tool=>tool.name));
    if(!expected.every(name=>loaded.has(name)))throw new Error('新增的私信工具未全部注册。');
    console.log(JSON.stringify({chatAddonLoaded:true,loaderEntryId:id,registeredToolNames:expected}));
  },
};
