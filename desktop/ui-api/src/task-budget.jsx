import React, { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@dsh/primitives';

const FIELDS = [
  { key: 'maxSteps', title: '任务步数上限', label: '手动任务步数上限' },
  { key: 'maxToolCalls', title: '工具调用上限', label: '手动任务工具调用上限' },
  { key: 'timeoutSeconds', title: '超时上限（秒）', label: '手动任务超时秒数' },
];

export function TaskBudgetPanel({ state, api, run, busy, operationActive }) {
  const [values, setValues] = useState({ maxSteps: 20, maxToolCalls: 20, timeoutSeconds: 180 });
  const [notice, setNotice] = useState(''), dirty = useRef(false);
  const saving = busy?.has('taskLimits') === true, disabled = !state?.policy || operationActive || saving;
  useEffect(() => { if (state?.policy && !dirty.current) setValues({ ...state.policy }); }, [state?.policy]);
  async function save(event) {
    event.preventDefault(); if (disabled) return;
    const body = Object.fromEntries(FIELDS.map(({ key }) => [key, Number(values[key])]));
    await run('taskLimits', async () => {
      for (const { key, title } of FIELDS) {
        const bounds = state.hardLimits?.[key];
        if (!bounds || !Number.isSafeInteger(body[key]) || body[key] < bounds.minimum || body[key] > bounds.maximum) throw new Error(`${title}须为允许范围内的整数。`);
      }
      const result = await api('/api/task/limits', body);
      dirty.current = false; if (result?.policy) setValues({ ...result.policy });
      setNotice('手动任务预算已保存，将用于之后启动的任务。');
    });
  }
  return <section className="panel" aria-labelledby="task-budget-title"><div className="panel-title"><h2 id="task-budget-title">手动任务预算</h2></div>
    <form onSubmit={event => { void save(event); }}>
      {FIELDS.map(({ key, title, label }) => <label className="field" key={key}><span>{title}</span><Input aria-label={label} type="number" min={state?.hardLimits?.[key]?.minimum} max={state?.hardLimits?.[key]?.maximum} step={1} required disabled={disabled} value={values[key]} onChange={event => { dirty.current = true; setNotice(''); setValues(previous => ({ ...previous, [key]: event.target.value })); }} /></label>)}
      <Button size="sm" type="submit" variant="outline" disabled={disabled}>{saving ? '正在保存…' : '保存手动任务预算'}</Button>
    </form>
    <p className="notice">这三个上限只控制手动模型任务。保存不会改变视频允许时段或本轮截止，也不会重置自主观看预算。</p>
    {operationActive && <p className="notice">请先停止正在运行的任务或服务，再修改预算。</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
  </section>;
}

export default TaskBudgetPanel;
