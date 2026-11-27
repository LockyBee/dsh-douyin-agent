import fs from 'node:fs';import {randomUUID} from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const waitCell=new Int32Array(new SharedArrayBuffer(4));
const temporaryConflict=error=>['EPERM','EBUSY','EACCES'].includes(error.code);
function retryFileAccess(action) {
  for (let attempt = 0; ; attempt++) {
    try { return action(); }
    catch (error) {
      if (!temporaryConflict(error) || attempt >= 9) throw error;
      Atomics.wait(waitCell, 0, 0, 10);
    }
  }
}
export function atomicJsonWrite(file,value,{newline=false}={}){
  const temporary=`${file}.${process.pid}.${randomUUID()}.tmp`;
  try{
    fs.writeFileSync(temporary,JSON.stringify(value,null,2)+(newline?'\n':''),{mode:0o600,flag:'wx'});
    retryFileAccess(() => fs.renameSync(temporary, file));
  }finally{
    if (fs.existsSync(temporary)) retryFileAccess(() => fs.unlinkSync(temporary));
  }
}

function lockOwner(file, strictAccess = false) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 2048) return null;
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isSafeInteger(owner?.pid) && owner.pid > 0
      && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(owner.token) ? owner : null;
  } catch (error) {
    if (strictAccess && temporaryConflict(error)) throw error;
    return null;
  }
}

function ownerExited(owner) {
  if (!owner) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

function recoverJsonGuard(file, owner, busy) {
  // SQLite 串行核对退出进程留下的锁。回收进程若退出，操作系统会释放数据库锁。
  const databaseFile = path.join(path.dirname(file), 'control-guard-recovery.sqlite');
  try { if (!fs.lstatSync(databaseFile).isFile()) throw busy; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const database = new DatabaseSync(databaseFile);
  try {
    try { database.exec('BEGIN IMMEDIATE'); }
    catch (error) { if (error.errcode === 5 || error.errcode === 6) throw busy; throw error; }
    const current = lockOwner(file);
    if (current?.pid === owner.pid && current.token === owner.token && ownerExited(current)) fs.unlinkSync(file);
  } finally { database.close(); }
}

export function withJsonControlGuard(file, action, busy, { retryAccess = false, onBlockedRelease } = {}) {
  const token = randomUUID(), owner = { pid: process.pid, token, createdAt: new Date().toISOString() };
  const useFile = operation => retryAccess ? retryFileAccess(operation) : operation();
  const open = () => useFile(() => fs.openSync(file, 'wx', 0o600));
  const release = () => useFile(() => {
    const current = lockOwner(file, retryAccess);
    if (current?.pid === owner.pid && current.token === owner.token) fs.unlinkSync(file);
  });
  let descriptor;
  try { descriptor = open(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = useFile(() => lockOwner(file, retryAccess));
    if (!ownerExited(previous)) throw busy;
    useFile(() => recoverJsonGuard(file, previous, busy));
    try { descriptor = open(); }
    catch (error) { if (error.code === 'EEXIST') throw busy; throw error; }
  }
  try {
    try { fs.writeFileSync(descriptor, JSON.stringify(owner)); }
    finally { fs.closeSync(descriptor); }
    return action();
  } finally {
    try { release(); }
    catch (error) {
      if (!onBlockedRelease || !temporaryConflict(error)) throw error;
      onBlockedRelease(release, error);
    }
  }
}
