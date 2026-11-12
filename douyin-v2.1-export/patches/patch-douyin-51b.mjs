import fs from 'node:fs';

const base = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\';

// 1) 工具定义
{
  const p = base + 'tool-definitions.mjs';
  let t = fs.readFileSync(p, 'utf8');
  const NL = t.includes('\r\n') ? '\r\n' : '\n';
  const anchor = "  {" + NL + "    name: 'douyin_open_video',";
  const n = t.split(anchor).length - 1;
  if (n !== 1) throw new Error('def anchor occurrences=' + n);
  const block = [
    "  {",
    "    name: 'douyin_more',",
    "    description: '打开当前视频的“更多”菜单（点更多按钮或长按画面），只读取菜单里的选项文字，不点选任何项。',",
    "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
    "  },",
    ""
  ].join(NL);
  t = t.replace(anchor, block + anchor);
  fs.writeFileSync(p, t, 'utf8');
  console.log('def douyin_more ok');
}

// 2) core 实现
{
  const p = base + 'core.mjs';
  let t = fs.readFileSync(p, 'utf8');
  const NL = t.includes('\r\n') ? '\r\n' : '\n';
  const anchor = "        if(name==='douyin_video_zoom'){";
  const n = t.split(anchor).length - 1;
  if (n !== 1) throw new Error('core anchor occurrences=' + n);
  const block = [
    "        if (name==='douyin_more') {",
    "          const before = await this.state({ record: false });",
    "          const beforeText = String(before.visibleText || '');",
    "          let opened = false;",
    "          const moreBtn = this.page.locator('[data-e2e*=\"more\"], [aria-label*=\"更多\"], [aria-label*=\"more\"]').filter({ visible: true });",
    "          if (await moreBtn.count()) {",
    "            try { await moreBtn.first().click({ timeout: 2500 }); opened = true; } catch (error) { /* 退到长按 */ }",
    "          }",
    "          await wait(600, signal);",
    "          let after = await this.state({ record: false });",
    "          if (!opened || String(after.visibleText || '') === beforeText) {",
    "            const target = await this.currentVideo().catch(() => null);",
    "            if (target) {",
    "              const box = await target.boundingBox().catch(() => null);",
    "              if (box) {",
    "                try {",
    "                  await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);",
    "                  await this.page.mouse.down();",
    "                  await wait(900, signal);",
    "                  await this.page.mouse.up();",
    "                  opened = true;",
    "                } catch (error) { /* 长按失败也不影响读取 */ }",
    "              }",
    "            }",
    "            await wait(800, signal);",
    "            after = await this.state({ record: false });",
    "          }",
    "          return { ...after, moreOpened: opened };",
    "        }",
    ""
  ].join(NL);
  t = t.replace(anchor, block + anchor);
  fs.writeFileSync(p, t, 'utf8');
  console.log('core douyin_more ok');
}

console.log('patch51b done');
