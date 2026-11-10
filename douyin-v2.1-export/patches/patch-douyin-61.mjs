import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';

const oldS = [
  "                } catch (error) { this.onEvent({ type: 'watch.auto_not_interested_failed', message: error && error.message ? error.message : '' }); }",
  "              }",
  "            }",
  "          }",
  "          await this.delayImpl(6000, this.abort.signal);"
].join(NL) + NL;

const newS = [
  "                } catch (error) { this.onEvent({ type: 'watch.auto_not_interested_failed', message: error && error.message ? error.message : '' }); }",
  "              }",
  "              if (skipKind === 'offtopic') {",
  "                try {",
  "                  current = await this.execute('douyin_next');",
  "                  const nextId = (current.state || current).video?.id || null;",
  "                  this.onEvent({ type: 'watch.offtopic_next', videoId: observedState.video?.id || null, changed: current?.changed !== false, sameId: nextId === (observedState.video?.id || null) });",
  "                  if (nextId && nextId === observedState.video?.id) { current = await this.execute('douyin_open'); this.onEvent({ type: 'watch.loop_break', videoId: nextId }); }",
  "                } catch (error) { this.onEvent({ type: 'watch.next_failed', message: error && error.message ? error.message : '' }); }",
  "                await this.delayImpl(2000, this.abort.signal);",
  "                this.assertAllowed();",
  "                current = await this.execute('douyin_status');",
  "                if ((current.state || current).video?.paused !== false) current = await this.execute('douyin_play');",
  "                continue;",
  "              }",
  "            }",
  "          }",
  "          await this.delayImpl(6000, this.abort.signal);"
].join(NL) + NL;

const n = t.split(oldS).length - 1;
if (n !== 1) throw new Error('anchor occurrences=' + n);
t = t.replace(oldS, newS);
fs.writeFileSync(p, t, 'utf8');
console.log('patch61 done: offtopic 立即换片');
