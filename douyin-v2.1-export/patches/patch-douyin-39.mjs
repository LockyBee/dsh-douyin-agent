import fs from 'node:fs';

const base = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\';
const NL_OF = s => (s.includes('\r\n') ? '\r\n' : '\n');

// 1) 提示词：要求 skip 时给出 skipKind
{
  const p = base + 'api-agent.mjs';
  let t = fs.readFileSync(p, 'utf8');
  const anchor = 'topics最多5项，signal只能是like、dislike、neutral；主题与信号只是提议，最终喜好由真实观看时长、比例和已确认的停留、跳过或分享计算，不能单凭一帧自称喜欢。';
  if (t.split(anchor).length - 1 !== 1) throw new Error('prompt anchor not unique');
  t = t.replace(anchor, anchor + '选择skip时还必须给出"skipKind"，只能是：offtopic（内容类型完全不对，如科普、商品测评、段子、游戏、影视解说）、taste（内容类型对，但身形或风格不合偏好）、seen（这条已看过或与已看内容重复）；缺省按taste处理。');
  fs.writeFileSync(p, t, 'utf8');
  console.log('prompt ok');
}

// 2) 解析：透传 skipKind
{
  const p = base + 'api-agent.mjs';
  let t = fs.readFileSync(p, 'utf8');
  const NL = NL_OF(t);
  const anchor = "  return { action: value.action, reason: value.reason.trim(),";
  if (t.split(anchor).length - 1 !== 1) throw new Error('parse anchor not unique');
  const insert = "  const skipKind = value.action === 'skip' && ['offtopic', 'taste', 'seen'].includes(value.skipKind) ? value.skipKind : undefined;" + NL;
  t = t.replace(anchor, insert + anchor + " ...(skipKind ? { skipKind } : {}),");
  fs.writeFileSync(p, t, 'utf8');
  console.log('parse ok');
}

// 3) 自主观看：按 skipKind 分流
{
  const p = base + 'autonomous-watch.mjs';
  let t = fs.readFileSync(p, 'utf8');
  const NL = NL_OF(t);
  const rep = (oldS, newS, tag) => {
    const n = t.split(oldS).length - 1;
    if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
    t = t.replace(oldS, newS);
    console.log(tag, 'ok');
  };

  // 新增口味记录方法
  rep(
    "  recordNoise(item) {" + NL,
    "  recordTaste(item) {" + NL +
    "    try {" + NL +
    "      this.tasteSeen ??= new Set();" + NL +
    "      const key = item.videoId || item.url || '';" + NL +
    "      if (!key || this.tasteSeen.has(key)) return;" + NL +
    "      this.tasteSeen.add(key);" + NL +
    "      const dir = path.join(this.stateDir, 'taste');" + NL +
    "      fs.mkdirSync(dir, { recursive: true });" + NL +
    "      fs.appendFileSync(path.join(dir, day(this.now()) + '.jsonl'), JSON.stringify({ at: new Date(this.now()).toISOString(), runId: this.runId || null, ...item }) + '\\n');" + NL +
    "    } catch (error) { /* 记录失败不影响观看 */ }" + NL +
    "  }" + NL +
    "  recordNoise(item) {" + NL,
    'taste-method'
  );

  // 分流逻辑
  rep(
    "            const hasLike = (decision.topics || []).some(item => item.signal === 'like');" + NL +
    "            if (hasLike) {" + NL,
    "            const hasLike = (decision.topics || []).some(item => item.signal === 'like');" + NL +
    "            const skipKind = decision.skipKind || (hasLike ? 'seen' : 'taste');" + NL +
    "            if (skipKind === 'taste') {" + NL +
    "              this.recordTaste({ videoId: observedState.video?.id || null, url: observedState.video?.url || null, title: (observedState.video?.title || '').slice(0, 300), author: observedState.video?.author || null, reason: decision.reason, topics: decision.topics });" + NL +
    "            } else if (skipKind === 'seen') {" + NL,
    'skipkind-branch'
  );

  fs.writeFileSync(p, t, 'utf8');
}

console.log('patch39 done');
