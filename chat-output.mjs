import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { resolveQQMemoryPath } from './memory.mjs';
import { scrubMemoryText } from './qq-sync.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
export const UPLOAD_STAGING_CONTRACT = 'df76b0ab102f5d0cfa499a3c6ca9ab5ea5d98c3c3cbb8aabb00e6d8d2ee7ea7b';
const assetName = /^asset:([a-f0-9]{64})\.(png|jpg|gif|webp)$/;
function loadOutputConfig(qqPath) {
  let yaml;try{yaml=createRequire(import.meta.url)('yaml');}catch{yaml=createRequire(path.join(path.dirname(path.dirname(qqPath)),'package.json'))('yaml');}
  const config=yaml.parse(fs.readFileSync(path.join(path.dirname(path.dirname(qqPath)),'config.yaml'),'utf8'));
  if(!config||typeof config!=='object')throw new Error('共享表情配置无效。');
  return {memory:config.memory||{},interactions:config.interactions||{}};
}
export function imageFileType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > 8 * 1024 * 1024) throw new Error('表情图片为空或超过8MB。');
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { extension: 'png', mimeType: 'image/png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { extension: 'jpg', mimeType: 'image/jpeg' };
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return { extension: 'gif', mimeType: 'image/gif' };
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return { extension: 'webp', mimeType: 'image/webp' };
  throw new Error('只允许已核对的PNG、JPEG、GIF或WebP表情图片。');
}

export class ChatOutputAssets {
  constructor({ qqPath = resolveQQMemoryPath(resolveRuntimePaths().memoryDbPath), loadConfig = loadOutputConfig } = {}) { this.qqPath = qqPath; this.loadConfig = loadConfig; }
  withDatabase(callback) {
    const stat = fs.lstatSync(this.qqPath); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('共享表情来源无效。');
    const db = new DatabaseSync(this.qqPath, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout=1500;'); return callback(db); } finally { db.close(); }
  }
  enabled(db) {
    const cfg = this.loadConfig(this.qqPath), row = db.prepare("SELECT value_json FROM runtime_settings WHERE key='console-overrides'").get();
    const override = row ? JSON.parse(row.value_json) : {};
    return (override.memory?.shared ?? cfg.memory?.shared) === true && (override.interactions?.enabled ?? cfg.interactions?.enabled) !== false && (override.interactions?.allowStickers ?? cfg.interactions?.allowStickers) !== false;
  }
  candidates(db) {
    if (!this.enabled(db)) return [];
    return db.prepare("SELECT id,file_url,remark FROM stickers WHERE status='active' AND share_scope='public' AND file_url LIKE 'asset:%' ORDER BY updated_at DESC,id DESC LIMIT 100").all()
      .filter(row => Number.isSafeInteger(row.id) && assetName.test(row.file_url || ''));
  }
  key(row) { return 'sticker:' + sha(JSON.stringify([path.resolve(this.qqPath), row.id, row.file_url])); }
  catalog() {
    try { return this.withDatabase(db => this.candidates(db).slice(0, 18).map(row => ({ id: this.key(row), remark: scrubMemoryText(String(row.remark || '已公开表情')).slice(0, 180) }))); }
    catch { return []; }
  }
  read(id) {
    if (!/^sticker:[a-f0-9]{64}$/.test(id || '')) throw new Error('未选择可用的公开表情。');
    return this.withDatabase(db => {
      const row = this.candidates(db).find(row => this.key(row) === id); if (!row) throw new Error('表情已撤销公开、停用或变更，未发送。');
      const match = assetName.exec(row.file_url), root = path.join(path.dirname(this.qqPath), 'stickers');
      if (fs.lstatSync(root).isSymbolicLink()) throw new Error('表情缓存目录无效。');
      const realRoot = fs.realpathSync(root), file = path.join(realRoot, match[1] + '.' + match[2]), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 12 || stat.size > 8 * 1024 * 1024 || path.dirname(fs.realpathSync(file)) !== realRoot) throw new Error('表情缓存文件无效。');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); let bytes;
      try { const opened = fs.fstatSync(fd); if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw new Error('表情文件已变更。'); const buffer=Buffer.alloc(opened.size+1);let length=0;while(length<buffer.length){const n=fs.readSync(fd,buffer,length,buffer.length-length,null);if(!n)break;length+=n;}if(length!==opened.size)throw new Error('表情读取期间大小改变。');bytes=buffer.subarray(0,length); } finally { fs.closeSync(fd); }
      const type = imageFileType(bytes); if (type.extension !== match[2] || sha(bytes) !== match[1]) throw new Error('表情内容摘要或格式不匹配。');
      const current = this.candidates(db).find(value => this.key(value) === id); if (!current) throw new Error('读取期间表情许可已撤回。');
      return { id, bytes, sha256: sha(bytes), ...type, remark: scrubMemoryText(String(row.remark || '已公开表情')).slice(0, 180) };
    });
  }
}

