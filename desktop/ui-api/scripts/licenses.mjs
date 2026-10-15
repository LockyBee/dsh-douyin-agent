import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const posix = value => value.split(path.sep).join('/');
const legalName = value => /^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/i.test(value);
const within = (root, file) => { const relative = path.relative(root, file); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

async function ownerOf(file) {
  let directory = path.dirname(file);
  while (true) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (manifest.name && manifest.version) return { directory, manifest };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`无法确认构建输入的包归属：${path.basename(file)}`);
    directory = parent;
  }
}

async function legalFiles(directory, relative = '', depth = 0) {
  const result = [];
  for (const entry of (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.isSymbolicLink()) continue;
    const current = path.join(relative, entry.name);
    if (entry.isFile() && legalName(entry.name)) result.push(current);
    else if (entry.isDirectory() && depth < 3) result.push(...await legalFiles(directory, current, depth + 1));
  }
  return result;
}

export async function dependencyOwners(metafile, { projectRoot, upstreamRoot, workingDirectory = projectRoot }) {
  const included = new Map();
  for (const output of Object.values(metafile.outputs)) for (const [file, detail] of Object.entries(output.inputs)) {
    if (detail.bytesInOutput > 0) included.set(file, (included.get(file) || 0) + detail.bytesInOutput);
  }
  const packages = new Map();
  for (const [input, bytesInOutput] of included) {
    const file = path.resolve(workingDirectory, input), owner = await ownerOf(file);
    if (path.resolve(owner.directory) === path.resolve(projectRoot)) continue;
    const { name, version, license } = owner.manifest, id = `${name}@${version}`;
    let record = packages.get(id);
    if (!record) {
      let files = await legalFiles(owner.directory);
      let licenseRoot = owner.directory;
      if (!files.length && within(upstreamRoot, owner.directory)) { licenseRoot = upstreamRoot; files = ['LICENSE']; }
      if (!files.length) throw new Error(`实际打入的依赖缺少许可证原文：${id}`);
      if (typeof license !== 'string' || !license) throw new Error(`实际打入的依赖没有明确许可证字段：${id}`);
      record = { id, name, version, license, directory: owner.directory, licenseRoot, legalFiles: files, inputs: [] };
      packages.set(id, record);
    }
    record.inputs.push({ file: posix(path.relative(owner.directory, file)), bytesInOutput, sha256: sha256(await fs.readFile(file)) });
  }
  return [...packages.values()].sort((a, b) => a.id.localeCompare(b.id, 'en')).map(record => ({ ...record, inputs: record.inputs.sort((a, b) => a.file.localeCompare(b.file, 'en')) }));
}

