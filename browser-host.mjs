import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { chromium } from './playwright-runtime.mjs';

const [profile, controlDir, portText] = process.argv.slice(2);
const port = Number(portText);
if (!profile || !controlDir || !Number.isInteger(port) || port < 1024 || port > 65535) process.exit(2);
mkdirSync(controlDir, { recursive: true });
const stateFile = path.join(controlDir, 'browser.json');
let context;
function writeState(ready) {
  const temporary = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, profile, port, ready, startedAt: Date.now() }));
  renameSync(temporary, stateFile);
}
try {
  writeState(false);
  context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: false, viewport: null,
    ignoreDefaultArgs: ['--mute-audio'],
    args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--autoplay-policy=no-user-gesture-required'],
  });
  writeState(true);
  console.log('专用抖音 Edge 已启动。');
  context.on('close', () => process.exit(0));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => context.close().finally(() => process.exit(0)));
} catch (error) {
  // Playwright 的详细异常可能含用户资料路径；日志只保留可操作的原因。
  console.error(/ProcessSingleton|user data directory|profile.*in use/i.test(error.message)
    ? '专用资料目录正在被其他浏览器使用，请正常关闭旧专用窗口后重试。'
    : `专用浏览器启动失败：${error.name}`);
  process.exit(1);
}