export function parseChatOutput(text, { catalog = [], incomingText = '' } = {}) {
  const pattern = /\[\[DY_STICKER:(sticker:[a-f0-9]{64})\]\]/g, choices = [...String(text).matchAll(pattern)].map(item => item[1]);
  const body = String(text).replace(/\[\[DY_STICKER:[^\]\r\n]*\]\]/g, '').trim();
  const refuses = /(?:不要|别|不用|不许).{0,6}(?:表情|发图|图片)/u.test(incomingText);
  const id = !refuses && choices.length === 1 && catalog.some(item => item.id === choices[0]) ? choices[0] : undefined;
  return { text: body, ...(id ? { stickerId: id } : {}) };
}

// 仅观察当前上传组件的公开事件契约，不调用回调或读取上传凭据。
export function readUploadStagingContractDom() {
  const inputs = [...document.querySelectorAll('[data-e2e="im-dialog"] [data-e2e="msg-input"] input[type=file][multiple]')];
  if (inputs.length !== 1) return null;
  const node = inputs[0].closest('.semi-upload'), own = (o, k) => o && typeof o === 'object' ? Object.getOwnPropertyDescriptor(o, k)?.value : undefined;
  const keys = node ? Object.getOwnPropertyNames(node).filter(key => key.startsWith('__reactFiber$')) : [];
  if (keys.length !== 1) return null;
  for (let fiber = own(node, keys[0]), depth = 0; fiber && depth < 4; fiber = own(fiber, 'return'), depth++) {
    const fn = own(own(fiber, 'memoizedProps'), 'onFileChange');
    if (typeof fn === 'function') { const source = Function.prototype.toString.call(fn); return source.length <= 18000 ? source : null; }
  }
  return null;
}

export function readImageUploadPreviewDom({ name, bytes } = {}) {
  const visible = node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== 'hidden'; };
  const roots = [...document.querySelectorAll('.MsgInputSendFileModalbox')].filter(visible);
  if (roots.length !== 1) return null;
  const root = roots[0], own = (o, k) => o && typeof o === 'object' ? Object.getOwnPropertyDescriptor(o, k)?.value : undefined;
  const field = (object, key) => {
    const descriptor = object && typeof object === 'object' ? Object.getOwnPropertyDescriptor(object, key) : null;
    if (!descriptor) return undefined;
    if (Object.hasOwn(descriptor, 'value')) return descriptor.value;
    // 已渲染的 MobX 文件模型：直接读取固定 ObservableValue 数据槽，不执行属性 getter。
    const symbols = Object.getOwnPropertySymbols(object).filter(symbol => symbol.description === 'mobx administration');
    if (symbols.length !== 1) return undefined;
    const values = own(own(object, symbols[0]), 'values_');
    if (!(values instanceof Map)) return undefined;
    return own(Map.prototype.get.call(values, key), 'value_');
  };
  let files = null;
  const keys = Object.getOwnPropertyNames(root).filter(key => key.startsWith('__reactFiber$'));
  if (keys.length !== 1) return null;
  for (let fiber = own(root, keys[0]), depth = 0; fiber && depth < 16; fiber = own(fiber, 'return'), depth++) {
    const value = own(own(fiber, 'memoizedProps'), 'files');
    if (Array.isArray(value)) { if (files && files !== value) return null; files = value; }
  }
  if (!files || files.length !== 1 || !root.querySelector('.MsgInputSendFileModalfileList')) return null;
  const file = files[0], native = field(file, 'file');
  const imagePath = field(file, 'imagePath');
  if (!(native instanceof File) || native.name !== name || native.size !== bytes || field(file, 'name') !== name || typeof field(file, 'localId') !== 'string' || typeof imagePath !== 'string' || imagePath.length > 12 * 1024 * 1024 || !/^(?:blob:|data:image\/(?:png|jpeg|gif|webp);base64,)/.test(imagePath)) return null;
  const caption = root.querySelector('textarea');
  if (caption?.value?.trim()) return null;
  const send = root.querySelectorAll('button.MsgInputSendFileModalbtnSure'), cancel = root.querySelectorAll('button.MsgInputSendFileModalbtnCancle');
  if (send.length !== 1 || cancel.length !== 1 || !/^发送[（(]1[）)]$/.test(send[0].textContent.trim()) || send[0].disabled) return null;
  return { localId: field(file, 'localId'), imagePath: field(file, 'imagePath'), name, bytes, type: field(file, 'type') };
}

