import React from 'react';
import { Input } from '@dsh/primitives';
import { useAutoSave, AutoSaveStatus } from './use-auto-save.jsx';

const FIELDS = [
  { key: 'maxSteps', title: '任务步数上限', label: '手动任务步数上限' },
  { key: 'maxToolCalls', title: '工具调用上限', label: '手动任务工具调用上限' },
  { key: 'timeoutSeconds', title: '超时上限（秒）', label: '手动任务超时秒数' },
];

export function TaskBudgetPanel({ state, api, run, busy, operationActive }) {
  const disabled = !state?.policy || operationActive;
  const save = useAutoSave({ value: state?.policy, initial: { maxSteps: 20, maxToolCalls: 20, timeoutSeconds: 180 }, read: value => ({ ...value }), encode: values => {
      const body = Object.fromEntries(FIELDS.map(({ key }) => [key, Number(values[key])]));
      for (const { key, title } of FIELDS) {
        const bounds = state.hardLimits?.[key];
        if (!String(values[key]).trim() || !bounds || !Number.isSafeInteger(body[key]) || body[key] < bounds.minimum || body[key] > bounds.maximum) throw new Error(`${title}须为允许范围内的整数。`);
      }
      return body;
  }, write: payload => api('/api/task/limits', payload), available: !disabled });
  return <section className="panel" aria-labelledby="task-budget-title"><div className="panel-title"><h2 id="task-budget-title">手动任务预算</h2></div>
    {FIELDS.map(({ key, title, label }) => <label className="field" key={key}><span>{title}</span><Input aria-label={label} type="number" min={state?.hardLimits?.[key]?.minimum} max={state?.hardLimits?.[key]?.maximum} step={1} required disabled={disabled} value={save.draft[key]} onChange={event => save.edit({ [key]: event.target.value })} /></label>)}
    <AutoSaveStatus status={save.status} />
    {operationActive && <p className="notice">请先停止正在运行的任务或服务，再修改预算。</p>}
  </section>;
}

export default TaskBudgetPanel;
