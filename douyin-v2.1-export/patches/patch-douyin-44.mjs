import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';
const oldS = "    } catch (error) {" + NL +
  "      const reason = this.abort?.signal.aborted ? this.abort.signal.reason || error : error;" + NL +
  "      status = reason.watchStatus || 'failed'; lastError = redact(reason.message || String(reason), [this.config.apiKey]);" + NL;
const newS = "    } catch (error) {" + NL +
  "      const reason = this.abort?.signal.aborted ? this.abort.signal.reason || error : error;" + NL +
  "      const rawMessage = reason && reason.message ? reason.message : String(reason);" + NL +
  "      const browserGone = /Target page, context or browser has been closed|Target closed|browser has been closed|Execution context was destroyed|page\\.goto: Target/i.test(rawMessage);" + NL +
  "      if (browserGone) {" + NL +
  "        status = 'stopped';" + NL +
  "        lastError = '专用浏览器已关闭，本次自主观看自动结束；日报已生成，可直接汇报。';" + NL +
  "        this.browserClosed = true;" + NL +
  "        this.onEvent({ type: 'watch.browser_closed', message: '检测到浏览器关闭，已结束本次观看。' });" + NL +
  "      } else {" + NL +
  "        status = reason.watchStatus || 'failed'; lastError = redact(rawMessage, [this.config.apiKey]);" + NL +
  "      }" + NL;
const n = t.split(oldS).length - 1;
if (n !== 1) throw new Error('catch anchor occurrences=' + n);
t = t.replace(oldS, newS);
fs.writeFileSync(p, t, 'utf8');
console.log('patch44 done, chars:', t.length);
