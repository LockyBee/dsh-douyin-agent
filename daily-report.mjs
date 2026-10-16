import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BEHAVIOR_THRESHOLDS } from './persona-memory.mjs';

const MARKER = '<!-- DAFEIYU_VIDEO_DAILY_REPORT_V1 ';
const MAX_SOURCE = 8 * 1024 * 1024, MAX_REPORT = 2 * 1024 * 1024;
const WAIT = new Int32Array(new SharedArrayBuffer(4));
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = (message, code = 'DAILY_REPORT_INVALID', status = 409) => Object.assign(new Error(message), { code, status });
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const day = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const round = value => Math.round(value * 1000) / 1000;
const sources = new Set(['api', 'dsh']);
const identifier = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
function validateDate(value) {
  if (!datePattern.test(value || '')) throw failure('日报日期请使用 YYYY-MM-DD。', 'DAILY_REPORT_DATE', 400);
  const parsed = Date.parse(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value || value.startsWith('0000-')) throw failure('日报日期不是有效的日历日期。', 'DAILY_REPORT_DATE', 400);
  return value;
}
function directoryChain(directory, create = false) {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; if (!create) return false; fs.mkdirSync(current); stat = fs.lstatSync(current); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('日报和来源目录必须是普通目录，不能经过符号链接。', 'DAILY_REPORT_PATH');
  }
  return true;
}
function readFile(file, maximum, optional = false) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw failure('日报或来源文件类型、大小不符合要求。', 'DAILY_REPORT_PATH');
    const bytes = fs.readFileSync(file);
    if (bytes.length > maximum || bytes.includes(0)) throw failure('日报或来源文件过大或格式无效。');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