export function installImageDispatchGuardDom({ token, name, bytes } = {}) {
  // 本函数由可信代码与上面的同步预览读取器一起序列化；不会执行网页回调。
  const own = (o, k) => o && typeof o === 'object' ? Object.getOwnPropertyDescriptor(o, k)?.value : undefined;
  const modal = document.querySelector('.MsgInputSendFileModalbox'), button = modal?.querySelector('button.MsgInputSendFileModalbtnSure');
  const headers = [...document.querySelectorAll('[data-e2e="im-dialog"] [class*="StackLayoutStackChatHeaderuser"],[data-e2e="im-dialog"] [data-e2e="chat-header"],[data-e2e="im-dialog"] [data-e2e="group-chat-header"]')].filter(e => e.getBoundingClientRect().width > 0);
  if (headers.length !== 1 || !button || !readPreview({ name, bytes })) return false;
  const header = headers[0], page = header.closest('[class*="StackLayoutpagespageRoot"],[data-e2e="chat-page"]');
  if (!page) return false;
  const signature = () => {
    const keys = Object.getOwnPropertyNames(header).filter(k => k.startsWith('__reactProps$'));
    if (keys.length > 1) return null;
    const props = own(header, keys[0]), children = own(props, 'children'), conversation = own(own(Array.isArray(children) ? own(children, '0') : children, 'props'), 'conversation');
    const shape = descriptor => !descriptor ? null : !Object.hasOwn(descriptor, 'value') ? ['accessor'] : ['data', typeof descriptor.value, typeof descriptor.value === 'string' || Number.isSafeInteger(descriptor.value) ? String(descriptor.value) : null];
    const fields = ['conversationId','id','conversationShortId','shortId','groupId','secUid','_toParticipantSecUserId','userId','conversationType','type'];
    return JSON.stringify([[header, page].map(e => e ? ['data-conversation-id','data-conversation-short-id','data-conversation-type','data-is-group'].map(key => e.getAttribute(key)) : null), fields.map(key => [shape(conversation && Object.getOwnPropertyDescriptor(conversation, key)), shape(conversation && Object.getPrototypeOf(conversation) && Object.getOwnPropertyDescriptor(Object.getPrototypeOf(conversation), key))]), [...header.querySelectorAll('a[href]')].map(e => e.getAttribute('href')).filter(href => /\/user\//.test(href || ''))]);
  };
  const messageSignature = () => JSON.stringify([...page.querySelectorAll('[data-e2e="msg-item-content"],[data-e2e="message-content"]')].map(e => [e.textContent, [...e.querySelectorAll('img')].map(i => i.currentSrc || i.getAttribute('src'))]));
  const initial = signature(), messages = messageSignature(), preview = readPreview({ name, bytes });
  const samePreview = () => { const value=readPreview({name,bytes});return value&&preview&&['localId','imagePath','name','bytes','type'].every(key=>value[key]===preview[key]); };
  if (!initial || !page) return false;
  const entry = { accepted: 0, blocked: false, enabled: true };
  const listener = event => {
    if (!event.composedPath().includes(button)) { entry.blocked = true; event.preventDefault(); event.stopImmediatePropagation(); return; }
    const protection = [...document.querySelectorAll('iframe[src*="captcha"],[class*="captcha-verify"],[data-e2e="captcha"],[data-e2e="login-panel"]')].some(e => e.getBoundingClientRect().width > 0);
    const valid = entry.enabled && !entry.accepted && !protection && header.isConnected && button.isConnected && modal.querySelectorAll('button.MsgInputSendFileModalbtnSure').length === 1 && signature() === initial && messageSignature() === messages && samePreview();
    if (!valid || event.isTrusted !== true) { entry.blocked = true; event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (event.type === 'click') entry.accepted++;
  };
  for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) document.addEventListener(type, listener, true);
  entry.dispose = () => { entry.enabled = false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) document.removeEventListener(type, listener, true); delete window[token]; };
  Object.defineProperty(window, token, { value: entry, configurable: true });
  return true;
}
