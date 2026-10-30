import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';

test('软件未答由后台处理，顶栏不提供人工清除入口且不展示旧核对副标题', async () => {
  const source=await fs.readFile(new URL('../src/main.jsx',import.meta.url),'utf8');
  assert.doesNotMatch(source,/function UnansweredDialog|setUnansweredOpen|onOpenUnanswered|chatResolveAll/);
  assert.match(source,/回复处理记录/);assert.match(source,/查看分享收据/);
  const component=source.slice(source.indexOf('function FriendPresence('),source.indexOf('function ReviewDialog('));
  const desktop=createRequire(new URL('../../package.json',import.meta.url));
  const code=desktop('esbuild').transformSync(component,{loader:'jsx',jsx:'transform',target:'es2022'}).code;
  const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)});
  const render=vm.runInNewContext(code+';FriendPresence;',{React:{createElement:h}});
  const tree=render({connected:true,presence:{reply:{status:'replying',online:true,label:'在线 · 回复中',reason:'正在处理许可会话的消息。'},review:{active:true,manualCount:2,label:'有2条未答',reason:'已核实的3个会话继续检查新消息。'}}});
  const nodes=value=>value&&typeof value==='object'?[value,...value.children.flatMap(nodes)]:[];
  const text=value=>value&&typeof value==='object'?value.children.map(text).join(' '):typeof value==='string'?value:'';
  assert.match(text(tree),/在线 · 回复中/);assert.doesNotMatch(text(tree),/未答|已核实|核对/);
  assert.equal(nodes(tree).some(item=>item.type==='button'||item.props.onClick),false);
  const down=render({connected:false,presence:{reply:{status:'replying',online:true,label:'在线 · 回复中'}}});
  assert.doesNotMatch(text(down),/在线 · 回复中/);assert.match(text(down),/状态待核实/);
});