async function resetLicenseDirectory(directory, projectRoot) {
  if (path.resolve(directory) !== path.resolve(projectRoot, 'dist', 'licenses')) throw new Error('许可证输出目录越界。');
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !within(await fs.realpath(projectRoot), await fs.realpath(directory))) throw new Error('许可证输出目录通过链接指向外部。');
    await fs.rm(directory, { recursive: true, force: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(directory, { recursive: true });
}

export async function writeDependencyNotices({ metafile, projectRoot, upstreamRoot, workingDirectory = projectRoot }) {
  const dist = path.join(projectRoot, 'dist'), licenseDir = path.join(dist, 'licenses');
  const packages = await dependencyOwners(metafile, { projectRoot, upstreamRoot, workingDirectory });
  await resetLicenseDirectory(licenseDir, projectRoot);
  const records = [];
  for (const record of packages) {
    const slug = `${record.name.replace(/^@/, '').replaceAll('/', '--')}-${record.version}`;
    if (!/^[a-zA-Z\d._+-]+$/.test(slug)) throw new Error('依赖许可证目录名称无效。');
    const directory = path.join(licenseDir, slug); await fs.mkdir(directory, { recursive: true });
    const notices = [];
    for (const source of record.legalFiles) {
      const content = await fs.readFile(path.join(record.licenseRoot, source));
      if (!content.toString('utf8').trim()) throw new Error(`依赖的许可证原文为空：${record.id}`);
      const relative = path.join('licenses', slug, source);
      await fs.mkdir(path.dirname(path.join(dist, relative)), { recursive: true });
      await fs.writeFile(path.join(dist, relative), content);
      notices.push({ file: posix(relative), sha256: sha256(content) });
    }
    records.push({ name: record.name, version: record.version, license: record.license, notices, inputs: record.inputs });
  }
  const fonts = [];
  const katex = packages.find(record => record.name === 'katex');
  if (katex) {
    const evidence = JSON.parse(await fs.readFile(path.join(projectRoot, 'notices', 'katex-fonts-0.16.47.json'), 'utf8'));
    if (katex.version !== evidence.packageVersion) throw new Error('KaTeX 字体版本改变，须重新读取字体内嵌许可证。');
    const ofl = await fs.readFile(path.join(projectRoot, 'notices', 'OFL-1.1.txt'), 'utf8');
    if (sha256(Buffer.from(ofl)) !== '1d361a8f8e8ce6e68457dcd93fb56e162e6baa3bbb7e7573a290d44399f6b57e') throw new Error('OFL 标准许可证字节改变，须重新核对来源。');
    const fontNotices = new Set();
    for (const [output, detail] of Object.entries(metafile.outputs)) {
      if (!/\.(?:ttf|woff2?)$/i.test(output)) continue;
      const source = Object.keys(detail.inputs).find(file => /\.(?:ttf|woff2?)$/i.test(file));
      if (!source) throw new Error('字体输出缺少可核对的原始输入。');
      const inputPath = path.resolve(workingDirectory, source), outputPath = path.resolve(workingDirectory, output);
      if (!within(path.join(katex.directory, 'dist', 'fonts'), inputPath) || !within(dist, outputPath)) throw new Error('出现未核对的字体来源。');
      const bytes = await fs.readFile(inputPath), hash = sha256(bytes), stored = evidence.fonts.find(font => font.file === path.basename(inputPath));
      if (!stored || stored.sha256 !== hash || sha256(await fs.readFile(outputPath)) !== hash) throw new Error('KaTeX 字体字节不再匹配已核对的内嵌许可证。');
      if (!stored.names['13']?.some(text => text.includes('SIL Open Font License, Version 1.1'))) throw new Error('字体没有已核对的 OFL 1.1 声明。');
      for (const text of [...stored.names['0'], ...stored.names['13']]) fontNotices.add(text);
      fonts.push({ file: posix(path.relative(dist, outputPath)), sourceFile: stored.file, sha256: hash, family: stored.names['1'], license: 'OFL-1.1', licenseFile: 'licenses/katex-fonts/OFL-1.1.txt' });
    }
    if (fonts.length) {
      const directory = path.join(licenseDir, 'katex-fonts'); await fs.mkdir(directory);
      const body = ofl.slice(ofl.indexOf('SIL OPEN FONT LICENSE Version 1.1'));
      await fs.writeFile(path.join(directory, 'OFL-1.1.txt'), [...fontNotices].sort().join('\n\n') + '\n\n' + body);
      await fs.writeFile(path.join(directory, 'FONT-METADATA.json'), JSON.stringify({ package: `katex@${katex.version}`, metadataSource: evidence.metadataSource, parser: evidence.parser, fonts: evidence.fonts.filter(font => fonts.some(output => output.sourceFile === font.file)) }, null, 2) + '\n');
    }
  }
  fonts.sort((a, b) => a.file.localeCompare(b.file, 'en'));
  const artifacts = [];
  for (const output of Object.keys(metafile.outputs).sort()) {
    const file = path.resolve(workingDirectory, output);
    if (!within(dist, file)) throw new Error('构建产物路径不在本界面目录。');
    artifacts.push({ file: posix(path.relative(dist, file)), sha256: sha256(await fs.readFile(file)) });
  }
  const manifest = { version: 1, method: 'esbuild-metafile-bytesInOutput', packages: records, fonts, artifacts };
  await fs.writeFile(path.join(licenseDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const lines = [
    '# 第三方许可证与版权通知', '',
    '由构建器根据实际写入 JavaScript、CSS 和字体产物的 esbuild 输入图生成；未打入的开发工具不列入本清单。', '',
    '各包的许可证原文和版权声明分别保留在下列文件中。`licenses/manifest.json` 记录实际输入、原始通知和构建产物的 SHA-256，供独立核对。', '',
    '| 包 | 版本 | 声明许可证 | 许可证与通知原文 |', '| --- | --- | --- | --- |',
    ...records.map(record => `| ${record.name} | ${record.version} | ${record.license} | ${record.notices.map(notice => `[${path.posix.basename(notice.file)}](${notice.file})`).join('、')} |`), '',
    '## KaTeX 字体', '',
    fonts.length ? `实际分发 ${fonts.length} 个 TTF、WOFF、WOFF2 字体文件。每个原始文件的内嵌 name 表均已读取并记录，构建时逐一核对原始与输出哈希。字体采用 SIL OFL 1.1，区别于 KaTeX JavaScript/CSS 的 MIT 声明。` : '本次构建没有字体产物。', '',
    ...(fonts.length ? ['[字体版权声明、保留字体名与 OFL 1.1 全文](licenses/katex-fonts/OFL-1.1.txt)', '', '[逐字体内嵌元数据](licenses/katex-fonts/FONT-METADATA.json)', '', '标准许可证来源：https://openfontlicense.org/documents/OFL.txt 。原始字体来自实际安装的 `katex@' + katex.version + '`，字体字节未修改。', ''] : []),
    '官方 React 组件、布局与主题样式来自固定提交 `fb2c4b9e698e30edb738bca4cf0618587db7d203`；其 MIT 原文保留 DeepSeek 版权通知。', '',
  ];
  await fs.writeFile(path.join(dist, 'THIRD_PARTY_NOTICES.md'), lines.join('\n'));
  return { packages: records.length, fontAssets: fonts.length };
}
