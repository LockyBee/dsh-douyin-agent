import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\core.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';

const anchor = "    if(expectedVideoId!==undefined&&(typeof expectedVideoId!=='string'||!/^\\d{1,64}$/.test(expectedVideoId)))throw new TypeError('预期作品ID须为纯数字字符串。');" + NL;
const block = [
  "    if (direction > 0) {",
  "      // 直播卡没有作品 ID，不做身份门禁，直接滑走",
  "      const probe = await this.state({ record: false });",
  "      if (probe.pageKind === 'live-preview' && probe.livePreview?.recognized === true) {",
  "        const beforeLive = `${probe.pageKind}|${probe.livePreview?.roomId || ''}|${probe.video?.id || ''}`;",
  "        const arrow = this.page.locator('[data-e2e=\"video-switch-next-arrow\"]').filter({ visible: true });",
  "        try {",
  "          if (await arrow.count()) await arrow.first().click({ timeout: 3000 });",
  "          else await this.page.keyboard.press('ArrowDown');",
  "        } catch (error) { /* 点不到就交给下面的常规流程 */ }",
  "        await wait(1200, signal);",
  "        const after = await this.state({ record: false });",
  "        const afterLive = `${after.pageKind}|${after.livePreview?.roomId || ''}|${after.video?.id || ''}`;",
  "        if (afterLive !== beforeLive) return { changed: true, before: probe.video, after: after.video, state: after, reasonCode: 'live-card-bypass' };",
  "        return { changed: false, before: probe.video, after: after.video, state: after, reasonCode: 'live-card-not-moved' };",
  "      }",
  "    }",
  ""
].join(NL);

const n = t.split(anchor).length - 1;
if (n !== 1) throw new Error('anchor occurrences=' + n);
t = t.replace(anchor, anchor + block);
fs.writeFileSync(p, t, 'utf8');
console.log('patch35 done, chars:', t.length);
