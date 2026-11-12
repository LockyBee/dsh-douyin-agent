import fs from 'node:fs';

const base = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\';

// 1) 定义：douyin_more 增加可选 press（白名单键）
{
  const p = base + 'tool-definitions.mjs';
  let t = fs.readFileSync(p, 'utf8');
  const NL = t.includes('\r\n') ? '\r\n' : '\n';
  const oldS = "    name: 'douyin_more'," + NL +
    "    description: '打开当前视频的“更多”菜单（点更多按钮或长按画面），只读取菜单里的选项文字，不点选任何项。'," + NL +
    "    parameters: { type: 'object', properties: {}, additionalProperties: false },";
  const newS = "    name: 'douyin_more'," + NL +
    "    description: '打开当前视频的“更多”菜单（点更多按钮或长按画面），读取菜单里的选项文字；可用 press 按一个白名单快捷键（如 R=不感兴趣）。'," + NL +
    "    parameters: { type: 'object', properties: { press: { type: 'string', minLength: 1, maxLength: 1, description: '可选：菜单快捷键，仅允许 R/X/Z/J/F/P/V。R 表示不感兴趣，慎用。' } }, additionalProperties: false },";
  if (t.split(oldS).length - 1 !== 1) throw new Error('def anchor not unique');
  t = t.replace(oldS, newS);
  fs.writeFileSync(p, t, 'utf8');
  console.log('def press ok');
}

// 2) 实现：打开菜单后可按键
{
  const p = base + 'core.mjs';
  let t = fs.readFileSync(p, 'utf8');
  const NL = t.includes('\r\n') ? '\r\n' : '\n';
  const oldS = "          return { ...after, moreOpened: opened };" + NL;
  const newS = "          let pressed = null;" + NL +
    "          if (args.press !== undefined) {" + NL +
    "            const key = String(args.press).toUpperCase();" + NL +
    "            if (!['R', 'X', 'Z', 'J', 'F', 'P', 'V'].includes(key)) throw new Error('不支持的菜单快捷键。');" + NL +
    "            await this.page.keyboard.press(key).catch(() => {});" + NL +
    "            pressed = key;" + NL +
    "            await wait(900, signal);" + NL +
    "            after = await this.state({ record: false });" + NL +
    "          }" + NL +
    "          return { ...after, moreOpened: opened, ...(pressed ? { pressed } : {}) };" + NL;
  if (t.split(oldS).length - 1 !== 1) throw new Error('core anchor not unique');
  t = t.replace(oldS, newS);
  fs.writeFileSync(p, t, 'utf8');
  console.log('core press ok');
}

console.log('patch53 done');
