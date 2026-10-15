import { createRequire } from 'node:module';

// CLI/MCP 已锁定同一套官方 Playwright，控制器直接复用它的浏览器库。
const require = createRequire(import.meta.url);
const runtime = createRequire(require.resolve('@playwright/mcp/package.json'));
export const { chromium } = runtime('playwright-core');
