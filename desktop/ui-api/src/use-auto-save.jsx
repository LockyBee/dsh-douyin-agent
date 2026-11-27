import React, { useEffect, useRef, useState } from 'react';

// 草稿在写入成功且读回同一设置之前保持独立，迟到的轮询不会覆盖新输入。
export function useAutoSave({ value, initial, read, encode, write, canonical = (_result, payload) => payload, delay = 600, available = true }) {
  const [draft, setDraft] = useState(() => value ? read(value) : initial);
  const [status, setStatus] = useState({ kind: 'idle', message: '' });
  const current = useRef(draft), dirty = useRef(false), version = useRef(0), ack = useRef(null), timer = useRef(null), writing = useRef(false), queued = useRef(false), requested = useRef(false), mounted = useRef(true);
  const options = useRef(); options.current = { read, encode, write, canonical, delay, available };
  const schedule = immediate => { requested.current = true; clearTimeout(timer.current); timer.current = setTimeout(() => { void flush(); }, immediate ? 0 : options.current.delay); };
  async function flush() {
    requested.current = true; clearTimeout(timer.current);
    if (!mounted.current || !dirty.current || !options.current.available) return;
    if (writing.current) { queued.current = true; return; }
    let payload;
    try { payload = options.current.encode(current.current); }
    catch (error) { setStatus({ kind: 'editing', message: error.message || '填写完整后自动生效。' }); return; }
    const submitted = version.current; writing.current = true; queued.current = false; requested.current = false;
    setStatus({ kind: 'saving', message: '正在保存…' });
    try {
      const result = await options.current.write(payload);
      const expected = options.current.canonical(result, payload);
      if (!mounted.current) return;
      if (version.current === submitted) { ack.current = { version: submitted, key: JSON.stringify(expected) }; setStatus({ kind: 'saved', message: '已保存，等待状态同步。' }); }
    } catch (error) { if (mounted.current) setStatus({ kind: 'error', message: `${error.message || '保存失败。'} 草稿已保留。` }); }
    finally { writing.current = false; if (mounted.current && queued.current) schedule(true); }
  }
  function edit(patch, { immediate = false, blurOnly = false } = {}) {
    current.current = { ...current.current, ...patch }; version.current += 1; dirty.current = true; ack.current = null; setDraft(current.current);
    setStatus({ kind: 'editing', message: blurOnly ? '离开输入框后自动保存。' : '修改后自动保存。' });
    clearTimeout(timer.current); requested.current = !blurOnly; if (blurOnly) queued.current = false; else schedule(immediate);
  }
  useEffect(() => {
    if (!value) return;
    let incoming, key;
    try { incoming = options.current.read(value); key = JSON.stringify(options.current.encode(incoming)); } catch { return; }
    if (ack.current?.version === version.current && ack.current.key === key) { dirty.current = false; ack.current = null; setStatus({ kind: 'saved', message: '已生效。' }); }
    if (!dirty.current && !writing.current) { current.current = incoming; setDraft(incoming); }
  }, [value]);
  useEffect(() => { if (available && requested.current && dirty.current) schedule(true); }, [available]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timer.current); }; }, []);
  return { draft, edit, flush, status };
}

export function AutoSaveStatus({ status }) {
  return status?.message && status.kind !== 'editing' ? <p className={status.kind === 'error' ? 'notice error' : 'notice'} role={status.kind === 'error' ? 'alert' : 'status'}>{status.message}</p> : null;
}