const markdown = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\\`*_[\]{}()#!|]/g, '\\$&');
function parseSource(raw) {
  if (raw === null) return { available: false, observations: [], viewings: [], actions: [], interests: [] };
  let state;
  try { state = JSON.parse(raw); } catch { throw failure('共享作品证据格式损坏，未生成或覆盖日报。', 'DAILY_REPORT_SOURCE'); }
  if (!state || state.version !== 1 || !Array.isArray(state.observations) || !Array.isArray(state.interests) || (state.behavior !== undefined && (state.behavior?.version !== 1 || !Array.isArray(state.behavior.viewings) || !Array.isArray(state.behavior.actions)))) throw failure('共享作品证据结构错误，未生成或覆盖日报。', 'DAILY_REPORT_SOURCE');
  const observations = [], known = new Map(), videos = new Map();
  for (const row of state.observations) {
    if (!row || !/^video:[a-f0-9]{64}$/.test(row.id) || !/^\d{1,64}$/.test(row.videoId) || row.url !== `https://www.douyin.com/video/${row.videoId}` || typeof row.title !== 'string' || row.title.length > 1000 || typeof row.author !== 'string' || row.author.length > 256 || row.privacy !== 'internal-reference' || row.visibility !== 'account-visible-unverified' || !sources.has(row.source) || !Array.isArray(row.sources) || row.sources.some(source => !sources.has(source)) || !Number.isSafeInteger(row.observedAt) || row.observedAt < 0 || !Number.isFinite(row.playback?.duration) || row.playback.duration <= 0 || known.has(row.id)) throw failure('作品观察缺少可靠身份、日期或范围证据。', 'DAILY_REPORT_SOURCE');
    const item = { id: row.id, videoId: row.videoId, url: row.url, title: row.title, author: row.author, source: row.source, sources: [...row.sources], observedAt: row.observedAt, kind: row.kind, duration: row.playback.duration };
    if (videos.has(item.videoId) && Math.abs(videos.get(item.videoId) - item.duration) > 0.5) throw failure('同一作品的时长证据不一致。', 'DAILY_REPORT_SOURCE');
    known.set(item.id, item); videos.set(item.videoId, item.duration); observations.push(item);
  }
  const reference = row => row && known.has(row.evidenceId) && known.get(row.evidenceId).videoId === row.videoId && known.get(row.evidenceId).sources.includes(row.source) && Number.isSafeInteger(row.at) && row.at >= known.get(row.evidenceId).observedAt;
  const viewings = [], actions = [], sampleIds = new Set(), actionIds = new Set(), operationIds = new Set();
  for (const row of state.behavior?.viewings || []) {
    const validVideo = video => video && Number.isFinite(video.time) && video.time >= 0 && Number.isFinite(video.duration) && video.duration > 0 && video.time <= video.duration + 1 && Math.abs(video.duration - videos.get(row.videoId)) <= 0.5 && typeof video.paused === 'boolean' && Number.isInteger(video.readyState) && video.readyState >= 2;
    if (!reference(row) || !identifier(row.sampleId) || sampleIds.has(row.sampleId) || !Number.isFinite(row.wallSeconds) || row.wallSeconds < 0 || row.wallSeconds > BEHAVIOR_THRESHOLDS.maxWallSeconds || !validVideo(row.from) || !validVideo(row.to)) throw failure('观看样本身份、进度或日期无法核对。', 'DAILY_REPORT_SOURCE');
    sampleIds.add(row.sampleId); viewings.push({ sampleId: row.sampleId, evidenceId: row.evidenceId, videoId: row.videoId, source: row.source, at: row.at, wallSeconds: row.wallSeconds, from: { time: row.from.time, duration: row.from.duration, paused: row.from.paused }, to: { time: row.to.time, duration: row.to.duration, paused: row.to.paused } });
  }
  for (const row of state.behavior?.actions || []) {
    if (!reference(row) || !identifier(row.sampleId) || actionIds.has(row.sampleId) || !['stay', 'skip', 'share'].includes(row.action) || row.confirmed !== true || (row.action === 'share' && (!identifier(row.operationId) || operationIds.has(row.operationId)))) throw failure('停留、跳过或分享记录没有可靠的已确认依据。', 'DAILY_REPORT_SOURCE');
    actionIds.add(row.sampleId); if (row.action === 'share') operationIds.add(row.operationId);
    actions.push({ sampleId: row.sampleId, evidenceId: row.evidenceId, videoId: row.videoId, source: row.source, at: row.at, action: row.action, ...(row.action === 'share' ? { operationId: row.operationId } : {}) });
  }
  const interests = [], topicKeys = new Set();
  for (const row of state.interests) {
    if (!row || typeof row.topic !== 'string' || !row.topic.trim() || row.topic.length > 80 || row.key !== hash(row.topic.normalize('NFKC').toLowerCase()) || topicKeys.has(row.key) || row.privacy !== 'internal-reference' || row.visibility !== 'account-visible-unverified' || !Array.isArray(row.evidence)) throw failure('作品兴趣的主题或证据引用格式无效。', 'DAILY_REPORT_SOURCE');
    topicKeys.add(row.key);
    const evidence = [], evidenceVideos = new Set();
    for (const ref of row.evidence) {
      if (!reference(ref) || evidenceVideos.has(ref.videoId)) throw failure('作品兴趣引用了不存在或重复的观察。', 'DAILY_REPORT_SOURCE');
      evidenceVideos.add(ref.videoId);
      evidence.push({ evidenceId: ref.evidenceId, videoId: ref.videoId, source: ref.source, at: ref.at });
    }
    interests.push({ topic: row.topic, evidence });
  }
  return { available: true, observations, viewings, actions, interests };
}
function progress(sample) {
  const delta = sample.to.time - sample.from.time;
  if (sample.from.paused || sample.to.paused || !sample.wallSeconds || delta <= 0 || delta > sample.wallSeconds * BEHAVIOR_THRESHOLDS.progressRateTolerance + BEHAVIOR_THRESHOLDS.progressSlackSeconds) return null;
  const end = Math.min(sample.from.duration, sample.to.time);
  return end > sample.from.time ? { start: sample.from.time, end, credit: Math.min(delta, sample.wallSeconds) * (end - sample.from.time) / delta } : null;
}
function creditIntervals(intervals) {
  let total = 0, covered = [];
  for (const row of intervals) {
    const overlap = covered.reduce((sum, previous) => sum + Math.max(0, Math.min(previous.end, row.end) - Math.max(previous.start, row.start)), 0);
    total += Math.max(0, row.end - row.start - overlap) * row.credit / (row.end - row.start);
    const merged = [];
    for (const next of [...covered, row].sort((a, b) => a.start - b.start)) { const last = merged.at(-1); if (last && next.start <= last.end) last.end = Math.max(last.end, next.end); else merged.push({ start: next.start, end: next.end }); }
    covered = merged;
  }
  return round(total);
}
function assess(item) {
  const ratio = Math.min(1, item.seconds / item.duration);
  if (item.actions.share) return 'like';
  if (item.actions.stay && (item.seconds >= BEHAVIOR_THRESHOLDS.sustainedSeconds || item.seconds >= BEHAVIOR_THRESHOLDS.shortVideoSeconds && ratio >= BEHAVIOR_THRESHOLDS.completionRatio)) return 'like';
  if (item.actions.skip && item.seconds > 0 && item.seconds <= BEHAVIOR_THRESHOLDS.quickSkipSeconds && ratio < BEHAVIOR_THRESHOLDS.completionRatio) return 'dislike';
  return 'neutral';
}
function summarize(source, date, now) {
  const dated = at => at <= now && day(at) === date;
  const observations = source.observations.filter(row => dated(row.observedAt)), viewings = source.viewings.filter(row => dated(row.at)), actions = source.actions.filter(row => dated(row.at));
  const active = new Set([...observations, ...viewings, ...actions].map(row => row.videoId));
  const referenced = source.observations.filter(row => active.has(row.videoId) && row.observedAt <= now);
  const rows = [...active].sort().map(videoId => {
    const facts = referenced.filter(row => row.videoId === videoId).sort((a, b) => b.observedAt - a.observedAt), record = facts[0];
    const samples = viewings.filter(row => row.videoId === videoId), intervals = samples.map(progress).filter(Boolean);
    const interactions = actions.filter(row => row.videoId === videoId), counts = { stay: 0, skip: 0, share: 0 };
    for (const item of interactions) counts[item.action]++;
    const item = { videoId, url: record.url, title: record.title, author: record.author, duration: record.duration, observations: observations.filter(row => row.videoId === videoId).length, frames: observations.filter(row => row.videoId === videoId && row.kind === 'visual').length, seconds: creditIntervals(intervals), samples: samples.length, acceptedSamples: intervals.length, actions: counts, sources: [...new Set([...observations.filter(row => row.videoId === videoId).map(row => row.source), ...samples.map(row => row.source), ...interactions.map(row => row.source)])].sort() };
    return { ...item, signal: assess(item) };
  });
  const topics = source.interests.map(item => {
    const ids = new Set(item.evidence.filter(ref => active.has(ref.videoId)).map(ref => ref.videoId));
    const works = rows.filter(row => ids.has(row.videoId)), counts = { like: 0, dislike: 0, neutral: 0 };
    for (const row of works) counts[row.signal]++;
    return { topic: item.topic, videoIds: works.map(row => row.videoId), counts };
  }).filter(item => item.videoIds.length).sort((a, b) => a.topic.localeCompare(b.topic, 'zh-CN'));
  const totalActions = { stay: 0, skip: 0, share: 0 }; for (const item of actions) totalActions[item.action]++;
  const counts = { observedCount: rows.length, observationCount: observations.length, verifiedProgressSeconds: round(rows.reduce((sum, row) => sum + row.seconds, 0)), actions: totalActions, interestCount: topics.length };
  const input = { date, sourceAvailable: source.available, observations, referenced, viewings, actions, topics };
  return { rows, topics, counts, sourceAvailable: source.available, sourceDigest: hash(JSON.stringify(input)) };
}
function render(date, summary) {
  const { counts, rows, topics } = summary;
  const lines = [`# 大肥鱼刷视频日报 · ${date}`, '', '按上海时区汇总共用抖音记忆中的实际作品观察和宿主确认行为。仅供本机查看，不包含人格正文、QQ、私信或联系人资料。', '', `记录涉及 ${counts.observedCount} 条作品，当日新增观察 ${counts.observationCount} 条，可核采样进度 ${counts.verifiedProgressSeconds} 秒；确认停留 ${counts.actions.stay} 次、跳过 ${counts.actions.skip} 次、分享 ${counts.actions.share} 次。`, '', '## 作品及行为证据', '', '| 作品 | 作者 | 当日观察 | 可核采样进度 | 已确认行为 | 当日依据 |', '| --- | --- | ---: | ---: | --- | --- |'];
  for (const row of rows) lines.push(`| ${markdown(row.title || '无文案作品')} · [${row.videoId}](${row.url}) | ${markdown(row.author || '未登记作者')} | ${row.observations} | ${row.seconds} 秒 | 停留 ${row.actions.stay} / 跳过 ${row.actions.skip} / 分享 ${row.actions.share} | ${{ like: '有正向行为依据', dislike: '有快划依据', neutral: '证据不足，待观察' }[row.signal]} |`);
  if (!rows.length) lines.push('| 本日暂无留存作品证据 | — | 0 | 0 秒 | — | 无法据此判断是否实际刷过视频 |');
  lines.push('', '## 当日证据支持的题材倾向', '', '以下按当日作品行为重新计数，不代表今天新产生的兴趣，也不把历史累计喜好算作今天的变化。');
  for (const topic of topics) lines.push(`- ${markdown(topic.topic)}：${topic.counts.like} 条作品有正向依据、${topic.counts.dislike} 条有快划依据、${topic.counts.neutral} 条待观察；涉及作品 ${topic.videoIds.map(id => `[${id}](https://www.douyin.com/video/${id})`).join('、')}。`);
  if (!topics.length) lines.push('- 本日没有可关联题材的留存证据，未推断偏好变化。');
  lines.push('', '## 记录覆盖范围', '', '- 只汇总共用记忆已留存的记录，不代表当天全部浏览。观察会去重，重复浏览可能没有新的观察时间戳。', '- 采样进度来自同作品、可播放状态的真实进度与墙钟间隔；暂停、倒退、明显拖动不计，同作品重叠区间在本日不重复累计。这不是全天观看总时长。', '- 按记录结束时间归入上海日期，没有把跨午夜采样推算分拆；未留存的时段不补记。', '- 当日停留、快划和确认分享只支持代理自己的题材倾向，不表示用户喜好。画面采样不表示完整观看或听懂音频。', '- 作品链接沿用已登记的规范抖音地址；只核对了本机账号可见，未验证当前仍可播放或对外可见范围。');
  if (!summary.sourceAvailable) lines.push('- 共用作品证据文件尚未建立；本报告没有以空记录冒充完成观看。');
  return lines.join('\n') + '\n';
}
function managed(raw, expectedDate) {
  if (raw === null) return null;
  const newline = raw.indexOf('\n'), header = raw.slice(0, newline);
  if (newline < 0 || !header.startsWith(MARKER) || !header.endsWith(' -->')) throw failure('该日期文件不是本组件管理的日报，已保留原文件。', 'DAILY_REPORT_CONFLICT');
  let metadata;
  try { metadata = JSON.parse(header.slice(MARKER.length, -4)); } catch { throw failure('日报管理标记被改动，已保留原文件。', 'DAILY_REPORT_CONFLICT'); }
  const body = raw.slice(newline + 1);
  const { metadataSha256, ...unsigned } = metadata || {};
  if (metadata?.version !== 1 || metadata.date !== expectedDate || metadata.timeZone !== 'Asia/Shanghai' || metadata.coverage !== 'stored-video-evidence-only' || metadataSha256 !== hash(JSON.stringify(unsigned)) || header !== `${MARKER}${JSON.stringify(metadata)} -->` || !/^[a-f0-9]{64}$/.test(metadata.sourceDigest || '') || !/^[a-f0-9]{64}$/.test(metadata.bodySha256 || '') || metadata.bodySha256 !== hash(body) || !Number.isFinite(Date.parse(metadata.generatedAt)) || !['manual', 'watch-finished'].includes(metadata.reason)) throw failure('日报内容或管理标记已被手工修改，已保留原文件。', 'DAILY_REPORT_CONFLICT');
  return { metadata, body };
}

export class DailyReport {
  constructor({ personaMemory, now = Date.now } = {}) {
    if (!personaMemory || typeof personaMemory.personaFolder !== 'string' || !path.isAbsolute(personaMemory.personaFolder) || typeof personaMemory.stateFile !== 'string' || !path.isAbsolute(personaMemory.stateFile) || path.dirname(path.normalize(personaMemory.stateFile)) !== path.normalize(personaMemory.personaFolder) || typeof now !== 'function') throw new TypeError('日报需要共享人格中的独立作品证据路径。');
    this.personaFolder = path.normalize(personaMemory.personaFolder); this.stateFile = path.normalize(personaMemory.stateFile); this.now = now;
    this.folder = path.join(path.dirname(this.personaFolder), 'reports', 'videos'); this.guardFile = path.join(this.folder, '.daily-report.guard');
  }
  date(value) { return validateDate(value === undefined ? day(this.now()) : value); }
  file(date) { return path.join(this.folder, `${this.date(date)}.md`); }
  result(date, raw, parsed, changed) { return { available: true, managed: true, ...parsed.metadata, folder: this.folder, path: this.file(date), markdown: raw, ...(changed === undefined ? {} : { changed }) }; }
  read({ date } = {}) {
    const selected = this.date(date); directoryChain(this.folder);
    const raw = readFile(this.file(selected), MAX_REPORT, true);
    if (raw === null) throw failure('该日期尚无本地刷视频日报。', 'DAILY_REPORT_NOT_FOUND', 404);
    return this.result(selected, raw, managed(raw, selected));
  }
  state({ date } = {}) {
    const selected = this.date(date), today = this.date(), reports = [];
    if (directoryChain(this.folder)) for (const name of fs.readdirSync(this.folder)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
      const reportDate = name.slice(0, -3); validateDate(reportDate);
      try { const item = this.read({ date: reportDate }); const { markdown: _markdown, ...metadata } = item; reports.push(metadata); }
      catch (error) { if (error.code !== 'DAILY_REPORT_CONFLICT') throw error; reports.push({ date: reportDate, path: this.file(reportDate), conflict: true, reason: error.message }); }
    }
    reports.sort((a, b) => b.date.localeCompare(a.date));
    return { available: true, folder: this.folder, date: selected, reports, today: reports.find(item => item.date === today) || null };
  }
  generate({ date, reason = 'manual' } = {}) {
    const selected = this.date(date);
    if (selected > this.date()) throw failure('不能为尚未到来的上海日期生成事实日报。', 'DAILY_REPORT_DATE', 400);
    if (!['manual', 'watch-finished'].includes(reason)) throw failure('日报生成原因无效。', 'DAILY_REPORT_ARGUMENT', 400);
    directoryChain(this.personaFolder); directoryChain(this.folder, true);
    const owner = JSON.stringify({ pid: process.pid, token: randomUUID() }); let descriptor;
    try { descriptor = fs.openSync(this.guardFile, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw failure('另一入口正在生成日报，或生成锁需要核对。', 'DAILY_REPORT_BUSY'); throw error; }
    try { fs.writeFileSync(descriptor, owner); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    let temporary;
    try {
      const source = parseSource(readFile(this.stateFile, MAX_SOURCE, true));
      const summary = summarize(source, selected, this.now());
      const file = this.file(selected), original = readFile(file, MAX_REPORT, true), previous = managed(original, selected);
      if (previous?.metadata.sourceDigest === summary.sourceDigest) return this.result(selected, original, previous, false);
      const body = render(selected, summary), unsigned = { version: 1, date: selected, timeZone: 'Asia/Shanghai', generatedAt: new Date(this.now()).toISOString(), reason, sourceDigest: summary.sourceDigest, bodySha256: hash(body), ...summary.counts, coverage: 'stored-video-evidence-only' }, metadata = { ...unsigned, metadataSha256: hash(JSON.stringify(unsigned)) };
      const raw = `${MARKER}${JSON.stringify(metadata)} -->\n${body}`;
      if (Buffer.byteLength(raw) > MAX_REPORT) throw failure('当日报告达到文件上限，已保留旧文件。', 'DAILY_REPORT_CAPACITY');
      temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      const output = fs.openSync(temporary, 'wx', 0o600); try { fs.writeFileSync(output, raw); fs.fsyncSync(output); } finally { fs.closeSync(output); }
      if (original === null) {
        try { directoryChain(this.folder); fs.linkSync(temporary, file); } catch (error) { if (error.code === 'EEXIST') throw failure('生成期间该日期文件刚被创建，已保留原文件。', 'DAILY_REPORT_CONFLICT'); throw error; }
      } else for (let attempt = 0;; attempt++) {
        directoryChain(this.folder);
        if (readFile(file, MAX_REPORT, true) !== original) throw failure('生成期间日报被手工修改，已保留原文件。', 'DAILY_REPORT_CONFLICT');
        try { fs.renameSync(temporary, file); break; }
        catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error; Atomics.wait(WAIT, 0, 0, 20 * (attempt + 1)); }
      }
      return this.result(selected, raw, { metadata }, true);
    } finally {
      if (temporary) { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      if (readFile(this.guardFile, 2048, true) === owner) fs.unlinkSync(this.guardFile);
    }
  }
}
