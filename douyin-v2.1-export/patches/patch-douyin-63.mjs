import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';
const rep = (oldS, newS, tag) => {
  const n = t.split(oldS).length - 1;
  if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
  t = t.replace(oldS, newS);
  console.log(tag, 'ok');
};

// 1) 报错写清是哪个遮拦条件，方便以后定位
rep(
  "    if (state?.loginRequired || state?.verificationRequired || state?.blocked || state?.privateChatVisible || state?.unsupportedPage) throw failure('抖音页面需要手动处理，已停止自主观看。', 'needs_user');",
  "    if (state?.loginRequired || state?.verificationRequired || state?.blocked || state?.privateChatVisible || state?.unsupportedPage) {" + NL +
  "      const why = [state?.loginRequired && '登录', state?.verificationRequired && '验证', state?.privateChatVisible && '私信遮挡', state?.unsupportedPage && '非视频页', state?.blocked && 'blocked', state?.livePreview?.recognized && '直播卡', state?.videoSelection?.identityConflict && '身份冲突'].filter(Boolean).join('/');" + NL +
  "      throw failure(`抖音页面需要手动处理（${why || '未知原因'}），已停止自主观看。`, 'needs_user');" + NL +
  "    }",
  'blocked-reason'
);

// 2) 搜索偶发未就绪：等 1.5 秒重试一次
rep(
  "    const search = await this.execute('douyin_search', { query: topic, hover: '筛选', tap: '最新发布|一周内|视频#2' });",
  "    let search;" + NL +
  "    try { search = await this.execute('douyin_search', { query: topic, hover: '筛选', tap: '最新发布|一周内|视频#2' }); }" + NL +
  "    catch (error) {" + NL +
  "      this.onEvent({ type: 'watch.topic_retry', topic, message: error && error.message ? error.message : '' });" + NL +
  "      await this.delayImpl(1500, this.abort.signal);" + NL +
  "      search = await this.execute('douyin_search', { query: topic, hover: '筛选', tap: '最新发布|一周内|视频#2' });" + NL +
  "    }",
  'search-retry'
);

// 3) 打开结果若落在直播卡，跳过换下一个候选，而不是整轮 needs_user
rep(
  "      if (readyVideo(opened.state || opened)) { this.onEvent({ type: 'watch.topic_open', topic, index: item.index, unseenLeft: candidates.length - 1 }); return opened; }",
  "      const openedState = opened.state || opened;" + NL +
  "      if (openedState.livePreview?.recognized === true) { this.onEvent({ type: 'watch.topic_skip', topic, index: item.index, message: '打开的是直播卡，试下一条' }); continue; }" + NL +
  "      if (readyVideo(openedState)) { this.onEvent({ type: 'watch.topic_open', topic, index: item.index, unseenLeft: candidates.length - 1 }); return opened; }",
  'live-card-candidate'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch63 done');
