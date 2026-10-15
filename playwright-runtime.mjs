import { createRequire } from 'node:module';

// 独立软件直接使用 playwright-core；原插件的 CLI/MCP 安装保留兼容入口。
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright-core'); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  playwright = createRequire(require.resolve('@playwright/mcp/package.json'))('playwright-core');
}
export const { chromium } = playwright;
