import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { writeDependencyNotices } from './scripts/licenses.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const parent = createRequire(new URL('../package.json', import.meta.url));
const local = createRequire(new URL('./package.json', import.meta.url));
const { version } = JSON.parse(await fs.readFile(path.join(root, '../package.json'), 'utf8'));
const { build } = parent('esbuild');
const upstream = path.resolve(root, '../.cache/upstream/fb2c4b9e698e30edb738bca4cf0618587db7d203');
const packages = path.join(upstream, 'packages/client');
await fs.mkdir(path.join(root, 'dist'), { recursive: true });
const result = await build({
  entryPoints: [path.join(root, 'src/main.jsx')], outfile: path.join(root, 'dist/app.js'),
  bundle: true, format: 'esm', platform: 'browser', target: ['chrome120'], jsx: 'automatic',
  tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
  alias: { '@dsh/primitives': path.join(packages, 'ui-primitives/src/index.ts'), '@dsh/frame': path.join(packages, 'ui-layout/src/client/AppFrame.module.css'), '@dsh/theme': path.join(packages, 'ui-theme/src/styles'),
    ...Object.fromEntries(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map(name => [name, local.resolve(name)])) },
  nodePaths: [path.join(root, 'node_modules')],
  loader: { '.png':'file', '.svg':'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, assetNames: 'assets/[name]-[hash]',
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: JSON.stringify(version) }, minify: true, legalComments: 'inline', metafile: true,
});
const forbidden = Object.keys(result.metafile.inputs).filter(file => /(?:cordis|ui-renderer|dsh-app-boot|dsh-client-connection)[/\\]/.test(file));
if (forbidden.length) throw new Error('独立前端意外引入 DSH 运行服务。');
await fs.copyFile(path.join(root, 'index.html'), path.join(root, 'dist/index.html'));
const licenses = await writeDependencyNotices({ metafile: result.metafile, projectRoot: root, upstreamRoot: upstream, workingDirectory: process.cwd() });
await fs.writeFile(path.join(root, 'dist/build-info.json'), JSON.stringify({ version, upstreamCommit: 'fb2c4b9e698e30edb738bca4cf0618587db7d203', primitives: true, cordisRuntime: false, files: Object.keys(result.metafile.outputs).length, licenses }, null, 2) + '\n');
console.log('独立 React 界面已构建，复用官方组件；不含 DSH Host 或 Cordis 运行服务。');
