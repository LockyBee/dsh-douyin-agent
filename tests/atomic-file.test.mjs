import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {atomicJsonWrite} from '../atomic-file.mjs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { withJsonControlGuard } from '../atomic-file.mjs';
test('原子替换遇到短暂共享冲突可恢复，永久拒绝保留原记录并清理自己的临时文件',t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-atomic-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,'state.json');atomicJsonWrite(file,{sequence:1});const rename=fs.renameSync;let attempts=0;fs.renameSync=(...args)=>{if(attempts++<2)throw Object.assign(Error('合成共享冲突'),{code:'EPERM'});return rename(...args);};try{atomicJsonWrite(file,{sequence:2});}finally{fs.renameSync=rename;}assert.equal(attempts,3);assert.deepEqual(JSON.parse(fs.readFileSync(file)),{sequence:2});fs.renameSync=()=>{throw Object.assign(Error('合成持续拒绝'),{code:'EACCES'})};try{assert.throws(()=>atomicJsonWrite(file,{sequence:3}),{code:'EACCES'});}finally{fs.renameSync=rename;}assert.deepEqual(JSON.parse(fs.readFileSync(file)),{sequence:2});assert.deepEqual(fs.readdirSync(root),['state.json']);});

test('回收已退出进程留下的控制锁，保留仍有人持有或无法识别的锁', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-control-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'video-control.guard'), busy = new Error('合成控制锁正在使用');
  const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(child.status, 0);
  fs.writeFileSync(file, JSON.stringify({ pid: child.pid, token: randomUUID() }));
  assert.equal(withJsonControlGuard(file, () => JSON.parse(fs.readFileSync(file)).pid, busy), process.pid);
  assert.equal(fs.existsSync(file), false);
  for (const record of ['', '合成损坏记录', JSON.stringify({ pid: process.pid, token: randomUUID() })]) {
    fs.writeFileSync(file, record);
    assert.throws(() => withJsonControlGuard(file, () => assert.fail(), busy), busy);
    assert.equal(fs.readFileSync(file, 'utf8'), record);
  }
});
