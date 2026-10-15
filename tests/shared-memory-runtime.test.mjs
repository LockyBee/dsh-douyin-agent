import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

for (const customName of [false, true]) test(customName ? '精确定位自定义文件名后，API 与 DSH 两个真实 controller 仍共用临时 SQLite' : 'API 与 DSH 两个真实 controller 在临时同一 SQLite 中互相写入和检索', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-shared-sqlite-'));
  t.after(() => {
    const resolved = path.resolve(root), temporaryRoot = path.resolve(os.tmpdir());
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('douyin-shared-sqlite-')) throw new Error('临时测试清理路径不符。');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const location = path.join(root, 'runtime-location.json');
  const memoryDir = path.join(root, 'shared-memory');
  const memoryDbPath = path.join(memoryDir, customName ? 'custom-central.sqlite' : 'shared.sqlite');
  fs.writeFileSync(location, JSON.stringify({ version: 1, stateDir: path.join(root, 'state'), memoryDir, ...(customName ? { memoryDbPath } : {}) }));
  const script = `
    import assert from 'node:assert/strict';
    import { BrowserController } from ${JSON.stringify(new URL('../core.mjs', import.meta.url).href)};
    const api = new BrowserController({source:'api'}), dsh = new BrowserController({source:'dsh'});
    try {
      const left = api.store(), right = dsh.store();
      // 测试仅访问临时视频记忆；不检查、打开或同步本机 QQ 库。
      left.qqMemoryPath = null; right.qqMemoryPath = null;
      assert.equal(left.dbPath, right.dbPath);
      assert.notEqual(left.db, right.db);
      const first = left.remember({content:'合成共享测试：API 记下蓝色纸船。',source:'api'});
      const apiFromDsh = right.recall({query:'蓝色纸船'}).entries.find(item=>item.id===first.id);
      assert.equal(apiFromDsh?.source, 'api');
      const second = right.remember({content:'合成共享测试：DSH 记下绿色纸鹤。',source:'dsh'});
      const dshFromApi = left.recall({query:'绿色纸鹤'}).entries.find(item=>item.id===second.id);
      assert.equal(dshFromApi?.source, 'dsh');
      assert.equal(api.browser, null); assert.equal(dsh.browser, null);
      console.log(JSON.stringify({path:left.dbPath,apiToDsh:!!apiFromDsh,dshToApi:!!dshFromApi,rows:left.db.prepare('SELECT count(*) AS total FROM memory_entries').get().total}));
    } finally {
      // close() 会暂停已存在的浏览器，本项仅关闭自己打开的 SQLite。
      api.memory?.close(); dsh.memory?.close();
    }
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, DEEPSEEK_SHARED_MEMORY_DB: '', DOUYIN_RUNTIME_LOCATION_FILE: location, DOUYIN_STATE_DIR: '', DSH_HOME: path.join(root, 'unrelated-dsh-home') },
    timeout: 15_000,
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.path, memoryDbPath);
  assert.equal(result.apiToDsh, true);
  assert.equal(result.dshToApi, true);
  assert.equal(result.rows, 2);
  assert.equal(fs.existsSync(result.path), true);
  assert.equal(fs.existsSync(path.join(root, 'unrelated-dsh-home')), false);
  if (customName) assert.equal(fs.existsSync(path.join(memoryDir, 'shared.sqlite')), false);
});
